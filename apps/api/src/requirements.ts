import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AssistInput,
  AssistResult,
  CheckResult,
  Requirement,
  RequirementCheckInput,
  RequirementCreate,
  RequirementImport,
  RequirementImportResult,
  RequirementReview,
  RequirementWithCheck,
} from "@qa/core";
import { modelSetting, schema, type createDb } from "@qa/db";
import { assistRequirement, checkRequirement, extractRequirements, resolveModel } from "@qa/intelligence";
import { and, asc, eq } from "drizzle-orm";

type Db = ReturnType<typeof createDb>;

// Spec files to import; INPUTS_DIR is relative to the repo root (default docs/inputs).
const INPUTS_DIR = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)), process.env.INPUTS_DIR || "docs/inputs") + path.sep;
const Params = z.object({ id: z.uuid() });
const ReqParams = z.object({ id: z.uuid(), requirementId: z.uuid() });

const sourceRef = (r: { source: Requirement["source"] }) => (r.source ? `${r.source.file}, ${r.source.location}` : null);

// What the checker and assistant know about a project: its app map and requirements.
async function knowledge(db: Db, projectId: string) {
  const [project] = await db.select({ appMap: schema.projects.appMap }).from(schema.projects).where(eq(schema.projects.id, projectId));
  if (!project) return null;
  const rows = await db.select().from(schema.requirements).where(eq(schema.requirements.projectId, projectId)).orderBy(asc(schema.requirements.createdAt));
  return { appMap: project.appMap ?? null, rows, existing: rows.filter((r) => r.status !== "rejected").map((r) => ({ id: r.id, text: r.text })) };
}

export function requirementRoutes(app: FastifyInstance, db: Db) {
  app.get("/projects/:id/requirements", async (req, reply) => {
    const params = Params.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    const k = await knowledge(db, params.data.id);
    if (!k) return [];
    // Each requirement is checked against the others (Review shows the status).
    const rows = k.rows.map((r) => ({
      ...r,
      check: checkRequirement({ text: r.text, source: sourceRef(r), quoteTruncated: r.source?.truncated }, { appMap: k.appMap, existing: k.existing.filter((e) => e.id !== r.id) }),
    }));
    return z.array(RequirementWithCheck).parse(rows);
  });

  // Rule-based check while the engineer types; works in every LLM_MODE.
  app.post("/projects/:id/requirements/check", async (req, reply) => {
    const params = Params.safeParse(req.params);
    const body = RequirementCheckInput.safeParse(req.body);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    if (!body.success) return reply.code(400).send({ error: z.treeifyError(body.error) });
    const k = await knowledge(db, params.data.id);
    if (!k) return reply.code(404).send({ error: "project not found" });
    return CheckResult.parse(checkRequirement(body.data, k));
  });

  // AI suggestions are returned, never stored: only POST /requirements (the engineer's Accept) saves one.
  app.post("/projects/:id/requirements/assist", async (req, reply) => {
    const params = Params.safeParse(req.params);
    const body = AssistInput.safeParse(req.body);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    if (!body.success) return reply.code(400).send({ error: z.treeifyError(body.error) });
    if ((process.env.LLM_MODE ?? "live") === "replay") {
      return reply.code(409).send({ error: "Suggestions need a live model: LLM_MODE is replay. The checker still works." });
    }
    const k = await knowledge(db, params.data.id);
    if (!k) return reply.code(404).send({ error: "project not found" });
    const model = await modelSetting(db, params.data.id);
    try {
      await resolveModel(model);
    } catch (err) {
      return reply.code(409).send({ error: `No model connected: ${(err as Error).message}` });
    }
    const sources = k.rows.flatMap((r) => (r.source && r.status !== "rejected" ? [r.source.quote] : []));
    const check = checkRequirement(body.data, k);
    return AssistResult.parse(await assistRequirement(body.data, check, { ...k, sources }, model));
  });

  // A manual requirement, saved by the engineer: authoritative + approved, with its draft history.
  app.post("/projects/:id/requirements", async (req, reply) => {
    const params = Params.safeParse(req.params);
    const body = RequirementCreate.safeParse(req.body);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    if (!body.success) return reply.code(400).send({ error: z.treeifyError(body.error) });
    const [project] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, params.data.id));
    if (!project) return reply.code(404).send({ error: "project not found" });
    const { text, source, history } = body.data;
    const [row] = await db
      .insert(schema.requirements)
      .values({
        projectId: project.id,
        text,
        authority: "authoritative",
        status: "approved",
        source: { file: source, location: "manual entry", quote: history.draft },
        history: { ...history, accepted: text },
      })
      .returning();
    return reply.code(201).send(Requirement.parse(row));
  });

  // AI-extracted requirements always enter as observed + needs_review.
  app.post("/projects/:id/requirements/import", async (req, reply) => {
    const params = Params.safeParse(req.params);
    const body = RequirementImport.safeParse(req.body);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    if (!body.success) return reply.code(400).send({ error: z.treeifyError(body.error) });
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, params.data.id));
    if (!project) return reply.code(404).send({ error: "project not found" });
    const content = await readFile(INPUTS_DIR + body.data.file, "utf8").catch(() => null);
    if (content === null) return reply.code(404).send({ error: "file not found in the inputs folder" });

    const { requirements, dropped, call } = await extractRequirements(body.data.file, content, await modelSetting(db, project.id));
    const rows = requirements.length
      ? await db
          .insert(schema.requirements)
          .values(requirements.map((r) => ({ ...r, projectId: project.id, authority: "observed" as const, status: "needs_review" as const })))
          .returning()
      : [];
    return reply.code(201).send(RequirementImportResult.parse({ requirements: rows, dropped, llmCallKey: call.key }));
  });

  app.get("/inputs", async () => z.array(z.string()).parse((await readdir(INPUTS_DIR)).filter((f) => f !== "README.md").sort()));

  // Human review: only a person can approve, reject or mark a Requirement authoritative.
  app.patch("/projects/:id/requirements/:requirementId", async (req, reply) => {
    const params = ReqParams.safeParse(req.params);
    const body = RequirementReview.safeParse(req.body);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    if (!body.success) return reply.code(400).send({ error: z.treeifyError(body.error) });
    const [row] = await db
      .update(schema.requirements)
      .set(body.data)
      .where(and(eq(schema.requirements.id, params.data.requirementId), eq(schema.requirements.projectId, params.data.id)))
      .returning();
    if (!row) return reply.code(404).send({ error: "requirement not found" });
    return Requirement.parse(row);
  });
}

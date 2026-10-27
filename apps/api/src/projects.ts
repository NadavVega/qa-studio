import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Project, ProjectInput, ProjectModel } from "@qa/core";
import { demoMode, loadDemoModels } from "@qa/core/demo";
import { demoProjectModel, schema, type createDb } from "@qa/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Db = ReturnType<typeof createDb>;
// Same evidence root as the worker: relative EVIDENCE_DIR resolves against the repo root.
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const Params = z.object({ id: z.uuid() });

async function loadProjects(db: Db, ids?: string[]): Promise<Project[]> {
  const rows = await db
    .select()
    .from(schema.projects)
    .where(and(ids ? inArray(schema.projects.id, ids) : undefined, demoMode() ? undefined : eq(schema.projects.isDemo, false)))
    .orderBy(asc(schema.projects.createdAt));
  if (rows.length === 0) return [];
  const envs = await db
    .select()
    .from(schema.environments)
    .where(inArray(schema.environments.projectId, rows.map((r) => r.id)));
  const models = demoMode() ? loadDemoModels() : null;
  return rows.map((p) =>
    Project.parse({
      ...p,
      ...(models && p.isDemo && demoProjectModel(models, p)),
      projectId: p.id,
      environments: envs.filter((e) => e.projectId === p.id),
    }),
  );
}

export function projectRoutes(app: FastifyInstance, db: Db) {
  // Demo projects do not exist unless DEMO_MODE=on: every /projects/:id/... route answers 404.
  app.addHook("preHandler", async (req, reply) => {
    if (demoMode() || !req.routeOptions.url?.startsWith("/projects/:id")) return;
    const params = Params.safeParse(req.params);
    if (!params.success) return;
    const [p] = await db.select({ isDemo: schema.projects.isDemo }).from(schema.projects).where(eq(schema.projects.id, params.data.id));
    if (p?.isDemo) return reply.code(404).send({ error: "project not found" });
  });

  app.get("/projects", async () => z.array(Project).parse(await loadProjects(db)));

  app.get("/projects/:id", async (req, reply) => {
    const params = Params.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    const [project] = await loadProjects(db, [params.data.id]);
    if (!project) return reply.code(404).send({ error: "project not found" });
    return project;
  });

  app.post("/projects", async (req, reply) => {
    const body = ProjectInput.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: z.treeifyError(body.error) });
    const { environments, ...fields } = body.data;
    const id = await db.transaction(async (tx) => {
      const [p] = await tx.insert(schema.projects).values(fields).returning({ id: schema.projects.id });
      if (environments.length) {
        await tx.insert(schema.environments).values(environments.map((e) => ({ ...e, projectId: p!.id })));
      }
      return p!.id;
    });
    const [project] = await loadProjects(db, [id]);
    return reply.code(201).send(project);
  });

  // Per-project model override (Knowledge & Config); null falls back to the default in Settings.
  app.patch("/projects/:id/model", async (req, reply) => {
    const params = Params.safeParse(req.params);
    const body = ProjectModel.safeParse(req.body);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    if (!body.success) return reply.code(400).send({ error: z.treeifyError(body.error) });
    const [demo] = await db.select({ isDemo: schema.projects.isDemo }).from(schema.projects).where(eq(schema.projects.id, params.data.id));
    if (demo?.isDemo) return reply.code(409).send({ error: "set in demo-local/models.json while demo mode is on" });
    const [row] = await db.update(schema.projects).set(body.data).where(eq(schema.projects.id, params.data.id)).returning({ id: schema.projects.id });
    if (!row) return reply.code(404).send({ error: "project not found" });
    const [project] = await loadProjects(db, [row.id]);
    return project;
  });

  // Removes the project and everything linked to it (every table cascades from projects), then its evidence folder.
  app.delete("/projects/:id", async (req, reply) => {
    const params = Params.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    const id = params.data.id;
    const [row] = await db.transaction((tx) => tx.delete(schema.projects).where(eq(schema.projects.id, id)).returning({ id: schema.projects.id }));
    if (!row) return reply.code(404).send({ error: "project not found" });
    await rm(path.resolve(repoRoot, process.env.EVIDENCE_DIR ?? "./data/evidence", id), { recursive: true, force: true });
    return reply.code(204).send();
  });
}

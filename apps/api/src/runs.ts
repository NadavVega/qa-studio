import type { FastifyInstance } from "fastify";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { AuthConfig, credentialPolicyViolation, InvestigateInput, InvestigateResult, JobStatus, QUEUES, QueueName, Run, RunDetail, RunInput, RunListQuery, type InvestigateJob } from "@qa/core";
import { schema, type createDb } from "@qa/db";
import { and, asc, desc, eq } from "drizzle-orm";

type Db = ReturnType<typeof createDb>;

const ProjectParams = z.object({ id: z.uuid() });
const RunParams = z.object({ id: z.uuid(), runId: z.uuid() });
const EvidenceParams = z.object({ id: z.uuid(), evidenceId: z.uuid() });
const JobParams = z.object({ id: z.uuid(), queue: QueueName, jobId: z.uuid() });
const CONTENT_TYPES: Record<string, string> = { png: "image/png", html: "text/plain; charset=utf-8", json: "application/json", zip: "application/zip" };

async function loadRun(db: Db, projectId: string, runId: string): Promise<Run | undefined> {
  const [run] = await db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.id, runId), eq(schema.runs.projectId, projectId)));
  if (!run) return undefined;
  const evidence = await db
    .select()
    .from(schema.evidence)
    .where(and(eq(schema.evidence.runId, runId), eq(schema.evidence.projectId, projectId)))
    .orderBy(asc(schema.evidence.createdAt));
  return Run.parse({ ...run, evidence });
}

export function runRoutes(app: FastifyInstance, db: Db, boss: PgBoss) {
  app.post("/projects/:id/runs", async (req, reply) => {
    const params = ProjectParams.safeParse(req.params);
    const body = RunInput.safeParse(req.body);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    if (!body.success) return reply.code(400).send({ error: z.treeifyError(body.error) });
    const projectId = params.data.id;
    const [env] = await db
      .select({ id: schema.environments.id })
      .from(schema.environments)
      .where(and(eq(schema.environments.id, body.data.environmentId), eq(schema.environments.projectId, projectId)));
    if (!env) return reply.code(404).send({ error: "environment not found in project" });
    const [run] = await db.insert(schema.runs).values({ projectId, environmentId: env.id }).returning();
    return reply.code(201).send(await loadRun(db, projectId, run!.id));
  });

  // Investigate stage: queue the worker to carry out one Mission (default: top-ranked Selection).
  app.post("/projects/:id/runs/:runId/investigate", async (req, reply) => {
    const params = RunParams.safeParse(req.params);
    const body = InvestigateInput.safeParse(req.body ?? {});
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    if (!body.success) return reply.code(400).send({ error: z.treeifyError(body.error) });
    const { id: projectId, runId } = params.data;
    const [selection] = await db
      .select({ missionId: schema.selections.missionId })
      .from(schema.selections)
      .where(
        and(
          eq(schema.selections.runId, runId),
          eq(schema.selections.projectId, projectId),
          body.data.missionId ? eq(schema.selections.missionId, body.data.missionId) : undefined,
        ),
      )
      .orderBy(asc(schema.selections.rank))
      .limit(1);
    if (!selection) return reply.code(409).send({ error: "no selected mission; run the select stage first" });
    // Execution policy is checked before anything is queued; the worker checks it again.
    const [env] = await db
      .select({ authConfig: schema.environments.authConfig })
      .from(schema.runs)
      .innerJoin(schema.environments, eq(schema.environments.id, schema.runs.environmentId))
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.projectId, projectId)));
    const violation = env && credentialPolicyViolation(AuthConfig.parse(env.authConfig), process.env.CREDENTIAL_ENVS);
    if (violation) return reply.code(403).send({ error: `rejected by execution policy: ${violation}` });
    const job: InvestigateJob = { runId, projectId, missionId: selection.missionId };
    const jobId = await boss.send(QUEUES.investigate, job);
    return reply.code(202).send(InvestigateResult.parse({ runId, missionId: selection.missionId, queued: true, jobId }));
  });

  app.get("/projects/:id/runs/:runId", async (req, reply) => {
    const params = RunParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    const run = await loadRun(db, params.data.id, params.data.runId);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return run;
  });

  app.get("/projects/:id/runs", async (req, reply) => {
    const params = ProjectParams.safeParse(req.params);
    const query = RunListQuery.safeParse(req.query);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    if (!query.success) return reply.code(400).send({ error: z.treeifyError(query.error) });
    const rows = await db
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.projectId, params.data.id), query.data.mode ? eq(schema.runs.mode, query.data.mode) : undefined))
      .orderBy(desc(schema.runs.createdAt));
    return z.array(Run).parse(rows.map((r) => ({ ...r, evidence: [] })));
  });

  // Everything the Guided view shows for one run.
  app.get("/projects/:id/runs/:runId/detail", async (req, reply) => {
    const params = RunParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    const { id: projectId, runId } = params.data;
    const run = await loadRun(db, projectId, runId);
    if (!run) return reply.code(404).send({ error: "run not found" });
    const scope = <T extends typeof schema.stageRecords | typeof schema.missions | typeof schema.selections | typeof schema.findings>(t: T) =>
      and(eq(t.runId, runId), eq(t.projectId, projectId));
    const [stageRecords, missions, selections, findings] = await Promise.all([
      db.select().from(schema.stageRecords).where(scope(schema.stageRecords)).orderBy(asc(schema.stageRecords.createdAt)),
      db.select().from(schema.missions).where(scope(schema.missions)).orderBy(asc(schema.missions.createdAt)),
      db.select().from(schema.selections).where(scope(schema.selections)).orderBy(asc(schema.selections.rank)),
      db.select().from(schema.findings).where(scope(schema.findings)).orderBy(asc(schema.findings.createdAt)),
    ]);
    return RunDetail.parse({ ...run, stageRecords, missions, selections, findings });
  });

  // Evidence file, scoped to the project.
  app.get("/projects/:id/evidence/:evidenceId", async (req, reply) => {
    const params = EvidenceParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    const [row] = await db
      .select()
      .from(schema.evidence)
      .where(and(eq(schema.evidence.id, params.data.evidenceId), eq(schema.evidence.projectId, params.data.id)));
    if (!row) return reply.code(404).send({ error: "evidence not found" });
    const file = await readFile(row.path).catch(() => null);
    if (!file) return reply.code(404).send({ error: "evidence file missing" });
    return reply.type(CONTENT_TYPES[row.path.split(".").pop()!] ?? "application/octet-stream").send(file);
  });

  // State of a queued job, so the UI can tell running from failed.
  app.get("/projects/:id/jobs/:queue/:jobId", async (req, reply) => {
    const params = JobParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    const job = await boss.getJobById<{ projectId: string }>(params.data.queue, params.data.jobId);
    if (!job || job.data.projectId !== params.data.id) return reply.code(404).send({ error: "job not found" });
    return JobStatus.parse({ id: job.id, state: job.state, output: job.output ?? null });
  });
}

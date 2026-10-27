import type { FastifyInstance } from "fastify";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { Finding, FindingDetail, FindingReview, QUEUES, Queued, RegressionRunInput, RegressionTest, RegressionTestReview, type RegressionJob, type TestSpec, type ValidateJob } from "@qa/core";
import { findingInvestigation, missionRequirements, modelSetting, schema, type createDb } from "@qa/db";
import { callFields, generateChecks } from "@qa/intelligence";
import { and, asc, eq, inArray } from "drizzle-orm";

type Db = ReturnType<typeof createDb>;

const FindingParams = z.object({ id: z.uuid(), findingId: z.uuid() });
const TestParams = z.object({ id: z.uuid(), testId: z.uuid() });

async function loadFinding(db: Db, projectId: string, findingId: string) {
  const [finding] = await db
    .select()
    .from(schema.findings)
    .where(and(eq(schema.findings.id, findingId), eq(schema.findings.projectId, projectId)));
  return finding;
}

export function findingRoutes(app: FastifyInstance, db: Db, boss: PgBoss) {
  app.get("/projects/:id/findings/:findingId", async (req, reply) => {
    const params = FindingParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    const { id: projectId, findingId } = params.data;
    const finding = await loadFinding(db, projectId, findingId);
    if (!finding) return reply.code(404).send({ error: "finding not found" });
    const validationAttempts = await db
      .select()
      .from(schema.validationAttempts)
      .where(and(eq(schema.validationAttempts.findingId, findingId), eq(schema.validationAttempts.projectId, projectId)))
      .orderBy(asc(schema.validationAttempts.createdAt));
    const tests = await db
      .select()
      .from(schema.regressionTests)
      .where(and(eq(schema.regressionTests.findingId, findingId), eq(schema.regressionTests.projectId, projectId)))
      .orderBy(asc(schema.regressionTests.createdAt));
    const results = tests.length
      ? await db
          .select()
          .from(schema.testResults)
          .where(and(inArray(schema.testResults.regressionTestId, tests.map((t) => t.id)), eq(schema.testResults.projectId, projectId)))
          .orderBy(asc(schema.testResults.createdAt))
      : [];
    return FindingDetail.parse({
      ...finding,
      validationAttempts,
      regressionTests: tests.map((t) => ({ ...t, results: results.filter((r) => r.regressionTestId === t.id) })),
    });
  });

  // Validate stage: queue a fresh, independent reproduction of a potential Finding.
  app.post("/projects/:id/findings/:findingId/validate", async (req, reply) => {
    const params = FindingParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    const { id: projectId, findingId } = params.data;
    const finding = await loadFinding(db, projectId, findingId);
    if (!finding) return reply.code(404).send({ error: "finding not found" });
    if (finding.status !== "potential") return reply.code(409).send({ error: `finding is ${finding.status}, not potential` });
    // Observational findings are for a person to review; only potential defects are reproduced.
    if (finding.verdict !== "potential_defect") return reply.code(409).send({ error: "only potential defects are validated; observational findings need human review" });
    const job: ValidateJob = { projectId, findingId };
    const jobId = await boss.send(QUEUES.validate, job);
    return reply.code(202).send(Queued.parse({ id: findingId, queued: true, jobId }));
  });

  // Automate stage: propose a RegressionTest for a confirmed Finding. Steps are the investigation's own;
  // the model writes the checks. The spec is interpreted by the worker, never executed as code.
  app.post("/projects/:id/findings/:findingId/regression-tests", async (req, reply) => {
    const params = FindingParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    const { id: projectId, findingId } = params.data;
    const finding = await loadFinding(db, projectId, findingId);
    if (!finding) return reply.code(404).send({ error: "finding not found" });
    if (finding.status !== "confirmed") return reply.code(409).send({ error: "only confirmed findings get regression tests" });
    const { judge, investigation } = await findingInvestigation(db, projectId, findingId);
    const { reasoning } = z.object({ reasoning: z.string() }).parse(judge.decision);
    const requirements = await missionRequirements(db, projectId, investigation.input.missionId);
    const { steps } = investigation.decision;
    const { checks, call } = await generateChecks({ title: finding.title, reasoning, requirements, steps, finalSnapshot: investigation.output.finalSnapshot }, await modelSetting(db, params.data.id));
    const spec: TestSpec = { steps, checks };

    const test = await db.transaction(async (tx) => {
      const [row] = await tx.insert(schema.regressionTests).values({ projectId, findingId, code: JSON.stringify(spec, null, 2) }).returning();
      await tx.insert(schema.stageRecords).values({
        projectId,
        runId: finding.runId,
        stage: "automate",
        input: { findingId, title: finding.title, reasoning, requirements, steps, llmRequest: call.request },
        decision: { ...callFields(call), checks },
        output: { regressionTestId: row!.id, status: row!.status },
      });
      await tx.update(schema.runs).set({ currentStage: "automate" }).where(eq(schema.runs.id, finding.runId));
      return row!;
    });
    return reply.code(201).send(RegressionTest.parse(test));
  });

  // Queue one execution of a RegressionTest; a passing run validates a proposed test.
  app.post("/projects/:id/regression-tests/:testId/run", async (req, reply) => {
    const params = TestParams.safeParse(req.params);
    const body = RegressionRunInput.safeParse(req.body ?? {});
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    if (!body.success) return reply.code(400).send({ error: z.treeifyError(body.error) });
    const { id: projectId, testId } = params.data;
    const { environmentId } = body.data;
    if (environmentId) {
      const [env] = await db
        .select({ id: schema.environments.id })
        .from(schema.environments)
        .where(and(eq(schema.environments.id, environmentId), eq(schema.environments.projectId, projectId)));
      if (!env) return reply.code(404).send({ error: "environment not found in project" });
    }
    const [test] = await db
      .select({ id: schema.regressionTests.id })
      .from(schema.regressionTests)
      .where(and(eq(schema.regressionTests.id, testId), eq(schema.regressionTests.projectId, projectId)));
    if (!test) return reply.code(404).send({ error: "regression test not found" });
    const job: RegressionJob = { projectId, regressionTestId: testId, environmentId };
    const jobId = await boss.send(QUEUES.regression, job);
    return reply.code(202).send(Queued.parse({ id: testId, queued: true, jobId }));
  });

  // Human review: dismiss a potential Finding.
  app.post("/projects/:id/findings/:findingId/review", async (req, reply) => {
    const params = FindingParams.safeParse(req.params);
    const body = FindingReview.safeParse(req.body);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    if (!body.success) return reply.code(400).send({ error: z.treeifyError(body.error) });
    const { id: projectId, findingId } = params.data;
    const finding = await loadFinding(db, projectId, findingId);
    if (!finding) return reply.code(404).send({ error: "finding not found" });
    if (finding.status !== "potential") return reply.code(409).send({ error: `finding is ${finding.status}, not potential` });
    const [row] = await db.update(schema.findings).set(body.data).where(eq(schema.findings.id, findingId)).returning();
    return Finding.parse(row);
  });

  // Human review: promote a validated RegressionTest, or reject a proposed/validated one.
  app.post("/projects/:id/regression-tests/:testId/review", async (req, reply) => {
    const params = TestParams.safeParse(req.params);
    const body = RegressionTestReview.safeParse(req.body);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    if (!body.success) return reply.code(400).send({ error: z.treeifyError(body.error) });
    const { id: projectId, testId } = params.data;
    const [test] = await db
      .select()
      .from(schema.regressionTests)
      .where(and(eq(schema.regressionTests.id, testId), eq(schema.regressionTests.projectId, projectId)));
    if (!test) return reply.code(404).send({ error: "regression test not found" });
    const allowed = body.data.status === "promoted" ? ["validated"] : ["proposed", "validated"];
    if (!allowed.includes(test.status)) return reply.code(409).send({ error: `test is ${test.status}; cannot become ${body.data.status}` });
    const [row] = await db.update(schema.regressionTests).set(body.data).where(eq(schema.regressionTests.id, testId)).returning();
    return RegressionTest.parse(row);
  });
}

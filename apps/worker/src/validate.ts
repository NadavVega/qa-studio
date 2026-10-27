import { TestSpec, type RegressionJob, type ValidateJob } from "@qa/core";
import { callFields, judgeInvestigation } from "@qa/intelligence";
import { findingInvestigation, modelSetting, missionRequirements, schema, type createDb } from "@qa/db";
import { and, eq } from "drizzle-orm";
import { browse, projectEnvironment, runEnvironment, saveEvidence } from "./investigate";

type Db = ReturnType<typeof createDb>;

// Validate stage: one fresh, independent reproduction of a potential Finding. The investigation's
// steps are replayed in a new browser (no AI planning), new Evidence is captured and judged again.
// Same verdict: confirmed. Different verdict: not_reproduced. An infra failure leaves the Finding potential.
export async function validateFinding(db: Db, job: ValidateJob) {
  const { finding, investigation } = await findingInvestigation(db, job.projectId, job.findingId);
  const { missionId, goal } = investigation.input;
  const env = await runEnvironment(db, job.projectId, finding.runId);
  const b = await browse(env, job.projectId, finding.runId, async () => investigation.decision.steps);
  const evidence = b.saved;
  const requirements = await missionRequirements(db, job.projectId, missionId);
  const judged = b.output.infraError ? undefined : await judgeInvestigation({ goal, requirements, ...b.output }, evidence, await modelSetting(db, job.projectId));
  const reproduced = judged?.judgement.verdict === finding.verdict;
  const status = b.output.infraError ? finding.status : reproduced ? "confirmed" : "not_reproduced";

  return db.transaction(async (tx) => {
    await saveEvidence(tx, job.projectId, finding.runId, b.saved);
    const [attempt] = await tx
      .insert(schema.validationAttempts)
      .values({ projectId: job.projectId, findingId: finding.id, reproduced, evidenceIds: evidence.map((e) => e.id) })
      .returning();
    await tx.update(schema.findings).set({ status }).where(eq(schema.findings.id, finding.id));
    await tx.insert(schema.stageRecords).values({
      projectId: job.projectId,
      runId: finding.runId,
      stage: "validate",
      input: { findingId: finding.id, verdict: finding.verdict, investigateRecordId: investigation.id, steps: investigation.decision.steps, requirements, llmRequest: judged?.call.request ?? null },
      decision: { ...callFields(judged?.call), judgement: judged?.judgement ?? null, reproduced },
      output: { ...b.output, validationAttemptId: attempt!.id, status, evidenceIds: evidence.map((e) => e.id) },
    });
    await tx.update(schema.runs).set({ currentStage: "validate" }).where(eq(schema.runs.id, finding.runId));
    return attempt!;
  });
}

// Runs a RegressionTest spec: its steps, then each check on the final page. No AI call.
// Passed: a proposed test becomes validated. Failed or infra failure: it stays as it is.
// Recorded in job.runId (a suite run) when given, else in the run of the test's finding.
export async function runRegressionTest(db: Db, job: RegressionJob) {
  const [test] = await db
    .select({ test: schema.regressionTests, runId: schema.findings.runId })
    .from(schema.regressionTests)
    .innerJoin(schema.findings, eq(schema.regressionTests.findingId, schema.findings.id))
    .where(and(eq(schema.regressionTests.id, job.regressionTestId), eq(schema.regressionTests.projectId, job.projectId)));
  if (!test) throw new Error(`regression test ${job.regressionTestId} not found`);
  const spec = TestSpec.parse(JSON.parse(test.test.code));
  const env = job.environmentId ? await projectEnvironment(db, job.projectId, job.environmentId) : await runEnvironment(db, job.projectId, test.runId);
  const runId = job.runId ?? test.runId;
  const b = await browse(env, job.projectId, runId, async () => spec.steps, async (page) => {
    const checks = [];
    for (const c of spec.checks) {
      const text = await page.getByRole(c.role, { name: c.name }).first().innerText({ timeout: 5000 }).catch(() => null);
      checks.push({ ...c, actual: text, ok: text?.includes(c.contains) ?? false });
    }
    return checks;
  });
  const checks = b.checked ?? [];
  const passed = !b.output.infraError && b.output.stepResults.every((s) => s.ok) && checks.every((c) => c.ok);
  const status = passed && test.test.status === "proposed" ? "validated" : test.test.status;
  const evidenceIds = b.saved.map((e) => e.id);

  return db.transaction(async (tx) => {
    await saveEvidence(tx, job.projectId, runId, b.saved);
    const [result] = await tx
      .insert(schema.testResults)
      .values({ projectId: job.projectId, regressionTestId: test.test.id, passed, environmentId: env.id, evidenceIds })
      .returning();
    await tx.update(schema.regressionTests).set({ status }).where(eq(schema.regressionTests.id, test.test.id));
    await tx.insert(schema.stageRecords).values({
      projectId: job.projectId,
      runId,
      stage: "automate",
      input: { regressionTestId: test.test.id, environmentId: env.id, baseUrl: env.baseUrl, spec },
      decision: { passed, checks },
      output: { ...b.output, testResultId: result!.id, status, evidenceIds },
    });
    return { ...result!, infraError: b.output.infraError };
  });
}

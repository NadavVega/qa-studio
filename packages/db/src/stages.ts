import { z } from "zod";
import { Mission } from "@qa/core";
import { authorityGuard, callFields, judgeInfra, judgeInvestigation, planMissions, selectMissions, WEIGHTS, type Judgement, type LlmCall } from "@qa/intelligence";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { missionRequirementRows, modelSetting, type createDb } from "./index";
import * as schema from "./schema";

// Plan, Select and Judge stages, shared by the API (guided runs) and the worker (release runs).
// A precondition that is not met throws StageError with the HTTP status the API answers with.

type Db = ReturnType<typeof createDb>;

export class StageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Plan stage: AI proposes Missions from the project's (non-rejected) Requirements.
export async function planStage(db: Db, projectId: string, runId: string) {
  const [run] = await db.select().from(schema.runs).where(and(eq(schema.runs.id, runId), eq(schema.runs.projectId, projectId)));
  if (!run) throw new StageError(404, "run not found");
  const requirements = await db
    .select({ id: schema.requirements.id, text: schema.requirements.text, authority: schema.requirements.authority })
    .from(schema.requirements)
    .where(and(eq(schema.requirements.projectId, projectId), ne(schema.requirements.status, "rejected")))
    // Text, not id, breaks createdAt ties (one import shares a timestamp) so the prompt and its replay fixture are the same in every database.
    .orderBy(asc(schema.requirements.createdAt), asc(schema.requirements.text));
  if (!requirements.length) throw new StageError(409, "project has no requirements to plan from");

  const { missions, dropped, call } = await planMissions(requirements, await modelSetting(db, projectId));
  const rows = await db.transaction(async (tx) => {
    const inserted = missions.length
      ? await tx.insert(schema.missions).values(missions.map((m) => ({ ...m, projectId, runId }))).returning()
      : [];
    await tx.insert(schema.stageRecords).values({
      projectId,
      runId,
      stage: "plan",
      input: { requirements, llmRequest: call.request },
      decision: { ...callFields(call), droppedMissions: dropped },
      output: { missionIds: inserted.map((m) => m.id) },
    });
    await tx.update(schema.runs).set({ currentStage: "plan" }).where(eq(schema.runs.id, runId));
    return inserted;
  });
  return { missions: rows, call };
}

// Select stage: deterministic ranking of the run's Missions.
export async function selectStage(db: Db, projectId: string, runId: string) {
  const missionRows = await db
    .select()
    .from(schema.missions)
    .where(and(eq(schema.missions.runId, runId), eq(schema.missions.projectId, projectId)));
  if (!missionRows.length) throw new StageError(409, "run has no missions; run the plan stage first");
  const missions = z.array(Mission).parse(missionRows);
  const reqs = await db
    .select({ id: schema.requirements.id, authority: schema.requirements.authority })
    .from(schema.requirements)
    .where(eq(schema.requirements.projectId, projectId));
  const authority = new Map(reqs.map((r) => [r.id, r.authority]));

  const ranking = selectMissions(missions, (id) => authority.get(id));
  const rows = await db.transaction(async (tx) => {
    await tx.delete(schema.selections).where(and(eq(schema.selections.runId, runId), eq(schema.selections.projectId, projectId)));
    const inserted = await tx.insert(schema.selections).values(ranking.map((r) => ({ ...r, projectId, runId }))).returning();
    await tx.insert(schema.stageRecords).values({
      projectId,
      runId,
      stage: "select",
      input: { missions, requirementAuthority: Object.fromEntries(authority) },
      decision: { weights: WEIGHTS },
      output: { ranking },
    });
    await tx.update(schema.runs).set({ currentStage: "select" }).where(eq(schema.runs.id, runId));
    return inserted;
  });
  return rows.sort((a, b) => a.rank - b.rank);
}

const InvestigateOutput = z.object({
  stepResults: z.array(z.unknown()),
  finalSnapshot: z.string(),
  consoleErrors: z.array(z.string()),
  failedRequests: z.array(z.unknown()),
  infraError: z.string().nullable(),
  evidenceIds: z.array(z.uuid()),
});
const InvestigateRecordInput = z.object({ missionId: z.uuid(), goal: z.string() });

// Judge stage: verdict on the run's latest investigation. Every verdict cites real Evidence ids.
export async function judgeStage(db: Db, projectId: string, runId: string) {
  const [record] = await db
    .select()
    .from(schema.stageRecords)
    .where(and(eq(schema.stageRecords.runId, runId), eq(schema.stageRecords.projectId, projectId), eq(schema.stageRecords.stage, "investigate")))
    .orderBy(desc(schema.stageRecords.createdAt))
    .limit(1);
  if (!record) throw new StageError(409, "run has no investigation; run the investigate stage first");
  const investigation = InvestigateOutput.parse(record.output);
  const { missionId, goal } = InvestigateRecordInput.parse(record.input);
  const evidence = investigation.evidenceIds.length
    ? await db
        .select({ id: schema.evidence.id, kind: schema.evidence.kind, path: schema.evidence.path })
        .from(schema.evidence)
        .where(and(inArray(schema.evidence.id, investigation.evidenceIds), eq(schema.evidence.projectId, projectId)))
    : [];

  let judgement: Judgement;
  let call: LlmCall | undefined;
  let requirements: string[] = [];
  let requirementAuthority: { text: string; authority: string; status: string }[] = [];
  let aiVerdict: string | null = null;
  if (investigation.infraError) {
    judgement = judgeInfra(investigation.infraError, evidence);
  } else {
    const rows = await missionRequirementRows(db, projectId, missionId);
    requirements = rows.map((r) => r.text);
    let aiJudgement: Judgement;
    ({ judgement: aiJudgement, call } = await judgeInvestigation({ goal, requirements, ...investigation }, evidence, await modelSetting(db, projectId)));
    aiVerdict = aiJudgement.verdict;
    judgement = authorityGuard(aiJudgement, rows);
    requirementAuthority = rows;
  }

  const finding = await db.transaction(async (tx) => {
    // Only product behavior worth a look becomes a Finding; potential_defect then goes to validation.
    // correct, inconclusive and infra_failure stay on the StageRecord.
    const [row] = !["potential_defect", "observational"].includes(judgement.verdict)
      ? []
      : await tx
          .insert(schema.findings)
          .values({ projectId, runId, verdict: judgement.verdict, title: judgement.title, evidenceIds: judgement.evidenceIds })
          .returning();
    await tx.insert(schema.stageRecords).values({
      projectId,
      runId,
      stage: "judge",
      input: { investigateRecordId: record.id, missionId, goal, requirements, requirementAuthority, investigation, evidence, llmRequest: call?.request ?? null },
      decision: { ...callFields(call), aiVerdict, ...judgement },
      output: { verdict: judgement.verdict, findingId: row?.id ?? null, evidenceIds: judgement.evidenceIds },
    });
    await tx.update(schema.runs).set({ currentStage: "judge" }).where(eq(schema.runs.id, runId));
    return row ?? null;
  });
  return { judgement, finding, call };
}

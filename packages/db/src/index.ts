import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { drizzle } from "drizzle-orm/node-postgres";
import { BrowserStep, MissionDetail, demoProjectName, type DemoModels } from "@qa/core";
import { demoMode, loadDemoModels } from "@qa/core/demo";
import * as schema from "./schema";

export const createDb = (url: string) => drizzle(url, { schema });
export { schema };

// Texts of the Requirements a Mission checks, ordered by text so prompts built from them are stable.
// Text, authority and review status of the requirements a Mission checks, ordered by text.
export async function missionRequirementRows(db: ReturnType<typeof createDb>, projectId: string, missionId: string) {
  const [mission] = await db
    .select({ detail: schema.missions.detail })
    .from(schema.missions)
    .where(and(eq(schema.missions.id, missionId), eq(schema.missions.projectId, projectId)));
  if (!mission) return [];
  const { requirementIds } = MissionDetail.parse(mission.detail);
  if (!requirementIds.length) return [];
  const rows = await db
    .select({ text: schema.requirements.text, authority: schema.requirements.authority, status: schema.requirements.status })
    .from(schema.requirements)
    .where(and(inArray(schema.requirements.id, requirementIds), eq(schema.requirements.projectId, projectId)))
    .orderBy(schema.requirements.text);
  return rows;
}

export async function missionRequirements(db: ReturnType<typeof createDb>, projectId: string, missionId: string) {
  return (await missionRequirementRows(db, projectId, missionId)).map((r) => r.text);
}

const InvestigateRecord = z.object({
  input: z.object({ missionId: z.uuid(), goal: z.string() }),
  decision: z.object({ steps: z.array(BrowserStep) }),
  output: z.object({ finalSnapshot: z.string() }),
});

// The investigate StageRecord a Finding was judged from (via the judge record that created it).
export async function findingInvestigation(db: ReturnType<typeof createDb>, projectId: string, findingId: string) {
  const [finding] = await db
    .select()
    .from(schema.findings)
    .where(and(eq(schema.findings.id, findingId), eq(schema.findings.projectId, projectId)));
  if (!finding) throw new Error(`finding ${findingId} not found`);
  const [judge] = await db
    .select()
    .from(schema.stageRecords)
    .where(and(eq(schema.stageRecords.projectId, projectId), eq(schema.stageRecords.stage, "judge"), sql`${schema.stageRecords.output}->>'findingId' = ${findingId}`));
  const { investigateRecordId } = z.object({ investigateRecordId: z.uuid() }).parse(judge?.input);
  const [record] = await db
    .select()
    .from(schema.stageRecords)
    .where(and(eq(schema.stageRecords.id, investigateRecordId), eq(schema.stageRecords.projectId, projectId)));
  return { finding, judge: judge!, investigation: { id: investigateRecordId, ...InvestigateRecord.parse(record) } };
}

// Demo mode: models.json sets a demo project's model and "Local models only" flag (null model = demo default).
export function demoProjectModel(models: DemoModels, project: { isDemo: boolean; name: string }) {
  const ds = project.isDemo ? Object.entries(models.datasets).find(([n]) => demoProjectName(n) === project.name)?.[1] : undefined;
  return { llmModel: ds?.model ?? null, localOnly: ds?.localOnly ?? false };
}

// Model setting for a project's AI calls: its override, else the default from Settings, else "auto".
// With DEMO_MODE=on, demo-local/models.json replaces the Settings default and decides demo projects' models;
// nothing is written, so turning demo mode off restores the Settings values.
export async function modelSetting(db: ReturnType<typeof createDb>, projectId: string) {
  const [p] = await db
    .select({ llmModel: schema.projects.llmModel, isDemo: schema.projects.isDemo, name: schema.projects.name })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  const models = demoMode() ? loadDemoModels() : null;
  if (models && p?.isDemo) return demoProjectModel(models, p).llmModel ?? models.defaultModel;
  if (p?.llmModel) return p.llmModel;
  if (models) return models.defaultModel;
  const [s] = await db.select().from(schema.settings).where(eq(schema.settings.key, "defaultModel"));
  return s?.value ?? "auto";
}

export { judgeStage, planStage, selectStage, StageError } from "./stages";

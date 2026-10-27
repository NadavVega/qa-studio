import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import {
  EvidenceKind,
  FindingStatus,
  GithubEventKind,
  RegressionTestStatus,
  RequirementAuthority,
  RequirementStatus,
  RunMode,
  Stage,
  Verdict,
  type AuthConfig,
  type RequirementSource,
  type RequirementHistory,
  type AppMap,
} from "@qa/core";

// Every project-scoped table carries projectId. Enums come from the glossary in @qa/core.

// zod 4 types .options as a plain array; pgEnum needs a non-empty tuple.
const values = <T extends string>(e: { options: T[] }) => e.options as [T, ...T[]];

export const requirementAuthority = pgEnum("requirement_authority", values(RequirementAuthority));
export const requirementStatus = pgEnum("requirement_status", values(RequirementStatus));
export const runMode = pgEnum("run_mode", values(RunMode));
export const stage = pgEnum("stage", values(Stage));
export const evidenceKind = pgEnum("evidence_kind", values(EvidenceKind));
export const verdict = pgEnum("verdict", values(Verdict));
export const findingStatus = pgEnum("finding_status", values(FindingStatus));
export const regressionTestStatus = pgEnum("regression_test_status", values(RegressionTestStatus));
export const githubEventKind = pgEnum("github_event_kind", values(GithubEventKind));

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const projectId = () =>
  uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" });

export const orgs = pgTable("orgs", { id: id(), name: text("name").notNull(), createdAt: createdAt() });

export const teams = pgTable("teams", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const projects = pgTable("projects", {
  id: id(),
  teamId: uuid("team_id").references(() => teams.id),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  isSimulated: boolean("is_simulated").notNull().default(false),
  // Created by pnpm demo:seed from demo-local; hidden everywhere unless DEMO_MODE=on.
  isDemo: boolean("is_demo").notNull().default(false),
  // "provider:model" override; null uses settings.defaultModel.
  llmModel: text("llm_model"),
  appMap: jsonb("app_map").$type<AppMap>(),
  createdAt: createdAt(),
});

// Global key/value settings (today only defaultModel). Not project data.
export const settings = pgTable("settings", { key: text("key").primaryKey(), value: text("value").notNull() });

// authConfig names env vars (e.g. APP_USER); it never holds credential values.
export const environments = pgTable("environments", {
  id: id(),
  projectId: projectId(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  authConfig: jsonb("auth_config").$type<AuthConfig>().notNull().default({}),
  createdAt: createdAt(),
});

export const requirements = pgTable("requirements", {
  id: id(),
  projectId: projectId(),
  text: text("text").notNull(),
  authority: requirementAuthority("authority").notNull().default("observed"),
  status: requirementStatus("status").notNull().default("needs_review"),
  source: jsonb("source").$type<RequirementSource>(),
  // Manual requirements: original draft, AI suggestion (if any) and the accepted text.
  history: jsonb("history").$type<RequirementHistory>(),
  createdAt: createdAt(),
});

export const runs = pgTable("runs", {
  id: id(),
  projectId: projectId(),
  environmentId: uuid("environment_id").notNull().references(() => environments.id),
  mode: runMode("mode").notNull().default("guided"),
  // null: started by a person; else "pull request #12" or "release v1.4.0".
  trigger: text("trigger"),
  currentStage: stage("current_stage").notNull().default("plan"),
  createdAt: createdAt(),
});

export const missions = pgTable("missions", {
  id: id(),
  projectId: projectId(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  detail: jsonb("detail").notNull().default({}),
  createdAt: createdAt(),
});

export const selections = pgTable("selections", {
  id: id(),
  projectId: projectId(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  missionId: uuid("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  rank: integer("rank").notNull(),
  scores: jsonb("scores").$type<Record<string, number>>().notNull(),
  createdAt: createdAt(),
});

export const stageRecords = pgTable("stage_records", {
  id: id(),
  projectId: projectId(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  stage: stage("stage").notNull(),
  input: jsonb("input").notNull(),
  decision: jsonb("decision"),
  output: jsonb("output"),
  createdAt: createdAt(),
});

export const evidence = pgTable("evidence", {
  id: id(),
  projectId: projectId(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  kind: evidenceKind("kind").notNull(),
  path: text("path").notNull(),
  createdAt: createdAt(),
});

export const findings = pgTable("findings", {
  id: id(),
  projectId: projectId(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  verdict: verdict("verdict").notNull(),
  status: findingStatus("status").notNull().default("potential"),
  title: text("title").notNull(),
  evidenceIds: uuid("evidence_ids").array().notNull().default([]),
  createdAt: createdAt(),
});

export const validationAttempts = pgTable("validation_attempts", {
  id: id(),
  projectId: projectId(),
  findingId: uuid("finding_id").notNull().references(() => findings.id, { onDelete: "cascade" }),
  reproduced: boolean("reproduced").notNull(),
  evidenceIds: uuid("evidence_ids").array().notNull().default([]),
  createdAt: createdAt(),
});

export const regressionTests = pgTable("regression_tests", {
  id: id(),
  projectId: projectId(),
  findingId: uuid("finding_id").references(() => findings.id, { onDelete: "set null" }),
  status: regressionTestStatus("status").notNull().default("proposed"),
  code: text("code").notNull(),
  createdAt: createdAt(),
});

export const testResults = pgTable("test_results", {
  id: id(),
  projectId: projectId(),
  regressionTestId: uuid("regression_test_id").notNull().references(() => regressionTests.id, { onDelete: "cascade" }),
  passed: boolean("passed").notNull(),
  environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "set null" }),
  evidenceIds: uuid("evidence_ids").array().notNull().default([]),
  createdAt: createdAt(),
});

// One GitHub repository per project. tokenEnv is the NAME of the worker env var holding the token.
export const githubConnections = pgTable("github_connections", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  repo: text("repo").notNull(),
  tokenEnv: text("token_env").notNull().default("GITHUB_TOKEN"),
  prEnvironmentId: uuid("pr_environment_id").references(() => environments.id, { onDelete: "set null" }),
  prUrlTemplate: text("pr_url_template"),
  releaseEnvironmentId: uuid("release_environment_id").references(() => environments.id, { onDelete: "set null" }),
  healthPath: text("health_path"),
  pollSeconds: integer("poll_seconds").notNull().default(60),
  onPullRequests: boolean("on_pull_requests").notNull().default(true),
  onReleases: boolean("on_releases").notNull().default(true),
  prComments: boolean("pr_comments").notNull().default(false),
  releaseMissions: integer("release_missions").notNull().default(3),
  lastPollAt: timestamp("last_poll_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: createdAt(),
});

// Every pull request head SHA and release seen. The unique key makes each event trigger at most once.
// Releases are keyed by tag alone (second index); their sha is filled in when the run starts.
export const githubEvents = pgTable(
  "github_events",
  {
    id: id(),
    projectId: projectId(),
    kind: githubEventKind("kind").notNull(),
    ref: text("ref").notNull(),
    sha: text("sha").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    jobId: text("job_id"),
    result: text("result").notNull().default("queued"),
  },
  (t) => [unique().on(t.projectId, t.kind, t.ref, t.sha), uniqueIndex("github_events_release_tag").on(t.projectId, t.ref).where(sql`${t.kind} = 'release'`)],
);

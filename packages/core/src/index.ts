import { z } from "zod";

// Glossary: these names are used verbatim in code, API and UI. See CLAUDE.md.

export const PORTS = { web: 3000, api: 3001, worker: 3002 } as const;

export const RequirementAuthority = z.enum(["authoritative", "observed", "unknown"]);
export const RequirementStatus = z.enum(["needs_review", "approved", "rejected"]);
// truncated: the stored quote was cut to MAX_QUOTE; file + location still point at the full text.
export const RequirementSource = z.object({ file: z.string(), location: z.string(), quote: z.string(), truncated: z.boolean().optional() });
export const MAX_TEXT = 2000;
export const MAX_QUOTE = 500;

// guided: the engineer advances each stage. suite: promoted regression tests (no AI). release: unattended release check.
export const RunMode = z.enum(["guided", "suite", "release"]);
export const Stage = z.enum(["plan", "select", "investigate", "judge", "validate", "automate"]);
export const EvidenceKind = z.enum(["screenshot", "dom", "console", "network", "trace"]);
export const Verdict = z.enum(["correct", "observational", "inconclusive", "potential_defect", "infra_failure"]);
export const FindingStatus = z.enum(["potential", "confirmed", "not_reproduced", "dismissed"]);
export const RegressionTestStatus = z.enum(["proposed", "validated", "rejected", "promoted"]);

export type RequirementAuthority = z.infer<typeof RequirementAuthority>;
export type RequirementStatus = z.infer<typeof RequirementStatus>;
export type RequirementSource = z.infer<typeof RequirementSource>;
export type RunMode = z.infer<typeof RunMode>;
export type Stage = z.infer<typeof Stage>;
export type EvidenceKind = z.infer<typeof EvidenceKind>;
export type Verdict = z.infer<typeof Verdict>;
export type FindingStatus = z.infer<typeof FindingStatus>;
export type RegressionTestStatus = z.infer<typeof RegressionTestStatus>;

export const HealthResponse = z.object({ status: z.literal("ok"), service: z.string() });
export type HealthResponse = z.infer<typeof HealthResponse>;

// Projects API
// authConfig holds only env var names; credential values never reach the database.
const EnvVarName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
export const AuthConfig = z.strictObject({ userEnv: EnvVarName.optional(), passwordEnv: EnvVarName.optional() });
export const EnvironmentInput = z.object({
  name: z.string().min(1),
  baseUrl: z.url({ protocol: /^https?$/ }),
  authConfig: AuthConfig.default({}),
});
export const Environment = EnvironmentInput.extend({ id: z.uuid(), projectId: z.uuid(), createdAt: z.coerce.date() });
// Pages and their fields (labels, columns, messages) that requirements can name.
export const AppMap = z.object({ pages: z.array(z.object({ name: z.string(), path: z.string(), fields: z.array(z.string()) })) });
export const ProjectInput = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  isSimulated: z.boolean().default(false),
  teamId: z.uuid().nullable().default(null),
  environments: z.array(EnvironmentInput).default([]),
});
export const Project = ProjectInput.extend({
  id: z.uuid(),
  // Per-project model override ("provider:model"); null uses the default from Settings.
  llmModel: z.string().nullable().default(null),
  // Demo mode only (demo-local/models.json): only openai-compatible (local) models may answer.
  localOnly: z.boolean().default(false),
  // Created from demo-local by pnpm demo:seed; listed only when DEMO_MODE=on.
  isDemo: z.boolean().default(false),
  // Pages and fields the engine knows (seeded per project); null when unknown.
  appMap: AppMap.nullable().default(null),
  projectId: z.uuid(),
  createdAt: z.coerce.date(),
  environments: z.array(Environment),
});

export type AuthConfig = z.infer<typeof AuthConfig>;

// Execution policy: an Environment may only name credential env vars the operator allowlisted
// (CREDENTIAL_ENVS, comma-separated). Returns the violation, or null.
export function credentialPolicyViolation(auth: AuthConfig, allowlist: string | undefined): string | null {
  const allowed = (allowlist ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const bad = [auth.userEnv, auth.passwordEnv].filter((n): n is string => !!n && !allowed.includes(n));
  return bad.length ? `env var ${bad.join(", ")} is not in CREDENTIAL_ENVS` : null;
}
export type EnvironmentInput = z.infer<typeof EnvironmentInput>;
export type Environment = z.infer<typeof Environment>;
export type ProjectInput = z.infer<typeof ProjectInput>;
export type Project = z.infer<typeof Project>;

// Runs API
export const QUEUES = { investigate: "run-investigate", validate: "finding-validate", regression: "regression-test-run", githubEvent: "github-event", githubRun: "github-run" } as const;
// github-run: one active job per singletonKey (the target environment), FIFO; never retried, since a retry would trigger a second run.
export const QUEUE_OPTIONS: Partial<Record<string, { policy: string; expireInSeconds: number; retryLimit: number }>> = {
  [QUEUES.githubRun]: { policy: "key_strict_fifo", expireInSeconds: 7200, retryLimit: 0 },
};
export const InvestigateJob = z.object({ runId: z.uuid(), projectId: z.uuid(), missionId: z.uuid() });
// Optional missionId; default is the top-ranked Selection.
export const InvestigateInput = z.object({ missionId: z.uuid().optional() });
export const RunInput = z.object({ environmentId: z.uuid() });
export const RunListQuery = z.object({ mode: RunMode.optional() });
export const Evidence = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  runId: z.uuid(),
  kind: EvidenceKind,
  path: z.string(),
  createdAt: z.coerce.date(),
});
export const Run = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  environmentId: z.uuid(),
  mode: RunMode,
  // null: started by a person; else e.g. "pull request #12" or "release v1.4.0".
  trigger: z.string().nullable(),
  currentStage: Stage,
  createdAt: z.coerce.date(),
  evidence: z.array(Evidence),
});

export type InvestigateJob = z.infer<typeof InvestigateJob>;
export type RunInput = z.infer<typeof RunInput>;
export type InvestigateInput = z.infer<typeof InvestigateInput>;
export type Evidence = z.infer<typeof Evidence>;
export type Run = z.infer<typeof Run>;

// Knowledge base API
// file is a name inside the inputs folder (INPUTS_DIR, no directories).
export const RequirementImport = z.object({ file: z.string().regex(/^[\w.-]+$/).refine((f) => f !== ".." && f !== ".") });
// Requirements assistant. The checker is rule-based (no AI) and runs in every LLM_MODE.
export const CheckStatus = z.enum(["ready", "needs_work", "not_testable"]);
export const CheckRule = z.enum(["too_long", "split", "vague", "observable", "concrete", "source", "out_of_scope", "unknown_page", "duplicate"]);
// level: fix makes the draft Needs work, out_of_scope makes it Not testable here, warn changes nothing.
export const CheckIssue = z.object({
  rule: CheckRule,
  level: z.enum(["fix", "warn", "out_of_scope"]),
  message: z.string(),
  fix: z.string(),
  requirementId: z.uuid().optional(),
});
export const CheckResult = z.object({ status: CheckStatus, issues: z.array(CheckIssue) });
// source is a spec section or "Product-owner decision"; null when the engineer gave none.
// Lengths are capped: the checker runs regexes over this text on every keystroke.
export const RequirementCheckInput = z.object({ text: z.string().max(MAX_TEXT), source: z.string().max(MAX_QUOTE).nullable() });
export const Suggestion = z.object({
  statement: z.string(),
  observedAt: z.object({ page: z.string(), field: z.string() }),
  expected: z.string(),
  edgeCases: z.array(z.string()),
});
export const AssistInput = RequirementCheckInput.extend({
  answers: z.array(z.object({ question: z.string().max(1000), answer: z.string().max(2000) })).max(10).default([]),
});
// Suggestions are proposals: returned to the engineer, never stored until accepted.
export const AssistResult = z.object({
  suggestions: z.array(Suggestion.extend({ check: CheckResult })),
  questions: z.array(z.string()),
  // Suggestions dropped in code because they invented a number or formula.
  dropped: z.array(z.object({ statement: z.string(), reason: z.string() })),
  llmCallKey: z.string(),
});
export const RequirementHistory = z.object({
  draft: z.string(),
  aiSuggestion: Suggestion.nullable(),
  llmCallKey: z.string().nullable(),
  accepted: z.string(),
});
// A manual requirement, saved only by the engineer's click: authoritative + approved.
export const RequirementCreate = z.object({
  text: z.string().trim().min(1).max(MAX_TEXT),
  source: z.string().trim().min(1).max(MAX_QUOTE),
  history: RequirementHistory.omit({ accepted: true }),
});
export const Requirement = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  text: z.string(),
  authority: RequirementAuthority,
  status: RequirementStatus,
  source: RequirementSource.nullable(),
  history: RequirementHistory.nullable(),
  createdAt: z.coerce.date(),
});
export const RequirementWithCheck = Requirement.extend({ check: CheckResult });
export const RequirementImportResult = z.object({
  requirements: z.array(Requirement),
  dropped: z.number().int(),
  llmCallKey: z.string(),
});

export type RequirementImport = z.infer<typeof RequirementImport>;
export type Requirement = z.infer<typeof Requirement>;
export type AppMap = z.infer<typeof AppMap>;
export type CheckStatus = z.infer<typeof CheckStatus>;
export type CheckIssue = z.infer<typeof CheckIssue>;
export type CheckResult = z.infer<typeof CheckResult>;
export type Suggestion = z.infer<typeof Suggestion>;
export type AssistInput = z.infer<typeof AssistInput>;
export type AssistResult = z.infer<typeof AssistResult>;
export type RequirementHistory = z.infer<typeof RequirementHistory>;
export type RequirementWithCheck = z.infer<typeof RequirementWithCheck>;
export type RequirementImportResult = z.infer<typeof RequirementImportResult>;

// Plan and select
export const MissionDetail = z.object({
  goal: z.string(),
  requirementIds: z.array(z.uuid()),
  risk: z.number().int().min(1).max(5),
  steps: z.number().int().min(1),
});
export const Mission = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  runId: z.uuid(),
  title: z.string(),
  detail: MissionDetail,
  createdAt: z.coerce.date(),
});
export const Selection = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  runId: z.uuid(),
  missionId: z.uuid(),
  rank: z.number().int(),
  scores: z.record(z.string(), z.number()),
  createdAt: z.coerce.date(),
});
export const PlanResult = z.object({ missions: z.array(Mission), llmCallKey: z.string() });
export const SelectResult = z.object({ selections: z.array(Selection) });

export type MissionDetail = z.infer<typeof MissionDetail>;
export type Mission = z.infer<typeof Mission>;
export type Selection = z.infer<typeof Selection>;
export type PlanResult = z.infer<typeof PlanResult>;
export type SelectResult = z.infer<typeof SelectResult>;

// Investigate: steps the investigator performs in the browser.
export const BrowserStep = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), path: z.string().startsWith("/") }),
  z.object({ action: z.literal("click"), role: z.enum(["link", "button"]), name: z.string() }),
  z.object({ action: z.literal("fill"), label: z.string(), value: z.string() }),
]);
export const InvestigateResult = z.object({ runId: z.uuid(), missionId: z.uuid(), queued: z.literal(true), jobId: z.string() });

export type BrowserStep = z.infer<typeof BrowserStep>;
export type InvestigateResult = z.infer<typeof InvestigateResult>;

// Judge
export const Finding = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  runId: z.uuid(),
  verdict: Verdict,
  status: FindingStatus,
  title: z.string(),
  evidenceIds: z.array(z.uuid()),
  createdAt: z.coerce.date(),
});
// finding is set only for potential_defect and observational; llmCallKey is null for infra_failure (no AI call).
export const JudgeResult = z.object({
  verdict: Verdict,
  title: z.string(),
  reasoning: z.string(),
  evidenceIds: z.array(z.uuid()),
  finding: Finding.nullable(),
  llmCallKey: z.string().nullable(),
});

export type Finding = z.infer<typeof Finding>;
export type JudgeResult = z.infer<typeof JudgeResult>;

// Validate and Automate
export const ValidateJob = z.object({ projectId: z.uuid(), findingId: z.uuid() });
// environmentId: run against another Environment of the project (e.g. a fixed build); default is the finding's run environment.
// runId: record the result in this run (a suite run); default is the run of the test's finding.
export const RegressionJob = z.object({ projectId: z.uuid(), regressionTestId: z.uuid(), environmentId: z.uuid().optional(), runId: z.uuid().optional() });
export const RegressionRunInput = z.object({ environmentId: z.uuid().optional() });
// A regression check: the element with this role and accessible name must contain the text.
export const TestCheck = z.object({ role: z.enum(["row", "cell", "heading", "status", "link", "button"]), name: z.string(), contains: z.string() });
// RegressionTest.code holds this spec as JSON. The worker interprets it; generated code is never executed.
export const TestSpec = z.object({ steps: z.array(BrowserStep).max(20), checks: z.array(TestCheck).min(1).max(10) });
export const ValidationAttempt = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  findingId: z.uuid(),
  reproduced: z.boolean(),
  evidenceIds: z.array(z.uuid()),
  createdAt: z.coerce.date(),
});
export const RegressionTest = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  findingId: z.uuid().nullable(),
  status: RegressionTestStatus,
  code: z.string(),
  createdAt: z.coerce.date(),
});
export const TestResult = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  regressionTestId: z.uuid(),
  passed: z.boolean(),
  environmentId: z.uuid().nullable(),
  evidenceIds: z.array(z.uuid()),
  createdAt: z.coerce.date(),
});
export const FindingDetail = Finding.extend({
  validationAttempts: z.array(ValidationAttempt),
  regressionTests: z.array(RegressionTest.extend({ results: z.array(TestResult) })),
});
export const Queued = z.object({ id: z.uuid(), queued: z.literal(true), jobId: z.string() });

export type ValidateJob = z.infer<typeof ValidateJob>;
export type RegressionJob = z.infer<typeof RegressionJob>;
export type TestCheck = z.infer<typeof TestCheck>;
export type TestSpec = z.infer<typeof TestSpec>;
export type ValidationAttempt = z.infer<typeof ValidationAttempt>;
export type RegressionTest = z.infer<typeof RegressionTest>;
export type TestResult = z.infer<typeof TestResult>;
export type FindingDetail = z.infer<typeof FindingDetail>;

// UI support
export const StageRecord = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  runId: z.uuid(),
  stage: Stage,
  input: z.unknown(),
  decision: z.unknown(),
  output: z.unknown(),
  createdAt: z.coerce.date(),
});
export const RunDetail = Run.extend({
  stageRecords: z.array(StageRecord),
  missions: z.array(Mission),
  selections: z.array(Selection),
  findings: z.array(Finding),
});
// pg-boss job state; failed jobs carry the error in output.
export const JobStatus = z.object({ id: z.string(), state: z.string(), output: z.unknown() });
export const QueueName = z.enum([QUEUES.investigate, QUEUES.validate, QUEUES.regression]);
export const RequirementReview = z.object({ status: RequirementStatus.optional(), authority: RequirementAuthority.optional() });
export const FindingReview = z.object({ status: z.literal("dismissed") });
export const RegressionTestReview = z.object({ status: z.enum(["promoted", "rejected"]) });

export type StageRecord = z.infer<typeof StageRecord>;
export type RunDetail = z.infer<typeof RunDetail>;
export type JobStatus = z.infer<typeof JobStatus>;

// Model picker. A model id is "provider:model"; the provider is always derived from it.
export const LlmProviderName = z.enum(["anthropic", "openai", "google", "openai-compatible"]);
// Env var that connects each provider (checked in this order for "auto").
export const PROVIDER_ENV = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GEMINI_API_KEY", "openai-compatible": "OLLAMA_BASE_URL" } as const;
export const ModelId = z.string().regex(/^(anthropic|openai|google|openai-compatible):.+$/);
export const ModelSetting = z.union([z.literal("auto"), ModelId]);
export const ModelInfo = z.object({ id: ModelId, vision: z.boolean(), maxInputTokens: z.number().nullable() });
export const ProviderStatus = z.object({
  provider: LlmProviderName,
  envVar: z.string(),
  status: z.enum(["connected", "connected_no_list", "not_connected"]),
  recommended: ModelId.nullable(),
  models: z.array(ModelInfo),
});
export const LlmProviders = z.object({ mode: z.string(), auto: ModelId.nullable(), providers: z.array(ProviderStatus) });
// source "demo-local": demo mode is on and models.json sets the default (Settings keeps its own value).
export const Settings = z.object({ defaultModel: ModelSetting, source: z.enum(["settings", "demo-local"]).default("settings") });
export const ProjectModel = z.object({ llmModel: ModelId.nullable() });

export type LlmProviderName = z.infer<typeof LlmProviderName>;
export type ModelInfo = z.infer<typeof ModelInfo>;
export type ProviderStatus = z.infer<typeof ProviderStatus>;
export type LlmProviders = z.infer<typeof LlmProviders>;
export type Settings = z.infer<typeof Settings>;

export function parseModelId(id: string): { provider: LlmProviderName; model: string } {
  if (!ModelId.safeParse(id).success) throw new Error(`model id must be "provider:model", got "${id}"`);
  const i = id.indexOf(":");
  return { provider: id.slice(0, i) as LlmProviderName, model: id.slice(i + 1) };
}

// GitHub connection. The token is never stored: tokenEnv names the worker env var that holds it
// (GITHUB_*TOKEN only, so a connection cannot point the worker at another secret).
export const GithubEventKind = z.enum(["pull_request", "release"]);
export const GithubConnectionInput = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name"),
  tokenEnv: z.string().regex(/^GITHUB_[A-Z0-9_]*TOKEN$/, "GITHUB_..._TOKEN").default("GITHUB_TOKEN"),
  // Pull-request environment: an existing Environment, or a URL template with {number}.
  prEnvironmentId: z.uuid().nullable().default(null),
  prUrlTemplate: z.string().regex(/^https?:\/\/[^\s]*\{number\}[^\s]*$/, "http(s) URL with {number}").nullable().default(null),
  releaseEnvironmentId: z.uuid().nullable().default(null),
  // Readiness check path on the target environment (default: its base URL).
  healthPath: z.string().startsWith("/").nullable().default(null),
  pollSeconds: z.number().int().min(15).max(3600).default(60),
  onPullRequests: z.boolean().default(true),
  onReleases: z.boolean().default(true),
  prComments: z.boolean().default(false),
  releaseMissions: z.number().int().min(1).max(10).default(3),
});
export const GithubConnection = GithubConnectionInput.extend({
  projectId: z.uuid(),
  lastPollAt: z.coerce.date().nullable(),
  lastError: z.string().nullable(),
});
// ref: PR number or release tag. result: queued | superseded | baseline | running | passed/failed summary | infra_failure | error: ...
export const GithubEvent = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  kind: GithubEventKind,
  ref: z.string(),
  sha: z.string(),
  seenAt: z.coerce.date(),
  runId: z.uuid().nullable(),
  jobId: z.string().nullable(),
  result: z.string(),
});
export const GithubStatus = z.object({ connection: GithubConnection.nullable(), events: z.array(GithubEvent) });
export const GithubEventJob = z.object({ projectId: z.uuid(), kind: GithubEventKind, ref: z.string(), sha: z.string() });
export const GithubRunJob = z.object({ projectId: z.uuid(), eventId: z.uuid() });

export type GithubEventKind = z.infer<typeof GithubEventKind>;
export type GithubConnectionInput = z.infer<typeof GithubConnectionInput>;
export type GithubConnection = z.infer<typeof GithubConnection>;
export type GithubEvent = z.infer<typeof GithubEvent>;
export type GithubStatus = z.infer<typeof GithubStatus>;
export type GithubEventJob = z.infer<typeof GithubEventJob>;
export type GithubRunJob = z.infer<typeof GithubRunJob>;

// Run history label for a run's trigger.
export const triggerLabel = (kind: GithubEventKind, ref: string) => (kind === "pull_request" ? `pull request #${ref}` : `release ${ref}`);

// Private demo profile: files in DEMO_DATA_DIR (default ./demo-local, never committed). Loaded by @qa/core/demo.
// models.json holds model ids only; strict objects reject anything else (an API key goes in .env).
export const DemoDatasetName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes");
export const DemoModels = z
  .strictObject({
    defaultModel: ModelSetting,
    datasets: z.record(DemoDatasetName, z.strictObject({ model: ModelId.optional(), localOnly: z.boolean().default(false) })).default({}),
  })
  .superRefine((m, ctx) => {
    for (const [name, d] of Object.entries(m.datasets)) {
      const model = d.model ?? m.defaultModel;
      if (d.localOnly && !model.startsWith("openai-compatible:")) {
        ctx.addIssue({ code: "custom", path: ["datasets", name, "model"], message: `localOnly needs a local model: set it to "openai-compatible:<model>" (got "${model}")` });
      }
    }
  });
export const DemoStatus = z.object({ on: z.boolean(), dir: z.string() });

export type DemoModels = z.infer<typeof DemoModels>;
export type DemoStatus = z.infer<typeof DemoStatus>;
export const demoProjectName = (dataset: string) => `${dataset} (demo)`;

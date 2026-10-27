import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { MissionDetail, credentialPolicyViolation, type BrowserStep, type EvidenceKind, type InvestigateJob } from "@qa/core";
import { callFields, planSteps } from "@qa/intelligence";
import { modelSetting, schema, type createDb } from "@qa/db";
import { and, eq } from "drizzle-orm";

type Db = ReturnType<typeof createDb>;
// Relative EVIDENCE_DIR resolves against the repo root, not the worker's cwd.
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

type Env = typeof schema.environments.$inferSelect;
type SavedEvidence = { id: string; kind: EvidenceKind; path: string };

export async function runEnvironment(db: Db, projectId: string, runId: string) {
  const [row] = await db
    .select({ env: schema.environments })
    .from(schema.runs)
    .innerJoin(schema.environments, eq(schema.runs.environmentId, schema.environments.id))
    .where(and(eq(schema.runs.id, runId), eq(schema.runs.projectId, projectId)));
  if (!row) throw new Error(`run ${runId} not found`);
  return row.env;
}

export async function projectEnvironment(db: Db, projectId: string, environmentId: string) {
  const [env] = await db
    .select()
    .from(schema.environments)
    .where(and(eq(schema.environments.id, environmentId), eq(schema.environments.projectId, projectId)));
  if (!env) throw new Error(`environment ${environmentId} not found`);
  return env;
}

// Investigate stage: opens the environment, signs in, asks the model for browser steps that carry
// out the Mission, performs them and captures Evidence (see browse). Writes an `investigate`
// StageRecord with the input, the model's steps and the Evidence ids.
export async function investigateRun(db: Db, job: InvestigateJob) {
  const env = await runEnvironment(db, job.projectId, job.runId);
  const [mission] = await db
    .select()
    .from(schema.missions)
    .where(and(eq(schema.missions.id, job.missionId), eq(schema.missions.projectId, job.projectId)));
  if (!mission) throw new Error(`mission ${job.missionId} not found`);
  const { goal } = MissionDetail.parse(mission.detail);

  let plan: Awaited<ReturnType<typeof planSteps>> | undefined;
  const b = await browse(env, job.projectId, job.runId, async (snapshot) => {
    plan = await planSteps(goal, snapshot, await modelSetting(db, job.projectId));
    return plan.steps;
  });
  const evidenceIds = b.saved.map((e) => e.id);
  await db.transaction(async (tx) => {
    await saveEvidence(tx, job.projectId, job.runId, b.saved);
    await tx.insert(schema.stageRecords).values({
      projectId: job.projectId,
      runId: job.runId,
      stage: "investigate",
      input: { missionId: mission.id, goal, baseUrl: env.baseUrl, snapshot: b.snapshot, llmRequest: plan?.call.request ?? null },
      decision: { ...callFields(plan?.call), steps: plan?.steps ?? [] },
      output: { ...b.output, evidenceIds },
    });
    await tx.update(schema.runs).set({ currentStage: "investigate" }).where(eq(schema.runs.id, job.runId));
  });
  return evidenceIds;
}

export async function saveEvidence(tx: Pick<Db, "insert">, projectId: string, runId: string, saved: SavedEvidence[]) {
  if (saved.length) await tx.insert(schema.evidence).values(saved.map((e) => ({ ...e, projectId, runId })));
}

// Opens the environment in a fresh browser, signs in if authConfig names credential env vars,
// performs the steps returned by getSteps (given the signed-in page snapshot), runs `check` on the
// final page, and captures one of each Evidence kind. Files are named by Evidence id under
// EVIDENCE_DIR/<projectId>/<runId>/. An unreachable app or a browser/LLM error is returned as
// output.infraError for the Judge, never thrown.
export async function browse<T>(
  env: Env,
  projectId: string,
  runId: string,
  getSteps: (snapshot: string) => Promise<BrowserStep[]>,
  check?: (page: Page) => Promise<T>,
) {
  const dir = path.resolve(repoRoot, process.env.EVIDENCE_DIR ?? "./data/evidence", projectId, runId);
  await mkdir(dir, { recursive: true });
  const saved: SavedEvidence[] = [];
  // Evidence is kept only if it was written, so a capture that fails after an infra failure is skipped.
  const capture = async (kind: EvidenceKind, ext: string, write: (p: string) => Promise<unknown>) => {
    const id = randomUUID();
    const p = path.join(dir, `${id}.${ext}`);
    try {
      await write(p);
      saved.push({ id, kind, path: p });
    } catch {
      // nothing to keep
    }
  };

  const consoleLog: { type: string; text: string }[] = [];
  const network: { method: string; url: string; status?: number; failure?: string }[] = [];
  let snapshot = "";
  let finalSnapshot = "";
  let finalUrl = "";
  let infraError: string | undefined;
  let checked: T | undefined;
  // Page content is captured only after sign-in finished, so filled credentials never land in Evidence.
  let signedIn = false;
  const results: (BrowserStep & { ok: boolean; error?: string })[] = [];
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("console", (m) => consoleLog.push({ type: m.type(), text: m.text() }));
    page.on("requestfinished", async (r) =>
      network.push({ method: r.method(), url: r.url(), status: (await r.response())?.status() }),
    );
    page.on("requestfailed", (r) => network.push({ method: r.method(), url: r.url(), failure: r.failure()?.errorText }));

    try {
      await page.goto(env.baseUrl);
      const { userEnv, passwordEnv } = env.authConfig;
      // authConfig comes from API callers, so only operator-allowlisted env vars may be read,
      // and only typed into a page on the environment's own origin.
      const violation = credentialPolicyViolation(env.authConfig, process.env.CREDENTIAL_ENVS);
      if (violation) throw new Error(violation);
      const sameOrigin = new URL(page.url()).origin === new URL(env.baseUrl).origin;
      const password = page.locator("input[type=password]").first();
      if (userEnv && passwordEnv && sameOrigin && (await password.count())) {
        // Credentials come from the worker's env only; they are never logged or stored.
        await page.locator("input:not([type=password]):not([type=hidden])").first().fill(process.env[userEnv] ?? "");
        await password.fill(process.env[passwordEnv] ?? "");
        await Promise.all([page.waitForLoadState("load"), password.press("Enter")]);
        await page.waitForLoadState("networkidle");
      }
      // Tracing starts after sign-in: a trace records typed values, so it would otherwise contain the password.
      await context.tracing.start({ screenshots: true, snapshots: true });
      await page.reload();
      signedIn = true;

      snapshot = await page.locator("body").ariaSnapshot();
      for (const step of await getSteps(snapshot)) {
        try {
          await runStep(page, step, env.baseUrl);
          results.push({ ...step, ok: true });
        } catch (err) {
          // A failed step is recorded, not fatal: the Judge decides what it means.
          results.push({ ...step, ok: false, error: (err as Error).message.split("\n")[0] });
        }
      }
      finalSnapshot = await page.locator("body").ariaSnapshot();
      if (check) checked = await check(page);
    } catch (err) {
      // Unreachable app, browser or LLM failure: an infra failure, never a product defect.
      infraError = (err as Error).message.split("\n")[0];
    }

    // Capture what is available, also after an infra failure.
    finalUrl = page.url();
    if (signedIn) {
      await capture("screenshot", "png", (p) => page.screenshot({ path: p, fullPage: true }));
      await capture("dom", "html", async (p) => writeFile(p, await page.content()));
    }
    await capture("console", "json", (p) => writeFile(p, JSON.stringify(consoleLog, null, 2)));
    await capture("network", "json", (p) => writeFile(p, JSON.stringify(network, null, 2)));
    await capture("trace", "zip", (p) => context.tracing.stop({ path: p }));
  } finally {
    await browser.close();
  }

  return {
    saved,
    snapshot,
    checked,
    output: {
      stepResults: results,
      finalUrl,
      finalSnapshot,
      consoleErrors: consoleLog.filter((m) => m.type === "error").map((m) => m.text),
      failedRequests: network.filter((n) => n.failure || (n.status ?? 0) >= 400),
      infraError: infraError ?? null,
    },
  };
}

const STEP_TIMEOUT = 5000;

async function runStep(page: Page, step: BrowserStep, baseUrl: string) {
  if (step.action === "goto") {
    // Resolve against the environment so the model can only navigate within it.
    const url = new URL(step.path, baseUrl);
    if (url.origin !== new URL(baseUrl).origin) throw new Error("goto outside the environment");
    await page.goto(url.href);
    return;
  }
  // Steps come from a model that read page content, so a click must not lead to (and a fill
  // must not type into) a page on another origin.
  const onOrigin = () => {
    if (new URL(page.url()).origin !== new URL(baseUrl).origin) throw new Error("page left the environment");
  };
  onOrigin();
  if (step.action === "click") {
    await Promise.all([page.waitForLoadState("load"), page.getByRole(step.role, { name: step.name }).first().click({ timeout: STEP_TIMEOUT })]);
    onOrigin();
  } else {
    await page.getByLabel(step.label).first().fill(step.value, { timeout: STEP_TIMEOUT });
  }
}

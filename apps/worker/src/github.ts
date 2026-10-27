import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { PORTS, QUEUES, triggerLabel, type GithubEventJob, type GithubRunJob } from "@qa/core";
import { judgeStage, planStage, schema, selectStage, type createDb } from "@qa/db";
import { and, asc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { investigateRun } from "./investigate";
import { runRegressionTest, validateFinding } from "./validate";

// GitHub connection: polls a project's repository for new pull requests and releases, tests the mapped
// environment and reports back with commit statuses. QA Studio never checks out or changes code.
// The token is read from the worker env (connection.tokenEnv) at call time; it is never stored or logged.

type Db = ReturnType<typeof createDb>;
type Boss = Pick<PgBoss, "send" | "cancel">;
type Connection = typeof schema.githubConnections.$inferSelect;
type Event = typeof schema.githubEvents.$inferSelect;

export const STATUS_CONTEXT = { regression: "QA Studio / regression", release: "QA Studio / release" } as const;

async function github<T>(conn: Connection, method: string, path: string, body?: unknown): Promise<T> {
  const token = process.env[conn.tokenEnv];
  if (!token) throw new Error(`${conn.tokenEnv} is not set in the worker env`);
  const res = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${conn.repo}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path.split("?")[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

const Pulls = z.array(z.object({ number: z.number().int(), head: z.object({ sha: z.string() }) }));
const Releases = z.array(z.object({ tag_name: z.string(), draft: z.boolean() }));

// Connections whose poll interval has passed. One poll per tick at most (ticks may overlap a slow poll).
let polling = false;
export async function pollDue(db: Db, boss: Boss) {
  if (polling) return;
  polling = true;
  try {
    const due = await db
      .select()
      .from(schema.githubConnections)
      .where(or(isNull(schema.githubConnections.lastPollAt), lte(sql`${schema.githubConnections.lastPollAt} + make_interval(secs => ${schema.githubConnections.pollSeconds})`, sql`now()`)));
    for (const conn of due) await pollGithub(db, boss, conn);
  } finally {
    polling = false;
  }
}

// Open pull requests and published releases become events. The first poll of a connection only records
// what already exists (result "baseline"), so connecting a repository does not test its whole history.
export async function pollGithub(db: Db, boss: Boss, conn: Connection) {
  const baseline = !conn.lastPollAt;
  let lastError: string | null = null;
  try {
    const pulls = Pulls.parse(await github(conn, "GET", "/pulls?state=open&per_page=100"));
    const releases = Releases.parse(await github(conn, "GET", "/releases?per_page=30")).filter((r) => !r.draft);
    const events: GithubEventJob[] = [
      ...pulls.map((p) => ({ projectId: conn.projectId, kind: "pull_request" as const, ref: String(p.number), sha: p.head.sha })),
      ...releases.map((r) => ({ projectId: conn.projectId, kind: "release" as const, ref: r.tag_name, sha: "" })),
    ];
    for (const e of events) await recordEvent(db, boss, e, baseline);
  } catch (err) {
    lastError = (err as Error).message;
  }
  // lastPollAt stays null until a poll succeeds, so the baseline is never skipped (a failing first poll retries every tick).
  const lastPollAt = baseline && lastError ? null : new Date();
  await db.update(schema.githubConnections).set({ lastPollAt, lastError }).where(eq(schema.githubConnections.projectId, conn.projectId));
}

// Records an event once (unique key: PR number + head SHA, or release tag) and queues its run.
// A newer SHA on the same pull request supersedes the run still queued for an older one.
export async function recordEvent(db: Db, boss: Boss, e: GithubEventJob, baseline = false) {
  const [conn] = await db.select().from(schema.githubConnections).where(eq(schema.githubConnections.projectId, e.projectId));
  if (!conn) return;
  const on = e.kind === "pull_request" ? conn.onPullRequests : conn.onReleases;
  const key = targetKey(conn, e);
  const result = baseline ? "baseline" : !on ? "skipped: trigger off" : !key ? `error: no ${e.kind === "pull_request" ? "pull-request" : "release"} environment mapped` : "queued";
  const [row] = await db.insert(schema.githubEvents).values({ ...e, result }).onConflictDoNothing().returning();
  if (!row || result !== "queued") return row;

  if (e.kind === "pull_request") {
    const older = await db
      .update(schema.githubEvents)
      .set({ result: "superseded" })
      .where(
        and(
          eq(schema.githubEvents.projectId, e.projectId),
          eq(schema.githubEvents.kind, "pull_request"),
          eq(schema.githubEvents.ref, e.ref),
          eq(schema.githubEvents.result, "queued"),
          ne(schema.githubEvents.id, row.id),
        ),
      )
      .returning();
    for (const o of older) if (o.jobId) await boss.cancel(QUEUES.githubRun, o.jobId);
  }
  const job: GithubRunJob = { projectId: e.projectId, eventId: row.id };
  // singletonKey = target environment: one run at a time per environment, the rest wait in order.
  const jobId = await boss.send(QUEUES.githubRun, job, { singletonKey: key! });
  await db.update(schema.githubEvents).set({ jobId }).where(eq(schema.githubEvents.id, row.id));
  return { ...row, jobId };
}

function prUrl(conn: Connection, number: string) {
  return conn.prUrlTemplate?.replaceAll("{number}", number);
}

function targetKey(conn: Connection, e: Pick<Event, "kind" | "ref">) {
  if (e.kind === "release") return conn.releaseEnvironmentId;
  return conn.prEnvironmentId ?? (conn.prUrlTemplate ? `url:${prUrl(conn, e.ref)}` : null);
}

// The Environment to test: the mapped one, or for a URL template one Environment per PR URL
// (sign-in config copied from the release environment, since it is the same app).
async function targetEnvironment(db: Db, conn: Connection, e: Event) {
  const envId = e.kind === "release" ? conn.releaseEnvironmentId : conn.prEnvironmentId;
  if (envId) {
    const [env] = await db.select().from(schema.environments).where(and(eq(schema.environments.id, envId), eq(schema.environments.projectId, conn.projectId)));
    if (env) return env;
  }
  const url = e.kind === "pull_request" && prUrl(conn, e.ref);
  if (!url) throw new Error(`no ${e.kind} environment mapped`);
  const baseUrl = z.url({ protocol: /^https?$/ }).parse(url);
  const [existing] = await db.select().from(schema.environments).where(and(eq(schema.environments.projectId, conn.projectId), eq(schema.environments.baseUrl, baseUrl)));
  if (existing) return existing;
  const [release] = conn.releaseEnvironmentId
    ? await db.select().from(schema.environments).where(eq(schema.environments.id, conn.releaseEnvironmentId))
    : [];
  const [env] = await db
    .insert(schema.environments)
    .values({ projectId: conn.projectId, name: `PR #${e.ref}`, baseUrl, authConfig: release?.authConfig ?? {} })
    .returning();
  return env!;
}

// Readiness: the environment must answer 200 within READY_TIMEOUT_MS (default 10 min).
export async function waitReady(url: string) {
  const timeout = Number(process.env.READY_TIMEOUT_MS ?? 600_000);
  const interval = Number(process.env.READY_INTERVAL_MS ?? 5_000);
  const deadline = Date.now() + timeout;
  for (;;) {
    const ok = await fetch(url, { signal: AbortSignal.timeout(10_000) }).then((r) => r.status === 200, () => false);
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, Math.min(interval, deadline - Date.now())));
  }
}

// Promoted regression suite against one environment, recorded in the suite run. No AI call.
async function runSuite(db: Db, projectId: string, runId: string, environmentId: string) {
  const tests = await db
    .select({ id: schema.regressionTests.id })
    .from(schema.regressionTests)
    .where(and(eq(schema.regressionTests.projectId, projectId), eq(schema.regressionTests.status, "promoted")))
    .orderBy(asc(schema.regressionTests.createdAt));
  const counts = { passed: 0, failed: 0, infra: 0 };
  for (const t of tests) {
    const r = await runRegressionTest(db, { projectId, regressionTestId: t.id, environmentId, runId });
    counts[r.infraError ? "infra" : r.passed ? "passed" : "failed"]++;
  }
  const summary = `${counts.passed} passed, ${counts.failed} failed${counts.infra ? `, ${counts.infra} infrastructure failures` : ""}`;
  return { ...counts, summary, state: counts.failed ? "failure" : counts.infra ? "error" : "success" };
}

// Unattended release check: Plan and Select once, then one release run per top-N mission through
// Investigate, Judge and Validate. Runs after the first get a copy of its missions and their own Select,
// so each run page tells one mission's story. Regression tests are not generated or promoted here.
async function releaseCheck(db: Db, conn: Connection, environmentId: string, trigger: string) {
  const { projectId } = conn;
  const newRun = async () =>
    (await db.insert(schema.runs).values({ projectId, environmentId, mode: "release", trigger }).returning())[0]!;
  const first = await newRun();
  await planStage(db, projectId, first.id);
  const ranking = await selectStage(db, projectId, first.id);
  const missions = await db.select().from(schema.missions).where(eq(schema.missions.runId, first.id));
  const outcomes: { verdict: string; findingStatus: string | null }[] = [];
  for (let i = 0; i < Math.min(conn.releaseMissions, ranking.length); i++) {
    const run = i === 0 ? first : await newRun();
    let selections = ranking;
    if (i > 0) {
      const copies = await db
        .insert(schema.missions)
        .values(missions.map((m) => ({ projectId, runId: run.id, title: m.title, detail: m.detail })))
        .returning();
      await db.insert(schema.stageRecords).values({
        projectId,
        runId: run.id,
        stage: "plan",
        input: { copiedFromRunId: first.id },
        decision: null,
        output: { missionIds: copies.map((m) => m.id) },
      });
      selections = await selectStage(db, projectId, run.id);
    }
    await investigateRun(db, { projectId, runId: run.id, missionId: selections[i]!.missionId });
    const { judgement, finding } = await judgeStage(db, projectId, run.id);
    let findingStatus = finding?.status ?? null;
    if (finding?.verdict === "potential_defect") {
      await validateFinding(db, { projectId, findingId: finding.id });
      const [validated] = await db.select({ status: schema.findings.status }).from(schema.findings).where(eq(schema.findings.id, finding.id));
      findingStatus = validated?.status ?? findingStatus;
    }
    outcomes.push({ verdict: judgement.verdict, findingStatus });
  }
  const confirmed = outcomes.filter((o) => o.findingStatus === "confirmed").length;
  const infra = outcomes.filter((o) => o.verdict === "infra_failure").length;
  const counts = new Map<string, number>();
  for (const o of outcomes) {
    const label = o.findingStatus === "confirmed" ? "confirmed defect" : o.verdict.replace("_", " ");
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const summary = `${outcomes.length} missions: ${[...counts].map(([k, n]) => `${n} ${k}`).join(", ") || "none planned"}`;
  return { summary, state: confirmed ? "failure" : infra ? "error" : "success", runId: first.id };
}

// github-run job: readiness wait, regression suite, and for a release the release check; commit statuses throughout.
export async function runGithubEvent(db: Db, job: GithubRunJob) {
  // Claim the event; a superseded (or already handled) event is skipped.
  const [event] = await db
    .update(schema.githubEvents)
    .set({ result: "running" })
    .where(and(eq(schema.githubEvents.id, job.eventId), eq(schema.githubEvents.projectId, job.projectId), eq(schema.githubEvents.result, "queued")))
    .returning();
  if (!event) return null;
  const [conn] = await db.select().from(schema.githubConnections).where(eq(schema.githubConnections.projectId, job.projectId));
  const setResult = (result: string) => db.update(schema.githubEvents).set({ result }).where(eq(schema.githubEvents.id, event.id));
  if (!conn) return setResult("error: connection removed");

  let sha = event.sha;
  const runLink = (runId: string) => `${process.env.WEB_URL ?? `http://localhost:${PORTS.web}`}/projects/${conn.projectId}/runs/${runId}`;
  // Contexts set to pending and not yet final; an error ends them as "error".
  const contexts: string[] = [STATUS_CONTEXT.regression, ...(event.kind === "release" ? [STATUS_CONTEXT.release] : [])];
  const pending = new Set<string>();
  const status = async (context: string, state: string, description: string, runId: string) => {
    await github(conn, "POST", `/statuses/${sha}`, { state, context, description: description.slice(0, 140), target_url: runLink(runId) });
    if (state === "pending") pending.add(context);
    else pending.delete(context);
  };
  let suiteRunId: string | undefined;
  try {
    if (!sha) {
      sha = (await github<{ sha: string }>(conn, "GET", `/commits/${encodeURIComponent(event.ref)}`)).sha;
      await db.update(schema.githubEvents).set({ sha }).where(eq(schema.githubEvents.id, event.id));
    }
    const env = await targetEnvironment(db, conn, event);
    const trigger = triggerLabel(event.kind, event.ref);
    const [suite] = await db.insert(schema.runs).values({ projectId: conn.projectId, environmentId: env.id, mode: "suite", trigger, currentStage: "automate" }).returning();
    suiteRunId = suite!.id;
    await db.update(schema.githubEvents).set({ runId: suiteRunId }).where(eq(schema.githubEvents.id, event.id));
    for (const c of contexts) await status(c, "pending", "Waiting for the environment", suiteRunId);

    const readyUrl = new URL(conn.healthPath ?? "", env.baseUrl).href;
    if (!(await waitReady(readyUrl))) {
      const infraError = `Environment did not answer 200 at ${readyUrl} in time (infrastructure failure)`;
      await db.insert(schema.stageRecords).values({
        projectId: conn.projectId,
        runId: suiteRunId,
        stage: "automate",
        input: { readyUrl, timeoutMs: Number(process.env.READY_TIMEOUT_MS ?? 600_000) },
        decision: { verdict: "infra_failure" },
        output: { infraError },
      });
      for (const c of contexts) await status(c, "error", "Environment not ready: infrastructure failure", suiteRunId);
      return setResult("infra_failure");
    }

    const suiteResult = await runSuite(db, conn.projectId, suiteRunId, env.id);
    await status(STATUS_CONTEXT.regression, suiteResult.state, `Regression suite: ${suiteResult.summary}`, suiteRunId);
    if (event.kind === "pull_request" && conn.prComments) {
      await github(conn, "POST", `/issues/${event.ref}/comments`, { body: `**QA Studio / regression** on ${sha.slice(0, 7)}: ${suiteResult.summary}. [Results](${runLink(suiteRunId)})` });
    }
    let result = `suite: ${suiteResult.summary}`;
    if (event.kind === "release") {
      const release = await releaseCheck(db, conn, env.id, trigger);
      await status(STATUS_CONTEXT.release, release.state, `Release check: ${release.summary}`, release.runId);
      result += `; release check: ${release.summary}`;
    }
    return setResult(result);
  } catch (err) {
    const message = (err as Error).message;
    console.error(`github event ${event.id}: ${message}`);
    // Statuses are public to anyone who can read the repo: the details stay in the event result and log.
    for (const c of pending) await status(c, "error", "QA Studio error; see the run in QA Studio", suiteRunId!).catch(() => {});
    return setResult(`error: ${message.slice(0, 300)}`);
  }
}

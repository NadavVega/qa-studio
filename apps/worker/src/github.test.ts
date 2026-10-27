import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createDb, schema } from "@qa/db";
import { and, eq, sql } from "drizzle-orm";

// GitHub connection against the real database (docker compose Postgres) with the GitHub API mocked
// at fetch. Browser and AI stages are mocked: this covers detection, dedupe, queueing and statuses.

const { runRegressionTest, investigateRun, validateFinding, planStage, judgeStage } = vi.hoisted(() => ({
  runRegressionTest: vi.fn(),
  investigateRun: vi.fn(),
  validateFinding: vi.fn(),
  planStage: vi.fn(),
  judgeStage: vi.fn(),
}));
vi.mock("./validate", () => ({ runRegressionTest, validateFinding }));
vi.mock("./investigate", () => ({ investigateRun }));
vi.mock("@qa/db", async (orig) => ({ ...(await orig<typeof import("@qa/db")>()), planStage, judgeStage }));

const { pollGithub, runGithubEvent, STATUS_CONTEXT } = await import("./github");

const URL_DB = process.env.DATABASE_URL ?? "postgres://qa:qa@localhost:5433/qa_studio";
const db = createDb(URL_DB);
const dbUp = await db.execute(sql`select 1`).then(
  () => true,
  () => false,
);
const GH = "http://github.test";

// GitHub state the mock serves, and every write it received.
let pulls: { number: number; head: { sha: string } }[] = [];
let releases: { tag_name: string; draft: boolean }[] = [];
let writes: { path: string; body: { state?: string; context?: string; description?: string; body?: string } }[] = [];
const boss = { send: vi.fn(async () => randomUUID()), cancel: vi.fn(async () => ({ jobs: [], requested: 1, affected: 1 })) };

let ready: Server;
let readyUrl = "";
let projectId = "";
let envId = "";

beforeAll(async () => {
  if (!dbUp) return;
  ready = createServer((_req, res) => res.writeHead(200).end("ok")).listen(0);
  await new Promise((r) => ready.once("listening", r));
  readyUrl = `http://127.0.0.1:${(ready.address() as AddressInfo).port}/`;
});
afterAll(() => ready?.close());

beforeEach(async () => {
  if (!dbUp) return;
  pulls = [];
  releases = [];
  writes = [];
  vi.clearAllMocks();
  vi.stubEnv("GITHUB_TEST_TOKEN", "test-token");
  vi.stubEnv("GITHUB_API_URL", GH);
  vi.stubEnv("READY_TIMEOUT_MS", "2000");
  vi.stubEnv("READY_INTERVAL_MS", "100");
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(GH)) return realFetch(input, init);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
    const path = url.slice(GH.length).replace(/^\/repos\/acme\/shop/, "");
    if (init?.method === "POST") {
      writes.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json({}, { status: 201 });
    }
    if (path.startsWith("/pulls")) return Response.json(pulls);
    if (path.startsWith("/releases")) return Response.json(releases);
    if (path.startsWith("/commits/")) return Response.json({ sha: "relsha" });
    return Response.json({ message: "Not Found" }, { status: 404 });
  });
  runRegressionTest.mockResolvedValue({ passed: true, infraError: null });

  const [p] = await db.insert(schema.projects).values({ name: `GitHub test ${randomUUID()}`, isSimulated: true }).returning();
  projectId = p!.id;
  const [env] = await db.insert(schema.environments).values({ projectId, name: "Staging", baseUrl: readyUrl }).returning();
  envId = env!.id;
  // A promoted test so the suite has something to run.
  await db.insert(schema.regressionTests).values({ projectId, status: "promoted", code: "{}" });
  // lastPollAt set: past the baseline poll. pollSeconds is long so a running dev worker leaves it alone.
  await db.insert(schema.githubConnections).values({
    projectId,
    repo: "acme/shop",
    tokenEnv: "GITHUB_TEST_TOKEN",
    prEnvironmentId: envId,
    releaseEnvironmentId: envId,
    pollSeconds: 3600,
    lastPollAt: new Date(),
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (dbUp) await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
});

const conn = async () => (await db.select().from(schema.githubConnections).where(eq(schema.githubConnections.projectId, projectId)))[0]!;
const events = () => db.select().from(schema.githubEvents).where(eq(schema.githubEvents.projectId, projectId));
const runs = (mode: "suite" | "release") => db.select().from(schema.runs).where(and(eq(schema.runs.projectId, projectId), eq(schema.runs.mode, mode)));
const statuses = (context: string) => writes.filter((w) => w.path.startsWith("/statuses/") && w.body.context === context).map((w) => `${w.body.state}: ${w.body.description}`);

describe.skipIf(!dbUp)("github connection", () => {
  test("a new PR triggers one suite run with a pending then final status", async () => {
    pulls = [{ number: 12, head: { sha: "aaa" } }];
    await pollGithub(db, boss, await conn());
    const [event] = await events();
    expect(event).toMatchObject({ kind: "pull_request", ref: "12", sha: "aaa", result: "queued" });
    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith("github-run", { projectId, eventId: event!.id }, { singletonKey: envId });

    await runGithubEvent(db, { projectId, eventId: event!.id });
    const suite = await runs("suite");
    expect(suite).toHaveLength(1);
    expect(suite[0]!.trigger).toBe("pull request #12");
    expect(runRegressionTest).toHaveBeenCalledWith(db, expect.objectContaining({ environmentId: envId, runId: suite[0]!.id }));
    expect(statuses(STATUS_CONTEXT.regression)).toEqual(["pending: Waiting for the environment", "success: Regression suite: 1 passed, 0 failed"]);
    expect(writes.every((w) => w.path === "/statuses/aaa")).toBe(true); // PR comments are off by default
    expect((await events())[0]).toMatchObject({ runId: suite[0]!.id, result: "suite: 1 passed, 0 failed" });
    expect(await runs("release")).toHaveLength(0);
  });

  test("the same event never triggers twice", async () => {
    pulls = [{ number: 12, head: { sha: "aaa" } }];
    await pollGithub(db, boss, await conn());
    await pollGithub(db, boss, await conn());
    const [event] = await events();
    await runGithubEvent(db, { projectId, eventId: event!.id });
    await runGithubEvent(db, { projectId, eventId: event!.id });
    expect(await events()).toHaveLength(1);
    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(await runs("suite")).toHaveLength(1);
  });

  test("a new SHA on the same PR cancels the queued run for the older one", async () => {
    pulls = [{ number: 12, head: { sha: "aaa" } }];
    await pollGithub(db, boss, await conn());
    pulls = [{ number: 12, head: { sha: "bbb" } }];
    await pollGithub(db, boss, await conn());
    const all = await events();
    const old = all.find((e) => e.sha === "aaa")!;
    const fresh = all.find((e) => e.sha === "bbb")!;
    expect(old.result).toBe("superseded");
    expect(boss.cancel).toHaveBeenCalledWith("github-run", old.jobId);
    expect(fresh.result).toBe("queued");
    // If the cancelled job still reached the worker, it is skipped.
    expect(await runGithubEvent(db, { projectId, eventId: old.id })).toBeNull();
    await runGithubEvent(db, { projectId, eventId: fresh.id });
    expect(await runs("suite")).toHaveLength(1);
    expect(writes.every((w) => w.path === "/statuses/bbb")).toBe(true);
  });

  test("a release triggers the suite plus 3 release-mode runs", async () => {
    releases = [{ tag_name: "v1.4.0", draft: false }, { tag_name: "v1.5.0-draft", draft: true }];
    planStage.mockImplementation(async (d: typeof db, pid: string, runId: string) => {
      const missions = await d
        .insert(schema.missions)
        .values(["A", "B", "C", "D"].map((t, i) => ({ projectId: pid, runId, title: `Mission ${t}`, detail: { goal: t, requirementIds: [], risk: 5 - i, steps: 3 } })))
        .returning();
      return { missions, call: { key: "k" } };
    });
    judgeStage.mockResolvedValue({ judgement: { verdict: "correct" }, finding: null, call: undefined });

    await pollGithub(db, boss, await conn());
    const [event] = await events();
    expect(event).toMatchObject({ kind: "release", ref: "v1.4.0", sha: "" });
    await runGithubEvent(db, { projectId, eventId: event!.id });

    expect(await runs("suite")).toHaveLength(1);
    const release = await runs("release");
    expect(release).toHaveLength(3);
    expect(release.every((r) => r.trigger === "release v1.4.0")).toBe(true);
    expect(planStage).toHaveBeenCalledTimes(1);
    // Each release run investigates a different mission, in ranking order.
    const investigated = await Promise.all(
      investigateRun.mock.calls.map(async ([, job]) => (await db.select().from(schema.missions).where(eq(schema.missions.id, job.missionId)))[0]!.title),
    );
    expect(investigated).toEqual(["Mission A", "Mission B", "Mission C"]);
    expect(judgeStage).toHaveBeenCalledTimes(3);
    expect(statuses(STATUS_CONTEXT.regression).at(-1)).toBe("success: Regression suite: 1 passed, 0 failed");
    expect(statuses(STATUS_CONTEXT.release)).toEqual(["pending: Waiting for the environment", "success: Release check: 3 missions: 3 correct"]);
    expect(writes.every((w) => w.path === "/statuses/relsha")).toBe(true);
    // A regression test is never promoted (or generated) by the release check.
    const tests = await db.select().from(schema.regressionTests).where(eq(schema.regressionTests.projectId, projectId));
    expect(tests).toHaveLength(1);
  });

  test("an environment that never answers ends as an infrastructure failure", async () => {
    await db.update(schema.environments).set({ baseUrl: "http://127.0.0.1:9/" }).where(eq(schema.environments.id, envId));
    vi.stubEnv("READY_TIMEOUT_MS", "300");
    pulls = [{ number: 7, head: { sha: "ccc" } }];
    await pollGithub(db, boss, await conn());
    const [event] = await events();
    await runGithubEvent(db, { projectId, eventId: event!.id });
    expect((await events())[0]!.result).toBe("infra_failure");
    expect(statuses(STATUS_CONTEXT.regression)).toEqual(["pending: Waiting for the environment", "error: Environment not ready: infrastructure failure"]);
    expect(runRegressionTest).not.toHaveBeenCalled();
    const [suite] = await runs("suite");
    const [record] = await db.select().from(schema.stageRecords).where(eq(schema.stageRecords.runId, suite!.id));
    expect(record).toMatchObject({ stage: "automate", decision: { verdict: "infra_failure" } });
  });

  test("the first successful poll records existing events without triggering", async () => {
    await db.update(schema.githubConnections).set({ lastPollAt: null }).where(eq(schema.githubConnections.projectId, projectId));
    pulls = [{ number: 3, head: { sha: "ddd" } }];
    releases = [{ tag_name: "v1.0.0", draft: false }];
    // A failing first poll (token not set) keeps the next one a baseline.
    vi.stubEnv("GITHUB_TEST_TOKEN", "");
    await pollGithub(db, boss, await conn());
    expect(await conn()).toMatchObject({ lastPollAt: null, lastError: "GITHUB_TEST_TOKEN is not set in the worker env" });
    vi.stubEnv("GITHUB_TEST_TOKEN", "test-token");
    await pollGithub(db, boss, await conn());
    expect((await conn()).lastError).toBeNull();
    expect((await events()).map((e) => e.result)).toEqual(["baseline", "baseline"]);
    expect(boss.send).not.toHaveBeenCalled();
  });
});

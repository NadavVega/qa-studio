import { createHmac, randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createDb, schema } from "@qa/db";
import { eq, sql } from "drizzle-orm";
import { githubRoutes } from "./github";

// Webhook: signature check, then the event goes to the same queue the poller feeds.
const db = createDb(process.env.DATABASE_URL ?? "postgres://qa:qa@localhost:5433/qa_studio");
const dbUp = await db.execute(sql`select 1`).then(
  () => true,
  () => false,
);
const send = vi.fn(async () => randomUUID());
const app = Fastify();
githubRoutes(app, db, { send } as unknown as PgBoss);
let projectId = "";

beforeAll(async () => {
  if (!dbUp) return;
  const [p] = await db.insert(schema.projects).values({ name: `Webhook test ${randomUUID()}` }).returning();
  projectId = p!.id;
  await db.insert(schema.githubConnections).values({ projectId, repo: "acme/webhook-test", tokenEnv: "GITHUB_TEST_TOKEN", pollSeconds: 3600, lastPollAt: new Date() });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (dbUp) await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
});

const deliver = (event: string, payload: object, secret = "s3cret") => {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return app.inject({ method: "POST", url: "/github/webhook", headers: { "content-type": "application/json", "x-github-event": event, "x-hub-signature-256": signature }, payload: body });
};
const pr = { action: "synchronize", number: 5, pull_request: { head: { sha: "abc" } }, repository: { full_name: "Acme/Webhook-Test" } };

describe.skipIf(!dbUp)("github webhook", () => {
  test("is off without GITHUB_WEBHOOK_SECRET", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
    expect((await deliver("pull_request", pr)).statusCode).toBe(503);
  });

  test("rejects a bad signature and queues a verified pull request event", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "s3cret");
    expect((await deliver("pull_request", pr, "wrong")).statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
    const res = await deliver("pull_request", pr);
    expect(res.json()).toEqual({ queued: 1 });
    expect(send).toHaveBeenCalledWith("github-event", { projectId, kind: "pull_request", ref: "5", sha: "abc" });
    expect((await deliver("pull_request", { ...pr, action: "closed" })).json()).toEqual({ ignored: true });
    expect((await deliver("ping", { zen: "hi" })).statusCode).toBe(200);
  });

  test("PUT rejects a token env var that is not GITHUB_*TOKEN", async () => {
    const res = await app.inject({ method: "PUT", url: `/projects/${projectId}/github`, payload: { repo: "acme/webhook-test", tokenEnv: "DATABASE_URL" } });
    expect(res.statusCode).toBe(400);
  });
});

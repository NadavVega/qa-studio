import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { GithubConnectionInput, GithubStatus, QUEUES, type GithubEventJob } from "@qa/core";
import { schema, type createDb } from "@qa/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

type Db = ReturnType<typeof createDb>;

const ProjectParams = z.object({ id: z.uuid() });

// Webhook payloads: only the fields used. Other events and actions are acknowledged and ignored.
const PullRequestPayload = z.object({
  action: z.string(),
  number: z.number().int(),
  pull_request: z.object({ head: z.object({ sha: z.string() }) }),
  repository: z.object({ full_name: z.string() }),
});
const ReleasePayload = z.object({
  action: z.string(),
  release: z.object({ tag_name: z.string(), draft: z.boolean() }),
  repository: z.object({ full_name: z.string() }),
});

// X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(secret, raw body).
export function validSignature(secret: string, body: Buffer, header: string | undefined) {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function githubRoutes(app: FastifyInstance, db: Db, boss: PgBoss) {
  // Connection status, settings and the last 50 events.
  app.get("/projects/:id/github", async (req, reply) => {
    const params = ProjectParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    const [connection] = await db.select().from(schema.githubConnections).where(eq(schema.githubConnections.projectId, params.data.id));
    const events = await db
      .select()
      .from(schema.githubEvents)
      .where(eq(schema.githubEvents.projectId, params.data.id))
      .orderBy(desc(schema.githubEvents.seenAt))
      .limit(50);
    return GithubStatus.parse({ connection: connection ?? null, events });
  });

  // Create or update the connection. Mapped environments must belong to the project.
  app.put("/projects/:id/github", async (req, reply) => {
    const params = ProjectParams.safeParse(req.params);
    const body = GithubConnectionInput.safeParse(req.body);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    if (!body.success) return reply.code(400).send({ error: z.treeifyError(body.error) });
    const projectId = params.data.id;
    const [project] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId));
    if (!project) return reply.code(404).send({ error: "project not found" });
    const envIds = [body.data.prEnvironmentId, body.data.releaseEnvironmentId].filter((e): e is string => !!e);
    const found = envIds.length
      ? await db
          .select({ id: schema.environments.id })
          .from(schema.environments)
          .where(and(inArray(schema.environments.id, envIds), eq(schema.environments.projectId, projectId)))
      : [];
    if (found.length !== new Set(envIds).size) return reply.code(404).send({ error: "environment not found in project" });
    await db
      .insert(schema.githubConnections)
      .values({ projectId, ...body.data })
      // A changed repository starts over with a baseline poll.
      .onConflictDoUpdate({
        target: schema.githubConnections.projectId,
        set: { ...body.data, lastPollAt: sql`case when ${schema.githubConnections.repo} = ${body.data.repo} then ${schema.githubConnections.lastPollAt} end` },
      });
    const [connection] = await db.select().from(schema.githubConnections).where(eq(schema.githubConnections.projectId, projectId));
    return GithubStatus.shape.connection.parse(connection);
  });

  // Webhook for teams that can expose QA Studio: verified with GITHUB_WEBHOOK_SECRET, then fed to the
  // same queue the poller uses. Needs the raw body for the signature, so JSON is parsed here.
  app.register(async (hook) => {
    hook.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    hook.post("/github/webhook", async (req, reply) => {
      const secret = process.env.GITHUB_WEBHOOK_SECRET;
      if (!secret) return reply.code(503).send({ error: "webhook not configured (GITHUB_WEBHOOK_SECRET)" });
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !validSignature(secret, raw, req.headers["x-hub-signature-256"] as string | undefined)) {
        return reply.code(401).send({ error: "invalid signature" });
      }
      const payload: unknown = JSON.parse(raw.toString("utf8"));
      const kind = req.headers["x-github-event"];
      let event: Omit<GithubEventJob, "projectId"> & { repo: string };
      const pr = kind === "pull_request" ? PullRequestPayload.safeParse(payload) : null;
      const rel = kind === "release" ? ReleasePayload.safeParse(payload) : null;
      if (pr?.success && ["opened", "reopened", "synchronize"].includes(pr.data.action)) {
        event = { kind: "pull_request", ref: String(pr.data.number), sha: pr.data.pull_request.head.sha, repo: pr.data.repository.full_name };
      } else if (rel?.success && rel.data.action === "published" && !rel.data.release.draft) {
        event = { kind: "release", ref: rel.data.release.tag_name, sha: "", repo: rel.data.repository.full_name };
      } else {
        return reply.code(200).send({ ignored: true });
      }
      const connections = await db
        .select({ projectId: schema.githubConnections.projectId })
        .from(schema.githubConnections)
        .where(sql`lower(${schema.githubConnections.repo}) = lower(${event.repo})`);
      for (const c of connections) {
        const job: GithubEventJob = { projectId: c.projectId, kind: event.kind, ref: event.ref, sha: event.sha };
        await boss.send(QUEUES.githubEvent, job);
      }
      return reply.code(202).send({ queued: connections.length });
    });
  });
}

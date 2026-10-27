import Fastify from "fastify";
import { PgBoss } from "pg-boss";
import { PORTS, QUEUE_OPTIONS, QUEUES, type HealthResponse } from "@qa/core";
import { createDb } from "@qa/db";
import { projectRoutes } from "./projects";
import { runRoutes } from "./runs";
import { requirementRoutes } from "./requirements";
import { planRoutes } from "./plan";
import { judgeRoutes } from "./judge";
import { findingRoutes } from "./findings";
import { llmRoutes } from "./llm";
import { githubRoutes } from "./github";
import { refreshProviders } from "@qa/intelligence";
import { errorHandler } from "./errors";

const app = Fastify({ logger: true });
app.setErrorHandler(errorHandler);
const db = createDb(process.env.DATABASE_URL!);
const boss = new PgBoss(process.env.DATABASE_URL!);
boss.on("error", (err) => app.log.error(err, "pg-boss"));
await boss.start();
for (const q of Object.values(QUEUES)) await boss.createQueue(q, QUEUE_OPTIONS[q]);

app.get("/health", async (): Promise<HealthResponse> => ({ status: "ok", service: "api" }));
projectRoutes(app, db);
runRoutes(app, db, boss);
requirementRoutes(app, db);
planRoutes(app, db);
judgeRoutes(app, db);
findingRoutes(app, db, boss);
llmRoutes(app, db);
githubRoutes(app, db, boss);

// Provider detection at startup (env vars, then each provider's list-models call).
await refreshProviders();

await app.listen({ port: PORTS.api, host: "0.0.0.0" });

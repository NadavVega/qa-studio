import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DemoStatus, LlmProviders, ProviderStatus, Settings } from "@qa/core";
import { demoDataDir, demoMode, loadDemoModels } from "@qa/core/demo";
import path from "node:path";
import { schema, type createDb } from "@qa/db";
import { autoModel, providerStatuses, refreshProviders } from "@qa/intelligence";
import { eq } from "drizzle-orm";

type Db = ReturnType<typeof createDb>;

// Statuses only: which env var connects a provider and whether it is set. Keys never leave the process.
const providers = async (statuses: Promise<ProviderStatus[]>) => {
  const list = await statuses;
  return LlmProviders.parse({ mode: process.env.LLM_MODE ?? "live", auto: autoModel(list), providers: list });
};

export function llmRoutes(app: FastifyInstance, db: Db) {
  app.get("/llm/providers", () => providers(providerStatuses()));
  app.post("/llm/refresh", () => providers(refreshProviders()));

  app.get("/demo", () => DemoStatus.parse({ on: demoMode(), dir: path.basename(demoDataDir()) }));

  app.get("/settings", async () => {
    if (demoMode()) return Settings.parse({ defaultModel: loadDemoModels().defaultModel, source: "demo-local" });
    const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, "defaultModel"));
    return Settings.parse({ defaultModel: row?.value ?? "auto" });
  });
  app.put("/settings", async (req, reply) => {
    const body = Settings.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: z.treeifyError(body.error) });
    if (demoMode()) return reply.code(409).send({ error: "set in demo-local/models.json while demo mode is on" });
    const value = body.data.defaultModel;
    await db.insert(schema.settings).values({ key: "defaultModel", value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
    return Settings.parse({ defaultModel: value });
  });
}

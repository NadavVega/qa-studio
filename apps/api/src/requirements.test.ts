import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PROVIDER_ENV, Suggestion, type AppMap } from "@qa/core";
import { schema, type createDb } from "@qa/db";
import { refreshProviders } from "@qa/intelligence";
import { requirementRoutes } from "./requirements";

const PROJECT = "00000000-0000-4000-8000-0000000000aa";
const appMap: AppMap = { pages: [{ name: "Orders", path: "/orders", fields: ["Order ID", "Total"] }] };

// Minimal stand-in for drizzle: selects answer from fixed rows; every write is recorded.
function fakeDb() {
  const rows = new Map<unknown, unknown[]>([[schema.projects, [{ id: PROJECT, appMap, llmModel: null }]]]);
  const writes: { op: string; values?: Record<string, unknown> }[] = [];
  const chain = (result: unknown[]): unknown => {
    const c = {
      from: (table: unknown) => chain(rows.get(table) ?? []),
      where: () => c,
      orderBy: () => c,
      then: (ok: (v: unknown[]) => unknown, fail: (e: unknown) => unknown) => Promise.resolve(result).then(ok, fail),
    };
    return c;
  };
  const db = {
    select: () => chain([]),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        writes.push({ op: "insert", values });
        return { returning: async () => [{ id: "00000000-0000-4000-8000-0000000000bb", createdAt: new Date(), ...values }] };
      },
    }),
    update: () => (writes.push({ op: "update" }), { set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    delete: () => (writes.push({ op: "delete" }), { where: async () => [] }),
  };
  return { db: db as unknown as ReturnType<typeof createDb>, writes };
}

const aiAnswer = {
  suggestions: [
    { statement: "The Total column shows a whole-number unit count for each order", observedAt: { page: "Orders", field: "Total" }, expected: "whole-number unit count", edgeCases: ["order with no lines"] },
    { statement: "The Total column is within 5% of last year", observedAt: { page: "Orders", field: "Total" }, expected: "within 5%", edgeCases: [] },
  ],
  questions: ["Which value should the Total column be compared with?"],
};

beforeEach(async () => {
  for (const e of Object.values(PROVIDER_ENV)) vi.stubEnv(e, "");
  vi.stubEnv("LLM_MODE", "live");
  vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.test");
  vi.stubEnv("LLM_FIXTURE_DIR", await mkdtemp(path.join(tmpdir(), "qa-assist-")));
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    url.endsWith("/models")
      ? Response.json({ data: [{ id: "llama3.2" }] })
      : Response.json({ choices: [{ message: { content: JSON.stringify(aiAnswer) } }] })));
  await refreshProviders();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("AI suggestions are never stored until the engineer accepts one", async () => {
  const { db, writes } = fakeDb();
  const app = Fastify();
  requirementRoutes(app, db);
  const draft = { text: "Sales numbers should be correct", source: "Product-owner decision" };

  const assist = await app.inject({ method: "POST", url: `/projects/${PROJECT}/requirements/assist`, payload: draft });
  expect(assist.statusCode).toBe(200);
  const result = assist.json();
  expect(result.suggestions).toHaveLength(1);
  expect(result.suggestions[0].check.status).toBe("ready");
  expect(result.dropped).toEqual([{ statement: aiAnswer.suggestions[1]!.statement, reason: "invented number 5" }]);
  expect(result.questions).toEqual(aiAnswer.questions);
  expect(writes).toEqual([]);

  const aiSuggestion = Suggestion.parse(result.suggestions[0]); // drops the check, as the UI sends it
  const accept = await app.inject({
    method: "POST",
    url: `/projects/${PROJECT}/requirements`,
    payload: { text: aiSuggestion.statement, source: draft.source, history: { draft: draft.text, aiSuggestion, llmCallKey: result.llmCallKey } },
  });
  expect(accept.statusCode).toBe(201);
  expect(writes).toHaveLength(1);
  expect(accept.json()).toMatchObject({
    authority: "authoritative",
    status: "approved",
    source: { file: "Product-owner decision", location: "manual entry", quote: draft.text },
    history: { draft: draft.text, aiSuggestion, accepted: aiSuggestion.statement },
  });
});

test("replay mode explains that suggestions need a live model and stores nothing", async () => {
  vi.stubEnv("LLM_MODE", "replay");
  const { db, writes } = fakeDb();
  const app = Fastify();
  requirementRoutes(app, db);
  const res = await app.inject({ method: "POST", url: `/projects/${PROJECT}/requirements/assist`, payload: { text: "x", source: null } });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toContain("live model");
  const check = await app.inject({ method: "POST", url: `/projects/${PROJECT}/requirements/check`, payload: { text: "Sales numbers should be correct", source: null } });
  expect(check.json().status).toBe("needs_work");
  expect(writes).toEqual([]);
});

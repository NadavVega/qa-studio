import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { PROVIDER_ENV, parseModelId } from "@qa/core";
import { callJson, NO_VISION, ProviderError } from "./llm";
import { providerStatuses, refreshProviders, resolveModel } from "./providers";

const ENVS = Object.values(PROVIDER_ENV);
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

// Mocked list-models endpoints, one per provider; returns null for anything else.
function listResponse(url: string) {
  if (url.startsWith("https://api.anthropic.com/v1/models")) return json({ data: [{ id: "claude-sonnet-5-5", max_input_tokens: 1000000, capabilities: { image_input: { supported: true } } }] });
  if (url === "https://api.openai.com/v1/models") return json({ data: [{ id: "gpt-5" }, { id: "text-embedding-3-small" }] });
  if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models?")) return json({ models: [{ name: "models/gemini-2.5-pro", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent"] }] });
  if (url === "http://ollama.test/v1/models") return json({ data: [{ id: "llama3.2:latest" }, { id: "llava:7b" }] });
  return null;
}

beforeEach(() => {
  for (const e of ENVS) vi.stubEnv(e, "");
  vi.stubEnv("LLM_MODE", "live");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("model ids are provider:model; the model part may contain colons", () => {
  expect(parseModelId("anthropic:claude-sonnet-5-5")).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
  expect(parseModelId("openai-compatible:llama3.2:latest")).toEqual({ provider: "openai-compatible", model: "llama3.2:latest" });
  for (const bad of ["claude-sonnet-5-5", "mistral:large", "openai:", "auto"]) expect(() => parseModelId(bad)).toThrow();
});

test("a provider is connected exactly when its env var is set (every combination)", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => listResponse(url) ?? new Response("", { status: 404 })));
  for (let mask = 0; mask < 1 << ENVS.length; mask++) {
    ENVS.forEach((e, i) => vi.stubEnv(e, mask & (1 << i) ? (e === "OLLAMA_BASE_URL" ? "http://ollama.test" : "k") : ""));
    const statuses = await refreshProviders();
    const connected = statuses.filter((s) => s.status === "connected").map((s) => s.envVar);
    expect(connected).toEqual(ENVS.filter((_, i) => mask & (1 << i)));
    expect(statuses.filter((s) => s.status === "not_connected").every((s) => s.models.length === 0 && !s.recommended)).toBe(true);
  }
});

test("detection lists models with capabilities and auto picks the first connected provider", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => listResponse(url)!));
  vi.stubEnv("OPENAI_API_KEY", "k");
  vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.test/");
  const statuses = await refreshProviders();
  expect(statuses.find((s) => s.provider === "openai")!.models.map((m) => m.id)).toEqual(["openai:gpt-5"]);
  expect(statuses.find((s) => s.provider === "openai-compatible")!.models).toEqual([
    { id: "openai-compatible:llama3.2:latest", vision: false, maxInputTokens: null },
    { id: "openai-compatible:llava:7b", vision: true, maxInputTokens: null },
  ]);
  expect((await resolveModel("auto")).id).toBe("openai:gpt-5");
  await expect(resolveModel("anthropic:claude-sonnet-5-5")).rejects.toThrow("set ANTHROPIC_API_KEY");
});

test("a failed list-models call falls back to a static list, marked unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
  vi.stubEnv("GEMINI_API_KEY", "k");
  const google = (await refreshProviders()).find((s) => s.provider === "google")!;
  expect(google.status).toBe("connected_no_list");
  expect(google.models.length).toBeGreaterThan(0);
  expect(google.recommended).toBe("google:gemini-2.5-pro");
});

test("no provider connected: live calls fail with the env vars to set", async () => {
  await refreshProviders();
  await expect(resolveModel("auto")).rejects.toThrow("ANTHROPIC_API_KEY");
});

test("a text-only model gets no screenshots and the call records why; invalid JSON is retried once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "qa-llm-"));
  vi.stubEnv("LLM_FIXTURE_DIR", dir);
  vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.test");
  const shot = path.join(dir, "shot.png");
  await writeFile(shot, "png");
  const bodies: { messages: { content: unknown }[] }[] = [];
  const answers = ["not json", JSON.stringify({ ok: true }), JSON.stringify({ ok: true })];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const list = listResponse(url);
    if (list) return list;
    bodies.push(JSON.parse(init!.body as string));
    return json({ choices: [{ message: { content: answers.shift() } }] });
  }));
  await refreshProviders();
  const images = [{ evidenceId: "e-shot", path: shot }];
  const Ok = z.object({ ok: z.boolean() });

  const text = await callJson("sys", "judge this", Ok, { model: "openai-compatible:llama3.2:latest", images });
  expect(text.call).toMatchObject({ provider: "openai-compatible", model: "llama3.2:latest", note: NO_VISION, request: { images: [] } });
  expect(bodies).toHaveLength(2); // invalid JSON, then the retry
  expect(JSON.stringify(bodies[1]!.messages[1]!.content)).not.toContain("image_url");

  const vision = await callJson("sys", "judge this too", Ok, { model: "openai-compatible:llava:7b", images });
  expect(vision.call.note).toBeUndefined();
  expect(vision.call.request).toMatchObject({ images: ["e-shot"] });
  expect(JSON.stringify(bodies[2]!.messages[1]!.content)).toContain("data:image/png;base64,");
});

test("replay needs no provider and ignores the model setting", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "qa-llm-"));
  vi.stubEnv("LLM_FIXTURE_DIR", dir);
  vi.stubEnv("LLM_MODE", "record");
  vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.test");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => listResponse(url) ?? json({ choices: [{ message: { content: '{"ok":true}' } }] })));
  await refreshProviders();
  await callJson("sys", "u", z.object({ ok: z.boolean() }), { model: "openai-compatible:llama3.2:latest" });

  for (const e of ENVS) vi.stubEnv(e, "");
  vi.stubEnv("LLM_MODE", "replay");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in replay"); }));
  const { data, call } = await callJson("sys", "u", z.object({ ok: z.boolean() }), { model: "anthropic:claude-opus-5-5" });
  expect(data).toEqual({ ok: true });
  expect(call).toMatchObject({ provider: "replay", model: "llama3.2:latest" });
});

test("a provider's HTTP error surfaces as ProviderError with its message", async () => {
  vi.stubEnv("LLM_FIXTURE_DIR", await mkdtemp(path.join(tmpdir(), "qa-llm-")));
  vi.stubEnv("LLM_MODE", "record");
  vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.test");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => listResponse(url) ?? new Response("402 Payment Required", { status: 402 })));
  await refreshProviders();
  const err = await callJson("sys", "u", z.object({ ok: z.boolean() }), { model: "openai-compatible:llama3.2:latest" }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect((err as Error).message).toContain("402 Payment Required");
});

test("providerStatuses is cached until refreshed", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => listResponse(url)!));
  vi.stubEnv("OPENAI_API_KEY", "k");
  const first = await refreshProviders();
  vi.stubEnv("OPENAI_API_KEY", "");
  expect(await providerStatuses()).toBe(first);
  expect((await refreshProviders()).find((s) => s.provider === "openai")!.status).toBe("not_connected");
});

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { parseModelId } from "@qa/core";
import { demoMode, demoRecordingsDir } from "@qa/core/demo";
import { ADAPTERS, resolveModel } from "./providers";

// Every AI call goes through here. The full request and response are stored as a
// recording so the call can be replayed (LLM_MODE=replay) and audited. Recordings are never committed:
// demo mode records into demo-local/recordings, otherwise data/recordings; replay reads both.
const LOCAL = fileURLToPath(new URL("../../../data/recordings/", import.meta.url));
const fixtureDirs = () =>
  process.env.LLM_FIXTURE_DIR ? [process.env.LLM_FIXTURE_DIR] : demoMode() ? [demoRecordingsDir(), LOCAL] : [LOCAL, demoRecordingsDir()];

export interface LlmCall {
  key: string;
  // Who answered: "replay" when the response came from a recording.
  provider: string;
  model: string;
  request: unknown;
  response: unknown;
  note?: string;
}

// A screenshot to send with the prompt (vision models only).
export interface LlmImage { evidenceId: string; path: string }

export const NO_VISION = "screenshots not sent: model has no vision";

// Any failure of an AI call (provider HTTP error, no provider, missing recording, bad JSON). Its message is
// meant for the engineer, so the API returns it in error bodies; other 5xx errors stay generic.
export class ProviderError extends Error {
  override name = "ProviderError";
}

export async function callJson<T>(
  system: string,
  user: string,
  schema: z.ZodType<T>,
  opts: { model?: string; images?: LlmImage[] } = {},
): Promise<{ data: T; call: LlmCall }> {
  return call(system, user, schema, opts).catch((err: unknown) => {
    throw err instanceof ProviderError ? err : new ProviderError(err instanceof Error ? err.message : String(err), { cause: err });
  });
}

async function call<T>(system: string, user: string, schema: z.ZodType<T>, opts: { model?: string; images?: LlmImage[] }): Promise<{ data: T; call: LlmCall }> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete jsonSchema.$schema;
  // Model and images are left out of the key so a recording survives a model change.
  const key = createHash("sha256").update(JSON.stringify({ system, user })).digest("hex").slice(0, 16);
  const [writeDir, ...fallbacks] = fixtureDirs();
  const file = path.join(writeDir!, `${key}.json`);

  // Replay ignores the model setting and needs no provider.
  if ((process.env.LLM_MODE ?? "live") === "replay") {
    let text = await readFile(file, "utf8").catch(() => null);
    for (const dir of fallbacks) text ??= await readFile(path.join(dir, `${key}.json`), "utf8").catch(() => null);
    if (text === null) throw new Error(`no recording for LLM call ${key} in ${fixtureDirs().join(" or ")}`);
    const fixture = JSON.parse(text) as { model?: string; response: unknown };
    const request = { system, user, schema: jsonSchema, images: (opts.images ?? []).map((i) => i.evidenceId) };
    return { data: schema.parse(fixture.response), call: { key, provider: "replay", model: fixture.model ?? "recorded", request, response: fixture.response } };
  }

  const model = await resolveModel(opts.model);
  const { provider, model: name } = parseModelId(model.id);
  const images = model.vision ? (opts.images ?? []) : [];
  const note = opts.images?.length && !model.vision ? NO_VISION : undefined;
  const approxTokens = Math.ceil((system.length + user.length) / 4);
  if (model.maxInputTokens && approxTokens > model.maxInputTokens) {
    throw new Error(`prompt (~${approxTokens} tokens) is over ${model.id} max input of ${model.maxInputTokens}`);
  }
  const request = { model: model.id, system, user, schema: jsonSchema, images: images.map((i) => i.evidenceId) };
  const loaded = await Promise.all(images.map(async (i) => ({ mediaType: "image/png", data: (await readFile(i.path)).toString("base64") })));

  // One retry when the model returns JSON that does not parse or match the schema.
  let response: unknown;
  for (let attempt = 1; ; attempt++) {
    const text = await ADAPTERS[provider].complete({ model: name, system, user, schema: jsonSchema, images: loaded });
    try {
      response = JSON.parse(text);
      schema.parse(response);
      break;
    } catch (err) {
      if (attempt === 2) throw new Error(`${model.id} returned invalid JSON twice: ${err instanceof Error ? err.message : err}`);
    }
  }
  // live and record both store the call; record is the explicit "refresh fixtures" mode.
  await mkdir(writeDir!, { recursive: true });
  await writeFile(file, JSON.stringify({ provider, model: name, request, response }, null, 2));
  return { data: schema.parse(response), call: { key, provider, model: name, request, response, ...(note && { note }) } };
}

// The AI-call fields every StageRecord decision carries.
export const callFields = (call: LlmCall | undefined) => ({
  llmCallKey: call?.key ?? null,
  llmResponse: call?.response ?? null,
  llmProvider: call?.provider ?? null,
  llmModel: call?.model ?? null,
  ...(call?.note && { llmNote: call.note }),
});

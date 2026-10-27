import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { LlmProviderName, PROVIDER_ENV, parseModelId, type ModelInfo, type ProviderStatus } from "@qa/core";

export interface Image { mediaType: string; data: string } // data is base64
export interface CompleteRequest { model: string; system: string; user: string; schema: Record<string, unknown>; images: Image[] }

// One adapter per provider. complete() returns the model's raw JSON text; callJson parses and
// validates it with the caller's zod schema. Keys are read from env here and go nowhere else.
export interface LlmProvider {
  listModels(): Promise<ModelInfo[]>;
  complete(req: CompleteRequest): Promise<string>;
}

const TIMEOUT = 5000;

async function getJson<T>(url: string, headers: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return schema.parse(await res.json());
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

// ponytail: name heuristic where the list endpoint reports no capabilities; a wrong guess only
// decides whether screenshots are sent. Replace with per-provider metadata if it misleads.
const VISION = /claude|gpt-4o|gpt-4\.1|gpt-5|^o[134]|gemini|llava|vision|[-.]vl|vl[:-]|gemma3(?!:(270m|1b))|moondream|minicpm-v/i;
const info = (id: string, vision = VISION.test(id), maxInputTokens: number | null = null): ModelInfo => ({ id, vision, maxInputTokens });

const AnthropicModels = z.object({
  data: z.array(z.object({ id: z.string(), max_input_tokens: z.number().nullish(), capabilities: z.object({ image_input: z.object({ supported: z.boolean() }) }).nullish() })),
});

const anthropic: LlmProvider = {
  async listModels() {
    const { data } = await getJson("https://api.anthropic.com/v1/models?limit=100", { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" }, AnthropicModels);
    return data.map((m) => info(`anthropic:${m.id}`, m.capabilities?.image_input.supported ?? true, m.max_input_tokens ?? null));
  },
  async complete({ model, system, user, schema, images }) {
    const msg = await new Anthropic().messages.create({
      model,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: [...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mediaType as "image/png", data: i.data } })), { type: "text" as const, text: user }] }],
      output_config: { format: { type: "json_schema", schema } },
    });
    if (msg.stop_reason !== "end_turn") throw new Error(`LLM stopped with ${msg.stop_reason}`);
    const text = msg.content.find((b) => b.type === "text");
    return text?.type === "text" ? text.text : "";
  },
};

const OpenAiModels = z.object({ data: z.array(z.object({ id: z.string() })) });
const ChatCompletion = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1) });

// Ollama's grammar builder rejects regex "pattern" and non-standard "format" (zod's startsWith); the
// answer is still checked against the zod schema. String values only, so a property named "format" stays.
const noPatterns = (schema: Record<string, unknown>) =>
  JSON.parse(JSON.stringify(schema, (k, v) => ((k === "pattern" || k === "format") && typeof v === "string" ? undefined : v))) as Record<string, unknown>;

// OpenAI and any OpenAI-compatible server (Ollama, LM Studio, vLLM) share the chat completions API.
function openAiLike(provider: "openai" | "openai-compatible", baseUrl: () => string, key: () => string | undefined): LlmProvider {
  const auth = (): Record<string, string> => (key() ? { authorization: `Bearer ${key()}` } : {});
  return {
    async listModels() {
      const { data } = await getJson(`${baseUrl()}/models`, auth(), OpenAiModels);
      // OpenAI also lists embedding, audio and image models; keep chat models only.
      const chat = provider === "openai" ? data.filter((m) => /^(gpt-|o\d|chatgpt)/.test(m.id) && !/audio|realtime|transcribe|tts|image|search/.test(m.id)) : data;
      return chat.map((m) => info(`${provider}:${m.id}`));
    },
    async complete({ model, system, user, schema, images }) {
      const content = [{ type: "text", text: user }, ...images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mediaType};base64,${i.data}` } }))];
      const res = ChatCompletion.parse(
        await postJson(`${baseUrl()}/chat/completions`, auth(), {
          model,
          messages: [{ role: "system", content: system }, { role: "user", content }],
          response_format: { type: "json_schema", json_schema: { name: "result", schema: provider === "openai-compatible" ? noPatterns(schema) : schema } },
        }),
      );
      return res.choices[0]!.message.content ?? "";
    },
  };
}

const GeminiModels = z.object({
  models: z.array(z.object({ name: z.string(), inputTokenLimit: z.number().optional(), supportedGenerationMethods: z.array(z.string()).default([]) })),
});
const GeminiResponse = z.object({ candidates: z.array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional() })) }) })).min(1) });
const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
// Key in a header, not the URL, so it cannot end up in an error message or log.
const geminiAuth = () => ({ "x-goog-api-key": process.env.GEMINI_API_KEY! });

const google: LlmProvider = {
  async listModels() {
    const { models } = await getJson(`${GEMINI}/models?pageSize=1000`, geminiAuth(), GeminiModels);
    return models
      .filter((m) => m.supportedGenerationMethods.includes("generateContent"))
      .map((m) => info(`google:${m.name.replace(/^models\//, "")}`, /gemini/.test(m.name), m.inputTokenLimit ?? null));
  },
  async complete({ model, system, user, schema, images }) {
    const res = GeminiResponse.parse(
      await postJson(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, geminiAuth(), {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }, ...images.map((i) => ({ inlineData: { mimeType: i.mediaType, data: i.data } }))] }],
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema },
      }),
    );
    return res.candidates[0]!.content.parts.map((p) => p.text ?? "").join("");
  },
};

const ollamaBase = () => `${process.env.OLLAMA_BASE_URL!.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`;

export const ADAPTERS: Record<LlmProviderName, LlmProvider> = {
  anthropic,
  openai: openAiLike("openai", () => "https://api.openai.com/v1", () => process.env.OPENAI_API_KEY),
  google,
  "openai-compatible": openAiLike("openai-compatible", ollamaBase, () => undefined),
};

// Used when a connected provider's list-models call fails.
const STATIC: Record<LlmProviderName, ModelInfo[]> = {
  anthropic: [info("anthropic:claude-sonnet-5-5", true), info("anthropic:claude-opus-5-5", true), info("anthropic:claude-haiku-5-5", true)],
  openai: [info("openai:gpt-5"), info("openai:gpt-5-mini")],
  google: [info("google:gemini-2.5-pro", true, 1048576), info("google:gemini-2.5-flash", true, 1048576)],
  "openai-compatible": [info("openai-compatible:llama3.2")],
};
// "auto" uses the first connected provider's recommended model (its first listed model if absent).
const RECOMMENDED: Record<LlmProviderName, string> = {
  anthropic: "anthropic:claude-sonnet-5-5",
  openai: "openai:gpt-5",
  google: "google:gemini-2.5-pro",
  "openai-compatible": "openai-compatible:llama3.2",
};

async function detect(): Promise<ProviderStatus[]> {
  return Promise.all(
    LlmProviderName.options.map(async (provider): Promise<ProviderStatus> => {
      const envVar = PROVIDER_ENV[provider];
      if (!process.env[envVar]) return { provider, envVar, status: "not_connected", recommended: null, models: [] };
      let models: ModelInfo[];
      let status: ProviderStatus["status"] = "connected";
      try {
        models = await ADAPTERS[provider].listModels();
      } catch {
        models = STATIC[provider];
        status = "connected_no_list";
      }
      const recommended = models.find((m) => m.id === RECOMMENDED[provider])?.id ?? models[0]?.id ?? RECOMMENDED[provider];
      return { provider, envVar, status, recommended, models };
    }),
  );
}

// Detected once per process (API startup, or the worker's first live call); POST /llm/refresh re-detects.
let detected: Promise<ProviderStatus[]> | undefined;
export const providerStatuses = () => (detected ??= detect());
export const refreshProviders = () => (detected = detect());

export const autoModel = (statuses: ProviderStatus[]) => statuses.find((s) => s.status !== "not_connected")?.recommended ?? null;

// Turns a model setting ("auto" or "provider:model") into the model to call, with its capabilities.
export async function resolveModel(setting: string | undefined): Promise<ModelInfo> {
  const statuses = await providerStatuses();
  const id = !setting || setting === "auto" ? autoModel(statuses) : setting;
  if (!id) throw new Error(`No LLM provider connected: set one of ${Object.values(PROVIDER_ENV).join(", ")}`);
  const s = statuses.find((x) => x.provider === parseModelId(id).provider)!;
  if (s.status === "not_connected") throw new Error(`${id}: provider not connected; set ${s.envVar}`);
  // A model the list does not know is treated as text-only.
  return s.models.find((m) => m.id === id) ?? info(id, false);
}

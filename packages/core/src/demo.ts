import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { DemoModels } from "./index";

// Node-only loader for the private demo profile (import from "@qa/core/demo"). Every file is
// validated; on an error nothing is loaded and the message names the file, the field and the fix.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export const demoMode = () => process.env.DEMO_MODE === "on";
export const demoDataDir = () => path.resolve(ROOT, process.env.DEMO_DATA_DIR || "demo-local");
export const demoRecordingsDir = () => path.join(demoDataDir(), "recordings");

export class DemoFileError extends Error {}

export function loadDemoFile<T>(file: string, schema: z.ZodType<T>, parse: (text: string) => unknown): T {
  const rel = path.relative(ROOT, file);
  if (!existsSync(file)) throw new DemoFileError(`${rel}: missing. Fix: create it (see demo-local.example/).`);
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new DemoFileError(`${rel}: not valid JSON (${(e as Error).message}). Fix: correct the syntax.`);
  }
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const lines = r.error.issues.map((i) => {
    const field = i.path.join(".") || "(file)";
    const fix = i.code === "unrecognized_keys" ? `remove ${i.keys.join(", ")} (only the documented fields are allowed; API keys go in .env)` : i.message;
    return `${rel} · ${field}: ${i.code === "unrecognized_keys" ? "unknown field" : "invalid"}. Fix: ${fix}`;
  });
  throw new DemoFileError(lines.join("\n"));
}

export const loadDemoModels = () => loadDemoFile(path.join(demoDataDir(), "models.json"), DemoModels, JSON.parse);

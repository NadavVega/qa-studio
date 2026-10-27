import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { DemoFileError, loadDemoModels } from "./demo";

async function profile(models: unknown) {
  const dir = await mkdtemp(path.join(tmpdir(), "qa-demo-"));
  await writeFile(path.join(dir, "models.json"), JSON.stringify(models));
  vi.stubEnv("DEMO_DATA_DIR", dir);
}

test("valid models.json loads", async () => {
  await profile({ defaultModel: "auto", datasets: { d1: { model: "openai-compatible:m", localOnly: true } } });
  expect(loadDemoModels().datasets.d1).toEqual({ model: "openai-compatible:m", localOnly: true });
});

test("a key in models.json is refused with file, field and fix", async () => {
  await profile({ defaultModel: "auto", apiKey: "sk-x" });
  expect(loadDemoModels).toThrow(DemoFileError);
  expect(loadDemoModels).toThrow(/models\.json · \(file\): unknown field\. Fix: remove apiKey/);
});

test("localOnly needs a local model", async () => {
  await profile({ defaultModel: "anthropic:claude-sonnet-5-5", datasets: { d1: { localOnly: true } } });
  expect(loadDemoModels).toThrow(/datasets\.d1\.model: invalid\. Fix: localOnly needs a local model/);
});

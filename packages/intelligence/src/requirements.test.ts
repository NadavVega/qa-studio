import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { MAX_QUOTE, MAX_TEXT, PROVIDER_ENV, Requirement } from "@qa/core";
import { checkRequirement } from "./checker";
import { refreshProviders } from "./providers";
import { extractRequirements, locate } from "./requirements";

test("locate finds the quote's line and rejects unknown quotes", () => {
  const doc = "# Spec\nTotal must equal the sum.\n";
  expect(locate("a.md", doc, "Total must equal")).toEqual({ file: "a.md", location: "line 2", quote: "Total must equal" });
  expect(locate("a.md", doc, "made up")).toBeNull();
  expect(locate("a.md", doc, "  ")).toBeNull();
});

test("over-long extracted requirements are kept: quote cut with …, flagged Needs work: too long", async () => {
  const longLine = `The Total column must equal the sum of ${"Jan, ".repeat(150)}and Jun.`; // > MAX_QUOTE
  const longText = `The Total column shows ${"1255 ".repeat(450)}`; // > MAX_TEXT
  const answer = { requirements: [{ text: longText, quote: longLine }, { text: "The Total column equals the sum of the six months", quote: "sum of Jan" }] };
  for (const e of Object.values(PROVIDER_ENV)) vi.stubEnv(e, "");
  vi.stubEnv("LLM_MODE", "live");
  vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.test");
  vi.stubEnv("LLM_FIXTURE_DIR", await mkdtemp(path.join(tmpdir(), "qa-long-")));
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    url.endsWith("/models") ? Response.json({ data: [{ id: "llama3.2" }] }) : Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }] })));
  await refreshProviders();
  try {
    const { requirements, dropped } = await extractRequirements("spec.md", `# Spec\n${longLine}\n`);
    expect(dropped).toBe(0);
    const [long, short] = requirements;
    expect(long!.text.length).toBeGreaterThan(MAX_TEXT);
    expect(long!.source).toMatchObject({ file: "spec.md", location: "line 2", truncated: true });
    expect(long!.source.quote).toHaveLength(MAX_QUOTE);
    expect(long!.source.quote.endsWith("…")).toBe(true);
    // What the import stores and returns still parses (no length caps on stored requirements).
    expect(() => Requirement.parse({ ...long, id: crypto.randomUUID(), projectId: crypto.randomUUID(), authority: "observed", status: "needs_review", history: null, createdAt: new Date() })).not.toThrow();

    const ctx = { appMap: null, existing: [] };
    const ref = (s: typeof long) => ({ source: `${s!.source.file}, ${s!.source.location}`, quoteTruncated: s!.source.truncated });
    const flagged = checkRequirement({ text: long!.text, ...ref(long) }, ctx);
    expect(flagged.status).toBe("needs_work");
    expect(flagged.issues[0]).toMatchObject({ rule: "too_long", message: expect.stringMatching(/^Too long/) });
    // Quote cut alone (statement within limits) is flagged too.
    expect(checkRequirement({ text: short!.text, source: "spec.md, line 2", quoteTruncated: true }, ctx).issues.map((i) => i.rule)).toContain("too_long");
    expect(checkRequirement({ text: short!.text, ...ref(short) }, ctx).issues.map((i) => i.rule)).not.toContain("too_long");
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});

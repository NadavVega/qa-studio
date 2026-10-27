import { z } from "zod";
import { MAX_QUOTE, type RequirementSource } from "@qa/core";
import { callJson, type LlmCall } from "./llm";

const Extracted = z.object({
  requirements: z.array(z.object({ text: z.string(), quote: z.string() })),
});

const SYSTEM = `You extract testable requirements from product documentation.
Return one entry per distinct, testable behavior. "text" is a short requirement statement.
"quote" is copied verbatim from a single line of the document and supports the requirement.
Do not invent behavior that the document does not state.`;

// Finds the quote in the file. Quotes that cannot be found are dropped: an AI
// statement without a real source is not a requirement.
export function locate(file: string, content: string, quote: string): RequirementSource | null {
  const lines = content.split("\n");
  const i = lines.findIndex((l) => l.includes(quote.trim()));
  const q = quote.trim();
  if (i === -1 || !q) return null;
  // Long quotes are cut for storage; the line reference keeps the full text findable.
  return q.length > MAX_QUOTE ? { file, location: `line ${i + 1}`, quote: `${q.slice(0, MAX_QUOTE - 1)}…`, truncated: true } : { file, location: `line ${i + 1}`, quote: q };
}

export async function extractRequirements(file: string, content: string, model?: string) {
  const { data, call } = await callJson(SYSTEM, `File: ${file}\n\n${content}`, Extracted, { model });
  const requirements = data.requirements.flatMap((r) => {
    const source = locate(file, content, r.quote);
    return source ? [{ text: r.text, source }] : [];
  });
  return { requirements, dropped: data.requirements.length - requirements.length, call: call satisfies LlmCall };
}

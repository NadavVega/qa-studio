import { z } from "zod";
import { Suggestion, type AppMap, type AssistInput, type CheckResult } from "@qa/core";
import { checkRequirement } from "./checker";
import { callJson } from "./llm";

const Output = z.object({ suggestions: z.array(Suggestion), questions: z.array(z.string()) });

const SYSTEM = `You help a QA engineer turn a draft requirement into requirements a browser-based test can check.
Return up to 3 suggestions. Each is one atomic rule ("statement"), where it is observed (a page and field from the app map),
the expected value or rule ("expected"), and edge cases. Return up to 3 clarifying questions when the draft is ambiguous.
Hard rules:
- Never invent numbers, thresholds, formulas, units or orders that are not in the draft, the answers or the sources.
- Anything unknown becomes a question, not a guess. A draft with an unknown formula or threshold gets a question and no suggestion that states one.
- Use only page and field names from the app map; if none fits, ask where it is seen.
- One rule per statement. No vague words (correct, properly, fast, user-friendly, as expected).`;

// Formula words a suggestion may only use when the draft, answers or sources already do.
const FORMULA = /(=|×|÷|\bsum\b|\bdivided\b|\bmultiplied\b|\bminus\b|\bplus\b|\bratio\b|\baverage\b|\bpercent(age)?\b|%|\bformula\b|\babsolute\b|\bweighted\b)/gi;
const numbers = (s: string): string[] => s.match(/\d+(?:[.,]\d+)?/g) ?? [];

// Code-side guard for the prompt's hard rule: a number or formula word not in the allowed text drops the suggestion.
export function invented(s: Suggestion, allowed: string): string | null {
  const text = [s.statement, s.expected, ...s.edgeCases].join(" ");
  const num = numbers(text).find((n) => !numbers(allowed).includes(n));
  if (num) return `invented number ${num}`;
  const lower = allowed.toLowerCase();
  const word = text.match(FORMULA)?.find((w) => !lower.includes(w.toLowerCase()));
  return word ? `invented formula ("${word}")` : null;
}

export interface AssistContext {
  appMap: AppMap | null;
  existing: { id: string; text: string }[];
  // Source quotes from uploaded files: the only other place numbers may come from.
  sources: string[];
}

export async function assistRequirement(input: AssistInput, check: CheckResult, ctx: AssistContext, model?: string) {
  const pages = ctx.appMap?.pages.map((p) => `- ${p.name} (${p.path}): ${p.fields.join(", ")}`).join("\n") ?? "(no app map)";
  const user = [
    `Draft: ${input.text}`,
    `Source: ${input.source ?? "(none)"}`,
    `Checker: ${check.status}\n${check.issues.map((i) => `- ${i.message} ${i.fix}`).join("\n") || "- no issues"}`,
    `App map pages and fields:\n${pages}`,
    `Existing requirements:\n${ctx.existing.map((r) => `- ${r.text}`).join("\n") || "(none)"}`,
    `Uploaded source quotes:\n${ctx.sources.map((q) => `- ${q}`).join("\n") || "(none)"}`,
    input.answers.length ? `Answers from the engineer:\n${input.answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const { data, call } = await callJson(SYSTEM, user, Output, { model });

  const allowed = [input.text, input.source ?? "", ...input.answers.map((a) => a.answer), ...ctx.sources].join("\n");
  const dropped: { statement: string; reason: string }[] = [];
  const suggestions = data.suggestions.slice(0, 3).map((s) => ({ ...s, edgeCases: s.edgeCases.filter((e) => e.trim()) })).flatMap((s) => {
    const reason = invented(s, allowed);
    if (reason) return dropped.push({ statement: s.statement, reason }), [];
    // Every suggestion goes through the checker before it is shown.
    return [{ ...s, check: checkRequirement({ text: s.statement, source: input.source }, ctx) }];
  });
  const questions = data.questions.map((q) => q.trim()).filter(Boolean).slice(0, 3);
  // A dropped suggestion means something was unknown: make sure the engineer is asked.
  if (dropped.length && !questions.length) questions.push("Which exact value, threshold or formula should apply? It is not in the draft or the sources.");
  return { suggestions, questions, dropped, llmCallKey: call.key };
}

import { MAX_TEXT, type AppMap, type CheckIssue, type CheckResult } from "@qa/core";
import { CLAUSE_STARTS, CONCRETE, OUT_OF_SCOPE, STOPWORDS, UI_NOUNS, VAGUE } from "./vocabulary";

// Rule-based requirement checker: no AI, same answer in every LLM_MODE.
export interface CheckContext {
  appMap: AppMap | null;
  existing: { id: string; text: string }[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phrase = (p: string) => new RegExp(`(?<![\\w-])${escape(p)}(?![\\w-])`, "i");
const found = (text: string, list: string[]) => list.filter((p) => phrase(p).test(text));

const QUOTED = /["“][^"”]{2,}["”]/;
const NAME_PATTERNS = [
  QUOTED,
  /\b[A-Z][\w&-]*(?:\s+[A-Z][\w&-]*)+/, // Title Case phrase: "Actual Sales"
  /(?<=[a-z,]\s)[A-Z][\w-]+/, // capitalized word mid-sentence: "the Total column"
  /\b[A-Z]{2,}\b/, // acronym: VAT
  /\b[a-z]+(?:_[a-z0-9]+)+\b|\b[a-z]+[A-Z]\w*\b/, // API field: actual_sales, actualSales
];

function names(text: string, appMap: AppMap | null): boolean {
  const mapNames = appMap?.pages.flatMap((p) => [p.name, ...p.fields]) ?? [];
  return NAME_PATTERNS.some((r) => r.test(text)) || found(text, [...mapNames, ...UI_NOUNS]).length > 0;
}

function compound(text: string): boolean {
  const modals = text.match(/\b(must|shall|should)\b/gi)?.length ?? 0;
  const andClause = new RegExp(`\\band\\s+(${CLAUSE_STARTS.join("|")})\\b`, "i");
  return text.includes(";") || /\balso\b/i.test(text) || modals > 1 || andClause.test(text) || /[.!?]\s+\S/.test(text.trim());
}

// Pages named as "<Title Case> page|screen|tab" that the app map does not list.
function unknownPages(text: string, appMap: AppMap): string[] {
  const known = appMap.pages.map((p) => p.name.toLowerCase());
  return [...text.matchAll(/((?:[A-Z][\w&-]*\s+){0,5}[A-Z][\w&-]*)\s+(?:page|screen|tab)\b/g)]
    .map((m) => m[1]!)
    .filter((n) => !known.some((k) => n.toLowerCase().endsWith(k))); // "The Orders" ends with a known page
}

const tokens = (text: string) => new Set(text.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w && !STOPWORDS.includes(w)));

// ponytail: word-set Jaccard; catches rewordings that keep the words, not paraphrases.
export function similarity(a: string, b: string): number {
  const [x, y] = [tokens(a), tokens(b)];
  const both = [...x].filter((w) => y.has(w)).length;
  return x.size + y.size === 0 ? 0 : both / (x.size + y.size - both);
}
export const DUPLICATE_AT = 0.75;

// quoteTruncated: an extracted requirement whose source quote was cut (see locate).
export function checkRequirement(draft: { text: string; source: string | null; quoteTruncated?: boolean }, ctx: CheckContext): CheckResult {
  const text = draft.text.trim();
  const issues: CheckIssue[] = [];
  const add = (issue: CheckIssue) => issues.push(issue);
  const richest = ctx.appMap?.pages.reduce((a, b) => (b.fields.length > a.fields.length ? b : a));
  const example = richest ? `, e.g. a field on the ${richest.name} page` : ", e.g. a column or message on a named page";

  if (text.length > MAX_TEXT || draft.quoteTruncated) {
    add({ rule: "too_long", level: "fix", message: `Too long${draft.quoteTruncated ? ": source quote was cut, full text is at the source line" : `: over ${MAX_TEXT} characters`}.`, fix: "Split it into short atomic requirements." });
  }
  for (const { pattern, reason } of OUT_OF_SCOPE) {
    if (pattern.test(text)) add({ rule: "out_of_scope", level: "out_of_scope", message: reason, fix: "Keep it outside QA Studio, or rewrite it as something one user can see in the browser." });
  }
  if (compound(text)) add({ rule: "split", level: "fix", message: "Several rules in one statement.", fix: "Split it: one rule per requirement, one \"must\" each." });
  const vague = found(text, VAGUE);
  if (vague.length) add({ rule: "vague", level: "fix", message: `Vague: ${vague.map((v) => `"${v}"`).join(", ")}.`, fix: "Replace with the exact value, rule or behavior a tester can check." });
  if (!names(text, ctx.appMap)) add({ rule: "observable", level: "fix", message: "Nothing observable: no page, field, column, value or API field is named.", fix: `Say where it is seen${example}.` });
  if (!/\d|[$€£%]/.test(text) && !QUOTED.test(text) && found(text, CONCRETE).length === 0) {
    add({ rule: "concrete", level: "fix", message: "No concrete value, unit, formula, order or edge case.", fix: "Add one: an exact value, a unit, a formula, a sort order, or what happens when empty, zero or negative." });
  }
  if (!draft.source?.trim()) add({ rule: "source", level: "fix", message: "No source.", fix: "Name the spec section (file and heading) or write \"Product-owner decision\"." });
  for (const page of ctx.appMap ? unknownPages(text, ctx.appMap) : []) {
    add({ rule: "unknown_page", level: "warn", message: `"${page}" is not a page in the app map.`, fix: "Check the page name, or refresh the app map if the app changed." });
  }
  const dup = ctx.existing.map((r) => ({ ...r, score: similarity(text, r.text) })).filter((r) => r.score >= DUPLICATE_AT).sort((a, b) => b.score - a.score)[0];
  if (dup) add({ rule: "duplicate", level: "warn", message: `Near-duplicate of "${dup.text}".`, fix: "Edit or keep the existing requirement instead of adding this one.", requirementId: dup.id });

  const status = issues.some((i) => i.level === "out_of_scope") ? "not_testable" : issues.some((i) => i.level === "fix") ? "needs_work" : "ready";
  return { status, issues };
}

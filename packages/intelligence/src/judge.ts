import { z } from "zod";
import { EvidenceKind, type RequirementAuthority, type RequirementStatus, type Verdict } from "@qa/core";
import { callJson } from "./llm";

// infra_failure is never the model's call: it is set from the investigate record (see judgeInfra).
const Judged = z.object({
  verdict: z.enum(["correct", "observational", "inconclusive", "potential_defect"]),
  title: z.string(),
  reasoning: z.string(),
  evidence: z.array(EvidenceKind),
});

const SYSTEM = `You judge the result of one QA investigation of a web application.
You get the Mission goal, the requirements it checks, the browser steps performed (with errors),
the accessibility snapshot of the final page, console errors and failed requests.
Pick one verdict:
- "correct": the behavior matches the requirements.
- "potential_defect": the evidence shows behavior that contradicts a requirement.
- "observational": notable behavior no requirement clearly covers (worth a human look, not a defect).
- "inconclusive": the evidence is not enough to decide (e.g. steps failed, page not reached).
"title" is one short line. "reasoning" explains the verdict with concrete values from the evidence.
"evidence" lists the evidence kinds that support it (screenshot, dom, console, network, trace).
The final page snapshot is the "dom" evidence.`;

export interface JudgeInput {
  goal: string;
  requirements: string[];
  stepResults: unknown[];
  finalSnapshot: string;
  consoleErrors: string[];
  failedRequests: unknown[];
}

export interface Judgement {
  verdict: Verdict;
  title: string;
  reasoning: string;
  evidenceIds: string[];
}

type SavedEvidence = { id: string; kind: EvidenceKind; path?: string };

// Evidence is cited by kind (one of each per investigation), not by id, so the prompt and its
// replay fixture stay the same across runs. Kinds are mapped back to real Evidence ids here.
export function citeEvidence(j: z.infer<typeof Judged>, evidence: SavedEvidence[]): Judgement {
  const evidenceIds = evidence.filter((e) => j.evidence.includes(e.kind)).map((e) => e.id);
  // A conclusion that cites no real Evidence is not a conclusion.
  if (!evidenceIds.length) {
    return { verdict: "inconclusive", title: j.title, reasoning: `${j.reasoning}\n(Downgraded: no real Evidence cited.)`, evidenceIds: [] };
  }
  return { verdict: j.verdict, title: j.title, reasoning: j.reasoning, evidenceIds };
}

// A potential defect needs an approved, authoritative requirement behind it. Against AI-observed
// requirements only, the same behavior is recorded as observational for a person to review.
export function authorityGuard(j: Judgement, requirements: { authority: RequirementAuthority; status: RequirementStatus }[]): Judgement {
  if (j.verdict !== "potential_defect") return j;
  if (requirements.some((r) => r.authority === "authoritative" && r.status === "approved")) return j;
  return { ...j, verdict: "observational", reasoning: `${j.reasoning}\n(Authority guard: no approved authoritative requirement, so this is observational until a person approves one.)` };
}

export function judgeInfra(error: string, evidence: SavedEvidence[]): Judgement {
  return {
    verdict: "infra_failure",
    title: "Investigation could not run",
    reasoning: error,
    evidenceIds: evidence.map((e) => e.id),
  };
}

// Sorted keys: step results come back from jsonb with reordered keys, and the prompt (so its
// replay fixture) must not depend on where they were read from.
const stable = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x), 2);

// Screenshots go to vision models only; callJson drops them for others and notes it on the call.
export async function judgeInvestigation(input: JudgeInput, evidence: SavedEvidence[], model?: string) {
  const user = [
    `Mission goal: ${input.goal}`,
    `Requirements:\n${input.requirements.map((r) => `- ${r}`).join("\n")}`,
    `Steps performed:\n${stable(input.stepResults)}`,
    `Final page snapshot (dom):\n${input.finalSnapshot}`,
    `Console errors: ${JSON.stringify(input.consoleErrors)}`,
    `Failed requests: ${stable(input.failedRequests)}`,
  ].join("\n\n");
  const images = evidence.flatMap((e) => (e.kind === "screenshot" && e.path ? [{ evidenceId: e.id, path: e.path }] : []));
  const { data, call } = await callJson(SYSTEM, user, Judged, { model, images });
  return { judgement: citeEvidence(data, evidence), call };
}

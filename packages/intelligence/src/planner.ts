import { z } from "zod";
import type { MissionDetail, RequirementAuthority } from "@qa/core";
import { callJson } from "./llm";

const Planned = z.object({
  missions: z.array(
    z.object({
      title: z.string(),
      goal: z.string(),
      requirementRefs: z.array(z.string()),
      risk: z.number().int().min(1).max(5),
      steps: z.number().int().min(1),
    }),
  ),
});

const SYSTEM = `You plan QA investigations of a web application.
Given its requirements (each with a ref like R1), propose candidate Missions: short, focused
investigations a browser agent can run. "goal" says what to do and what to check.
"requirementRefs" lists the refs the mission checks (at least one, only refs that exist).
"risk" is 1-5: how bad it would be if this behavior were broken. "steps" estimates browser actions.`;

export interface PlannerRequirement {
  id: string;
  text: string;
  authority: RequirementAuthority;
}

// Requirements are sent as R1..Rn, not by id, so the prompt (and its replay
// fixture) does not change between databases.
export async function planMissions(requirements: PlannerRequirement[], model?: string) {
  const user = requirements.map((r, i) => `R${i + 1} (${r.authority}): ${r.text}`).join("\n");
  const { data, call } = await callJson(SYSTEM, user, Planned, { model });
  const missions = data.missions.flatMap((m) => {
    const requirementIds = m.requirementRefs.flatMap((ref) => {
      const r = requirements[Number(ref.replace(/^R/, "")) - 1];
      return r ? [r.id] : [];
    });
    // A mission that checks no known requirement has no basis; drop it.
    if (!requirementIds.length) return [];
    const detail: MissionDetail = { goal: m.goal, requirementIds, risk: m.risk, steps: m.steps };
    return [{ title: m.title, detail }];
  });
  return { missions, dropped: data.missions.length - missions.length, call };
}

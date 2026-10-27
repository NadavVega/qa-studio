import { z } from "zod";
import { TestCheck, type BrowserStep } from "@qa/core";
import { callJson } from "./llm";

const Checks = z.object({ checks: z.array(TestCheck).min(1).max(10) });

const SYSTEM = `You write the assertions of a regression test for a confirmed defect in a web application.
You get the defect title, the judge's reasoning, the requirements it breaks, the browser steps that reach
the defect, and the accessibility snapshot of the page after those steps.
Return checks that pass only when the application behaves as the requirements say (they fail while the defect exists).
Each check is {"role":"row"|"cell"|"heading"|"status"|"link"|"button","name":"<substring of the accessible name>","contains":"<expected text>"}.
Use names you can see in the snapshot. Compute expected values from the requirements, not from the defective output.`;

export interface TestGenInput {
  title: string;
  reasoning: string;
  requirements: string[];
  steps: BrowserStep[];
  finalSnapshot: string;
}

// Proposes the checks of a RegressionTest; the steps are the investigation's own steps.
export async function generateChecks(input: TestGenInput, model?: string) {
  const user = [
    `Defect: ${input.title}`,
    `Judge reasoning: ${input.reasoning}`,
    `Requirements:\n${input.requirements.map((r) => `- ${r}`).join("\n")}`,
    `Steps:\n${JSON.stringify(input.steps, null, 2)}`,
    `Page snapshot after the steps:\n${input.finalSnapshot}`,
  ].join("\n\n");
  const { data, call } = await callJson(SYSTEM, user, Checks, { model });
  return { checks: data.checks, call };
}

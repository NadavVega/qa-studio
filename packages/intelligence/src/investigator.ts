import { z } from "zod";
import { BrowserStep } from "@qa/core";
import { callJson } from "./llm";

const Steps = z.object({ steps: z.array(BrowserStep).max(20) });

const SYSTEM = `You drive a browser to investigate one QA Mission on a web application.
You get the Mission goal and an accessibility snapshot of the current page (already signed in).
Return the browser steps to perform, in order:
- {"action":"goto","path":"/some/path"} opens a path on the same site.
- {"action":"click","role":"link"|"button","name":"<accessible name>"} clicks an element.
- {"action":"fill","label":"<field label>","value":"<text>"} types into a form field.
Only use names and labels you can see in the snapshot or expect after earlier steps.
Do not judge the result; evidence is captured after the last step.`;

// Asks the model for the browser steps that carry out a Mission's goal.
export async function planSteps(goal: string, snapshot: string, model?: string) {
  const user = `Mission goal: ${goal}\n\nCurrent page snapshot:\n${snapshot}`;
  const { data, call } = await callJson(SYSTEM, user, Steps, { model });
  return { steps: data.steps, call };
}

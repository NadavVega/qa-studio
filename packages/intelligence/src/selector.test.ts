import { expect, test } from "vitest";
import { selectMissions, type SelectorMission } from "./selector";

const m = (id: string, title: string, risk: number, steps: number, reqs: string[]): SelectorMission => ({
  id,
  title,
  detail: { goal: "", requirementIds: reqs, risk, steps },
});

test("selection ranking is deterministic with per-factor scores", () => {
  const missions = [
    m("a", "Edit order", 3, 6, ["r1"]),
    m("b", "Check totals", 5, 3, ["r1", "r2"]),
    m("c", "Login redirect", 3, 6, ["r1"]),
  ];
  const authority = (id: string) => (id === "r2" ? "authoritative" : "observed");
  const first = selectMissions(missions, authority);
  expect(selectMissions([...missions].reverse(), authority)).toEqual(first);
  expect(first.map((s) => s.missionId)).toEqual(["b", "a", "c"]); // a/c tie, broken by title
  expect(first[0]!.scores).toEqual({ risk: 1, coverage: 0.667, authority: 0.5, cost: 0.7, total: 0.772 });
});

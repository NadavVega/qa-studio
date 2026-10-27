import { expect, test } from "vitest";
import { authorityGuard, citeEvidence, judgeInfra } from "./judge";

const evidence = [
  { id: "e-dom", kind: "dom" as const },
  { id: "e-shot", kind: "screenshot" as const },
];

test("cited kinds map to real Evidence ids", () => {
  const j = citeEvidence({ verdict: "potential_defect", title: "t", reasoning: "r", evidence: ["dom", "trace"] }, evidence);
  expect(j).toMatchObject({ verdict: "potential_defect", evidenceIds: ["e-dom"] });
});

test("a verdict with no real Evidence is downgraded to inconclusive", () => {
  const j = citeEvidence({ verdict: "potential_defect", title: "t", reasoning: "r", evidence: ["trace"] }, evidence);
  expect(j).toMatchObject({ verdict: "inconclusive", evidenceIds: [] });
});

test("infra failure cites all captured Evidence", () => {
  expect(judgeInfra("net::ERR_CONNECTION_REFUSED", evidence)).toMatchObject({
    verdict: "infra_failure",
    evidenceIds: ["e-dom", "e-shot"],
  });
});

test("a potential defect without an approved authoritative requirement becomes observational", () => {
  const j = { verdict: "potential_defect" as const, title: "t", reasoning: "r", evidenceIds: ["e-dom"] };
  expect(authorityGuard(j, [{ authority: "observed", status: "needs_review" }]).verdict).toBe("observational");
  expect(authorityGuard(j, [{ authority: "authoritative", status: "needs_review" }]).verdict).toBe("observational");
  expect(authorityGuard(j, [{ authority: "authoritative", status: "approved" }]).verdict).toBe("potential_defect");
});

import type { MissionDetail, RequirementAuthority } from "@qa/core";

// Deterministic: no AI, no randomness, no clock. Same input gives the same ranking.
export const WEIGHTS = { risk: 0.4, coverage: 0.25, authority: 0.2, cost: 0.15 } as const;

export interface SelectorMission {
  id: string;
  title: string;
  detail: MissionDetail;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function selectMissions(missions: SelectorMission[], authorityOf: (requirementId: string) => RequirementAuthority | undefined) {
  const scored = missions.map((m) => {
    const ids = m.detail.requirementIds;
    const factors = {
      risk: m.detail.risk / 5,
      coverage: Math.min(ids.length, 3) / 3,
      authority: ids.filter((id) => authorityOf(id) === "authoritative").length / ids.length,
      cost: 1 - Math.min(m.detail.steps, 10) / 10,
    };
    const total = Object.entries(factors).reduce((s, [k, v]) => s + v * WEIGHTS[k as keyof typeof WEIGHTS], 0);
    const scores = Object.fromEntries(Object.entries({ ...factors, total }).map(([k, v]) => [k, round(v)]));
    return { missionId: m.id, title: m.title, scores };
  });
  // Ties break on title, then id, so input order never matters.
  scored.sort((a, b) => b.scores.total! - a.scores.total! || a.title.localeCompare(b.title) || a.missionId.localeCompare(b.missionId));
  return scored.map((s, i) => ({ missionId: s.missionId, rank: i + 1, scores: s.scores }));
}

"use client";
import { useParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Check, ExternalLink, Pause } from "lucide-react";
import {
  QUEUES, type BrowserStep, type Environment, type Evidence, type FindingDetail, type Project, type RequirementAuthority, type RunDetail, type Stage,
  type StageRecord, type TestSpec, type Verdict,
} from "@qa/core";
import { api, useAction, useApi, waitForJob } from "@/lib/api";
import { AuthorityBadge, Badge, Button, Empty, ErrorText, FindingBadge, Json, Panel, Shell, TestBadge, VerdictBadge, input } from "../../../../ui";

// Shapes of the StageRecords the api and worker write (see apps/api and apps/worker).
type AiCall = { llmCallKey: string | null; llmResponse: unknown; llmProvider?: string | null; llmModel?: string | null; llmNote?: string };
type PlanRec = { input: { copiedFromRunId?: string; requirements: { id: string; text: string; authority: RequirementAuthority }[]; llmRequest: unknown }; decision: AiCall & { droppedMissions: number } };
type SelectRec = { decision: { weights: Record<string, number> } };
type BrowseOut = { stepResults: (BrowserStep & { ok: boolean; error?: string })[]; finalUrl: string; consoleErrors: string[]; failedRequests: unknown[]; infraError: string | null; evidenceIds: string[] };
type InvestigateRec = { input: { missionId: string; goal: string; baseUrl: string; llmRequest: unknown }; decision: AiCall & { steps: BrowserStep[] }; output: BrowseOut };
type JudgeRec = { input: { requirements: string[]; evidence: { id: string }[]; investigation: BrowseOut; llmRequest: unknown }; decision: AiCall & { aiVerdict?: Verdict | null; verdict: Verdict; title: string; reasoning: string; evidenceIds: string[] }; output: { findingId: string | null } };
type ValidateRec = { input: { findingId: string; steps: BrowserStep[]; llmRequest: unknown }; decision: AiCall & { judgement: { verdict: Verdict; reasoning: string } | null; reproduced: boolean }; output: BrowseOut & { status: string } };
type AutomateRec = { input: { findingId?: string; regressionTestId?: string; llmRequest?: unknown }; decision: AiCall & { passed?: boolean } };
// Suite runs: one record per promoted test (checks + browse output), or one infra record when the environment never got ready.
type SuiteRec = { input: { regressionTestId?: string; readyUrl?: string }; decision: { passed?: boolean; checks?: { role: string; name: string; contains: string; actual: string | null; ok: boolean }[]; verdict?: Verdict }; output: Partial<BrowseOut> };

const STAGES: { stage: Stage; name: string; about: string; idle: string }[] = [
  { stage: "plan", name: "Plan", about: "The AI proposes candidate missions from the project's requirements.", idle: "AI proposes missions" },
  { stage: "select", name: "Select", about: "Deterministic: the same input always gives the same ranking. No AI call in this stage.", idle: "Deterministic ranking" },
  { stage: "investigate", name: "Investigate", about: "The worker signs in and carries out the mission in a fresh browser. Values are captured, not judged, in this stage.", idle: "Browser, signed in" },
  { stage: "judge", name: "Judge", about: "Compares what was observed with the requirements. Every verdict must cite real evidence.", idle: "Verdict with evidence" },
  { stage: "validate", name: "Validate", about: "An independent reproduction in a fresh browser, judged only on its own evidence.", idle: "Fresh reproduction" },
  { stage: "automate", name: "Automate", about: "A regression test from the confirmed finding. It is interpreted by the worker, with no AI at test runtime.", idle: "Regression test" },
];

const as = <T,>(r: StageRecord | undefined) => r as unknown as T | undefined;

export default function RunPage() {
  const { id, runId } = useParams<{ id: string; runId: string }>();
  const project = useApi<Project>(`/projects/${id}`);
  const run = useApi<RunDetail>(`/projects/${id}/runs/${runId}/detail`);
  const action = useAction();
  const [view, setView] = useState<Stage | null>(null);
  const [missionId, setMissionId] = useState("");
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const r = run.data;
  const lastModel = r?.stageRecords.map((x) => (x.decision ? answeredBy(x.decision as AiCall) : null)).filter(Boolean).at(-1);

  const records = (s: Stage) => r?.stageRecords.filter((x) => x.stage === s) ?? [];
  const latest = (s: Stage) => records(s).at(-1);
  // The finding the later stages work on: the first potential defect, else the first finding.
  const finding = r?.findings.find((f) => f.verdict === "potential_defect") ?? r?.findings[0];
  const detail = useApi<FindingDetail>(finding ? `/projects/${id}/findings/${finding.id}` : null);
  const fd = detail.data;
  const test = fd?.regressionTests.at(-1);

  const inv = latest("investigate");
  const judge = latest("judge");
  const judgedLatest = !!judge && !!inv && judge.createdAt >= inv.createdAt;
  // Next step the engineer can take; null when the run has nothing left to do.
  const guidedNext: { stage: Stage; label: string; go: () => Promise<unknown> } | null = !r
    ? null
    : !latest("plan") ? { stage: "plan", label: "Run Plan", go: () => post("plan") }
    : !latest("select") ? { stage: "select", label: "Continue to Select", go: () => post("select") }
    : !inv ? { stage: "investigate", label: "Continue to Investigate", go: () => post("investigate", missionId ? { missionId } : {}, QUEUES.investigate) }
    : !judgedLatest ? { stage: "judge", label: "Continue to Judge", go: () => post("judge") }
    : finding?.verdict === "potential_defect" && fd?.status === "potential" ? { stage: "validate", label: "Continue to Validate", go: () => queued(`/findings/${fd.id}/validate`, QUEUES.validate) }
    : fd?.status === "confirmed" && !test ? { stage: "automate", label: "Continue to Automate", go: () => call(`/findings/${fd.id}/regression-tests`) }
    : test?.status === "proposed" ? { stage: "automate", label: "Run regression test", go: () => queued(`/regression-tests/${test.id}/run`, QUEUES.regression) }
    : null;
  // Suite and release runs advance by themselves; on a release run the engineer may still automate a confirmed finding.
  const next = r?.mode === "guided" || (r?.mode === "release" && guidedNext?.stage === "automate") ? guidedNext : null;

  const reload = () => Promise.all([run.reload(), detail.reload()]);
  async function post(path: string, body: unknown = {}, queue?: string) {
    const res = await api<{ jobId?: string }>(`/projects/${id}/runs/${runId}/${path}`, "POST", body);
    if (queue && res.jobId) await waitForJob(id, queue, res.jobId);
  }
  async function queued(path: string, queue: string, body: unknown = {}) {
    const { jobId } = await api<{ jobId: string }>(`/projects/${id}${path}`, "POST", body);
    await waitForJob(id, queue, jobId);
  }
  const call = (path: string, body: unknown = {}) => api(`/projects/${id}${path}`, "POST", body);
  const act = (stage: Stage, label: string, fn: () => Promise<unknown>) =>
    action.run(label, async () => {
      setView(stage);
      try {
        await fn();
      } finally {
        await reload();
      }
    });

  const doneStages = new Set(r?.stageRecords.map((x) => x.stage));
  const shown: Stage = view ?? next?.stage ?? r?.stageRecords.at(-1)?.stage ?? "plan";
  const env = project.data?.environments.find((e) => e.id === r?.environmentId);
  const evNo = new Map(r?.evidence.map((e, i) => [e.id, i + 1]));
  const ev = (ids: string[] | undefined) => (
    <span className="qs-row">
      {ids?.map((e) => {
        const kind = r?.evidence.find((x) => x.id === e)?.kind;
        return <button key={e} type="button" className="qs-ev" onClick={() => setEvidenceId(e)} title={e}>#{evNo.get(e)} {kind}</button>;
      })}
    </span>
  );
  const missionTitle = (mid: string | undefined) => r?.missions.find((m) => m.id === mid)?.title;

  const meta = (s: Stage): string => {
    const rec = latest(s);
    if (action.busy && next?.stage === s) return `Running…`;
    if (!rec) return next?.stage === s ? "Waiting for you" : STAGES.find((x) => x.stage === s)!.idle;
    switch (s) {
      case "plan": return `${r!.missions.length} missions · ${as<PlanRec>(rec)!.decision.droppedMissions} dropped`;
      case "select": return `Top score ${r!.selections[0]?.scores.total ?? "–"} · deterministic`;
      case "investigate": {
        const o = as<InvestigateRec>(rec)!.output;
        return o.infraError ? "Infrastructure error" : `${o.stepResults.filter((x) => x.ok).length}/${o.stepResults.length} actions · ${o.evidenceIds.length} evidence`;
      }
      case "judge": return as<JudgeRec>(rec)!.decision.title;
      case "validate": return as<ValidateRec>(rec)!.decision.reproduced ? "Reproduced" : "Not reproduced";
      case "automate": return r!.mode === "suite" ? `${records("automate").length} records` : test ? `Test ${test.status}` : "Test proposed";
    }
  };

  return (
    <Shell
      project={project.data}
      env={env}
      active="workspace"
      crumbs={[project.data?.name ?? "…", "Workspace", `Run ${runId.slice(0, 8)}`]}
      actions={
        <>
          {lastModel && <span className="qs-meta qs-mono" title="Provider and model that answered the latest AI call">{lastModel}</span>}
          {action.busy ? <Badge kind="running">Running {action.busy}</Badge> : next ? <Badge kind="waiting">Waiting for you</Badge> : r?.mode !== "guided" ? r && <Badge kind="neutral">Unattended · {r.trigger ?? r.mode}</Badge> : r && <Badge kind="correct">Run complete</Badge>}
          {next && (
            <Button variant="primary" sm disabled={!!action.busy} onClick={() => act(next.stage, next.stage, next.go)}>{next.label}</Button>
          )}
        </>
      }
    >
      <ErrorText error={run.error ?? action.error} />
      {r && (
        <div className="flex flex-wrap items-start gap-6">
          <section className="qs-panel max-w-full flex-[1_1_220px] p-4" aria-label="Stages">
            <div className="qs-label mb-3">Run {runId.slice(0, 8)} · {r.mode}{r.trigger && ` · ${r.trigger}`}</div>
            <ol className="qs-steps">
              {STAGES.map(({ stage, name }) => {
                const state = doneStages.has(stage) && next?.stage !== stage ? "done" : next?.stage === stage ? "waiting" : "pending";
                return (
                  <li key={stage} className={`qs-step qs-step--${state} ${shown === stage && state === "pending" ? "qs-step--current" : ""}`}>
                    <span className="qs-step__node">{state === "done" ? <Check size={14} aria-hidden /> : state === "waiting" ? <Pause size={14} aria-hidden /> : null}</span>
                    <button
                      type="button"
                      // A done stage keeps its node; viewing it only highlights the body.
                      className={`qs-step__body cursor-pointer text-left ${shown === stage && state === "done" ? "-mt-1 -ml-2 rounded-[var(--radius-md)] bg-[var(--probe-soft)] px-2 py-1" : ""}`}
                      onClick={() => setView(stage)} aria-current={shown === stage ? "step" : undefined}>
                      <span className="qs-step__name">{name}</span>
                      <span className="qs-step__meta">{meta(stage)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>

          <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="m-0 text-xl font-semibold">{STAGES.find((s) => s.stage === shown)!.name}</h1>
              <span className="qs-meta">{STAGES.find((s) => s.stage === shown)!.about}</span>
            </div>
            {shown === "plan" && <PlanView rec={as<PlanRec>(latest("plan"))} r={r} />}
            {shown === "select" && (
              <SelectView
                rec={as<SelectRec>(latest("select"))}
                r={r}
                chosen={missionId || as<InvestigateRec>(inv)?.input.missionId || r.selections[0]?.missionId}
                choose={inv ? undefined : setMissionId}
              />
            )}
            {shown === "investigate" && <InvestigateView rec={as<InvestigateRec>(inv)} title={missionTitle(as<InvestigateRec>(inv)?.input.missionId)} env={env?.authConfig.userEnv} ev={ev} running={action.busy === "investigate"} />}
            {shown === "judge" && <JudgeView rec={as<JudgeRec>(judge)} ev={ev} />}
            {shown === "validate" && (
              <ValidateView
                fd={fd}
                recs={records("validate").filter((x) => as<ValidateRec>(x)!.input.findingId === fd?.id).map((x) => as<ValidateRec>(x)!)}
                ev={ev}
                busy={!!action.busy}
                dismiss={() => fd && act("validate", "dismiss", () => call(`/findings/${fd.id}/review`, { status: "dismissed" }))}
              />
            )}
            {shown === "automate" && r.mode === "suite" && <SuiteView recs={records("automate").map((x) => as<SuiteRec>(x)!)} ev={ev} />}
            {shown === "automate" && r.mode !== "suite" && (
              <AutomateView
                fd={fd}
                aiCall={as<AutomateRec>(records("automate").find((x) => as<AutomateRec>(x)!.input.findingId === fd?.id))}
                ev={ev}
                busy={!!action.busy}
                review={(status) => test && act("automate", status, () => call(`/regression-tests/${test.id}/review`, { status }))}
                envs={project.data?.environments ?? []}
                rerun={(environmentId) => test && act("automate", "regression test", () => queued(`/regression-tests/${test.id}/run`, QUEUES.regression, { environmentId }))}
              />
            )}
          </div>

          <EvidencePanel
            projectId={id}
            evidence={r.evidence}
            selected={evidenceId}
            select={setEvidenceId}
            evNo={evNo}
            url={as<InvestigateRec>(inv)?.output.finalUrl}
            running={action.busy === "investigate" || action.busy === "validate" || action.busy === "regression test"}
          />
        </div>
      )}
    </Shell>
  );
}

type Ev = (ids: string[] | undefined) => ReactNode;

function Kv({ k, children }: { k: string; children: ReactNode }) {
  return <div><span className="qs-meta">{k}</span><br />{children}</div>;
}

function NotYet({ stage }: { stage: string }) {
  return <Empty title={`${stage} has not run yet`}>Use the button at the top right to continue the run.</Empty>;
}

// "provider · model" that answered an AI call; old records have neither.
const answeredBy = (call: AiCall) => (call.llmProvider ? `${call.llmProvider} · ${call.llmModel}` : null);

function AiCallJson({ request, call }: { request: unknown; call: AiCall }) {
  return (
    <>
      <Json label={`AI call · ${answeredBy(call) ?? "unknown model"} · ${call.llmCallKey ?? "none"}`} value={{ request, response: call.llmResponse }} />
      {call.llmNote && <span className="qs-meta">{call.llmNote}</span>}
    </>
  );
}

function PlanView({ rec, r }: { rec?: PlanRec; r: RunDetail }) {
  if (!rec) return <NotYet stage="Plan" />;
  if (rec.input.copiedFromRunId) {
    return (
      <Panel label="Received" meta="release check">
        <p className="m-0">
          Missions copied from release run <a className="qs-mono" href={`/projects/${r.projectId}/runs/${rec.input.copiedFromRunId}`}>{rec.input.copiedFromRunId.slice(0, 8)}</a>, where Plan ran once for the whole release check.
        </p>
      </Panel>
    );
  }
  return (
    <>
      <Panel label="Received" meta="from Knowledge & Config">
        <p className="m-0">{rec.input.requirements.length} requirements (rejected ones are left out):</p>
        {rec.input.requirements.map((q, i) => (
          <div key={q.id} className="flex flex-wrap items-center gap-2"><span className="qs-mono w-7 text-xs">R{i + 1}</span><AuthorityBadge authority={q.authority} /><span>{q.text}</span></div>
        ))}
      </Panel>
      <Panel label="Decided">
        <p className="m-0">{r.missions.length} missions proposed, {rec.decision.droppedMissions} dropped because they failed validation.</p>
        <AiCallJson request={rec.input.llmRequest} call={rec.decision} />
      </Panel>
      <Panel label="Produced" meta="to Select">
        {r.missions.map((m) => (
          <div key={m.id}>
            <span className="font-medium">{m.title}</span> <span className="qs-meta">risk {m.detail.risk} · {m.detail.steps} steps · {m.detail.requirementIds.length} requirements</span>
            <div className="qs-meta">{m.detail.goal}</div>
          </div>
        ))}
      </Panel>
    </>
  );
}

const FACTORS = ["authority", "risk", "coverage", "cost"] as const;

function SelectView({ rec, r, chosen, choose }: { rec?: SelectRec; r: RunDetail; chosen?: string; choose?: (id: string) => void }) {
  if (!rec) return <NotYet stage="Select" />;
  const w = rec.decision.weights;
  const m = r.missions.find((x) => x.id === chosen);
  return (
    <>
      <Panel label="Received" meta="from Plan">
        <p className="m-0">{r.missions.length} candidate missions and the authority of each requirement they target.</p>
      </Panel>
      <Panel label="Decided" meta={<span className="qs-mono">total = {FACTORS.map((f) => `${w[f]}×${f}`).join(" + ")}</span>} bodyClassName="qs-panel__body flex flex-col gap-2">
        {r.selections.map((s) => (
          <div key={s.id} className={`qs-mission ${s.missionId === chosen ? "qs-mission--selected" : ""}`}>
            <span className="qs-mission__rank">{s.rank}</span>
            <span className="qs-mission__title">{r.missions.find((x) => x.id === s.missionId)?.title}</span>
            <span className="qs-mission__total">{s.scores.total}</span>
            <div className="qs-score">
              <div className="qs-score__bar" role="img" aria-label={`Score ${s.scores.total} of 1`}>
                {FACTORS.map((f) => <span key={f} className={`qs-score__seg--${f}`} style={{ width: `${(w[f] ?? 0) * (s.scores[f] ?? 0) * 100}%` }} />)}
              </div>
              <div className="qs-score__legend">
                {FACTORS.map((f) => <span key={f}><i className={`qs-swatch qs-score__seg--${f}`} />{f[0]!.toUpperCase() + f.slice(1)} <b>{s.scores[f]}</b></span>)}
              </div>
            </div>
            {s.missionId === chosen && <div className="qs-mission__reason"><b>Selected.</b> {s.rank === 1 ? "Highest weighted total." : "Chosen by the engineer instead of rank 1."}</div>}
          </div>
        ))}
        {choose && (
          <label className="qs-row pt-1">
            <span className="qs-meta">Choose a different mission</span>
            <select className={input} value={chosen} onChange={(e) => choose(e.target.value)}>
              {r.selections.map((s) => <option key={s.id} value={s.missionId}>#{s.rank} {r.missions.find((x) => x.id === s.missionId)?.title}</option>)}
            </select>
          </label>
        )}
      </Panel>
      <Panel label="Produced" meta="to Investigate">
        {m && (
          <>
            <span className="font-medium">{m.title}</span>
            <dl className="qs-dl text-[13px] leading-5"><dt>Goal</dt><dd className="font-sans">{m.detail.goal}</dd><dt>Risk</dt><dd>{m.detail.risk} of 5</dd><dt>Steps</dt><dd>about {m.detail.steps}</dd></dl>
          </>
        )}
      </Panel>
    </>
  );
}

function stepText(s: BrowserStep) {
  return s.action === "goto" ? s.path : s.action === "click" ? `${s.role} "${s.name}"` : `${s.label} = ${s.value}`;
}

function Produced({ o, ev }: { o: BrowseOut; ev: Ev }) {
  return (
    <>
      {o.infraError && <div className="qs-row"><Badge kind="infra">Infrastructure failure</Badge><span className="qs-mono text-xs">{o.infraError}</span></div>}
      <dl className="qs-dl"><dt>Final URL</dt><dd>{o.finalUrl}</dd><dt>Console errors</dt><dd>{o.consoleErrors.length}</dd><dt>Failed requests</dt><dd>{o.failedRequests.length}</dd></dl>
      <div className="qs-row"><span className="qs-meta">Evidence:</span>{ev(o.evidenceIds)}</div>
    </>
  );
}

function InvestigateView({ rec, title, env, ev, running }: { rec?: InvestigateRec; title?: string; env?: string; ev: Ev; running: boolean }) {
  if (!rec) return running ? <Empty title="Investigating…">The worker is signing in and carrying out the mission.</Empty> : <NotYet stage="Investigate" />;
  return (
    <>
      <Panel label="Received" meta="from Select" bodyClassName="qs-panel__body flex flex-wrap gap-x-8 gap-y-3">
        <Kv k="Mission">{title}</Kv>
        <Kv k="Base URL"><span className="qs-mono">{rec.input.baseUrl}</span></Kv>
        <Kv k="Sign-in">{env ? `Form login, credentials from env (${env})` : "None"}</Kv>
        <Kv k="Goal">{rec.input.goal}</Kv>
      </Panel>
      <Panel label="Decided · action log" meta={`${rec.decision.steps.length} steps planned`} bodyClassName="flex flex-col">
        <div className="overflow-x-auto">
          <table className="qs-table">
            <thead><tr><th>#</th><th>Action</th><th>Target</th><th>Result</th></tr></thead>
            <tbody>
              {rec.output.stepResults.map((s, i) => (
                <tr key={i}>
                  <td className="qs-mono">{i + 1}</td>
                  <td>{s.action}</td>
                  <td className="qs-mono">{stepText(s)}</td>
                  <td>{s.ok ? <Badge kind="correct">Done</Badge> : <span title={s.error}><Badge kind="rejected">Failed</Badge> <span className="qs-meta">{s.error}</span></span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="qs-pad"><AiCallJson request={rec.input.llmRequest} call={rec.decision} /></div>
      </Panel>
      <Panel label="Produced" meta="to Judge"><Produced o={rec.output} ev={ev} /></Panel>
    </>
  );
}

function JudgeView({ rec, ev }: { rec?: JudgeRec; ev: Ev }) {
  if (!rec) return <NotYet stage="Judge" />;
  const d = rec.decision;
  return (
    <>
      <Panel label="Received" meta="from Investigate">
        {rec.input.requirements.map((q, i) => <div key={i} className="flex items-baseline gap-2"><span className="qs-mono w-7 flex-none text-xs">R{i + 1}</span><span>{q}</span></div>)}
        <div className="qs-row">
          <span className="qs-meta">Evidence sent:</span>{ev(rec.input.evidence.map((e) => e.id))}
          <span className="qs-meta">{rec.input.investigation.consoleErrors.length} console errors · {rec.input.investigation.failedRequests.length} failed requests</span>
        </div>
      </Panel>
      <Panel
        label="Decided"
        meta={!d.llmCallKey ? "No AI call: infrastructure failure" : d.aiVerdict && d.aiVerdict !== d.verdict ? `AI verdict: ${d.aiVerdict} · Final: ${d.verdict} · changed by the authority guard` : "AI verdict · no guard changed it"}
      >
        <div className="qs-row"><VerdictBadge verdict={d.verdict} /><span className="text-[15px] font-semibold leading-[22px]">{d.title}</span></div>
        <div><div className="qs-label mb-1">Reasoning</div><p className="m-0">{d.reasoning}</p></div>
        <div className="qs-row"><span className="qs-meta">Cited:</span>{ev(d.evidenceIds)}</div>
        {d.llmCallKey && <AiCallJson request={rec.input.llmRequest} call={d} />}
      </Panel>
      <Panel label="Produced" meta={rec.output.findingId ? "to Validate" : undefined}>
        {rec.output.findingId
          ? <div className="qs-row"><Badge kind="potential">Potential</Badge><span className="font-medium">{d.title}</span><span className="qs-meta qs-mono">finding {rec.output.findingId.slice(0, 8)}</span></div>
          : <span>No finding. {d.verdict === "infra_failure" ? "Infrastructure failures are never product defects." : "The verdict stays on this stage record."}</span>}
        {d.verdict === "observational" && <p className="qs-meta m-0">Observational findings need a person to decide; only potential defects go to validation.</p>}
      </Panel>
    </>
  );
}

function ValidateView({ fd, recs, ev, busy, dismiss }: { fd?: FindingDetail | null; recs: ValidateRec[]; ev: Ev; busy: boolean; dismiss: () => void }) {
  if (!fd) return <Empty title="Nothing to validate">Validate runs when the Judge records a potential defect.</Empty>;
  return (
    <>
      <Panel label="Received" meta="from Judge" bodyClassName="qs-panel__body flex flex-wrap gap-x-8 gap-y-3">
        <Kv k="Finding"><span className="qs-mono">{fd.id.slice(0, 8)}</span> {fd.title}</Kv>
        <Kv k="Steps">Saved from Investigate, {recs[0]?.input.steps.length ?? "–"} actions, no AI planning</Kv>
        <Kv k="Withheld from the Judge">Original reasoning, verdict and evidence</Kv>
      </Panel>
      <Panel label="Decided" meta={fd.validationAttempts.length ? `${fd.validationAttempts.filter((a) => a.reproduced).length} of ${fd.validationAttempts.length} reproduced` : undefined}>
        {recs.length === 0 && <p className="qs-meta m-0">No attempt yet.</p>}
        {recs.map((v, i) => (
          <article key={i} className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--line)] p-3">
            <div className="qs-row">
              <span className="font-medium">Attempt {i + 1}</span>
              {v.decision.judgement ? <VerdictBadge verdict={v.decision.judgement.verdict} /> : <Badge kind="infra">Infrastructure failure</Badge>}
              <Badge kind={v.decision.reproduced ? "confirmed" : "neutral"}>{v.decision.reproduced ? "Reproduced" : "Not reproduced"}</Badge>
            </div>
            {v.decision.judgement && <p className="m-0 text-[13px]">{v.decision.judgement.reasoning}</p>}
            <div className="qs-row"><span className="qs-meta">Evidence:</span>{ev(v.output.evidenceIds)}</div>
          </article>
        ))}
        <p className="qs-meta m-0">Rule: same verdict → Confirmed · different verdict → Not reproduced · infrastructure failure → stays Potential.</p>
      </Panel>
      <Panel label="Produced" meta={fd.status === "confirmed" ? "to Automate" : undefined}>
        <div className="qs-row"><FindingBadge status={fd.status} /><span className="font-medium">{fd.title}</span></div>
        {fd.status === "potential" && <div><Button sm variant="danger" disabled={busy} onClick={dismiss}>Dismiss finding</Button></div>}
      </Panel>
    </>
  );
}

// Regression suite run (pull request or release): every promoted test's result on this run's environment.
function SuiteView({ recs, ev }: { recs: SuiteRec[]; ev: Ev }) {
  if (!recs.length) return <Empty title="Suite running">Waiting for the environment, then each promoted regression test runs. No AI call.</Empty>;
  return (
    <Panel label="Produced" meta="Promoted regression tests · no AI at test runtime" bodyClassName="overflow-x-auto">
      <table className="qs-table">
        <thead><tr><th>Test</th><th>Result</th><th>Checks</th><th>Evidence</th></tr></thead>
        <tbody>
          {recs.map((x, i) => (
            <tr key={i}>
              <td className="qs-mono">{x.input.regressionTestId?.slice(0, 8) ?? x.input.readyUrl}</td>
              <td>
                {x.output.infraError ? <VerdictBadge verdict="infra_failure" /> : <Badge kind={x.decision.passed ? "correct" : "rejected"}>{x.decision.passed ? "Passed" : "Failed"}</Badge>}
                {x.output.infraError && <div className="qs-meta">{x.output.infraError}</div>}
              </td>
              <td>
                {x.decision.checks?.map((c, j) => (
                  <div key={j} className={c.ok ? "" : "font-medium"}>{c.ok ? "✓" : "✗"} {c.role} &ldquo;{c.name}&rdquo; contains &ldquo;{c.contains}&rdquo;{!c.ok && <span className="qs-meta"> (got {c.actual === null ? "nothing" : `“${c.actual}”`})</span>}</div>
                ))}
              </td>
              <td>{ev(x.output.evidenceIds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function AutomateView({ fd, aiCall, ev, busy, review, envs, rerun }: {
  fd?: FindingDetail | null; aiCall?: AutomateRec; ev: Ev; busy: boolean; review: (s: "promoted" | "rejected") => void; envs: Environment[]; rerun: (environmentId: string) => void;
}) {
  const [envId, setEnvId] = useState("");
  const t = fd?.regressionTests.at(-1);
  if (!fd || !t) return <Empty title="No regression test yet">Automate runs when a finding is confirmed.</Empty>;
  const spec = JSON.parse(t.code) as TestSpec;
  return (
    <>
      <Panel label="Received" meta="from Validate" bodyClassName="qs-panel__body flex flex-wrap gap-x-8 gap-y-3">
        <Kv k="Finding"><span className="qs-mono">{fd.id.slice(0, 8)}</span> <FindingBadge status={fd.status} /></Kv>
        <Kv k="Steps">{spec.steps.length} saved actions</Kv>
        <Kv k="Expected behaviour">{fd.title}</Kv>
      </Panel>
      <Panel label="Decided" meta="No AI at test runtime">
        <ul className="qs-guards">
          {spec.checks.map((c, i) => (
            <li key={i} className="qs-guard"><Check size={14} aria-hidden /><span><span className="qs-guard__name">{c.role} &ldquo;{c.name}&rdquo;</span><span className="qs-guard__rule">must contain &ldquo;{c.contains}&rdquo;</span></span><span /></li>
          ))}
        </ul>
        <div className="qs-code">
          <div className="qs-code__head"><span>regression-test-{t.id.slice(0, 8)}.json</span></div>
          <pre>{t.code.split("\n").map((l, i) => <span key={i} className="ln">{l}</span>)}</pre>
        </div>
        {aiCall && <AiCallJson request={aiCall.input.llmRequest} call={aiCall.decision} />}
      </Panel>
      <Panel label="Produced">
        <div className="qs-row">
          <span className="qs-mono">{t.id.slice(0, 8)}</span><TestBadge status={t.status} />
          <span className="flex-auto" />
          <select className={input} value={envId || envs[0]?.id} onChange={(e) => setEnvId(e.target.value)} aria-label="Environment to run on">
            {envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <Button sm disabled={busy || !envs.length} onClick={() => rerun(envId || envs[0]!.id)}>Run test</Button>
          <Button sm disabled={busy || !["proposed", "validated"].includes(t.status)} onClick={() => review("rejected")}>Reject</Button>
          <Button sm variant="primary" disabled={busy || t.status !== "validated"} onClick={() => review("promoted")}>Promote to suite</Button>
        </div>
        <p className="qs-meta m-0">A test counts when it fails on the buggy build and passes on the fixed one: a passing run turns Proposed into Validated.</p>
        {t.results.length > 0 && (
          <table className="qs-table">
            <thead><tr><th>Time</th><th>Environment</th><th>Result</th><th>Evidence</th></tr></thead>
            <tbody>
              {t.results.map((x) => (
                <tr key={x.id}>
                  <td className="qs-mono">{new Date(x.createdAt).toLocaleTimeString()}</td>
                  <td>{envs.find((e) => e.id === x.environmentId)?.name ?? "–"}</td>
                  <td><Badge kind={x.passed ? "correct" : "rejected"}>{x.passed ? "Passed" : "Failed"}</Badge></td>
                  <td>{ev(x.evidenceIds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

function EvidencePanel({ projectId, evidence, selected, select, evNo, url, running }: {
  projectId: string; evidence: Evidence[]; selected: string | null; select: (id: string) => void; evNo: Map<string, number>; url?: string; running: boolean;
}) {
  const shots = evidence.filter((e) => e.kind === "screenshot");
  const cur = evidence.find((e) => e.id === selected) ?? shots.at(-1);
  const href = (e: Evidence) => `/api/projects/${projectId}/evidence/${e.id}`;
  return (
    <section className="qs-panel max-w-full flex-[1_1_340px]" aria-label="Evidence in view">
      <div className="qs-panel__head">
        <span className="qs-label">{cur ? `Evidence #${evNo.get(cur.id)} · ${cur.kind}` : "Evidence"}</span>
        {running && <Badge kind="running">Live</Badge>}
        {cur && <a className="qs-btn qs-btn--ghost qs-btn--sm ml-auto" href={href(cur)} target="_blank" aria-label="Open evidence in a new tab"><ExternalLink size={14} aria-hidden /></a>}
      </div>
      <div className="qs-panel__body flex flex-col gap-3">
        {!cur && <Empty title="No browser activity yet">The worker signs in to the environment when Investigate starts. Screenshots appear here.</Empty>}
        {cur && (
          <>
            {url && <div className="qs-mono wrap-anywhere rounded-[var(--radius-sm)] border border-[var(--line-strong)] bg-[var(--surface-sunken)] px-2 py-1.5 text-xs">{url}</div>}
            {cur.kind === "screenshot"
              ? <img src={href(cur)} alt={`Screenshot evidence #${evNo.get(cur.id)}`} className="w-full rounded-[var(--radius-sm)] border border-[var(--line)]" />
              : <Empty title={`${cur.kind} evidence`}><a href={href(cur)} target="_blank">Open {cur.kind} file</a></Empty>}
            <dl className="qs-dl"><dt>Id</dt><dd>{cur.id}</dd><dt>Captured</dt><dd>{new Date(cur.createdAt).toLocaleTimeString()}</dd></dl>
          </>
        )}
        {shots.length > 0 && (
          <>
            <div className="qs-label">Filmstrip</div>
            <div className="flex gap-2 overflow-x-auto p-1">
              {shots.map((e) => (
                <button key={e.id} type="button" className={`qs-thumb w-24 flex-none cursor-pointer text-left ${e.id === cur?.id ? "qs-thumb--active" : ""}`} onClick={() => select(e.id)}>
                  <span className="qs-thumb__img"><img src={href(e)} alt="" className="h-full w-full object-cover object-top" /></span>
                  <span className="qs-thumb__cap"><b>#{evNo.get(e.id)}</b> · {new Date(e.createdAt).toLocaleTimeString()}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

"use client";
import { useEffect, useRef, useState } from "react";
import type { AssistResult, CheckResult, LlmProviders, Suggestion } from "@qa/core";
import { api, useAction } from "@/lib/api";
import { Button, CheckBadge, CheckIssues, ErrorText, Field, Panel, input } from "../../../ui";

const area = `${input} h-auto min-h-16 py-1.5`;

// "Write a requirement": live rule-based check, optional AI suggestions, and an explicit save.
// Nothing is stored until the engineer presses Accept or Save requirement.
export function WriteRequirement({ projectId, providers, onSaved, onGuide }: {
  projectId: string;
  providers: LlmProviders | null;
  onSaved: () => Promise<unknown>;
  onGuide: () => void;
}) {
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [draft, setDraft] = useState<string | null>(null); // text when the assistant was first asked
  const [result, setResult] = useState<AssistResult | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [fromSuggestion, setFromSuggestion] = useState<Suggestion | null>(null);
  const action = useAction();

  useEffect(() => {
    if (!text.trim()) return setCheck(null);
    const t = setTimeout(() => {
      api<CheckResult>(`/projects/${projectId}/requirements/check`, "POST", { text, source: source || null }).then(setCheck, () => setCheck(null));
    }, 250);
    return () => clearTimeout(t);
  }, [projectId, text, source]);

  const replay = providers?.mode === "replay";
  const connected = !!providers?.providers.some((p) => p.status !== "not_connected");
  const aiBlocked = replay ? "Suggestions need a live model (LLM_MODE=live or record). The checker works in every mode." : !connected ? "No model connected" : null;

  const improve = (extra: Record<string, string> = answers) =>
    action.run("assist", async () => {
      const original = draft ?? text;
      setDraft(original);
      const qa = Object.entries(extra).filter(([, a]) => a.trim()).map(([question, answer]) => ({ question, answer }));
      setResult(await api<AssistResult>(`/projects/${projectId}/requirements/assist`, "POST", { text: original, source: source || null, answers: qa }));
    });

  const save = (accepted: string, aiSuggestion: Suggestion | null) =>
    action.run("save", async () => {
      await api(`/projects/${projectId}/requirements`, "POST", {
        text: accepted,
        source,
        history: { draft: draft ?? text, aiSuggestion, llmCallKey: aiSuggestion ? result?.llmCallKey ?? null : null },
      });
      setText(""); setDraft(null); setResult(null); setAnswers({}); setFromSuggestion(null);
      await onSaved();
    });

  const discard = (s: Suggestion) => setResult((r) => r && { ...r, suggestions: r.suggestions.filter((x) => x !== s) });

  return (
    <Panel label="Write a requirement" meta={<button type="button" className="underline" onClick={onGuide}>How to write requirements</button>}>
      <Field label="Requirement">
        <textarea className={area} value={text} placeholder="One rule, where it is seen, the exact value or rule" onChange={(e) => setText(e.target.value)} />
      </Field>
      <Field label="Source">
        <input className={input} value={source} placeholder='Spec section, e.g. orders-spec.md, Orders table, or "Product-owner decision"' onChange={(e) => setSource(e.target.value)} />
      </Field>
      {check && (
        <div className="flex flex-col gap-1.5" aria-live="polite">
          <span><CheckBadge status={check.status} /></span>
          <CheckIssues check={check} />
        </div>
      )}
      <div className="qs-row">
        <Button variant="primary" sm disabled={!text.trim() || !source.trim() || !!action.busy} onClick={() => save(text.trim(), fromSuggestion)}>
          {action.busy === "save" ? "Saving…" : "Save requirement"}
        </Button>
        <Button sm disabled={!text.trim() || !!aiBlocked || !!action.busy} onClick={() => improve()} title={aiBlocked ?? undefined}>
          {action.busy === "assist" ? "Asking…" : aiBlocked === "No model connected" ? "No model connected" : "Improve with AI"}
        </Button>
        {replay && <span className="qs-meta">{aiBlocked}</span>}
      </div>
      <span className="qs-meta">Saved requirements are Authoritative and Approved. AI suggestions are proposals: accept, edit or discard each one.</span>
      <ErrorText error={action.error} />
      {result && (
        <div className="flex flex-col gap-3">
          {result.suggestions.map((s, i) => (
            <div key={i} className="qs-panel flex flex-col gap-1.5 p-3">
              <div className="qs-row"><CheckBadge status={s.check.status} /><span className="qs-meta">AI suggestion</span></div>
              <p className="m-0 font-medium">{s.statement}</p>
              <p className="qs-meta m-0">Seen on {s.observedAt.page} · {s.observedAt.field}. Expected: {s.expected}</p>
              {!!s.edgeCases.length && <ul className="qs-meta m-0 pl-4">{s.edgeCases.map((e) => <li key={e}>{e}</li>)}</ul>}
              <CheckIssues check={s.check} />
              <div className="qs-row">
                <Button sm variant="primary" disabled={!source.trim() || !!action.busy} title={source.trim() ? undefined : "Add a source first"} onClick={() => save(s.statement, s)}>Accept</Button>
                <Button sm onClick={() => { setText(s.statement); setFromSuggestion(s); discard(s); }}>Edit</Button>
                <Button sm variant="ghost" onClick={() => discard(s)}>Discard</Button>
              </div>
            </div>
          ))}
          {result.dropped.map((d) => <p key={d.statement} className="qs-meta m-0">Not shown: “{d.statement}” ({d.reason}; not in the draft or sources).</p>)}
          {result.questions.map((q) => (
            <div key={q} className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">{q}</span>
              <div className="qs-row">
                <input className={`${input} min-w-64 flex-1`} aria-label={q} value={answers[q] ?? ""} onChange={(e) => setAnswers({ ...answers, [q]: e.target.value })} />
                <Button sm disabled={!answers[q]?.trim() || !!action.busy} onClick={() => improve(answers)}>Answer and re-run</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

const EXAMPLES = [
  ["Sales numbers should be correct", "Actual Sales is a unit count, not a monetary value"],
  ["The total should be right", "The Total column on Orders equals the sum of the line amounts"],
  ["Bad input is handled properly", "A negative quantity on Edit order is rejected with \"Quantity must be zero or more\""],
  ["Saving works as expected", "After Save order, Orders shows \"Order <id> saved\""],
  ["Only logged-in users get in; edits are validated", "Two requirements: signed-out users opening Orders go to Sign in; a non-numeric quantity is rejected"],
];

// "How to write requirements" side panel.
export function Guide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open) ref.current?.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-label="How to write requirements"
      className="fixed inset-y-0 right-0 left-auto m-0 h-full max-h-none w-[min(560px,100vw)] max-w-none overflow-y-auto border-l border-[var(--line)] bg-[var(--surface-raised)] p-6 text-[13px] text-[var(--ink)] backdrop:bg-black/30">
      <div className="flex flex-col gap-4">
        <div className="qs-row"><h2 className="m-0 text-lg font-semibold">How to write requirements</h2><Button sm variant="ghost" className="ml-auto" onClick={onClose}>Close</Button></div>
        <ol className="m-0 flex flex-col gap-1 pl-5">
          <li><b>One rule each.</b> One "must" per requirement; split "and", "also" and semicolons.</li>
          <li><b>Observable.</b> Name the page, field, column, message or API field where it is seen.</li>
          <li><b>Concrete.</b> Give the exact value, unit, formula, order or edge case (empty, zero, negative).</li>
          <li><b>Sourced.</b> Cite the spec section, or write "Product-owner decision".</li>
          <li><b>No vague words.</b> Not correct, properly, fast, intuitive, user-friendly, should work, as expected.</li>
        </ol>
        <div className="flex flex-col gap-1">
          <span className="qs-label">Weak vs testable (example app with an Orders page)</span>
          <table className="qs-table">
            <thead><tr><th>Weak</th><th>Testable</th></tr></thead>
            <tbody>{EXAMPLES.map(([weak, good]) => <tr key={weak}><td>{weak}</td><td>{good}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="flex flex-col gap-1">
          <span className="qs-label">Not testable here</span>
          <p className="m-0">QA Studio checks what one signed-in user can see in the browser. These are out of scope: performance and response times, load, security, email delivery, backend-only behavior (database, jobs, logs), and multi-user behavior.</p>
        </div>
      </div>
    </dialog>
  );
}

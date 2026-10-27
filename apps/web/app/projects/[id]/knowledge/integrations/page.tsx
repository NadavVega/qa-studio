"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { GithubConnectionInput, type GithubStatus, type Project } from "@qa/core";
import { api, useAction, useApi } from "@/lib/api";
import { Badge, Button, Empty, ErrorText, Field, KnowledgeTabs, Panel, Shell, input } from "../../../../ui";

const DEFAULTS: GithubConnectionInput = {
  repo: "",
  tokenEnv: "GITHUB_TOKEN",
  prEnvironmentId: null,
  prUrlTemplate: null,
  releaseEnvironmentId: null,
  healthPath: null,
  pollSeconds: 60,
  onPullRequests: true,
  onReleases: true,
  prComments: false,
  releaseMissions: 3,
};

const resultKind = (r: string) =>
  r === "running" ? "running" : r === "queued" ? "waiting" : r === "infra_failure" ? "infra" : r.startsWith("error") ? "rejected" : / [1-9]\d* failed|confirmed defect/.test(r) ? "potential" : r.startsWith("suite") ? "correct" : "outline";

export default function IntegrationsPage() {
  const { id } = useParams<{ id: string }>();
  const project = useApi<Project>(`/projects/${id}`);
  const github = useApi<GithubStatus>(`/projects/${id}/github`);
  const action = useAction();
  const [form, setForm] = useState<GithubConnectionInput>(DEFAULTS);
  const [prTarget, setPrTarget] = useState<"environment" | "template">("environment");
  const conn = github.data?.connection;
  const envs = project.data?.environments ?? [];

  useEffect(() => {
    if (!conn) return;
    // Parsing drops the status fields (projectId, lastPollAt, lastError).
    const saved = GithubConnectionInput.parse(conn);
    setForm(saved);
    setPrTarget(saved.prUrlTemplate ? "template" : "environment");
  }, [conn]);
  // Event results change while runs go on; refresh every 10 s.
  const reload = github.reload;
  useEffect(() => {
    const t = setInterval(() => void reload(), 10_000);
    return () => clearInterval(t);
  }, [reload]);

  const set = <K extends keyof GithubConnectionInput>(k: K, v: GithubConnectionInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const save = () =>
    action.run("save", async () => {
      const body = prTarget === "template" ? { ...form, prEnvironmentId: null } : { ...form, prUrlTemplate: null };
      await api(`/projects/${id}/github`, "PUT", body);
      await github.reload();
    });
  const envSelect = (value: string | null, onChange: (v: string | null) => void, label: string) => (
    <select className={input} aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Not mapped</option>
      {envs.map((e) => <option key={e.id} value={e.id}>{e.name} · {e.baseUrl}</option>)}
    </select>
  );
  const status = !conn ? null : conn.lastError ? <Badge kind="rejected">Error</Badge> : conn.lastPollAt ? <Badge kind="correct">Connected</Badge> : <Badge kind="waiting">Waiting for first poll</Badge>;

  return (
    <Shell project={project.data} env={envs[0]} active="knowledge" crumbs={[project.data?.name ?? "…", "Knowledge & Config", "Integrations"]}>
      <KnowledgeTabs projectId={id} active="integrations" />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="m-0 text-xl font-semibold">GitHub</h1>
        <span className="qs-meta">New pull requests and releases are tested on the mapped environment and reported back as commit statuses. QA Studio never checks out or changes code.</span>
      </div>
      <ErrorText error={project.error ?? github.error ?? action.error} />
      <div className="flex flex-wrap items-start gap-6">
        <Panel label="Connection" meta={status} className="min-w-0 flex-[999_1_520px]">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Repository (owner/name)">
              <input className={`${input} qs-mono`} value={form.repo} placeholder="acme/web-app" onChange={(e) => set("repo", e.target.value.trim())} />
            </Field>
            <Field label="Token env var (name only)">
              <input className={`${input} qs-mono`} value={form.tokenEnv} onChange={(e) => set("tokenEnv", e.target.value.trim())} />
            </Field>
          </div>
          <p className="qs-meta m-0">
            Fine-grained token in the worker env: read pull requests and releases, write commit statuses (and pull request comments only if enabled below). The token is never stored or shown.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Pull-request environment">
              <span className="qs-row">
                <select className={input} aria-label="Pull-request target" value={prTarget} onChange={(e) => setPrTarget(e.target.value as typeof prTarget)}>
                  <option value="environment">Existing environment</option>
                  <option value="template">URL template</option>
                </select>
                {prTarget === "environment" ? (
                  envSelect(form.prEnvironmentId, (v) => set("prEnvironmentId", v), "Pull-request environment")
                ) : (
                  <input className={`${input} qs-mono flex-1`} aria-label="Pull-request URL template" placeholder="https://pr-{number}.preview.example.com" value={form.prUrlTemplate ?? ""} onChange={(e) => set("prUrlTemplate", e.target.value.trim() || null)} />
                )}
              </span>
            </Field>
            <Field label="Release environment">{envSelect(form.releaseEnvironmentId, (v) => set("releaseEnvironmentId", v), "Release environment")}</Field>
            <Field label="Health path (default: base URL)">
              <input className={`${input} qs-mono`} placeholder="/health" value={form.healthPath ?? ""} onChange={(e) => set("healthPath", e.target.value.trim() || null)} />
            </Field>
            <span className="qs-row">
              <Field label="Poll every (s)">
                <input className={`${input} qs-mono w-24`} type="number" min={15} max={3600} value={form.pollSeconds} onChange={(e) => set("pollSeconds", Number(e.target.value))} />
              </Field>
              <Field label="Release missions">
                <input className={`${input} qs-mono w-24`} type="number" min={1} max={10} value={form.releaseMissions} onChange={(e) => set("releaseMissions", Number(e.target.value))} />
              </Field>
            </span>
          </div>
          <fieldset className="qs-row m-0 border-0 p-0">
            <legend className="qs-label mb-1">Triggers</legend>
            {([["onPullRequests", "Pull requests: regression suite"], ["onReleases", "Releases: suite + release check"], ["prComments", "Pull request comments"]] as const).map(([k, label]) => (
              <label key={k} className="qs-row text-[13px]">
                <input type="checkbox" checked={form[k]} onChange={(e) => set(k, e.target.checked)} />
                {label}
              </label>
            ))}
          </fieldset>
          <span className="qs-row">
            <Button variant="primary" sm disabled={!form.repo || !!action.busy} onClick={save}>{conn ? "Save connection" : "Connect"}</Button>
          </span>
        </Panel>
        <Panel label="Status" className="max-w-full flex-[1_1_340px]">
          {!conn && <Empty title="Not connected">Connect a repository to start polling.</Empty>}
          {conn && (
            <dl className="qs-dl">
              <dt>Repository</dt><dd>{conn.repo}</dd>
              <dt>Last poll</dt><dd>{conn.lastPollAt ? new Date(conn.lastPollAt).toLocaleString() : "not yet"}</dd>
              <dt>Last error</dt><dd className="font-sans">{conn.lastError ?? "none"}</dd>
              <dt>Webhook</dt><dd>POST /github/webhook (optional, needs GITHUB_WEBHOOK_SECRET)</dd>
            </dl>
          )}
        </Panel>
      </div>
      <Panel label="Events" meta="Each pull request head SHA and release triggers once" bodyClassName="overflow-x-auto">
        {!github.data?.events.length && <div className="qs-pad"><Empty title="No events yet">The first poll records open pull requests and existing releases as a baseline; anything new after that is tested.</Empty></div>}
        {!!github.data?.events.length && (
          <table className="qs-table">
            <thead><tr><th>Event</th><th>SHA</th><th>Seen</th><th>Run</th><th>Result</th></tr></thead>
            <tbody>
              {github.data.events.map((e) => (
                <tr key={e.id}>
                  <td>{e.kind === "pull_request" ? `Pull request #${e.ref}` : `Release ${e.ref}`}</td>
                  <td className="qs-mono">{e.sha.slice(0, 7) || "…"}</td>
                  <td className="qs-mono">{new Date(e.seenAt).toLocaleString()}</td>
                  <td>{e.runId ? <Link className="qs-mono" href={`/projects/${id}/runs/${e.runId}`}>{e.runId.slice(0, 8)}</Link> : "—"}</td>
                  <td><Badge kind={resultKind(e.result)}>{e.result}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </Shell>
  );
}

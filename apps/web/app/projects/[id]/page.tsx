"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import type { Project, Run, RunMode } from "@qa/core";
import { api, useAction, useApi } from "@/lib/api";
import { Badge, Button, Empty, ErrorText, Panel, Shell, input } from "../../ui";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const project = useApi<Project>(`/projects/${id}`);
  const [mode, setMode] = useState<RunMode | "">("");
  const runs = useApi<Run[]>(`/projects/${id}/runs${mode ? `?mode=${mode}` : ""}`);
  const action = useAction();
  const [envId, setEnvId] = useState("");
  const p = project.data;
  const env = p?.environments.find((e) => e.id === envId) ?? p?.environments[0];

  const newRun = () =>
    action.run("create run", async () => {
      const run = await api<Run>(`/projects/${id}/runs`, "POST", { environmentId: env!.id });
      router.push(`/projects/${id}/runs/${run.id}`);
    });

  return (
    <Shell
      project={p}
      env={env}
      active="workspace"
      crumbs={[p?.name ?? "…", "Workspace"]}
      actions={
        <>
          {p && p.environments.length > 1 && (
            <select className={input} value={env?.id} onChange={(e) => setEnvId(e.target.value)} aria-label="Environment">
              {p.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          )}
          <Button variant="primary" sm disabled={!env || !!action.busy} onClick={newRun}>New guided run</Button>
        </>
      }
    >
      <ErrorText error={project.error ?? action.error} />
      {p && (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="m-0 text-xl font-semibold">{p.name}</h1>
            <span className="qs-meta">{p.description}</span>
          </div>
          <div className="flex flex-wrap items-start gap-6">
            <Panel
              label="Runs"
              meta={
                <select className={input} value={mode} onChange={(e) => setMode(e.target.value as RunMode | "")} aria-label="Filter runs by mode">
                  <option value="">All modes</option>
                  <option value="guided">Guided</option>
                  <option value="suite">Regression suite</option>
                  <option value="release">Release check</option>
                </select>
              }
              className="min-w-0 flex-[999_1_520px]"
              bodyClassName=""
            >
              {runs.data?.length === 0 && <div className="qs-pad"><Empty title="No runs yet">Start a guided run. You advance every stage and see what each component received, decided and produced.</Empty></div>}
              {!!runs.data?.length && (
                <table className="qs-table">
                  <thead><tr><th>Run</th><th>Started</th><th>Mode</th><th>Trigger</th><th>Stage</th></tr></thead>
                  <tbody>
                    {runs.data.map((r) => (
                      <tr key={r.id}>
                        <td><Link className="qs-mono" href={`/projects/${id}/runs/${r.id}`}>{r.id.slice(0, 8)}</Link></td>
                        <td className="qs-mono">{new Date(r.createdAt).toLocaleString()}</td>
                        <td>{r.mode}</td>
                        <td>{r.trigger ?? "manual"}</td>
                        <td><Badge kind="neutral">{r.currentStage}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
            <Panel label="Environments" className="max-w-full flex-[1_1_340px]">
              {p.environments.map((e) => (
                <dl key={e.id} className="qs-dl">
                  <dt>Name</dt><dd className="font-sans">{e.name}</dd>
                  <dt>Base URL</dt><dd>{e.baseUrl}</dd>
                  <dt>Sign-in</dt><dd>{e.authConfig.userEnv ? `credentials from env (${e.authConfig.userEnv})` : "none"}</dd>
                </dl>
              ))}
            </Panel>
          </div>
        </>
      )}
    </Shell>
  );
}

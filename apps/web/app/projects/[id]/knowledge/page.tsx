"use client";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import type { CheckStatus, LlmProviders, Project, Requirement, RequirementWithCheck, Settings } from "@qa/core";
import { api, useAction, useApi } from "@/lib/api";
import { AuthorityBadge, Badge, Button, CheckBadge, CheckIssues, Empty, ErrorText, KnowledgeTabs, ModelSelect, Panel, Shell, input } from "../../../ui";
import { Guide, WriteRequirement } from "./assistant";

const STATUS = { needs_review: ["outline", "Needs review"], approved: ["correct", "Approved"], rejected: ["rejected", "Rejected"] } as const;
// Review order: Needs work first.
const CHECK_ORDER: Record<CheckStatus, number> = { needs_work: 0, not_testable: 1, ready: 2 };

export default function KnowledgePage() {
  const { id } = useParams<{ id: string }>();
  const project = useApi<Project>(`/projects/${id}`);
  const requirements = useApi<RequirementWithCheck[]>(`/projects/${id}/requirements`);
  const inputs = useApi<string[]>("/inputs");
  const providers = useApi<LlmProviders>("/llm/providers");
  const settings = useApi<Settings>("/settings");
  const action = useAction();
  const router = useRouter();
  const [file, setFile] = useState("");
  const [guide, setGuide] = useState(false);
  const sorted = requirements.data && [...requirements.data].sort((a, b) => CHECK_ORDER[a.check.status] - CHECK_ORDER[b.check.status]);

  const review = (r: Requirement, body: Partial<Pick<Requirement, "status" | "authority">>) =>
    action.run("review", async () => {
      await api(`/projects/${id}/requirements/${r.id}`, "PATCH", body);
      await requirements.reload();
    });
  const setModel = (value: string) =>
    action.run("model", async () => {
      await api(`/projects/${id}/model`, "PATCH", { llmModel: value || null });
      await project.reload();
    });
  const fallback = settings.data?.defaultModel === "auto" ? `auto · ${providers.data?.auto ?? "no provider connected"}` : settings.data?.defaultModel;
  const deleteProject = () => {
    if (!window.confirm(`Delete "${project.data?.name}" and all its runs, requirements, findings and evidence? This cannot be undone.`)) return;
    action.run("delete", async () => {
      await api(`/projects/${id}`, "DELETE");
      router.push("/");
    });
  };
  const importFile = () =>
    action.run("import", async () => {
      await api(`/projects/${id}/requirements/import`, "POST", { file });
      await requirements.reload();
    });

  return (
    <Shell
      project={project.data}
      env={project.data?.environments[0]}
      active="knowledge"
      crumbs={[project.data?.name ?? "…", "Knowledge & Config"]}
      actions={
        <>
          <select className={input} value={file} onChange={(e) => setFile(e.target.value)} aria-label="File from the inputs folder">
            <option value="">File from the inputs folder…</option>
            {inputs.data?.map((f) => <option key={f}>{f}</option>)}
          </select>
          <Button variant="primary" sm disabled={!file || !!action.busy} onClick={importFile}>{action.busy === "import" ? "Importing…" : "Import"}</Button>
        </>
      }
    >
      <KnowledgeTabs projectId={id} active="requirements" />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="m-0 text-xl font-semibold">Requirements</h1>
        <span className="qs-meta">AI-extracted requirements enter as Observed and Needs review. Only a person can make one authoritative.</span>
      </div>
      <ErrorText error={project.error ?? requirements.error ?? action.error} />
      <Panel
        label="Model"
        meta={project.data?.isDemo ? `Set by demo-local/models.json${project.data.localOnly ? " · Local models only" : ""}` : "Overrides the default from Settings for this project's AI calls"}
      >
        {project.data && (
          <ModelSelect
            label="Project model"
            providers={providers.data}
            value={project.data.llmModel ?? ""}
            first={{ value: "", label: `Use the default (${fallback ?? "…"})` }}
            disabled={!!action.busy || project.data.isDemo}
            onChange={setModel}
          />
        )}
      </Panel>
      <WriteRequirement projectId={id} providers={providers.data} onSaved={requirements.reload} onGuide={() => setGuide(true)} />
      <Guide open={guide} onClose={() => setGuide(false)} />
      <Panel
        label="Knowledge"
        meta={<>{requirements.data && `${requirements.data.length} requirements · Needs work first · `}<button type="button" className="underline" onClick={() => setGuide(true)}>How to write requirements</button></>}
        bodyClassName="overflow-x-auto"
      >
        {requirements.data?.length === 0 && <div className="qs-pad"><Empty title="No requirements yet">Import a file from the inputs folder (docs/inputs, or INPUTS_DIR) to extract requirements with their source.</Empty></div>}
        {!!requirements.data?.length && (
          <table className="qs-table">
            <thead><tr><th>Requirement</th><th>Check</th><th>Authority</th><th>Status</th><th>Source</th><th /></tr></thead>
            <tbody>
              {sorted?.map((r) => (
                <tr key={r.id}>
                  <td className="flex flex-col gap-1">{r.text}<CheckIssues check={r.check} /></td>
                  <td><CheckBadge status={r.check.status} /></td>
                  <td><AuthorityBadge authority={r.authority} /></td>
                  <td><Badge kind={STATUS[r.status][0]}>{STATUS[r.status][1]}</Badge></td>
                  <td className="qs-meta" title={r.source?.quote}>{r.source && <span className="qs-mono">{r.source.file} {r.source.location}</span>}</td>
                  <td className="whitespace-nowrap">
                    <span className="qs-row flex-nowrap">
                      <Button sm disabled={!!action.busy || r.authority === "authoritative"} onClick={() => review(r, { status: "approved", authority: "authoritative" })}>Approve as authoritative</Button>
                      <Button sm variant="danger" disabled={!!action.busy || r.status === "rejected"} onClick={() => review(r, { status: "rejected" })}>Reject</Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel label="Delete project" meta="Removes the project and everything linked to it: environments, runs, requirements, findings and evidence files">
        <div><Button variant="danger" sm disabled={!project.data || !!action.busy} onClick={deleteProject}>{action.busy === "delete" ? "Deleting…" : "Delete project"}</Button></div>
      </Panel>
    </Shell>
  );
}

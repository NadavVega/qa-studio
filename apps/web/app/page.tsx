"use client";
import Link from "next/link";
import { useState } from "react";
import type { Project } from "@qa/core";
import { api, useAction, useApi } from "@/lib/api";
import { Button, Empty, ErrorText, Field, Panel, Shell, Simulated, input } from "./ui";

export default function Home() {
  const projects = useApi<Project[]>("/projects");
  const action = useAction();
  const [form, setForm] = useState({ name: "", description: "", isSimulated: false, envName: "Test", baseUrl: "", userEnv: "APP_USER", passwordEnv: "APP_PASSWORD" });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  const create = () =>
    action.run("create", async () => {
      const authConfig = { ...(form.userEnv && { userEnv: form.userEnv }), ...(form.passwordEnv && { passwordEnv: form.passwordEnv }) };
      await api("/projects", "POST", {
        name: form.name,
        description: form.description,
        isSimulated: form.isSimulated,
        environments: [{ name: form.envName, baseUrl: form.baseUrl, authConfig }],
      });
      setForm({ ...form, name: "", description: "" });
      await projects.reload();
    });

  return (
    <Shell active="projects" crumbs={["Projects"]}>
      <h1 className="m-0 text-xl font-semibold">Projects</h1>
      <div className="flex flex-wrap items-start gap-6">
        <Panel label="All projects" meta={projects.data && `${projects.data.length} projects`} className="min-w-0 flex-[999_1_520px]" bodyClassName="flex flex-col">
          <ErrorText error={projects.error} />
          {projects.data?.length === 0 && <div className="qs-pad"><Empty title="Add your first project">Point QA Studio at a web application: give it a name and the base URL of one environment under New project.</Empty></div>}
          {projects.data?.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`} className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-4 py-3 text-[var(--ink)] no-underline last:border-b-0 hover:bg-[var(--surface-sunken)]">
              <span className="font-medium">{p.name}</span>
              <Simulated on={p.isSimulated} demo={p.isDemo} />
              <span className="qs-meta">{p.description}</span>
              <span className="qs-meta qs-mono ml-auto">{p.environments.map((e) => new URL(e.baseUrl).host).join(" · ")}</span>
            </Link>
          ))}
        </Panel>
        <Panel label="New project" className="max-w-full flex-[1_1_340px]">
          <Field label="Name"><input className={input} value={form.name} onChange={set("name")} /></Field>
          <Field label="Description"><input className={input} value={form.description} onChange={set("description")} /></Field>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.isSimulated} onChange={set("isSimulated")} /> Simulated application</label>
          <div className="qs-label mt-2">Environment</div>
          <Field label="Name"><input className={input} value={form.envName} onChange={set("envName")} /></Field>
          <Field label="Base URL"><input className={`${input} qs-mono`} value={form.baseUrl} placeholder="https://test.example.com" onChange={set("baseUrl")} /></Field>
          <Field label="User env var"><input className={`${input} qs-mono`} value={form.userEnv} onChange={set("userEnv")} /></Field>
          <Field label="Password env var"><input className={`${input} qs-mono`} value={form.passwordEnv} onChange={set("passwordEnv")} /></Field>
          <p className="qs-meta m-0">Credentials stay in the worker&apos;s environment. Only the variable names are stored.</p>
          <ErrorText error={action.error} />
          <Button variant="primary" disabled={!form.name || !form.baseUrl || !!action.busy} onClick={create}>Create project</Button>
        </Panel>
      </div>
    </Shell>
  );
}

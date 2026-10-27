"use client";
import type { LlmProviders, ProviderStatus, Settings } from "@qa/core";
import { api, useAction, useApi } from "@/lib/api";
import { Badge, Button, ErrorText, ModelSelect, Panel, Shell } from "../ui";

const STATUS: Record<ProviderStatus["status"], [Parameters<typeof Badge>[0]["kind"], string]> = {
  connected: ["correct", "Connected"],
  connected_no_list: ["inconclusive", "Connected, model list unavailable"],
  not_connected: ["outline", "Not connected"],
};

export default function SettingsPage() {
  const providers = useApi<LlmProviders>("/llm/providers");
  const settings = useApi<Settings>("/settings");
  const action = useAction();
  const p = providers.data;

  const refresh = () => action.run("refresh", () => api<LlmProviders>("/llm/refresh", "POST").then(() => providers.reload()));
  const save = (defaultModel: string) => action.run("save", () => api("/settings", "PUT", { defaultModel }).then(() => settings.reload()));

  return (
    <Shell
      active="settings"
      crumbs={["Settings"]}
      actions={<Button sm disabled={!!action.busy} onClick={refresh}>{action.busy === "refresh" ? "Detecting…" : "Re-detect providers"}</Button>}
    >
      <h1 className="m-0 text-xl font-semibold">Settings</h1>
      <ErrorText error={providers.error ?? settings.error ?? action.error} />
      {p?.mode === "replay" && (
        <p className="qs-meta m-0">LLM_MODE=replay: AI answers come from recordings, so the model setting is ignored until the API and worker run in live mode.</p>
      )}
      <Panel label="Default model" meta={settings.data?.source === "demo-local" ? "Set by demo-local/models.json while demo mode is on" : "Projects can override it in Knowledge & Config"}>
        {settings.data && (
          <ModelSelect
            label="Default model"
            providers={p}
            value={settings.data.defaultModel}
            first={{ value: "auto", label: `auto · ${p?.auto ?? "no provider connected"}` }}
            disabled={!!action.busy || settings.data.source === "demo-local"}
            onChange={save}
          />
        )}
        <span className="qs-meta">auto uses the recommended model of the first connected provider. The provider always comes from the model id.</span>
      </Panel>
      <Panel label="LLM providers" meta="Connected when its env var is set in .env; restart the API or re-detect after a change" bodyClassName="overflow-x-auto">
        <table className="qs-table">
          <thead><tr><th>Provider</th><th>Status</th><th>Env var</th><th>Models</th></tr></thead>
          <tbody>
            {p?.providers.map((s) => (
              <tr key={s.provider}>
                <td className="qs-mono">{s.provider}</td>
                <td><Badge kind={STATUS[s.status][0]}>{STATUS[s.status][1]}</Badge></td>
                <td className="qs-mono">{s.envVar}</td>
                <td className="qs-meta">{s.models.length ? `${s.models.length} · recommended ${s.recommended}` : `Set ${s.envVar} to connect`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </Shell>
  );
}

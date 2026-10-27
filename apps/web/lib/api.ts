"use client";
import { useCallback, useEffect, useState } from "react";

export async function api<T = unknown>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(data?.error ?? data)}`);
  return data as T;
}

// Loads path on mount (null: nothing to load); reload() fetches again. Error text is shown by the page.
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(
    async () => (path === null ? setData(null) : api<T>(path).then(setData, (e: Error) => setError(e.message))),
    [path],
  );
  useEffect(() => void reload(), [reload]);
  return { data, error, reload };
}

// Wraps an action: tracks busy state and the last error.
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run };
}

// Polls a pg-boss job until it completes or fails; throws the job's error on failure.
export async function waitForJob(projectId: string, queue: string, jobId: string) {
  for (;;) {
    const job = await api<{ state: string; output: unknown }>(`/projects/${projectId}/jobs/${queue}/${jobId}`);
    if (job.state === "completed") return;
    if (job.state === "failed" || job.state === "cancelled") throw new Error(`job ${job.state}: ${JSON.stringify(job.output)}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

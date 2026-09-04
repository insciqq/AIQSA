"use client";

import {
  adminWorkspaceErrorMessage,
  getAdminWorkspacePolicy,
  updateAdminWorkspacePolicy
} from "@/components/admin/adminWorkspaceApi";
import { quietButton } from "@/components/admin/adminPrimitives";
import type { WorkspacePolicyWire } from "@/lib/contracts/workspace";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

function runtimeDetail(policy: WorkspacePolicyWire): string {
  const { runtime } = policy;
  if (runtime.state !== "ready") {
    if (runtime.reasonCode === "workspace_virtualization_unavailable") {
      return "Hardware virtualization is unavailable to the runner.";
    }
    if (runtime.imageReady === false) return "The pinned workspace image is not ready.";
    return "The isolated runtime is not ready.";
  }
  return "The runner, pinned image, and virtualization checks are ready.";
}

function PolicyToggle({
  checked,
  description,
  disabled,
  label,
  onChange
}: Readonly<{
  checked: boolean;
  description: string;
  disabled: boolean;
  label: string;
  onChange(value: boolean): void;
}>) {
  return (
    <label className="grid min-w-0 gap-3 border-b border-trace-subtle py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6">
      <span className="min-w-0">
        <strong className="block text-sm font-medium text-ink">{label}</strong>
        <span className="mt-1 block max-w-2xl text-xs leading-5 text-ink-muted">{description}</span>
      </span>
      <input
        aria-label={label}
        checked={checked}
        className="size-4 shrink-0 accent-proof"
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
    </label>
  );
}

export function AdminWorkspaceSection() {
  const [policy, setPolicy] = useState<WorkspacePolicyWire | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await getAdminWorkspacePolicy();
    setLoading(false);
    if (result.ok) setPolicy(result.data);
    else setError(adminWorkspaceErrorMessage(result.error));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getAdminWorkspacePolicy().then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.ok) setPolicy(result.data);
      else setError(adminWorkspaceErrorMessage(result.error));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function update(patch: Readonly<{ enabled?: boolean; internetEnabled?: boolean }>) {
    if (!policy || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await updateAdminWorkspacePolicy(policy.version, patch);
    setBusy(false);
    if (result.ok) {
      setPolicy(result.data);
      setNotice("Workspace policy updated.");
    } else {
      setError(adminWorkspaceErrorMessage(result.error));
      if (result.error === "workspace_policy_stale") void refresh();
    }
  }

  return (
    <section aria-labelledby="admin-workspace-heading" className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <div className="max-w-4xl">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-trace-subtle pb-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-ink" id="admin-workspace-heading">Workspace policy</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">
              Control isolated per-chat development environments without exposing runner credentials or host details.
            </p>
          </div>
          <button className={quietButton} disabled={loading || busy} onClick={() => void refresh()} type="button">
            <RefreshCw aria-hidden="true" className={`size-3.5 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`} />
            Refresh
          </button>
        </div>

        {error ? <p className="mt-4 border-l-2 border-critical bg-critical/10 px-3 py-2 text-xs text-critical" role="alert">{error}</p> : null}
        {notice ? <p className="mt-4 border-l-2 border-positive bg-positive/10 px-3 py-2 text-xs text-positive" role="status">{notice}</p> : null}

        {policy ? (
          <>
            <dl className="mt-5 grid gap-3 border-y border-trace-subtle py-4 sm:grid-cols-2" aria-live="polite">
              <div className={`border-l-2 pl-3 ${policy.runtime.state === "ready" ? "border-positive" : "border-caution"}`}>
                <dt className="text-metadata font-semibold uppercase tracking-[0.09em] text-ink-muted">Runtime readiness</dt>
                <dd className={`mt-1 text-sm font-medium ${policy.runtime.state === "ready" ? "text-positive" : "text-caution"}`}>
                  {policy.runtime.state === "ready" ? "Ready" : "Unavailable"}
                </dd>
                <dd className="mt-1 text-xs leading-5 text-ink-muted">{runtimeDetail(policy)}</dd>
              </div>
              <div className="border-l-2 border-trace-strong pl-3">
                <dt className="text-metadata font-semibold uppercase tracking-[0.09em] text-ink-muted">Runtime facts</dt>
                <dd className="mt-1 text-sm text-ink">
                  Runtime {policy.runtime.runtimeVersion ?? "unavailable"} · MCP {policy.runtime.mcpVersion ?? "unavailable"}
                </dd>
                <dd className="mt-1 text-xs leading-5 text-ink-muted">
                  Image {policy.runtime.imageReady === true ? "ready" : "not ready"} · Virtualization {policy.runtime.virtualizationReady === true ? "ready" : "not ready"}
                </dd>
              </div>
            </dl>

            <div>
              <PolicyToggle
                checked={policy.enabled}
                description="Makes Workspace available only when the selected model supports tools and the runtime is healthy. New installations default to off."
                disabled={busy}
                label="Enable Workspace"
                onChange={(enabled) => void update({ enabled })}
              />
              <PolicyToggle
                checked={policy.internetEnabled}
                description="Allows public internet access in newly created or reset environments. Existing environments keep their actual network setting until reset."
                disabled={busy}
                label="Allow public internet in new workspaces"
                onChange={(internetEnabled) => void update({ internetEnabled })}
              />
            </div>
          </>
        ) : loading ? (
          <p className="mt-5 text-sm text-ink-muted" role="status">Loading Workspace policy…</p>
        ) : null}
      </div>
    </section>
  );
}

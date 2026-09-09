"use client";

import {
  adminWorkspaceErrorMessage,
  getAdminWorkspacePolicy,
  updateAdminWorkspacePolicy
} from "@/components/admin/adminWorkspaceApi";
import { useAdminSectionTopbar } from "@/components/admin/AdminShell";
import { cardClass, sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import { UiV2Button, UiV2Switch } from "@/components/ui-v2";
import { AdminWorkspaceOverview } from "./AdminWorkspaceOverview";
import type { WorkspacePolicyWire } from "@/lib/contracts/workspace";
import { useCallback, useEffect, useRef, useState } from "react";

const topbar = { title: "Workspace" };

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
    <div className="flex min-w-0 items-center justify-between gap-6 py-4">
      <span className="min-w-0">
        <strong className="block text-sm font-medium text-ink">{label}</strong>
        <span className="mt-1 block max-w-2xl text-xs leading-5 text-ink-muted">{description}</span>
      </span>
      <UiV2Switch
        checked={checked}
        className="shrink-0"
        disabled={disabled}
        label={label}
        onChange={onChange}
      />
    </div>
  );
}

export function AdminWorkspaceSection({ reportNotice }: Readonly<{
  reportNotice: AdminFeedbackController["reportNotice"];
}>) {
  useAdminSectionTopbar(topbar);
  const [policy, setPolicy] = useState<WorkspacePolicyWire | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const readGeneration = useRef(0);
  const mutationPending = useRef(false);
  const pendingRead = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const lastReadAt = useRef(-Infinity);

  const refresh = useCallback(async (force = false) => {
    if (!mounted.current || mutationPending.current || pendingRead.current || document.visibilityState === "hidden" ||
      !force && Date.now() - lastReadAt.current < 5_000) return;
    const generation = ++readGeneration.current;
    const controller = new AbortController();
    pendingRead.current = controller;
    lastReadAt.current = Date.now();
    const result = await getAdminWorkspacePolicy(undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]));
    if (!mounted.current || controller.signal.aborted || generation !== readGeneration.current) return;
    pendingRead.current = null;
    setLoading(false);
    if (result.ok) {
      setPolicy(result.data);
      setReadError(null);
    }
    else {
      if (result.error === "forbidden" || result.error === "unauthorized") setPolicy(null);
      setReadError(adminWorkspaceErrorMessage(result.error));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const onFocus = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        readGeneration.current += 1;
        pendingRead.current?.abort();
        pendingRead.current = null;
      } else onFocus();
    };
    queueMicrotask(() => { void refresh(true); });
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(onFocus, 30_000);
    return () => {
      mounted.current = false;
      readGeneration.current += 1;
      pendingRead.current?.abort();
      pendingRead.current = null;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, [refresh]);

  async function update(patch: Readonly<{ enabled?: boolean; internetEnabled?: boolean }>) {
    if (!policy || mutationPending.current) return;
    mutationPending.current = true;
    readGeneration.current += 1;
    pendingRead.current?.abort();
    pendingRead.current = null;
    setBusy(true);
    setLoading(false);
    setError(null);
    const result = await updateAdminWorkspacePolicy(policy.version, patch);
    if (!mounted.current) return;
    readGeneration.current += 1;
    mutationPending.current = false;
    setBusy(false);
    if (result.ok) {
      setPolicy(result.data);
      reportNotice("Workspace policy updated.");
    } else {
      setError(adminWorkspaceErrorMessage(result.error));
      if (result.error === "workspace_policy_stale") void refresh(true);
    }
  }

  return (
    <section aria-label="Workspace policy" className="flex max-w-[1120px] min-w-0 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <p className="max-w-2xl text-sm leading-6 text-ink-secondary">
        Control isolated development environments for each chat.
      </p>

      {error ? <p className="mt-4 border-l-2 border-critical bg-critical/10 px-3 py-2 text-xs text-critical" role="alert">{error}</p> : null}
      {readError ? <p className="text-xs leading-5 text-critical" role="alert">{readError}</p> : null}

      {policy ? (
        <>
          <div className={`${cardClass} px-5 py-1`}>
            <h2 className={`${sectionHeadingClass} pt-4`}>Workspace access</h2>
            <PolicyToggle
              checked={policy.enabled}
              description="Enabled by default. Workspace is available when the selected model supports tools and the runtime is ready."
              disabled={busy}
              label="Enable Workspace"
              onChange={(enabled) => void update({ enabled })}
            />
            <div className="border-t border-trace-subtle">
              <PolicyToggle
                checked={policy.internetEnabled}
                description="Allows public internet access in newly created or reset environments. Existing environments keep their network setting until reset."
                disabled={busy}
                label="Allow public internet in new workspaces"
                onChange={(internetEnabled) => void update({ internetEnabled })}
              />
            </div>
          </div>
          <AdminWorkspaceOverview />
          <dl className={`${cardClass} grid min-w-0 gap-5 p-5 sm:grid-cols-2`} aria-live="polite">
            <div className="min-w-0">
              <dt className={sectionHeadingClass}>Runtime readiness</dt>
              <dd className={`mt-1 text-sm font-medium ${policy.runtime.state === "ready" ? "text-positive" : "text-caution"}`}>
                {policy.runtime.state === "ready" ? "Ready" : "Unavailable"}
              </dd>
              <dd className="mt-1 text-xs leading-5 text-ink-muted">{runtimeDetail(policy)}</dd>
            </div>
            <div className="min-w-0">
              <dt className={sectionHeadingClass}>Runtime facts</dt>
              <dd className="mt-1 break-words font-mono text-xs text-ink [overflow-wrap:anywhere]">
                Runtime {policy.runtime.runtimeVersion ?? "unavailable"} · MCP {policy.runtime.mcpVersion ?? "unavailable"}
              </dd>
              <dd className="mt-1 text-xs leading-5 text-ink-muted">
                Image {policy.runtime.imageReady === true ? "ready" : "not ready"} · Virtualization {policy.runtime.virtualizationReady === true ? "ready" : "not ready"}
              </dd>
            </div>
          </dl>

        </>
      ) : loading ? (
        <p className="mt-5 text-sm text-ink-muted" role="status">Loading Workspace policy…</p>
      ) : <UiV2Button className="self-start" onClick={() => { setLoading(true); void refresh(true); }} tone="ghost">Try again</UiV2Button>}
    </section>
  );
}

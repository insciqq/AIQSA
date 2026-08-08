"use client";

import {
  adminModelPolicyErrorMessage,
  getAdminModelPolicy,
  updateAdminModelPolicy
} from "@/components/admin/adminModelPolicyApi";
import {
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import type { AdminModelPolicyCatalog } from "@/lib/contracts/adminModelPolicy";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export function AdminProviderModelDefaultTask({
  active,
  onMutationCommitted
}: Readonly<{
  active: boolean;
  onMutationCommitted?(): void | Promise<unknown>;
}>) {
  const [catalog, setCatalog] = useState<AdminModelPolicyCatalog | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const autoLoadAttemptedRef = useRef(false);

  const apply = useCallback((next: AdminModelPolicyCatalog) => {
    setCatalog(next);
    setSelectedId(next.policy.defaultModel?.id ?? "");
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await getAdminModelPolicy();
    setLoading(false);
    if (result.ok) {
      apply(result.data);
      return;
    }
    setError(adminModelPolicyErrorMessage(result.error));
  }, [apply]);

  useEffect(() => {
    if (!active) {
      autoLoadAttemptedRef.current = false;
      return;
    }
    if (catalog || loading || autoLoadAttemptedRef.current) return;
    let disposed = false;
    queueMicrotask(() => {
      if (disposed || autoLoadAttemptedRef.current) return;
      autoLoadAttemptedRef.current = true;
      void refresh();
    });
    return () => {
      disposed = true;
    };
  }, [active, catalog, loading, refresh]);

  const save = async (providerModelId: string | null) => {
    if (!catalog || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await updateAdminModelPolicy({
      expectedVersion: catalog.policy.version,
      providerModelId
    });
    setBusy(false);
    if (!result.ok) {
      setError(adminModelPolicyErrorMessage(result.error));
      return;
    }
    apply(result.data);
    setNotice(providerModelId ? "Installation default updated." : "Installation default cleared.");
    void Promise.resolve(onMutationCommitted?.()).catch(() => undefined);
  };

  return (
    <section className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7" aria-labelledby="provider-model-default-heading">
      <div className="max-w-3xl">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-trace-subtle pb-4">
          <div>
            <p className="text-metadata font-semibold uppercase tracking-[0.1em] text-ink-muted">Installation policy</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink" id="provider-model-default-heading">Default model</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">
              New chats inherit this deployment when a person has not chosen a personal default and already has access to it. This policy never grants access.
            </p>
          </div>
          <button className={quietButton} disabled={loading || busy} onClick={() => void refresh()} type="button">
            <RefreshCw aria-hidden="true" className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {error ? <p className="mt-4 rounded-control bg-critical/10 px-3 py-2 text-xs text-critical" role="alert">{error}</p> : null}
        {notice ? <p className="mt-4 rounded-control bg-positive/10 px-3 py-2 text-xs text-positive" role="status">{notice}</p> : null}

        {catalog ? (
          <div className="mt-5 grid gap-4">
            <div className="border-l-2 border-proof/60 pl-3 text-xs leading-5 text-ink-secondary">
              <p>
                Current: {catalog.policy.defaultModel
                  ? `${catalog.policy.defaultModel.connectionDisplayName} / ${catalog.policy.defaultModel.displayName}`
                  : "None"}.
              </p>
              {catalog.policy.defaultModel && !catalog.policy.defaultModel.available ? (
                <p className="text-caution">The configured deployment is currently unavailable. It remains selected until you replace or clear it.</p>
              ) : null}
              <p>Policy version: {catalog.policy.version}.</p>
              {catalog.policy.updatedBy ? <p>Last changed by {catalog.policy.updatedBy.displayName}.</p> : null}
            </div>

            <label className="grid gap-1.5 text-xs font-medium text-ink-secondary" htmlFor="installation-default-model">
              Active answer model deployment
              <select
                className={inputClass}
                disabled={busy || loading}
                id="installation-default-model"
                onChange={(event) => setSelectedId(event.currentTarget.value)}
                value={selectedId}
              >
                <option value="">No installation default</option>
                {catalog.policy.defaultModel
                  && !catalog.candidates.some((candidate) => candidate.id === catalog.policy.defaultModel?.id) ? (
                    <option disabled value={catalog.policy.defaultModel.id}>
                      Unavailable — {catalog.policy.defaultModel.connectionDisplayName} / {catalog.policy.defaultModel.displayName}
                    </option>
                  ) : null}
                {catalog.candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.connectionDisplayName} / {candidate.displayName}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <button
                className={primaryButton}
                disabled={busy || selectedId === (catalog.policy.defaultModel?.id ?? "")}
                onClick={() => void save(selectedId || null)}
                type="button"
              >
                Save default
              </button>
              <button
                className={quietButton}
                disabled={busy || catalog.policy.defaultModel === null}
                onClick={() => void save(null)}
                type="button"
              >
                Clear default
              </button>
            </div>
          </div>
        ) : loading ? (
          <p className="mt-5 text-sm text-ink-muted" role="status">Loading installation default…</p>
        ) : null}
      </div>
    </section>
  );
}

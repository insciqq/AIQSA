"use client";

import {
  adminSystemModelPolicyErrorMessage,
  getAdminSystemModelPolicy,
  updateAdminSystemModelPolicy
} from "@/components/admin/adminSystemModelPolicyApi";
import {
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import { useAdminDraftProtection } from "@/components/admin/AdminDraftProtection";
import type { AdminSystemModelPolicyCatalog } from "@/lib/contracts/adminSystemModelPolicy";
import { resolveProviderConnectionLabels } from "@/lib/contracts/providerConnectionLabels";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export function AdminProviderSystemModelTask({
  active,
  onMutationCommitted
}: Readonly<{
  active: boolean;
  onMutationCommitted?(): void | Promise<unknown>;
}>) {
  const [catalog, setCatalog] = useState<AdminSystemModelPolicyCatalog | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const autoLoadAttemptedRef = useRef(false);
  const connectionLabels = useMemo(() => resolveProviderConnectionLabels([
    ...(catalog?.candidates ?? []).map(({ connectionDisplayName: name, connectionId: id }) => ({ id, name })),
    ...(catalog?.policy.systemModel
      ? [{
          id: catalog.policy.systemModel.connectionId,
          name: catalog.policy.systemModel.connectionDisplayName
        }]
      : [])
  ]), [catalog]);
  const deploymentLabel = (deployment: AdminSystemModelPolicyCatalog["candidates"][number]) =>
    `${connectionLabels.get(deployment.connectionId) ?? deployment.connectionDisplayName} / ${deployment.displayName}`;
  const currentId = catalog?.policy.systemModel?.id ?? "";
  const draftDirty = Boolean(catalog) && selectedId !== currentId;
  const requestDraftDiscard = useAdminDraftProtection({
    dirty: draftDirty,
    onDiscard: () => setSelectedId(currentId),
    owner: "provider-system-model-policy",
    pending: draftDirty && busy
  });

  const apply = useCallback((next: AdminSystemModelPolicyCatalog) => {
    setCatalog(next);
    setSelectedId(next.policy.systemModel?.id ?? "");
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await getAdminSystemModelPolicy();
    setLoading(false);
    if (result.ok) {
      apply(result.data);
      return;
    }
    setError(adminSystemModelPolicyErrorMessage(result.error));
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
    const result = await updateAdminSystemModelPolicy({
      expectedVersion: catalog.policy.version,
      providerModelId
    });
    setBusy(false);
    if (!result.ok) {
      setError(adminSystemModelPolicyErrorMessage(result.error));
      return;
    }
    apply(result.data);
    setNotice(providerModelId ? "System model updated." : "System model cleared.");
    void Promise.resolve(onMutationCommitted?.()).catch(() => undefined);
  };

  const canSave = Boolean(catalog) && (
    selectedId !== currentId || Boolean(catalog?.policy.systemModel?.available === false)
  );

  return (
    <section
      aria-labelledby="provider-system-model-heading"
      className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7"
    >
      <div className="max-w-3xl">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-trace-subtle pb-4">
          <div>
            <p className="text-metadata font-semibold uppercase tracking-[0.1em] text-ink-muted">Installation role</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink" id="provider-system-model-heading">System model</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">
              Internal utility work uses this exact deployment. The role grants no user access and never falls back to another model.
            </p>
          </div>
          <button
            className={quietButton}
            disabled={loading || busy}
            onClick={() => requestDraftDiscard(() => {
              void refresh();
            })}
            type="button"
          >
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
                Current: {catalog.policy.systemModel
                  ? deploymentLabel(catalog.policy.systemModel)
                  : "None"}.
              </p>
              {catalog.policy.systemModel ? (
                <p className={catalog.policy.systemModel.available ? "text-ink-secondary" : "text-caution"}>
                  Status: {catalog.policy.systemModel.available ? "Available" : "Unavailable"}.
                  {!catalog.policy.systemModel.available
                    ? " It remains selected, but internal work fails closed until you re-save, replace, or clear it."
                    : ""}
                </p>
              ) : null}
              <p>Policy version: {catalog.policy.version}.</p>
              {catalog.policy.updatedBy ? (
                <p>
                  Provider access resolves as {catalog.policy.updatedBy.displayName}, the administrator who last saved this role.
                </p>
              ) : null}
            </div>

            <label className="grid gap-1.5 text-xs font-medium text-ink-secondary" htmlFor="system-model-deployment">
              Active answer model deployment
              <select
                className={inputClass}
                disabled={busy || loading}
                id="system-model-deployment"
                onChange={(event) => setSelectedId(event.currentTarget.value)}
                value={selectedId}
              >
                <option value="">No system model</option>
                {catalog.policy.systemModel &&
                  !catalog.candidates.some((candidate) => candidate.id === catalog.policy.systemModel?.id) ? (
                    <option disabled value={catalog.policy.systemModel.id}>
                      Unavailable — {deploymentLabel(catalog.policy.systemModel)}
                    </option>
                  ) : null}
                {catalog.candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {deploymentLabel(candidate)}
                  </option>
                ))}
              </select>
            </label>

            <p className="text-xs leading-5 text-ink-muted">
              Re-saving binds credential resolution to your current direct, group, or connection-default administrator access.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <button
                className={primaryButton}
                disabled={busy || !canSave}
                onClick={() => void save(selectedId || null)}
                type="button"
              >
                Save system model
              </button>
              <button
                className={quietButton}
                disabled={busy || catalog.policy.systemModel === null}
                onClick={() => void save(null)}
                type="button"
              >
                Clear system model
              </button>
            </div>
          </div>
        ) : loading ? (
          <p className="mt-5 text-sm text-ink-muted" role="status">Loading system model…</p>
        ) : null}
      </div>
    </section>
  );
}

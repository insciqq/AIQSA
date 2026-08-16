"use client";

import {
  adminSystemModelPolicyErrorMessage,
  getAdminSystemModelPolicy,
  updateAdminSystemModelPolicy,
  verifyAdminSystemModelStructuredOutput
} from "@/components/admin/adminSystemModelPolicyApi";
import {
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import { useAdminDraftProtection } from "@/components/admin/AdminDraftProtection";
import type {
  AdminSystemModelCandidate,
  AdminSystemModelPolicyCatalog
} from "@/lib/contracts/adminSystemModelPolicy";
import { resolveProviderConnectionLabels } from "@/lib/contracts/providerConnectionLabels";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function mcpAutoStatus(status: AdminSystemModelCandidate["structuredOutput"]): string {
  if (status === "verified") return "MCP Auto: Ready.";
  if (status === "not_verified") return "MCP Auto: Verification required.";
  return "MCP Auto: Not supported by this adapter.";
}

export function AdminProviderSystemModelTask({
  active,
  onMutationCommitted
}: Readonly<{
  active: boolean;
  onMutationCommitted?(): void | Promise<unknown>;
}>) {
  const [catalog, setCatalog] = useState<AdminSystemModelPolicyCatalog | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
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
  const currentReasoningEffort = catalog?.policy.reasoningEffort ?? "";
  const selectedDeployment = selectedId
    ? catalog?.candidates.find((candidate) => candidate.id === selectedId) ??
      (catalog?.policy.systemModel?.id === selectedId ? catalog.policy.systemModel : null)
    : null;
  const draftDirty = Boolean(catalog) && (
    selectedId !== currentId || selectedReasoningEffort !== currentReasoningEffort
  );
  const busy = saving || verifying;
  const requestDraftDiscard = useAdminDraftProtection({
    dirty: draftDirty,
    onDiscard: () => {
      setSelectedId(currentId);
      setSelectedReasoningEffort(currentReasoningEffort);
    },
    owner: "provider-system-model-policy",
    pending: draftDirty && busy
  });

  const apply = useCallback((next: AdminSystemModelPolicyCatalog) => {
    setCatalog(next);
    setSelectedId(next.policy.systemModel?.id ?? "");
    setSelectedReasoningEffort(next.policy.reasoningEffort ?? "");
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

  const save = async (providerModelId: string | null, reasoningEffort: string | null) => {
    if (!catalog || busy) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const result = await updateAdminSystemModelPolicy({
      expectedVersion: catalog.policy.version,
      providerModelId,
      reasoningEffort
    });
    setSaving(false);
    if (!result.ok) {
      setError(adminSystemModelPolicyErrorMessage(result.error));
      return;
    }
    apply(result.data);
    setNotice(providerModelId ? "System model updated." : "System model cleared.");
    void Promise.resolve(onMutationCommitted?.()).catch(() => undefined);
  };

  const verifyStructuredOutput = async () => {
    const systemModel = catalog?.policy.systemModel;
    if (!systemModel || systemModel.structuredOutput !== "not_verified" ||
      busy || draftDirty) return;
    setVerifying(true);
    setError(null);
    setNotice(null);
    const result = await verifyAdminSystemModelStructuredOutput(systemModel.id);
    setVerifying(false);
    if (!result.ok) {
      setError(adminSystemModelPolicyErrorMessage(result.error));
      return;
    }
    apply(result.data);
    setNotice("Structured output verified. MCP Auto is ready.");
    void Promise.resolve(onMutationCommitted?.()).catch(() => undefined);
  };

  const canSave = Boolean(catalog) && (
    selectedId !== currentId || selectedReasoningEffort !== currentReasoningEffort ||
    Boolean(catalog?.policy.systemModel?.available === false)
  );

  function selectDeployment(providerModelId: string) {
    setSelectedId(providerModelId);
    if (!providerModelId) {
      setSelectedReasoningEffort("");
      return;
    }
    const deployment = catalog?.candidates.find((candidate) => candidate.id === providerModelId) ??
      (catalog?.policy.systemModel?.id === providerModelId ? catalog.policy.systemModel : null);
    if (!deployment) {
      setSelectedReasoningEffort("");
      return;
    }
    setSelectedReasoningEffort((current) => {
      if (current && deployment.reasoningEfforts.includes(current)) return current;
      if (deployment.reasoningEfforts.includes("xhigh")) return "xhigh";
      return deployment.defaultReasoningEffort ?? "";
    });
  }

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
                  ? `${deploymentLabel(catalog.policy.systemModel)} · reasoning ${catalog.policy.reasoningEffort ?? "provider default"}`
                  : "None"}.
              </p>
              {catalog.policy.systemModel ? (
                <>
                  <p className={catalog.policy.systemModel.available ? "text-ink-secondary" : "text-caution"}>
                    Status: {catalog.policy.systemModel.available ? "Available" : "Unavailable"}.
                    {!catalog.policy.systemModel.available
                      ? " It remains selected, but internal work fails closed until you re-save, replace, or clear it."
                      : ""}
                  </p>
                  <p className={catalog.policy.systemModel.structuredOutput === "verified"
                    ? "text-ink-secondary"
                    : "text-caution"}>
                    {mcpAutoStatus(catalog.policy.systemModel.structuredOutput)}
                  </p>
                  {catalog.policy.systemModel.structuredOutput === "not_verified" ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <p className="max-w-xl text-ink-muted">
                        Verification sends one small model request and may incur provider charges.
                      </p>
                      <button
                        className={quietButton}
                        disabled={busy || loading || draftDirty}
                        onClick={() => void verifyStructuredOutput()}
                        type="button"
                      >
                        {verifying ? "Verifying…" : "Run verification"}
                      </button>
                    </div>
                  ) : catalog.policy.systemModel.structuredOutput === "unsupported" ? (
                    <p className="text-ink-muted">
                      Supported paths are OpenAI Responses, Responses-compatible deployments, and OpenRouter Chat Completions.
                    </p>
                  ) : null}
                </>
              ) : null}
              <p>Policy version: {catalog.policy.version}.</p>
              {catalog.policy.updatedBy ? (
                <p>
                  Last saved by {catalog.policy.updatedBy.displayName}.
                </p>
              ) : null}
            </div>

            <label className="grid gap-1.5 text-xs font-medium text-ink-secondary" htmlFor="system-model-deployment">
              Active answer model deployment
              <select
                className={inputClass}
                disabled={busy || loading}
                id="system-model-deployment"
                onChange={(event) => selectDeployment(event.currentTarget.value)}
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

            <label className="grid gap-1.5 text-xs font-medium text-ink-secondary" htmlFor="system-model-reasoning-effort">
              Reasoning effort
              <select
                className={inputClass}
                disabled={busy || loading || !selectedDeployment}
                id="system-model-reasoning-effort"
                onChange={(event) => setSelectedReasoningEffort(event.currentTarget.value)}
                value={selectedReasoningEffort}
              >
                <option value="">Provider default</option>
                {selectedReasoningEffort &&
                  !selectedDeployment?.reasoningEfforts.includes(selectedReasoningEffort) ? (
                    <option disabled value={selectedReasoningEffort}>
                      Unavailable — {selectedReasoningEffort}
                    </option>
                  ) : null}
                {(selectedDeployment?.reasoningEfforts ?? []).map((effort) => (
                  <option key={effort} value={effort}>{effort}</option>
                ))}
              </select>
            </label>

            <p className="text-xs leading-5 text-ink-muted">
              Runtime uses the selected connection&apos;s installation-default credential. Reasoning choices are limited to capabilities advertised by that deployment.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <button
                className={primaryButton}
                disabled={busy || !canSave}
                onClick={() => void save(selectedId || null, selectedId ? selectedReasoningEffort || null : null)}
                type="button"
              >
                Save system model
              </button>
              <button
                className={quietButton}
                disabled={busy || catalog.policy.systemModel === null}
                onClick={() => void save(null, null)}
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

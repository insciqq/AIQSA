"use client";

import {
  EmptyState,
  inputClass,
  quietButton
} from "@/components/admin/adminPrimitives";
import {
  activeProviderCheckLabel,
  providerCredentialUsable
} from "@/components/admin/providerAdvancedView";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import { RefreshCw, TestTube2 } from "lucide-react";
import { useState } from "react";

const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";

export function AdminProviderDiagnosticsTask({
  connection,
  controller,
  requestConfirmation
}: Readonly<{
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>) {
  const draftCredentials = connection.credentials.filter(providerCredentialUsable);
  const draftModels = connection.models.filter(({ enabled }) => enabled);
  const activeCredentials = connection.credentials.filter((credential) =>
    credential.enabled && credential.activeVersion && !credential.activeVersion.revokedAt
  );
  const activeModels = connection.models.filter((model) =>
    model.enabled && model.activeConfig && model.activeVersion > 0
  );
  const [draftModelId, setDraftModelId] = useState(draftModels[0]?.id ?? "");
  const [draftCredentialId, setDraftCredentialId] = useState(
    connection.defaultCredentialId ?? draftCredentials[0]?.id ?? ""
  );
  const [activeModelId, setActiveModelId] = useState(activeModels[0]?.id ?? "");
  const [activeCredentialId, setActiveCredentialId] = useState(
    connection.defaultCredentialId ?? activeCredentials[0]?.id ?? ""
  );
  const draftModel = draftModels.find(({ id }) => id === draftModelId) ?? draftModels[0];
  const draftCredential = draftCredentials.find(({ id }) => id === draftCredentialId) ?? draftCredentials[0];
  const activeModel = activeModels.find(({ id }) => id === activeModelId) ?? activeModels[0];
  const activeCredential = activeCredentials.find(({ id }) => id === activeCredentialId) ?? activeCredentials[0];
  const latestDraft = draftModel && draftCredential
    ? connection.draftChecks.find((check) =>
        check.connectionDraftVersion === connection.draftVersion &&
        check.modelDraftVersion === draftModel.draftVersion &&
        check.providerModelId === draftModel.id &&
        check.credentialId === draftCredential.id
      ) ?? null
    : null;
  const latestActive = activeModel && activeCredential?.activeVersion
    ? connection.activeChecks.find((check) =>
        check.connectionVersion === connection.activeVersion &&
        check.modelVersion === activeModel.activeVersion &&
        check.providerModelId === activeModel.id &&
        check.credentialId === activeCredential.id &&
        check.credentialVersionId === activeCredential.activeVersion!.id
      ) ?? null
    : null;
  const paid = connection.family !== "openrouter";

  const runDraftDiagnostic = () => {
    if (!draftModel || !draftCredential) return;
    const run = () => controller.actions.testDraft(connection.id, draftModel.id, {
      confirmPaidRequest: paid,
      credentialId: draftCredential.id,
      mode: paid ? "tiny_generation" : "account_catalog"
    });
    if (!paid) {
      void run();
      return;
    }
    requestConfirmation({
      body: "This diagnostic sends a tiny generation request and may charge the selected provider account for up to 16 output tokens.",
      confirmLabel: "Run paid diagnostic",
      dialogLabel: "Run paid provider diagnostic",
      onConfirm: async () => {
        await run();
      },
      testId: "admin-confirm-provider-paid-diagnostic",
      title: "Run a paid model diagnostic?",
      tone: "warning"
    });
  };

  const runActiveRefresh = () => {
    if (!activeModel || !activeCredential) return;
    const run = () => controller.actions.refreshActive(
      connection.id,
      activeModel.id,
      activeCredential.id,
      paid
    );
    if (!paid) {
      void run();
      return;
    }
    requestConfirmation({
      body: "Refreshing this exact active model and key performs a tiny generation request and may consume provider quota.",
      confirmLabel: "Refresh active check",
      dialogLabel: "Refresh active provider check",
      onConfirm: async () => {
        await run();
      },
      testId: "admin-confirm-provider-active-refresh",
      title: "Refresh with a paid request?",
      tone: "warning"
    });
  };

  return (
    <section className="min-w-0" data-testid="provider-task-diagnostics">
      <div className="border-b border-trace-subtle px-4 py-5 sm:px-6">
        <h3 className="text-base font-semibold text-ink">Diagnostics</h3>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-muted">
          Optional checks inspect one exact model and credential tuple. They do not grant access and never replace server validation during activation or run admission.
        </p>
      </div>

      <div className="grid gap-4 border-b border-trace-subtle px-4 py-5 sm:px-6">
        <div>
          <h4 className="text-sm font-semibold text-ink">Draft diagnostic</h4>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            Check the current unsaved/active key source against the current model draft. Saving another draft makes this evidence stale.
          </p>
        </div>
        {draftModel && draftCredential ? (
          <div className="grid max-w-3xl gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
            <label>
              <span className={fieldLabel}>Model</span>
              <select
                className={inputClass}
                disabled={controller.state.busy}
                onChange={(event) => setDraftModelId(event.currentTarget.value)}
                value={draftModel.id}
              >
                {draftModels.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
              </select>
            </label>
            <label>
              <span className={fieldLabel}>Credential</span>
              <select
                className={inputClass}
                disabled={controller.state.busy}
                onChange={(event) => setDraftCredentialId(event.currentTarget.value)}
                value={draftCredential.id}
              >
                {draftCredentials.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <button className={quietButton} disabled={controller.state.busy} onClick={runDraftDiagnostic} type="button">
              <TestTube2 aria-hidden="true" className="size-3.5" />
              {paid ? "Test model" : "Check model route"}
            </button>
            <p className="text-xs text-ink-muted md:col-span-3">
              Latest exact draft result: <span className={
                !latestDraft
                  ? "text-ink-muted"
                  : latestDraft.status === "available"
                    ? "text-positive"
                    : "text-critical"
              }>{latestDraft?.status ?? "Not run"}</span>
            </p>
          </div>
        ) : (
          <EmptyState detail="Create an enabled model and a usable credential first." title="Nothing to diagnose yet" />
        )}
      </div>

      <div className="grid gap-4 px-4 py-5 sm:px-6">
        <div>
          <h4 className="text-sm font-semibold text-ink">Active availability</h4>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            Refresh the exact active deployment and immutable credential version used by new admissions. A transient failure preserves matching prior authority and marks it for attention.
          </p>
        </div>
        {activeModel && activeCredential ? (
          <div className="grid max-w-3xl gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
            <label>
              <span className={fieldLabel}>Active model</span>
              <select
                className={inputClass}
                disabled={controller.state.busy}
                onChange={(event) => setActiveModelId(event.currentTarget.value)}
                value={activeModel.id}
              >
                {activeModels.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
              </select>
            </label>
            <label>
              <span className={fieldLabel}>Active credential</span>
              <select
                className={inputClass}
                disabled={controller.state.busy}
                onChange={(event) => setActiveCredentialId(event.currentTarget.value)}
                value={activeCredential.id}
              >
                {activeCredentials.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <button className={quietButton} disabled={controller.state.busy} onClick={runActiveRefresh} type="button">
              <RefreshCw aria-hidden="true" className="size-3.5" />
              Refresh active check
            </button>
            <div className="text-xs leading-5 text-ink-muted md:col-span-3">
              {latestActive ? (
                <>
                  <span className={latestActive.status === "available" ? "text-positive" : "text-critical"}>
                    {activeProviderCheckLabel(latestActive)}
                  </span>
                  {latestActive.refreshFailedAt ? ` · Last refresh failed ${latestActive.refreshFailedAt}` : ` · Checked ${latestActive.checkedAt}`}
                </>
              ) : "No matching active check. Activation or an explicit refresh must establish availability."}
            </div>
          </div>
        ) : (
          <EmptyState
            detail="Activate an enabled model and non-revoked credential before refreshing active evidence."
            title="No active tuple to refresh"
          />
        )}
      </div>
    </section>
  );
}

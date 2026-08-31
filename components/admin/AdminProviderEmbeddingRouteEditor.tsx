"use client";

import {
  AdminOpenRouterRouteEditor,
  type AdminOpenRouterRouteDraft
} from "@/components/admin/AdminProviderModelEditor";
import { useAdminDraftProtection } from "@/components/admin/AdminDraftProtection";
import {
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import {
  openRouterModelDiscoveryIdentity,
  type AdminOpenRouterDiscoverySession
} from "@/components/admin/useAdminOpenRouterDiscovery";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import type {
  AdminProviderConnection,
  AdminProviderModel
} from "@/lib/contracts/adminProviders";
import { useMemo, useState } from "react";

const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";
const helpText = "mt-1 text-metadata text-ink-muted";

function credentialCanDiscover(
  credential: AdminProviderConnection["credentials"][number] | undefined
): boolean {
  return Boolean(
    credential?.enabled &&
      (credential.draftSecretConfigured ||
        (credential.activeVersion && credential.activeVersion.revokedAt === null))
  );
}

export function AdminProviderEmbeddingRouteEditor({
  connection,
  controller,
  discovery,
  model,
  onClose
}: Readonly<{
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  discovery: AdminOpenRouterDiscoverySession;
  model: AdminProviderModel;
  onClose(): void;
}>) {
  const [route, setRoute] = useState<AdminOpenRouterRouteDraft>(() => ({
    mode: model.draftConfig.openRouterRouting?.mode ?? "automatic",
    providers: [...(model.draftConfig.openRouterRouting?.providers ?? [])],
    upstreamModelId: model.draftConfig.upstreamModelId
  }));
  const [baseline] = useState(route);
  const [credentialId, setCredentialId] = useState(() => {
    const defaultCredential = connection.credentials.find(
      ({ id }) => id === connection.defaultCredentialId
    );
    return credentialCanDiscover(defaultCredential)
      ? defaultCredential!.id
      : connection.credentials.find(credentialCanDiscover)?.id ?? "";
  });
  const [formError, setFormError] = useState<string | null>(null);
  const dirty = JSON.stringify(route) !== JSON.stringify(baseline);
  const requestDraftDiscard = useAdminDraftProtection({
    dirty,
    onDiscard: () => {
      setRoute(baseline);
      setFormError(null);
    },
    owner: "provider-model-editor",
    pending: dirty && controller.state.busy
  });
  const credential = connection.credentials.find(({ id }) => id === credentialId) ?? null;
  const modelIdentity = useMemo(
    () => openRouterModelDiscoveryIdentity(connection, credential),
    [connection, credential]
  );

  function submit() {
    if (route.mode === "only_selected" && route.providers.length === 0) {
      setFormError("Select at least one downstream provider or use Automatic routing.");
      return;
    }
    setFormError(null);
    const openRouterRouting = route.mode === "automatic"
      ? { mode: "automatic" as const, providers: [] as [] }
      : { mode: "only_selected" as const, providers: route.providers };
    void controller.actions.updateModel(
      connection.id,
      model.id,
      {
        action: "update",
        configuration: {
          ...model.draftConfig,
          openRouterRouting
        },
        displayName: model.displayName,
        expectedDraftVersion: model.draftVersion
      },
      "Embedding provider route saved; prior test evidence is stale."
    ).then((ok) => {
      if (ok) onClose();
    });
  }

  return (
    <form
      className="grid gap-4 rounded-control bg-answer-paper p-3"
      id="provider-model-editor"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div>
        <h4 className="text-sm font-semibold text-ink">Embedding provider route</h4>
        <p className={helpText}>
          Choose the ordered OpenRouter endpoints for future requests. This changes transport only; the model and stored vector space stay unchanged.
        </p>
      </div>

      {connection.credentials.length > 1 ? (
        <label className="max-w-md">
          <span className={fieldLabel}>Credential used for discovery</span>
          <select
            className={inputClass}
            disabled={controller.state.busy}
            onChange={(event) => setCredentialId(event.currentTarget.value)}
            value={credentialId}
          >
            {connection.credentials.map((candidate) => (
              <option
                disabled={!credentialCanDiscover(candidate)}
                key={candidate.id}
                value={candidate.id}
              >
                {candidate.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div>
          <span className={fieldLabel}>Routes available to credential</span>
          <p className="break-words text-sm text-ink">
            {credential?.label ?? "No usable credential"}
          </p>
        </div>
      )}

      <AdminOpenRouterRouteEditor
        credentialId={credentialId}
        discovery={discovery}
        modelIdentity={modelIdentity}
        onChange={setRoute}
        route={route}
        selectedModeHelp="Try selected providers in priority order; fallback never leaves this list."
      />

      {formError ? <p className="text-xs text-critical" role="alert">{formError}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button className={primaryButton} disabled={controller.state.busy} type="submit">
          Save provider route
        </button>
        <button
          className={quietButton}
          disabled={controller.state.busy}
          onClick={() => requestDraftDiscard(onClose)}
          type="button"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

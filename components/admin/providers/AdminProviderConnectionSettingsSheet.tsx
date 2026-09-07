"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { AdminSheet } from "@/components/admin/AdminSheet";
import { effectiveEndpoint, isCustomProvider } from "@/components/admin/providers/providerListView";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2Button } from "@/components/ui-v2";
import {
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_DEFAULT_SECONDS,
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS,
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS,
  type AdminProviderConnection
} from "@/lib/contracts/adminProviders";
import { useId, useState } from "react";

const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";
const helpText = "mt-1 block text-xs leading-5 text-ink-muted";

type SettingsForm = Readonly<{
  allowPrivateNetwork: boolean;
  apiRoot: string;
  displayName: string;
  responseTimeoutSeconds: string;
  secret: string;
}>;

function initialForm(connection: AdminProviderConnection): SettingsForm {
  return {
    allowPrivateNetwork: connection.draftConfig.allowPrivateNetwork,
    apiRoot: connection.draftConfig.apiRoot,
    displayName: connection.displayName,
    responseTimeoutSeconds: String(
      connection.draftConfig.responseTimeoutSeconds ?? ADMIN_PROVIDER_RESPONSE_TIMEOUT_DEFAULT_SECONDS
    ),
    secret: ""
  };
}

function SettingsSheetBody({
  connection,
  controller,
  onClose
}: Readonly<{
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  onClose(): void;
}>) {
  const [form, setForm] = useState(() => initialForm(connection));
  const [baseline] = useState(form);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const formId = useId();
  const errorId = useId();
  const busy = controller.state.busy;
  const live = connection.activeConfig !== null;
  const endpointChanged = form.apiRoot.trim() !== effectiveEndpoint(connection).trim();
  const defaultKey = connection.credentials.find(({ id }) => id === connection.defaultCredentialId) ?? null;
  const keyRequired = live && endpointChanged && defaultKey !== null;
  const dirty = form.allowPrivateNetwork !== baseline.allowPrivateNetwork ||
    form.apiRoot !== baseline.apiRoot ||
    form.displayName !== baseline.displayName ||
    form.responseTimeoutSeconds !== baseline.responseTimeoutSeconds ||
    form.secret !== "";
  const update = (patch: Partial<SettingsForm>) => setForm((current) => ({ ...current, ...patch }));

  const requestClose = () => {
    if (busy) return;
    if (dirty) {
      setDiscarding(true);
      return;
    }
    onClose();
  };

  const submit = async () => {
    setError(null);
    if (keyRequired && !form.secret.trim()) {
      setError(`Enter the key for “${defaultKey!.label}” again so it is only sent to the new endpoint.`);
      return;
    }
    const result = await controller.actions.saveConnectionSettings(connection.id, {
      configuration: {
        allowPrivateNetwork: form.allowPrivateNetwork,
        apiRoot: form.apiRoot.trim(),
        authenticationMode: connection.draftConfig.authenticationMode,
        responseTimeoutSeconds: Number(form.responseTimeoutSeconds)
      },
      displayName: form.displayName.trim(),
      secret: keyRequired ? form.secret.trim() : null
    });
    if (result.ok) {
      onClose();
      return;
    }
    setError(result.message);
  };

  return (
    <AdminSheet
      closeBlocked={busy}
      description={live
        ? "Changes apply to new requests as soon as they are saved."
        : "These settings are used when the first key is saved."}
      footer={(
        <>
          <UiV2Button busy={busy} disabled={!dirty} form={formId} tone="primary" type="submit">
            {live ? "Test & Save" : "Save"}
          </UiV2Button>
          <UiV2Button disabled={busy} onClick={requestClose} tone="ghost" type="button">Cancel</UiV2Button>
          {live ? (
            <span className="min-w-0 text-xs leading-5 text-ink-muted">
              Checks every saved key against the endpoint with one small request each.
            </span>
          ) : null}
        </>
      )}
      onClose={requestClose}
      open
      testId="provider-connection-settings"
      title="Connection settings"
    >
      <form
        className="flex flex-col gap-4"
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          <span className={fieldLabel}>Name</span>
          <input
            className={inputClass}
            disabled={busy}
            maxLength={160}
            onChange={(event) => update({ displayName: event.currentTarget.value })}
            required
            value={form.displayName}
          />
        </label>
        <label>
          <span className={fieldLabel}>Endpoint</span>
          <input
            className={`${inputClass} font-mono text-xs`}
            disabled={busy}
            onChange={(event) => update({ apiRoot: event.currentTarget.value })}
            required
            type="url"
            value={form.apiRoot}
          />
          <span className={helpText}>
            {isCustomProvider(connection)
              ? "The base URL of the API; request paths are added by AIQSA."
              : "Leave the vendor endpoint unless you route through a gateway."}
          </span>
        </label>
        {keyRequired ? (
          <label>
            <span className={fieldLabel}>API key for {defaultKey!.label}</span>
            <input
              aria-errormessage={error ? errorId : undefined}
              aria-invalid={error ? true : undefined}
              autoComplete="off"
              className={`${inputClass} font-mono`}
              disabled={busy}
              onChange={(event) => update({ secret: event.currentTarget.value })}
              placeholder="sk-…"
              spellCheck={false}
              type="password"
              value={form.secret}
            />
            <span className={helpText}>
              The endpoint changed, so the key is entered again and only ever sent to the new endpoint.
            </span>
          </label>
        ) : null}
        <label>
          <span className={fieldLabel}>Response timeout (seconds)</span>
          <input
            className={inputClass}
            disabled={busy}
            max={ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS}
            min={ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS}
            onChange={(event) => update({ responseTimeoutSeconds: event.currentTarget.value })}
            required
            step={1}
            type="number"
            value={form.responseTimeoutSeconds}
          />
          <span className={helpText}>
            How long one answer may take, from {ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS} to {ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS} seconds.
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm text-ink">
          <input
            checked={form.allowPrivateNetwork}
            className="mt-1 size-4 shrink-0 accent-proof"
            disabled={busy}
            onChange={(event) => update({ allowPrivateNetwork: event.currentTarget.checked })}
            type="checkbox"
          />
          <span>
            Private network
            <span className={helpText}>Allow a local or private endpoint. Keep this off for public providers.</span>
          </span>
        </label>
        {error ? (
          <p className="text-xs leading-5 text-critical" id={errorId} role="alert">{error}</p>
        ) : null}
      </form>
      {discarding ? (
        <ConfirmationDialog
          confirmLabel="Discard changes"
          dialogLabel="Discard unsaved connection settings"
          icon="x"
          onCancel={() => setDiscarding(false)}
          onConfirm={() => {
            setDiscarding(false);
            onClose();
          }}
          testId="provider-connection-settings-discard"
          title="Discard unsaved changes?"
          tone="warning"
        >
          Edits to the connection settings will be lost.
        </ConfirmationDialog>
      ) : null}
    </AdminSheet>
  );
}

/**
 * Connection settings sheet (PRD 5.4): name, endpoint, timeout and private
 * network behind one `Test & Save`. A changed endpoint asks for the default
 * key again so a stored key is never sent to an endpoint it was not saved for.
 * The dialog for unsaved edits lives inside the sheet because the page behind
 * an open sheet is inert.
 */
export function AdminProviderConnectionSettingsSheet({
  connection,
  controller,
  onClose,
  open
}: Readonly<{
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  onClose(): void;
  open: boolean;
}>) {
  if (!open) return null;
  return <SettingsSheetBody connection={connection} controller={controller} onClose={onClose} />;
}

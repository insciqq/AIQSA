"use client";

import {
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import { useAdminDraftProtection } from "@/components/admin/AdminDraftProtection";
import {
  providerFamilyLabel,
  providerFamilyRoot,
  type ProviderAdvancedFamily
} from "@/components/admin/providerAdvancedView";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import type {
  AdminProviderConnection,
  AdminProviderFamily
} from "@/lib/contracts/adminProviders";
import {
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_DEFAULT_SECONDS,
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS,
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS
} from "@/lib/contracts/adminProviders";
import { useRef, useState } from "react";

type ConnectionForm = {
  allowPrivateNetwork: boolean;
  apiRoot: string;
  authenticationMode: "bearer" | "none";
  displayName: string;
  family: AdminProviderFamily;
  responseTimeoutSeconds: string;
};

const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";
const helpText = "mt-1 text-xs leading-5 text-ink-muted";

function blankConnection(family: ProviderAdvancedFamily | null): ConnectionForm {
  const selectedFamily = family ?? "openrouter";
  return {
    allowPrivateNetwork: false,
    apiRoot: providerFamilyRoot(selectedFamily),
    authenticationMode: "bearer",
    displayName: providerFamilyLabel(selectedFamily),
    family: selectedFamily,
    responseTimeoutSeconds: String(ADMIN_PROVIDER_RESPONSE_TIMEOUT_DEFAULT_SECONDS)
  };
}

function connectionForm(connection: AdminProviderConnection): ConnectionForm {
  return {
    allowPrivateNetwork: connection.draftConfig.allowPrivateNetwork,
    apiRoot: connection.draftConfig.apiRoot,
    authenticationMode: connection.draftConfig.authenticationMode ?? "bearer",
    displayName: connection.displayName,
    family: connection.family === "fake" ? "openai_compatible" : connection.family,
    responseTimeoutSeconds: String(
      connection.draftConfig.responseTimeoutSeconds ??
        ADMIN_PROVIDER_RESPONSE_TIMEOUT_DEFAULT_SECONDS
    )
  };
}

export function AdminProviderConnectionEditor({
  connection,
  controller,
  initialFamily,
  onClose
}: Readonly<{
  connection: AdminProviderConnection | null;
  controller: AdminProvidersController;
  initialFamily?: ProviderAdvancedFamily | null;
  onClose(): void;
}>) {
  const [form, setForm] = useState<ConnectionForm>(() =>
    connection ? connectionForm(connection) : blankConnection(initialFamily ?? null)
  );
  const [baseline] = useState(form);
  const expectedDraftVersionRef = useRef(connection?.draftVersion);
  const unassignedPolicyRef = useRef(connection?.unassignedPolicy ?? "use_default");
  const editing = Boolean(connection);
  const draftDirty = JSON.stringify(form) !== JSON.stringify(baseline);
  const requestDraftDiscard = useAdminDraftProtection({
    dirty: draftDirty,
    onDiscard: () => setForm(baseline),
    owner: "provider-connection-editor",
    pending: draftDirty && controller.state.busy
  });

  return (
    <form
      className="grid gap-5 border-b border-trace-subtle bg-answer-paper px-4 py-5 sm:px-6"
      data-testid="provider-connection-editor"
      onSubmit={(event) => {
        event.preventDefault();
        const body = {
          configuration: {
            allowPrivateNetwork: form.allowPrivateNetwork,
            apiRoot: form.apiRoot,
            authenticationMode: form.authenticationMode,
            responseTimeoutSeconds: Number(form.responseTimeoutSeconds)
          },
          displayName: form.displayName,
          family: form.family,
          unassignedPolicy: unassignedPolicyRef.current,
          ...(connection ? { expectedDraftVersion: expectedDraftVersionRef.current } : {})
        };
        void (connection
          ? controller.actions.updateConnection(connection.id, body)
          : controller.actions.createConnection(body)
        ).then((ok) => {
          if (ok) onClose();
        });
      }}
    >
      <div className="max-w-3xl">
        <h3 className="text-base font-semibold text-ink">
          {editing ? "Edit connection" : "New provider connection"}
        </h3>
        <p className={helpText}>
          A connection identifies one endpoint boundary. Credentials and model deployments are configured after this draft is saved.
        </p>
      </div>

      <div className="grid max-w-3xl gap-4 md:grid-cols-2">
        <label>
          <span className={fieldLabel}>Display name</span>
          <input
            className={inputClass}
            disabled={controller.state.busy}
            maxLength={160}
            onChange={(event) => setForm({ ...form, displayName: event.currentTarget.value })}
            required
            value={form.displayName}
          />
        </label>
        <label>
          <span className={fieldLabel}>Provider family</span>
          <select
            className={inputClass}
            disabled={editing || controller.state.busy}
            onChange={(event) => {
              const family = event.currentTarget.value as AdminProviderFamily;
              setForm({
                ...form,
                apiRoot: providerFamilyRoot(family),
                authenticationMode: "bearer",
                displayName: providerFamilyLabel(family),
                family
              });
            }}
            value={form.family}
          >
            <option value="openrouter">OpenRouter</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Gemini</option>
            <option value="openai_compatible">OpenAI-compatible</option>
          </select>
        </label>
        {form.family === "openai_compatible" ? (
          <div className="rounded-control bg-control-surface/60 px-3 py-2.5 text-xs leading-5 text-ink-secondary">
            <p className="font-medium text-ink">Authentication</p>
            <p>{form.authenticationMode === "none" ? "No authentication" : "Bearer API key"}</p>
            <p className="mt-1 text-ink-muted">
              The tested mode is preserved with this connection. Create a different mode through Custom Test &amp; Save.
            </p>
          </div>
        ) : null}
        <label className="md:col-span-2">
          <span className={fieldLabel}>API root</span>
          <input
            className={`${inputClass} font-mono text-xs`}
            disabled={controller.state.busy}
            onChange={(event) => setForm({ ...form, apiRoot: event.currentTarget.value })}
            required
            type="url"
            value={form.apiRoot}
          />
          <span className={helpText}>
            AIQSA derives reviewed request paths from this canonical root. Query strings, embedded credentials, and arbitrary headers are not accepted.
          </span>
        </label>
        <label>
          <span className={fieldLabel}>Response timeout (seconds)</span>
          <input
            className={inputClass}
            disabled={controller.state.busy}
            max={ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS}
            min={ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS}
            onChange={(event) => setForm({
              ...form,
              responseTimeoutSeconds: event.currentTarget.value
            })}
            required
            step={1}
            type="number"
            value={form.responseTimeoutSeconds}
          />
          <span className={helpText}>
            Default complete-response deadline for this endpoint. Use a whole value from 5 to 900 seconds; streaming uses the same deadline.
          </span>
        </label>
        <label className="flex min-h-touch items-start gap-3 rounded-control bg-caution/10 px-3 py-2.5 text-xs leading-5 text-caution md:col-span-2">
          <input
            checked={form.allowPrivateNetwork}
            className="mt-0.5 size-4 shrink-0 accent-proof"
            disabled={controller.state.busy}
            onChange={(event) => setForm({
              ...form,
              allowPrivateNetwork: event.currentTarget.checked
            })}
            type="checkbox"
          />
          Allow only this exact configured private or local endpoint. Public production endpoints should keep this off.
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <button className={primaryButton} disabled={controller.state.busy} type="submit">
          {controller.state.busy ? "Saving…" : "Save connection"}
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

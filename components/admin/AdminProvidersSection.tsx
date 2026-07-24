"use client";

import {
  AdminProviderModelEditor,
  adminProviderAdapterLabel
} from "@/components/admin/AdminProviderModelEditor";
import { AdminRunProfilesPanel } from "@/components/admin/AdminRunProfilesPanel";
import {
  EmptyState,
  dangerButton,
  focusRing,
  inputClass,
  primaryButton,
  quietButton,
  touchTarget
} from "@/components/admin/adminPrimitives";
import {
  deriveProviderUiState,
  type ProviderPrimaryAction
} from "@/components/admin/providerUiState";
import {
  useAdminOpenRouterDiscovery,
  type AdminOpenRouterDiscoverySession
} from "@/components/admin/useAdminOpenRouterDiscovery";
import {
  useAdminProvidersController,
  type AdminProvidersController
} from "@/components/admin/useAdminProvidersController";
import type { AdminGroup } from "@/lib/contracts/admin";
import type {
  AdminProviderConnection,
  AdminProviderCredential,
  AdminProviderFamily,
  AdminProviderModel
} from "@/lib/contracts/adminProviders";
import {
  Check,
  ChevronDown,
  ChevronRight,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  TestTube2,
  Trash2,
  X
} from "lucide-react";
import { useRef, useState } from "react";

export type AdminProvidersSectionProps = Readonly<{
  active: boolean;
  groups: AdminGroup[];
}>;

const fieldLabel = "mb-1 block text-xs font-medium text-content-secondary";
const helpText = "mt-1 text-[11px] leading-4 text-content-muted";

type ConnectionForm = {
  allowPrivateNetwork: boolean;
  apiRoot: string;
  displayName: string;
  family: AdminProviderFamily;
  unassignedPolicy: "require_assignment" | "use_default";
};

function familyRoot(family: AdminProviderFamily): string {
  if (family === "anthropic") return "https://api.anthropic.com/v1";
  if (family === "openrouter") return "https://openrouter.ai/api/v1";
  if (family === "openai") return "https://api.openai.com/v1";
  return "https://provider.example.com/v1";
}

function familyLabel(family: AdminProviderConnection["family"]): string {
  const labels: Record<AdminProviderConnection["family"], string> = {
    anthropic: "Anthropic",
    fake: "Fake",
    openai: "OpenAI",
    openai_compatible: "OpenAI-compatible",
    openrouter: "OpenRouter"
  };
  return labels[family];
}

function blankConnection(): ConnectionForm {
  return {
    allowPrivateNetwork: false,
    apiRoot: familyRoot("openrouter"),
    displayName: "OpenRouter",
    family: "openrouter",
    unassignedPolicy: "use_default"
  };
}

function connectionForm(connection: AdminProviderConnection): ConnectionForm {
  return {
    allowPrivateNetwork: connection.draftConfig.allowPrivateNetwork,
    apiRoot: connection.draftConfig.apiRoot,
    displayName: connection.displayName,
    family: connection.family === "fake" ? "openai_compatible" : connection.family,
    unassignedPolicy: connection.unassignedPolicy
  };
}

function StatePill({
  label,
  tone = "neutral"
}: {
  label: string;
  tone?: "danger" | "neutral" | "success" | "warning";
}) {
  const toneClass = tone === "danger"
    ? "bg-accent-rose/10 text-accent-rose"
    : tone === "success"
      ? "bg-accent-green/10 text-accent-green"
      : tone === "warning"
        ? "bg-accent-amber/10 text-accent-amber"
        : "bg-surface-raised text-content-muted";
  return (
    <span className={`inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] ${toneClass}`}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

function credentialUsable(credential: AdminProviderCredential): boolean {
  return Boolean(
    credential.enabled &&
      (credential.draftSecretConfigured ||
        (credential.activeVersion && credential.activeVersion.revokedAt === null))
  );
}

function CredentialState({ credential }: { credential: AdminProviderCredential }) {
  const revoked = Boolean(credential.activeVersion?.revokedAt);
  const publication = revoked && !credential.draftSecretConfigured
    ? { label: "Revoked", tone: "danger" as const }
    : credential.draftSecretConfigured && credential.activeVersion && !revoked
      ? { label: "Replacement pending", tone: "warning" as const }
      : credential.draftSecretConfigured
        ? { label: "Key draft", tone: "warning" as const }
        : credential.activeVersion && !revoked
          ? { label: `Active v${credential.activeVersion.version}`, tone: "success" as const }
          : { label: "No usable key", tone: "neutral" as const };
  return (
    <span className="flex flex-wrap gap-1.5">
      <StatePill label={credential.enabled ? "Enabled" : "Disabled"} tone={credential.enabled ? "success" : "neutral"} />
      <StatePill {...publication} />
    </span>
  );
}

function ModelState({ model }: { model: AdminProviderModel }) {
  const publication = !model.activeConfig
    ? { label: "Not activated", tone: "neutral" as const }
    : model.activeVersion !== model.draftVersion
      ? { label: "Changes pending", tone: "warning" as const }
      : { label: `Active v${model.activeVersion}`, tone: "success" as const };
  return (
    <span className="flex flex-wrap gap-1.5">
      <StatePill label={model.enabled ? "Enabled" : "Disabled"} tone={model.enabled ? "success" : "neutral"} />
      <StatePill {...publication} />
    </span>
  );
}

function Feedback({ controller }: { controller: AdminProvidersController }) {
  if (
    controller.state.feedbackConnectionId &&
    controller.state.feedbackConnectionId !== controller.state.selectedConnection?.id
  ) {
    return null;
  }
  if (!controller.state.error && !controller.state.notice) return null;
  return (
    <div className="grid gap-2 border-b border-separator-subtle px-4 py-3">
      {controller.state.error ? (
        <div className="flex items-start justify-between gap-3 rounded-control bg-accent-rose/10 px-3 py-2 text-xs leading-5 text-accent-rose" role="alert">
          <span>{controller.state.error}</span>
          <button aria-label="Dismiss provider error" className={quietButton} onClick={controller.actions.dismissError} type="button"><X aria-hidden="true" className="size-3.5" /></button>
        </div>
      ) : null}
      {controller.state.notice ? (
        <div className="flex items-start justify-between gap-3 rounded-control bg-accent-green/10 px-3 py-2 text-xs leading-5 text-accent-green" role="status">
          <span>{controller.state.notice}</span>
          <button aria-label="Dismiss provider notice" className={quietButton} onClick={controller.actions.dismissNotice} type="button"><X aria-hidden="true" className="size-3.5" /></button>
        </div>
      ) : null}
    </div>
  );
}

function ConnectionEditor({
  connection,
  controller,
  onClose
}: {
  connection: AdminProviderConnection | null;
  controller: AdminProvidersController;
  onClose(): void;
}) {
  const [form, setForm] = useState<ConnectionForm>(() =>
    connection ? connectionForm(connection) : blankConnection()
  );
  const expectedDraftVersionRef = useRef(connection?.draftVersion);
  const editing = Boolean(connection);
  return (
    <form
      className="grid gap-4 border-b border-separator-subtle bg-surface-thread p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const body = {
          configuration: {
            allowPrivateNetwork: form.allowPrivateNetwork,
            apiRoot: form.apiRoot
          },
          displayName: form.displayName,
          family: form.family,
          unassignedPolicy: form.unassignedPolicy,
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
      <div>
        <h3 className="text-sm font-semibold text-content-primary">
          {editing ? "Edit connection" : "New provider connection"}
        </h3>
        <p className={helpText}>The API root and protocol remain server-owned. Arbitrary headers and request templates are not accepted.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label>
          <span className={fieldLabel}>Display name</span>
          <input className={inputClass} disabled={controller.state.busy} maxLength={160} onChange={(event) => setForm({ ...form, displayName: event.currentTarget.value })} required value={form.displayName} />
        </label>
        <label>
          <span className={fieldLabel}>Provider family</span>
          <select
            className={inputClass}
            disabled={editing || controller.state.busy}
            onChange={(event) => {
              const family = event.currentTarget.value as AdminProviderFamily;
              setForm({ ...form, apiRoot: familyRoot(family), displayName: familyLabel(family), family });
            }}
            value={form.family}
          >
            <option value="openrouter">OpenRouter</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="openai_compatible">OpenAI-compatible</option>
          </select>
        </label>
        <label className="md:col-span-2">
          <span className={fieldLabel}>Canonical API root</span>
          <input className={`${inputClass} font-mono text-xs`} disabled={controller.state.busy} onChange={(event) => setForm({ ...form, apiRoot: event.currentTarget.value })} required type="url" value={form.apiRoot} />
        </label>
        <label className="flex min-h-control items-center gap-2 rounded-control bg-accent-amber/10 px-3 text-xs text-accent-amber md:col-span-2">
          <input checked={form.allowPrivateNetwork} className="size-4 accent-accent-cyan" disabled={controller.state.busy} onChange={(event) => setForm({ ...form, allowPrivateNetwork: event.currentTarget.checked })} type="checkbox" />
          Allow the exact configured private/local endpoint
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className={primaryButton} disabled={controller.state.busy} type="submit">{controller.state.busy ? "Saving…" : "Save connection"}</button>
        <button className={quietButton} disabled={controller.state.busy} onClick={onClose} type="button">Cancel</button>
      </div>
    </form>
  );
}

function CredentialPanel({
  connection,
  controller
}: {
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
}) {
  const [addOpen, setAddOpen] = useState(connection.credentials.length === 0);
  const [label, setLabel] = useState("Primary");
  const [secret, setSecret] = useState("");
  const [testedSecret, setTestedSecret] = useState<{
    connectionDraftVersion: number;
    value: string;
  } | null>(null);
  const [rotateTarget, setRotateTarget] = useState<{
    credentialId: string;
    expectedDraftVersion: number;
  } | null>(null);
  const [rotatedSecret, setRotatedSecret] = useState("");
  const [testedRotatedSecret, setTestedRotatedSecret] = useState<{
    connectionDraftVersion: number;
    value: string;
  } | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renamedLabel, setRenamedLabel] = useState("");
  const secretIsTested = testedSecret?.connectionDraftVersion === connection.draftVersion &&
    testedSecret.value === secret;
  const rotatedSecretIsTested =
    testedRotatedSecret?.connectionDraftVersion === connection.draftVersion &&
    testedRotatedSecret.value === rotatedSecret;

  function toggleAddKeyForm() {
    if (addOpen) {
      setSecret("");
      setTestedSecret(null);
    }
    setAddOpen(!addOpen);
  }

  return (
    <section className="grid gap-3 p-4" aria-labelledby="provider-credentials-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-content-primary" id="provider-credentials-title">Credentials</h3>
          <p className={helpText}>Keys are write-only. Test validates the exact current input; saved values are never returned.</p>
        </div>
        <button
          aria-expanded={addOpen}
          className={quietButton}
          data-provider-action="add-key"
          disabled={controller.state.busy}
          onClick={toggleAddKeyForm}
          type="button"
        >
          <Plus aria-hidden="true" className="size-3.5" />
          {addOpen ? "Close key form" : "Add key"}
        </button>
      </div>

      {addOpen ? (
        <form
          className="grid gap-2 rounded-control bg-surface-thread p-3 md:grid-cols-[minmax(10rem,0.35fr)_minmax(14rem,1fr)_auto] md:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void controller.actions.createCredential(connection.id, { label, secret }).then((ok) => {
              if (ok) {
                setSecret("");
                setTestedSecret(null);
                setAddOpen(false);
              }
            });
          }}
        >
          <label><span className={fieldLabel}>Key label</span><input className={inputClass} disabled={controller.state.busy} maxLength={160} onChange={(event) => setLabel(event.currentTarget.value)} required value={label} /></label>
          <label><span className={fieldLabel}>API key</span><input autoComplete="new-password" className={`${inputClass} font-mono`} disabled={controller.state.busy} onChange={(event) => { setSecret(event.currentTarget.value); setTestedSecret(null); }} required type="password" value={secret} /></label>
          <div className="flex flex-wrap gap-2">
            <button
              className={quietButton}
              disabled={controller.state.busy || !secret.trim()}
              onClick={() => {
                const candidate = {
                  connectionDraftVersion: connection.draftVersion,
                  value: secret
                };
                void controller.actions.testCredential(connection.id, {
                  expectedConnectionDraftVersion: candidate.connectionDraftVersion,
                  secret: candidate.value
                }).then((ok) => {
                  if (ok) setTestedSecret(candidate);
                });
              }}
              type="button"
            >
              <TestTube2 aria-hidden="true" className="size-3.5" />Test new key
            </button>
            <button className={primaryButton} disabled={controller.state.busy || !secret.trim() || !secretIsTested} type="submit"><KeyRound aria-hidden="true" className="size-3.5" />Save key</button>
          </div>
        </form>
      ) : null}

      {connection.credentials.length ? (
        <div className="grid gap-1" role="list" aria-label="Provider credentials">
          {connection.credentials.map((credential) => (
            <div className="rounded-control bg-surface-thread px-3 py-2.5" key={credential.id} role="listitem">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-words text-xs font-medium text-content-primary">{credential.label}</span>
                    <CredentialState credential={credential} />
                  </div>
                  <p className={helpText}>
                    {credential.draftSecretConfigured && credential.activeVersion && !credential.activeVersion.revokedAt
                      ? `Replacement draft v${credential.draftVersion}; active key v${credential.activeVersion.version} remains in use until activation.`
                      : credential.draftSecretConfigured
                        ? `Key draft v${credential.draftVersion} is ready for activation.`
                        : credential.activeVersion?.revokedAt
                          ? `Key version ${credential.activeVersion.version} was revoked.`
                          : credential.activeVersion
                            ? `Active key version ${credential.activeVersion.version}.`
                            : "No usable key material."}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <button aria-label={`Rename ${credential.label} credential`} className={quietButton} disabled={controller.state.busy} onClick={() => { setRenameId(credential.id); setRotateTarget(null); setRenamedLabel(credential.label); }} type="button">Rename</button>
                  <button aria-label={`Rotate ${credential.label} credential`} className={quietButton} disabled={controller.state.busy} onClick={() => { setRotateTarget({ credentialId: credential.id, expectedDraftVersion: credential.draftVersion }); setRenameId(null); setRotatedSecret(""); setTestedRotatedSecret(null); }} type="button">Rotate</button>
                  <details className="relative">
                    <summary aria-label={`More actions for ${credential.label} credential`} className={`${quietButton} cursor-pointer list-none`}><MoreHorizontal aria-hidden="true" className="size-3.5" />More</summary>
                    <div className="absolute right-0 top-full z-20 mt-1 grid min-w-48 gap-1 rounded-panel border border-separator-subtle bg-surface-overlay p-2 shadow-overlay">
                      <button aria-label={`${credential.enabled ? "Disable" : "Enable"} ${credential.label} credential`} className={quietButton} disabled={controller.state.busy} onClick={() => void controller.actions.updateCredential(connection.id, credential.id, { action: credential.enabled ? "disable" : "enable" }, credential.enabled ? "Credential disabled for new runs." : "Credential enabled; activation will validate it before use.")} type="button">{credential.enabled ? "Disable credential" : "Enable credential"}</button>
                      {credential.draftSecretConfigured ? <button aria-label={`Clear ${credential.label} key draft`} className={dangerButton} disabled={controller.state.busy} onClick={() => { if (window.confirm("Clear this unactivated key draft?")) void controller.actions.updateCredential(connection.id, credential.id, { action: "clear_draft", confirmed: true, expectedDraftVersion: credential.draftVersion }, "Credential draft cleared."); }} type="button">Clear key draft</button> : null}
                      {credential.activeVersion && !credential.activeVersion.revokedAt ? <button aria-label={`Revoke ${credential.label} active key`} className={dangerButton} disabled={controller.state.busy} onClick={() => { if (window.confirm("Emergency-revoke this active key version and clear its encrypted value? Accepted calls that already loaded it cannot be recalled.")) void controller.actions.updateCredential(connection.id, credential.id, { action: "revoke_active_version", clearSecret: true, confirmed: true, versionId: credential.activeVersion!.id }, "Active credential version revoked."); }} type="button">Revoke active key</button> : null}
                      <button aria-label={`Delete ${credential.label} credential`} className={dangerButton} disabled={controller.state.busy} onClick={() => { if (window.confirm(`Delete credential “${credential.label}”? References must be removed first.`)) void controller.actions.deleteCredential(connection.id, credential.id); }} type="button"><Trash2 aria-hidden="true" className="size-3.5" />Delete credential</button>
                    </div>
                  </details>
                </div>
              </div>

              {renameId === credential.id ? (
                <form className="mt-3 flex flex-col gap-2 border-t border-separator-subtle pt-3 sm:flex-row" onSubmit={(event) => { event.preventDefault(); void controller.actions.updateCredential(connection.id, credential.id, { action: "rename", label: renamedLabel }, "Credential renamed.").then((ok) => { if (ok) setRenameId(null); }); }}>
                  <label className="min-w-0 flex-1"><span className="sr-only">New label for {credential.label}</span><input className={inputClass} disabled={controller.state.busy} maxLength={160} onChange={(event) => setRenamedLabel(event.currentTarget.value)} required value={renamedLabel} /></label>
                  <button className={primaryButton} disabled={controller.state.busy || !renamedLabel.trim()} type="submit">Save label</button>
                  <button className={quietButton} disabled={controller.state.busy} onClick={() => setRenameId(null)} type="button">Cancel</button>
                </form>
              ) : null}

              {rotateTarget?.credentialId === credential.id ? (
                <form className="mt-3 flex flex-col gap-2 border-t border-separator-subtle pt-3 sm:flex-row" onSubmit={(event) => { event.preventDefault(); void controller.actions.updateCredential(connection.id, credential.id, { action: "rotate", expectedDraftVersion: rotateTarget.expectedDraftVersion, secret: rotatedSecret }, "Verified replacement key draft saved. Activate it before use.").then((ok) => { if (ok) { setRotateTarget(null); setRotatedSecret(""); setTestedRotatedSecret(null); } }); }}>
                  <label className="min-w-0 flex-1"><span className="sr-only">Replacement API key for {credential.label}</span><input autoComplete="new-password" className={`${inputClass} font-mono`} disabled={controller.state.busy} onChange={(event) => { setRotatedSecret(event.currentTarget.value); setTestedRotatedSecret(null); }} placeholder="Replacement API key" required type="password" value={rotatedSecret} /></label>
                  <button className={quietButton} disabled={controller.state.busy || !rotatedSecret.trim()} onClick={() => { const candidate = { connectionDraftVersion: connection.draftVersion, value: rotatedSecret }; void controller.actions.testCredential(connection.id, { expectedConnectionDraftVersion: candidate.connectionDraftVersion, secret: candidate.value }).then((ok) => { if (ok) setTestedRotatedSecret(candidate); }); }} type="button"><TestTube2 aria-hidden="true" className="size-3.5" />Test replacement</button>
                  <button className={primaryButton} disabled={controller.state.busy || !rotatedSecret.trim() || !rotatedSecretIsTested} type="submit">Save replacement</button>
                  <button className={quietButton} disabled={controller.state.busy} onClick={() => { setRotateTarget(null); setRotatedSecret(""); setTestedRotatedSecret(null); }} type="button">Cancel</button>
                </form>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState detail="Add one administrator-owned key before discovering or testing models." title="No credentials yet" />
      )}
    </section>
  );
}

function AssignmentPanel({
  connection,
  controller,
  groups
}: {
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  groups: AdminGroup[];
}) {
  const activeGroups = groups.filter(({ archivedAt }) => !archivedAt);
  const usableCredentials = connection.credentials.filter(credentialUsable);
  const [groupId, setGroupId] = useState(activeGroups[0]?.id ?? "");
  const [credentialId, setCredentialId] = useState(
    usableCredentials[0]?.id ?? connection.credentials[0]?.id ?? ""
  );
  const effectiveGroupId = activeGroups.some(({ id }) => id === groupId)
    ? groupId
    : activeGroups[0]?.id ?? "";
  const effectiveCredentialId = usableCredentials.some(({ id }) => id === credentialId)
    ? credentialId
    : usableCredentials[0]?.id ?? "";

  return (
    <section className="grid gap-3 border-t border-separator-subtle p-4" aria-labelledby="provider-assignments-title">
      <div>
        <h3 className="text-sm font-semibold text-content-primary" id="provider-assignments-title">Key assignment</h3>
        <p className={helpText}>Choose which administrator-owned account authenticates a run. This never grants model access; ordinary RBAC remains separate.</p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label>
          <span className={fieldLabel}>Users without a group key</span>
          <select
            className={inputClass}
            id="provider-unassigned-policy"
            disabled={controller.state.busy}
            onChange={(event) => {
              const unassignedPolicy = event.currentTarget.value as ConnectionForm["unassignedPolicy"];
              void controller.actions.updateConnection(connection.id, {
                configuration: connection.draftConfig,
                displayName: connection.displayName,
                expectedDraftVersion: connection.draftVersion,
                family: connection.family,
                unassignedPolicy
              });
            }}
            value={connection.unassignedPolicy}
          >
            <option value="use_default">Use default credential</option>
            <option value="require_assignment">Require group assignment</option>
          </select>
        </label>
        <label>
          <span className={fieldLabel}>Default credential</span>
          <select
            className={inputClass}
            id="provider-default-credential"
            disabled={controller.state.busy || connection.unassignedPolicy === "require_assignment"}
            onChange={(event) => void controller.actions.connectionAction(
              connection.id,
              { action: "set_default_credential", credentialId: event.currentTarget.value || null },
              "Default credential updated; activate to validate the new effective set."
            )}
            value={connection.defaultCredentialId ?? ""}
          >
            <option value="">No default credential</option>
            {connection.credentials.map((credential) => (
              <option disabled={!credentialUsable(credential)} key={credential.id} value={credential.id}>
                {credential.label}{credentialUsable(credential) ? "" : " (unusable)"}
              </option>
            ))}
          </select>
        </label>
      </div>

      <form
        className="grid gap-2 rounded-control bg-surface-thread p-3 md:grid-cols-[1fr_1fr_auto] md:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void controller.actions.connectionAction(
            connection.id,
            {
              action: "assign_group_credential",
              credentialId: effectiveCredentialId,
              groupId: effectiveGroupId
            },
            "Group credential assignment saved; it does not grant model access."
          );
        }}
      >
        <label>
          <span className={fieldLabel}>Group override</span>
          <select className={inputClass} disabled={controller.state.busy} id="provider-group-assignment" onChange={(event) => setGroupId(event.currentTarget.value)} value={effectiveGroupId}>
            <option value="">Choose a group</option>
            {activeGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        </label>
        <label>
          <span className={fieldLabel}>Credential</span>
          <select className={inputClass} disabled={controller.state.busy} onChange={(event) => setCredentialId(event.currentTarget.value)} value={effectiveCredentialId}>
            <option value="">Choose a usable credential</option>
            {usableCredentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.label}</option>)}
          </select>
        </label>
        <button className={primaryButton} disabled={controller.state.busy || !effectiveGroupId || !effectiveCredentialId} type="submit">Assign</button>
      </form>

      {connection.assignments.length ? (
        <div className="grid gap-1" role="list" aria-label="Group credential assignments">
          {connection.assignments.map((assignment) => (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-control bg-surface-thread px-3 py-2" key={assignment.group.id} role="listitem">
              <span className="text-xs text-content-secondary">
                <strong className="font-medium text-content-primary">{assignment.group.name}</strong>
                {assignment.group.archivedAt ? " (archived; ignored)" : ""}
                {" → "}
                {connection.credentials.find(({ id }) => id === assignment.credentialId)?.label ?? "Removed credential"}
              </span>
              <button aria-label={`Remove credential override for ${assignment.group.name}`} className={dangerButton} disabled={controller.state.busy} onClick={() => void controller.actions.connectionAction(connection.id, { action: "revoke_group_credential", groupId: assignment.group.id }, "Group credential assignment removed.")} type="button">Remove override</button>
            </div>
          ))}
        </div>
      ) : <p className="text-xs text-content-muted">No group-specific keys. The unassigned-user policy applies.</p>}
    </section>
  );
}

function ModelPanel({
  connection,
  controller,
  discovery
}: {
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  discovery: AdminOpenRouterDiscoverySession;
}) {
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const editing = editingId && editingId !== "new"
    ? connection.models.find(({ id }) => id === editingId) ?? null
    : null;

  return (
    <section className="grid gap-3 p-4" aria-labelledby="provider-models-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-content-primary" id="provider-models-title">Models</h3>
          <p className={helpText}>
            {connection.family === "openai_compatible"
              ? "Choose Responses or Chat Completions explicitly for every custom model."
              : connection.family === "openrouter"
                ? "Choose from the account catalog; routing is Automatic unless you pin an ordered provider list."
                : "Each row is one concrete deployment available for grants after activation."}
          </p>
        </div>
        <button
          aria-controls="provider-model-editor"
          aria-expanded={editingId === "new"}
          className={quietButton}
          data-provider-action="add-model"
          disabled={controller.state.busy}
          onClick={() => setEditingId((current) => current === "new" ? null : "new")}
          type="button"
        >
          <Plus aria-hidden="true" className="size-3.5" />
          {editingId === "new" ? "Close model form" : "Add model"}
        </button>
      </div>

      {editingId ? (
        <AdminProviderModelEditor
          connection={connection}
          controller={controller}
          discovery={discovery}
          editing={editing}
          key={`${connection.id}:${editingId}:${editing?.draftVersion ?? 0}`}
          onClose={() => setEditingId(null)}
        />
      ) : null}

      {connection.models.length ? (
        <div className="rounded-control bg-surface-thread" role="list" aria-label="Configured models">
          {connection.models.map((model, index) => {
            const routing = model.draftConfig.openRouterRouting;
            const routingText = routing?.mode === "only_selected"
              ? `${routing.providers.length} pinned provider${routing.providers.length === 1 ? "" : "s"}`
              : routing
                ? "Automatic routing"
                : adminProviderAdapterLabel(model.draftConfig.adapterKind);
            return (
              <div className={`flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between ${index ? "border-t border-separator-subtle" : ""}`} key={model.id} role="listitem">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-words text-xs font-medium text-content-primary">{model.displayName}</span>
                    <ModelState model={model} />
                  </div>
                  <p className={helpText}>{adminProviderAdapterLabel(model.draftConfig.adapterKind)} · {routingText}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <button aria-label={`Edit ${model.displayName}`} className={quietButton} disabled={controller.state.busy} onClick={() => setEditingId(model.id)} type="button"><Pencil aria-hidden="true" className="size-3.5" />Edit</button>
                  <button aria-label={`${model.enabled ? "Disable" : "Enable"} ${model.displayName} model`} className={quietButton} disabled={controller.state.busy} onClick={() => void controller.actions.updateModel(connection.id, model.id, { action: model.enabled ? "disable" : "enable" }, model.enabled ? "Model disabled for new runs." : "Model enabled; activation will validate its catalog presence.")} type="button">{model.enabled ? "Disable" : "Enable"}</button>
                  <details className="relative">
                    <summary aria-label={`More actions for ${model.displayName} model`} className={`${quietButton} cursor-pointer list-none`}><MoreHorizontal aria-hidden="true" className="size-3.5" />More</summary>
                    <div className="absolute right-0 top-full z-20 mt-1 grid min-w-48 gap-1 rounded-panel border border-separator-subtle bg-surface-overlay p-2 shadow-overlay">
                      <button aria-label={`Delete ${model.displayName} model`} className={dangerButton} disabled={controller.state.busy} onClick={() => { if (window.confirm(`Delete model deployment “${model.displayName}”? References must be removed first.`)) void controller.actions.deleteModel(connection.id, model.id); }} type="button"><Trash2 aria-hidden="true" className="size-3.5" />Delete model</button>
                    </div>
                  </details>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState detail="Add one explicitly configured model deployment." title="No models yet" />
      )}
    </section>
  );
}

function TestingPanel({
  connection,
  controller
}: {
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
}) {
  const credentials = connection.credentials.filter(credentialUsable);
  const models = connection.models.filter(({ enabled }) => enabled);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const [credentialId, setCredentialId] = useState(
    connection.defaultCredentialId ?? credentials[0]?.id ?? ""
  );
  const model = models.find(({ id }) => id === modelId) ?? models[0];
  const credential = credentials.find(({ id }) => id === credentialId) ?? credentials[0];
  const latest = model && credential
    ? connection.draftChecks.find((check) =>
        check.connectionDraftVersion === connection.draftVersion &&
        check.modelDraftVersion === model.draftVersion &&
        check.providerModelId === model.id &&
        check.credentialId === credential.id
      )
    : null;
  const paid = connection.family !== "openrouter";

  return (
    <div className="grid gap-3">
      <div>
        <h4 className="text-xs font-semibold text-content-primary">Optional model diagnostic</h4>
        <p className={helpText}>Activation already validates every referenced key. Run this only for one exact model/credential check or OpenRouter route.</p>
      </div>
      {model && credential ? (
        <div className="grid gap-2 rounded-control bg-surface-thread p-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <label><span className={fieldLabel}>Model</span><select className={inputClass} disabled={controller.state.busy} onChange={(event) => setModelId(event.currentTarget.value)} value={model.id}>{models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
          <label><span className={fieldLabel}>Credential</span><select className={inputClass} disabled={controller.state.busy} onChange={(event) => setCredentialId(event.currentTarget.value)} value={credential.id}>{credentials.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <button className={quietButton} disabled={controller.state.busy} onClick={() => { if (paid && !window.confirm("Run a tiny generation diagnostic? The provider may charge for up to 16 output tokens.")) return; void controller.actions.testDraft(connection.id, model.id, { confirmPaidRequest: paid, credentialId: credential.id, mode: paid ? "tiny_generation" : "account_catalog" }); }} type="button"><TestTube2 aria-hidden="true" className="size-3.5" />{paid ? "Test model" : "Check model route"}</button>
          <p className="text-[11px] text-content-muted md:col-span-3">Latest current-draft result: <span className={!latest ? "text-content-muted" : latest.status === "available" ? "text-accent-green" : "text-accent-rose"}>{latest?.status ?? "Not run"}</span></p>
        </div>
      ) : <EmptyState detail="Create an enabled model and a usable credential first." title="Nothing to diagnose yet" />}
    </div>
  );
}

function focusProviderWorkflow(
  sectionId: "provider-credentials-workflow" | "provider-models-workflow",
  selector?: string,
  openDisclosure = false
) {
  const section = document.getElementById(sectionId);
  section?.scrollIntoView?.({ block: "start" });
  window.setTimeout(() => {
    const target = selector ? section?.querySelector<HTMLElement>(selector) : section;
    if (
      openDisclosure &&
      target instanceof HTMLButtonElement &&
      target.getAttribute("aria-expanded") === "false"
    ) {
      target.click();
    }
    target?.focus({ preventScroll: true });
  }, 0);
}

function runProviderPrimaryAction(
  action: ProviderPrimaryAction,
  connection: AdminProviderConnection,
  controller: AdminProvidersController,
  confirmUnavailable: boolean
) {
  if (action.kind === "activate") {
    void controller.actions.connectionAction(
      connection.id,
      { action: "activate", confirmUnavailable, enableConnection: true },
      "Provider draft activated and enabled for new runs."
    );
    return;
  }
  if (action.kind === "enable") {
    void controller.actions.connectionAction(
      connection.id,
      { action: "enable" },
      "Connection enabled for new runs."
    );
    return;
  }
  if (action.kind === "add_model") {
    focusProviderWorkflow("provider-models-workflow", '[data-provider-action="add-model"]', true);
    return;
  }
  if (action.kind === "configure_credential") {
    focusProviderWorkflow("provider-credentials-workflow", '[data-provider-action="add-key"]', true);
    return;
  }
  if (action.kind === "choose_default_credential") {
    focusProviderWorkflow("provider-credentials-workflow", "#provider-default-credential");
    return;
  }
  if (action.kind === "assign_group_credential") {
    focusProviderWorkflow("provider-credentials-workflow", "#provider-group-assignment");
    return;
  }
  focusProviderWorkflow("provider-credentials-workflow");
}

function ConnectionDetail({
  connection,
  controller,
  discovery,
  groups,
  onEdit
}: {
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  discovery: AdminOpenRouterDiscoverySession;
  groups: AdminGroup[];
  onEdit(): void;
}) {
  const activationOverrideRef = useRef<HTMLInputElement>(null);
  const ui = deriveProviderUiState(connection);
  const publicationTone = ui.publication.kind === "active"
    ? "success" as const
    : ui.publication.kind === "changes_pending"
      ? "warning" as const
      : "neutral" as const;
  const activationNeedsOverride =
    controller.state.feedbackConnectionId === connection.id &&
    controller.state.errorCode === "provider_activation_unavailable_confirmation_required";

  return (
    <div className="min-w-0">
      <div className="z-10 border-b border-separator-subtle bg-surface-navigation/95 lg:sticky lg:top-0">
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="break-words text-base font-semibold text-content-primary">{connection.displayName}</h2>
              <StatePill label={ui.runtime.label} tone={ui.runtime.kind === "enabled" ? "success" : "neutral"} />
              <StatePill label={ui.publication.label} tone={publicationTone} />
            </div>
            <p className="mt-1 text-xs text-content-muted">{familyLabel(connection.family)} connection</p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <button className={quietButton} disabled={controller.state.busy} onClick={onEdit} type="button"><Pencil aria-hidden="true" className="size-3.5" />Edit connection</button>
            {connection.activeConfig ? (
              <button aria-label={`${connection.enabled ? "Disable" : "Enable"} ${connection.displayName} connection`} className={quietButton} disabled={controller.state.busy} onClick={() => void controller.actions.connectionAction(connection.id, { action: connection.enabled ? "disable" : "enable" }, connection.enabled ? "Connection disabled for new runs." : "Connection enabled for new runs.")} type="button">{connection.enabled ? "Disable" : "Enable"}</button>
            ) : null}
            <details className="relative">
              <summary aria-label={`More actions for ${connection.displayName} connection`} className={`${quietButton} cursor-pointer list-none`}><MoreHorizontal aria-hidden="true" className="size-3.5" />More</summary>
              <div className="absolute right-0 top-full z-30 mt-1 grid min-w-64 gap-1 rounded-panel border border-separator-subtle bg-surface-overlay p-2 shadow-overlay">
                <div className="px-3 py-2">
                  <p className="break-all font-mono text-[11px] text-content-muted">{connection.draftConfig.apiRoot}</p>
                  <p className="mt-1 text-[11px] text-content-muted">Draft v{connection.draftVersion}{connection.activeConfig ? ` · active v${connection.activeVersion}` : " · not activated"}</p>
                </div>
                <button aria-label={`Delete ${connection.displayName} connection`} className={dangerButton} disabled={controller.state.busy} onClick={() => { if (window.confirm(`Delete provider connection “${connection.displayName}”? All references and child resources must be removed first.`)) void controller.actions.deleteConnection(connection.id); }} type="button"><Trash2 aria-hidden="true" className="size-3.5" />Delete connection</button>
              </div>
            </details>
          </div>
        </div>

        <div className={`mx-4 mb-4 flex flex-col gap-3 rounded-control px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between ${ui.readiness.blockers.length ? "bg-accent-amber/10" : "bg-accent-green/10"}`}>
          <div className="min-w-0">
            <p className={`text-xs font-medium ${ui.readiness.blockers.length ? "text-accent-amber" : "text-accent-green"}`}>
              {ui.readiness.blockers.length
                ? ui.readiness.summary
                : ui.publication.kind === "active" && connection.enabled
                  ? "Provider is active and ready for new runs."
                  : "Ready to activate."}
            </p>
            {ui.readiness.blockers.length ? (
              <details className="mt-1">
                <summary className={`inline-flex min-h-touch cursor-pointer list-none items-center rounded-control text-[11px] text-content-secondary ${focusRing} ${touchTarget}`}>Review setup items</summary>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-[11px] leading-4 text-content-secondary">
                  {ui.readiness.blockers.map((blocker) => <li key={blocker.code}>{blocker.message}</li>)}
                </ul>
              </details>
            ) : <p className="mt-0.5 text-[11px] text-content-muted">The server revalidates the current endpoint, models, and referenced keys during activation.</p>}
          </div>
          {ui.primaryAction ? (
            <button
              className={primaryButton}
              disabled={controller.state.busy}
              onClick={() => runProviderPrimaryAction(
                ui.primaryAction!,
                connection,
                controller,
                activationOverrideRef.current?.checked === true
              )}
              type="button"
            >
              {ui.primaryAction.kind === "activate" ? <Check aria-hidden="true" className="size-3.5" /> : null}
              {ui.primaryAction.label}
            </button>
          ) : null}
        </div>

        {activationNeedsOverride ? (
          <div className="mx-4 mb-4 rounded-control bg-accent-amber/10 px-3 py-2 text-xs leading-5 text-accent-amber">
            <label className="flex items-start gap-2">
              <input className="mt-0.5 size-4 shrink-0 accent-accent-cyan" ref={activationOverrideRef} type="checkbox" />
              <span>Allow activation even though one or more configured model IDs are absent from a referenced key catalog. Those exact model/key combinations remain unavailable.</span>
            </label>
          </div>
        ) : null}
      </div>

      <div className="border-b border-separator-subtle" id="provider-credentials-workflow">
        <CredentialPanel connection={connection} controller={controller} />
        <AssignmentPanel connection={connection} controller={controller} groups={groups} />
      </div>
      <div className="border-b border-separator-subtle" id="provider-models-workflow">
        <ModelPanel connection={connection} controller={controller} discovery={discovery} />
      </div>
      <details className="group">
        <summary className={`flex min-h-touch cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-content-secondary hover:bg-surface-hover ${focusRing} ${touchTarget}`}>
          <span>
            Diagnostics and troubleshooting
            <span className="mt-0.5 block text-[11px] font-normal text-content-muted">Optional checks stay out of the normal setup path.</span>
          </span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 group-open:rotate-180" />
        </summary>
        <div className="border-t border-separator-subtle p-4">
          <TestingPanel connection={connection} controller={controller} />
        </div>
      </details>
    </div>
  );
}

function ConnectionNavigationItem({
  connection,
  current,
  onSelect
}: {
  connection: AdminProviderConnection;
  current: boolean;
  onSelect(): void;
}) {
  const ui = deriveProviderUiState(connection);
  const publicationTone = ui.publication.kind === "active"
    ? "text-accent-green"
    : ui.publication.kind === "changes_pending"
      ? "text-accent-amber"
      : "text-content-muted";

  return (
    <button
      aria-current={current ? "page" : undefined}
      className={`flex min-h-touch w-full min-w-0 items-center gap-3 rounded-control px-3 py-2.5 text-left ${focusRing} ${touchTarget} ${current ? "bg-accent-cyan/10" : "hover:bg-surface-hover"}`}
      onClick={onSelect}
      type="button"
    >
      <span className="min-w-0 flex-1">
        <span className={`block break-words text-xs font-medium [overflow-wrap:anywhere] ${current ? "text-accent-cyan" : "text-content-primary"}`}>
          {connection.displayName}
        </span>
        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-4 text-content-muted">
          <span>{familyLabel(connection.family)}</span>
          <span aria-hidden="true">·</span>
          <span className={connection.enabled ? "text-accent-green" : "text-content-muted"}>
            {ui.runtime.label}
          </span>
          <span aria-hidden="true">·</span>
          <span className={publicationTone}>{ui.publication.label}</span>
        </span>
        <span className="mt-0.5 block text-[11px] leading-4 text-content-muted">
          {connection.models.length} model{connection.models.length === 1 ? "" : "s"} · {connection.credentials.length} key{connection.credentials.length === 1 ? "" : "s"}
        </span>
      </span>
      <ChevronRight aria-hidden="true" className={`size-4 shrink-0 ${current ? "text-accent-cyan" : "text-content-muted"}`} />
    </button>
  );
}

function DesktopConnectionNavigation({
  connections,
  onSelect,
  selectedId
}: {
  connections: AdminProviderConnection[];
  onSelect(id: string): void;
  selectedId: string | null;
}) {
  return (
    <aside className="hidden min-w-0 border-r border-separator-subtle lg:block">
      <div className="sticky top-0 max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain p-2">
        <p className="px-3 pb-2 pt-1 text-[11px] font-medium uppercase tracking-[0.08em] text-content-muted">
          Connections
        </p>
        <ul aria-label="Provider connections" className="grid gap-1">
          {connections.map((connection) => (
            <li key={connection.id}>
              <ConnectionNavigationItem
                connection={connection}
                current={connection.id === selectedId}
                onSelect={() => onSelect(connection.id)}
              />
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

function MobileConnectionSwitcher({
  connections,
  onSelect,
  selected
}: {
  connections: AdminProviderConnection[];
  onSelect(id: string): void;
  selected: AdminProviderConnection | null;
}) {
  const disclosureRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const selectedUi = selected ? deriveProviderUiState(selected) : null;

  if (!selected) return null;

  return (
    <details className="border-b border-separator-subtle lg:hidden" ref={disclosureRef}>
      <summary className={`flex min-h-touch cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 ${focusRing} ${touchTarget}`} ref={summaryRef}>
        <span className="min-w-0">
          <span className="block text-[11px] font-medium uppercase tracking-[0.08em] text-content-muted">Current provider</span>
          <span className="mt-0.5 block break-words text-sm font-semibold text-content-primary [overflow-wrap:anywhere]">{selected.displayName}</span>
          <span className="mt-0.5 block text-[11px] text-content-muted">{selectedUi?.runtime.label} · {selectedUi?.publication.label}</span>
        </span>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-content-muted" />
      </summary>
      <div className="border-t border-separator-subtle bg-surface-thread p-2">
        <ul aria-label="Choose provider connection" className="grid max-h-[min(55dvh,24rem)] gap-1 overflow-y-auto overscroll-contain">
          {connections.map((connection) => (
            <li key={connection.id}>
              <ConnectionNavigationItem
                connection={connection}
                current={connection.id === selected.id}
                onSelect={() => {
                  disclosureRef.current?.removeAttribute("open");
                  summaryRef.current?.focus({ preventScroll: true });
                  onSelect(connection.id);
                }}
              />
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

export function AdminProvidersSection({
  active,
  groups
}: AdminProvidersSectionProps) {
  const controller = useAdminProvidersController(active);
  const discovery = useAdminOpenRouterDiscovery({
    loadEndpoints: controller.actions.discoverEndpoints,
    loadModels: controller.actions.discoverModels
  });
  const [creating, setCreating] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  const selected = controller.state.selectedConnection;
  const enabledCount = controller.state.connections.filter(({ enabled }) => enabled).length;

  const selectConnection = (id: string) => {
    setCreating(false);
    setEditingConnectionId(null);
    controller.actions.select(id);
  };

  return (
    <div className="min-w-0">
      <AdminRunProfilesPanel active={active} />
      <div className="flex flex-col gap-3 border-b border-separator-subtle px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-content-muted">
          {controller.state.loading && !controller.state.loaded
            ? "Loading provider connections…"
            : `${controller.state.connections.length} connection${controller.state.connections.length === 1 ? "" : "s"} · ${enabledCount} enabled`}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            aria-label="Refresh provider connections"
            className={quietButton}
            disabled={controller.state.busy || controller.state.loading}
            onClick={() => void controller.actions.refresh()}
            type="button"
          >
            <RefreshCw aria-hidden="true" className={`size-3.5 ${controller.state.loading ? "animate-spin" : ""}`} />
            Refresh providers
          </button>
          <button
            className={primaryButton}
            disabled={controller.state.busy}
            onClick={() => {
              setEditingConnectionId(null);
              setCreating((value) => !value);
            }}
            type="button"
          >
            <Plus aria-hidden="true" className="size-3.5" />
            {creating ? "Close connection form" : "New connection"}
          </button>
        </div>
      </div>

      <Feedback controller={controller} />

      {creating ? (
        <ConnectionEditor
          connection={null}
          controller={controller}
          onClose={() => setCreating(false)}
        />
      ) : null}

      {controller.state.loading && !controller.state.loaded ? (
        <div className="px-4 py-12 text-center text-sm text-content-muted" role="status">
          Loading provider connections…
        </div>
      ) : controller.state.loaded && controller.state.connections.length === 0 ? (
        <EmptyState
          detail="Create an OpenRouter, OpenAI, Anthropic, or OpenAI-compatible connection to begin."
          title="No provider connections"
        />
      ) : (
        <>
          <MobileConnectionSwitcher
            connections={controller.state.connections}
            onSelect={selectConnection}
            selected={selected}
          />
          <div className="min-w-0 lg:grid lg:grid-cols-[18rem_minmax(0,1fr)]">
            <DesktopConnectionNavigation
              connections={controller.state.connections}
              onSelect={selectConnection}
              selectedId={selected?.id ?? null}
            />
            <div className="min-w-0">
              {selected ? (
                <>
                  {editingConnectionId === selected.id ? (
                    <ConnectionEditor
                      connection={selected}
                      controller={controller}
                      onClose={() => setEditingConnectionId(null)}
                    />
                  ) : null}
                  <ConnectionDetail
                    connection={selected}
                    controller={controller}
                    discovery={discovery}
                    groups={groups}
                    key={selected.id}
                    onEdit={() => {
                      setCreating(false);
                      setEditingConnectionId((current) => current === selected.id ? null : selected.id);
                    }}
                  />
                </>
              ) : (
                <EmptyState detail="Choose a connection from the list." title="No connection selected" />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

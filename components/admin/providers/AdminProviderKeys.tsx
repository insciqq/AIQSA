"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { AdminSearchablePicker } from "@/components/admin/AdminSearchablePicker";
import { describeDeleteBlockers } from "@/components/admin/providers/providerBlockers";
import { providerKeyState } from "@/components/admin/providers/providerListView";
import { ProviderRowMenu, ProviderTag } from "@/components/admin/providers/providerPrimitives";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import { UiV2Button, UiV2Icon, UiV2IconButton, type UiV2MenuAction } from "@/components/ui-v2";
import type { AdminGroup } from "@/lib/contracts/admin";
import type { AdminProviderConnection, AdminProviderCredential } from "@/lib/contracts/adminProviders";
import { KeyRound } from "lucide-react";
import { useId, useState, type FormEvent } from "react";

const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";
const compactInput = `${inputClass} h-8 min-h-0 py-0 text-[13px]`;

type KeyForm =
  | Readonly<{ kind: "add" }>
  | Readonly<{ credentialId: string; kind: "rotate" }>;

export type AdminProviderKeysProps = Readonly<{
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  groups: readonly AdminGroup[];
  onError(message: string): void;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>;

function KeyRow({
  connection,
  controller,
  onDelete,
  onRename,
  onRevoke,
  onRotate,
  credential
}: Readonly<{
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  credential: AdminProviderCredential;
  onDelete(): void;
  onRename(label: string): Promise<boolean>;
  onRevoke(): void;
  onRotate(): void;
}>) {
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(credential.label);
  const busy = controller.state.busy;
  const state = providerKeyState(connection, credential);
  const isDefault = connection.defaultCredentialId === credential.id;
  const canRevoke = credential.activeVersion !== null && credential.activeVersion.revokedAt === null;
  const actions: UiV2MenuAction[] = [
    { icon: "edit", label: "Rename", onSelect: () => { setLabel(credential.label); setRenaming(true); } },
    {
      label: credential.enabled ? "Disable" : "Enable",
      onSelect: () => void controller.actions.updateCredential(
        connection.id,
        credential.id,
        { action: credential.enabled ? "disable" : "enable" },
        credential.enabled ? "Key turned off." : "Key turned on."
      )
    },
    { disabled: !canRevoke, icon: "close", label: "Revoke", onSelect: onRevoke, separatorBefore: true, tone: "destructive" },
    { icon: "trash", label: "Delete", onSelect: onDelete, tone: "destructive" }
  ];

  return (
    <li
      className="flex min-w-0 flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:px-5"
      data-key-state={state.kind}
      data-testid={`provider-key-${credential.id}`}
    >
      <KeyRound aria-hidden="true" className="hidden size-4 shrink-0 text-ink-muted sm:block" />
      <div className="min-w-0 flex-1">
        {renaming ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void onRename(label.trim()).then((ok) => {
                if (ok) setRenaming(false);
              });
            }}
          >
            <input
              aria-label="Key name"
              autoFocus
              className={`${compactInput} w-56`}
              disabled={busy}
              maxLength={160}
              onChange={(event) => setLabel(event.currentTarget.value)}
              required
              value={label}
            />
            <UiV2Button busy={busy} tone="primary" type="submit">Save</UiV2Button>
            <UiV2Button disabled={busy} onClick={() => setRenaming(false)} tone="ghost" type="button">Cancel</UiV2Button>
          </form>
        ) : (
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
            <span className="truncate">{credential.label}</span>
            {isDefault ? <ProviderTag accent>Default key</ProviderTag> : null}
          </p>
        )}
        <p className="mt-0.5 text-xs text-ink-muted" data-testid="provider-key-detail">{state.detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <UiV2Button
          aria-label={`Rotate ${credential.label}`}
          disabled={busy}
          onClick={onRotate}
          tone="ghost"
          type="button"
        >
          Rotate
        </UiV2Button>
        <ProviderRowMenu actions={actions} label={`More actions for ${credential.label}`} />
      </div>
    </li>
  );
}

function KeyFormRow({
  busy,
  credentialLabel,
  firstKey,
  error,
  kind,
  onCancel,
  onSubmit
}: Readonly<{
  busy: boolean;
  credentialLabel: string | null;
  firstKey: boolean;
  error: string | null;
  kind: KeyForm["kind"];
  onCancel(): void;
  onSubmit(input: { label: string; secret: string }): void;
}>) {
  const [label, setLabel] = useState(firstKey ? "Main" : "");
  const [secret, setSecret] = useState("");
  const errorId = useId();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit({ label: label.trim(), secret: secret.trim() });
  };
  return (
    <li className="bg-control-surface/50 px-4 py-4 sm:px-5" data-testid="provider-key-form">
      <form autoComplete="off" className="flex min-w-0 flex-col gap-3 md:flex-row md:items-end" onSubmit={submit}>
        {kind === "add" ? (
          <label className="min-w-0 md:w-52">
            <span className={fieldLabel}>Label</span>
            <input
              autoFocus={!firstKey}
              className={inputClass}
              disabled={busy}
              maxLength={160}
              onChange={(event) => setLabel(event.currentTarget.value)}
              placeholder="Finance"
              required
              value={label}
            />
          </label>
        ) : null}
        <label className="min-w-0 flex-1">
          <span className={fieldLabel}>{kind === "rotate" ? `New API key for ${credentialLabel}` : "API key"}</span>
          <input
            aria-errormessage={error ? errorId : undefined}
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            autoCapitalize="none"
            autoFocus={kind === "rotate" || firstKey}
            className={`${inputClass} font-mono [-webkit-text-security:disc]`}
            disabled={busy}
            onChange={(event) => setSecret(event.currentTarget.value)}
            placeholder="sk-…"
            required
            spellCheck={false}
            type="text"
            value={secret}
          />
        </label>
        <div className="flex shrink-0 items-center gap-2">
          <UiV2Button busy={busy} disabled={!secret.trim() || (kind === "add" && !label.trim())} tone="primary" type="submit">
            Test &amp; Save
          </UiV2Button>
          <UiV2Button disabled={busy} onClick={onCancel} tone="ghost" type="button">Cancel</UiV2Button>
        </div>
      </form>
      <p className="mt-2 text-xs leading-5 text-ink-muted">Checks the key, enables available supported models on first setup, then checks models and Search with small paid requests. Suitable empty defaults and roles are filled automatically.</p>
      {error ? (
        <p className="mt-2 text-xs text-critical" id={errorId} role="alert">{error}</p>
      ) : null}
    </li>
  );
}

function OverrideForm({
  busy,
  credentials,
  groups,
  onCancel,
  onSubmit
}: Readonly<{
  busy: boolean;
  credentials: readonly AdminProviderCredential[];
  groups: readonly AdminGroup[];
  onCancel(): void;
  onSubmit(input: { credentialId: string; groupId: string }): void;
}>) {
  const [groupId, setGroupId] = useState<string | null>(null);
  const [credentialId, setCredentialId] = useState(credentials[0]?.id ?? "");
  return (
    <form
      className="flex min-w-0 flex-col gap-3 md:flex-row md:items-end"
      data-testid="provider-override-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (groupId && credentialId) onSubmit({ credentialId, groupId });
      }}
    >
      <div className="min-w-0 md:w-64">
        <AdminSearchablePicker
          disabled={busy}
          emptyDescription="Every group already has an override, or there are no groups yet."
          emptyTitle="No groups to add"
          items={groups.map((group) => ({
            id: group.id,
            label: group.name,
            secondaryText: `${group.userCount} ${group.userCount === 1 ? "member" : "members"}`
          }))}
          label="Group"
          noun={{ plural: "groups", singular: "group" }}
          onSelect={(item) => setGroupId(item.id)}
          placeholder="Choose a group"
          searchPlaceholder="Search groups"
          selectedId={groupId}
        />
      </div>
      <label className="min-w-0 md:w-56">
        <span className={fieldLabel}>Key</span>
        <select
          className={inputClass}
          disabled={busy}
          onChange={(event) => setCredentialId(event.currentTarget.value)}
          value={credentialId}
        >
          {credentials.map((credential) => (
            <option key={credential.id} value={credential.id}>{credential.label}</option>
          ))}
        </select>
      </label>
      <div className="flex shrink-0 items-center gap-2">
        <UiV2Button busy={busy} disabled={!groupId || !credentialId} tone="primary" type="submit">Add override</UiV2Button>
        <UiV2Button disabled={busy} onClick={onCancel} tone="ghost" type="button">Cancel</UiV2Button>
      </div>
    </form>
  );
}

/**
 * Keys block of a provider page (PRD 5.4): one row per key, an inline
 * `Test & Save` row for adding or rotating a key, then the default-key choice
 * and group overrides. Every change is one server call; the catalog response
 * is what the rows show.
 */
export function AdminProviderKeys({
  connection,
  controller,
  groups,
  onError,
  requestConfirmation
}: AdminProviderKeysProps) {
  const [form, setForm] = useState<KeyForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const busy = controller.state.busy;
  const credentialById = new Map(connection.credentials.map((credential) => [credential.id, credential]));
  const overrides = connection.assignments.filter((assignment) => assignment.group.archivedAt === null);
  const overriddenGroupIds = new Set(overrides.map((assignment) => assignment.group.id));
  const availableGroups = groups.filter((group) => !group.archivedAt && !overriddenGroupIds.has(group.id));

  const openForm = (next: KeyForm) => {
    setFormError(null);
    setForm(next);
  };

  const submitKey = async (input: { label: string; secret: string }) => {
    if (!form) return;
    const result = form.kind === "add"
      ? await controller.actions.saveCredential(connection.id, input)
      : await controller.actions.rotateCredential(connection.id, form.credentialId, {
          expectedDraftVersion: credentialById.get(form.credentialId)?.draftVersion ?? 0,
          secret: input.secret
        });
    if (result.ok) {
      setForm(null);
      setFormError(null);
      return;
    }
    setFormError(result.message);
  };

  const requestRevoke = (credential: AdminProviderCredential) => {
    const versionId = credential.activeVersion?.id;
    if (!versionId) return;
    requestConfirmation({
      body: "The key stops working for new requests right away; chats already running finish. Use Rotate when you have a replacement.",
      confirmLabel: "Revoke key",
      dialogLabel: `Revoke ${credential.label}`,
      icon: "x",
      onConfirm: async () => {
        await controller.actions.updateCredential(
          connection.id,
          credential.id,
          { action: "revoke_active_version", clearSecret: true, confirmed: true, versionId },
          "Key revoked."
        );
      },
      testId: "admin-confirm-revoke-provider-key",
      title: `Revoke “${credential.label}”?`,
      tone: "destructive"
    });
  };

  const requestDelete = (credential: AdminProviderCredential) => {
    const groupUses = overrides.filter((assignment) => assignment.credentialId === credential.id).length;
    const userUses = connection.userAssignments.filter((assignment) => assignment.credentialId === credential.id).length;
    if (connection.defaultCredentialId === credential.id) {
      onError(`Can't delete “${credential.label}”: it is the default key — choose another default first.`);
      return;
    }
    if (groupUses || userUses) {
      const uses = [
        groupUses ? `${groupUses} group ${groupUses === 1 ? "override" : "overrides"}` : null,
        userUses ? `${userUses} user ${userUses === 1 ? "override" : "overrides"}` : null
      ].filter(Boolean).join(" and ");
      onError(`Can't delete “${credential.label}”: used by ${uses} — remove them first.`);
      return;
    }
    requestConfirmation({
      body: "The key is turned off and removed. Chats already running finish with it.",
      confirmLabel: "Delete key",
      dialogLabel: `Delete ${credential.label}`,
      icon: "trash",
      onConfirm: async () => {
        if (credential.enabled) {
          const disabled = await controller.actions.updateCredential(
            connection.id,
            credential.id,
            { action: "disable" },
            "Key turned off.",
            { quiet: true }
          );
          if (!disabled) {
            onError(`“${credential.label}” could not be turned off, so it was not deleted.`);
            return;
          }
        }
        const result = await controller.actions.deleteCredential(connection.id, credential.id);
        if (!result.ok) {
          onError(`“${credential.label}” was turned off but not deleted. ${
            result.error.blockers.length ? describeDeleteBlockers(result.error.blockers, "key") : result.message
          }`);
        }
      },
      testId: "admin-confirm-delete-provider-key",
      title: `Delete “${credential.label}”?`,
      tone: "destructive"
    });
  };

  return (
    <section aria-labelledby="provider-keys-heading" className="flex min-w-0 flex-col gap-2.5" data-testid="provider-keys">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold tracking-[0.02em] text-ink-secondary" id="provider-keys-heading">Keys</h3>
        <UiV2Button
          disabled={busy || form?.kind === "add"}
          icon="plus"
          onClick={() => openForm({ kind: "add" })}
          tone="ghost"
          type="button"
        >
          Add key
        </UiV2Button>
      </div>
      <div className="overflow-hidden rounded-[12px] border border-trace-subtle bg-answer-paper">
        <ul aria-label="Keys" className="divide-y divide-trace-subtle">
          {connection.credentials.map((credential) => (
            <KeyRow
              connection={connection}
              controller={controller}
              credential={credential}
              key={credential.id}
              onDelete={() => requestDelete(credential)}
              onRename={(label) => controller.actions.updateCredential(
                connection.id,
                credential.id,
                { action: "rename", label },
                "Key renamed."
              )}
              onRevoke={() => requestRevoke(credential)}
              onRotate={() => openForm({ credentialId: credential.id, kind: "rotate" })}
            />
          ))}
          {connection.credentials.length === 0 && !form ? (
            <li className="px-5 py-6 text-center text-sm text-ink-muted" role="status">
              No keys yet. Add one to start using this provider.
            </li>
          ) : null}
          {form ? (
            <KeyFormRow
              busy={busy}
              credentialLabel={form.kind === "rotate" ? credentialById.get(form.credentialId)?.label ?? null : null}
              error={formError}
              firstKey={connection.credentials.length === 0}
              key={form.kind === "rotate" ? `rotate:${form.credentialId}` : "add"}
              kind={form.kind}
              onCancel={() => { setForm(null); setFormError(null); }}
              onSubmit={(input) => void submitKey(input)}
            />
          ) : null}
        </ul>
        {connection.credentials.length ? (
          <div className="flex flex-col gap-3 border-t border-trace-subtle px-4 py-3 sm:px-5 lg:flex-row lg:flex-wrap lg:items-center lg:gap-x-6">
            <label className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] text-ink-secondary">
              <span>Users without a group key use</span>
              <select
                aria-label="Default key"
                className={`${compactInput} w-auto min-w-[8rem]`}
                data-testid="provider-default-key"
                disabled={busy}
                onChange={(event) => void controller.actions.connectionAction(
                  connection.id,
                  { action: "set_default_credential", credentialId: event.currentTarget.value || null },
                  event.currentTarget.value ? "Default key changed." : "Default key cleared."
                )}
                value={connection.defaultCredentialId ?? ""}
              >
                <option value="">No key</option>
                {connection.credentials.map((credential) => (
                  <option key={credential.id} value={credential.id}>{credential.label}</option>
                ))}
              </select>
            </label>
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] text-ink-secondary">
              <span>Group overrides:</span>
              {overrides.map((assignment) => (
                <ProviderTag className="h-6 gap-1 pr-0.5" key={assignment.group.id}>
                  <span className="truncate">{assignment.group.name} → {credentialById.get(assignment.credentialId)?.label ?? "key"}</span>
                  <UiV2IconButton
                    className="!size-5 !min-h-0 !min-w-0"
                    disabled={busy}
                    icon="close"
                    label={`Remove override for ${assignment.group.name}`}
                    onClick={() => void controller.actions.connectionAction(
                      connection.id,
                      { action: "revoke_group_credential", groupId: assignment.group.id },
                      "Group override removed."
                    )}
                  />
                </ProviderTag>
              ))}
              {overrides.length === 0 ? <span className="text-ink-muted">none</span> : null}
              <UiV2Button
                aria-expanded={overrideOpen}
                disabled={busy || overrideOpen}
                icon="plus"
                onClick={() => setOverrideOpen(true)}
                tone="ghost"
                type="button"
              >
                Override
              </UiV2Button>
            </div>
            {overrideOpen ? (
              <div className="w-full border-t border-trace-subtle pt-3">
                <OverrideForm
                  busy={busy}
                  credentials={connection.credentials}
                  groups={availableGroups}
                  onCancel={() => setOverrideOpen(false)}
                  onSubmit={(input) => {
                    void controller.actions.connectionAction(
                      connection.id,
                      { action: "assign_group_credential", ...input },
                      "Group override added."
                    ).then((ok) => {
                      if (ok) setOverrideOpen(false);
                    });
                  }}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="text-xs leading-5 text-ink-muted">
        <UiV2Icon className="mr-1 inline-block size-3.5 align-[-2px]" name="lock" />
        Keys are stored encrypted and never shown again. System roles always use the default key.
      </p>
    </section>
  );
}

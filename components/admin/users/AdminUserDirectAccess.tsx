"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { providerDisplayName, providerModelDisplayName, searchStrategyDisplayName } from "@/components/admin/adminViewUtils";
import type { AdminUsersController } from "@/components/admin/useAdminUsersController";
import type { AdminUserPageProviders } from "@/components/admin/users/AdminUserPage";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminAccessGrantRecord, AdminCatalog, AdminGroupGrantChange, AdminUserRecord } from "@/lib/contracts/admin";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import { useState } from "react";

const helpClass = "text-xs leading-5 text-ink-muted";
const listClass = "divide-y divide-trace-subtle rounded-[10px] border border-trace-subtle";

function CredentialRow({ connection, providers, user, users }: Readonly<{
  connection: AdminProviderConnection;
  providers: AdminUserPageProviders;
  user: AdminUserRecord;
  users: AdminUsersController;
}>) {
  const assignment = connection.userAssignments.find(({ user: assigned }) => assigned.id === user.id);
  const [draft, setDraft] = useState<{
    expectedCredentialId: string | null;
    expectedUpdatedAt: string | null;
    value: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = assignment?.credentialId ?? "";
  const value = draft?.value ?? current;
  const available = connection.enabled && connection.activeConfig && connection.activeVersion > 0 && user.status === "active"
    ? connection.credentials.filter((key) => key.enabled && key.activeVersion && !key.activeVersion.revokedAt)
    : [];
  const unavailable = value && !available.some((key) => key.id === value)
    ? connection.credentials.find((key) => key.id === value)
    : null;
  const save = async (credentialId: string | null, removeCurrent = false) => {
    setBusy(true);
    setError(null);
    try {
      const result = await users.actions.saveCredential(user, {
        connectionId: connection.id,
        credentialId,
        expectedCredentialId: !removeCurrent && draft ? draft.expectedCredentialId : assignment?.credentialId ?? null,
        expectedUpdatedAt: !removeCurrent && draft ? draft.expectedUpdatedAt : assignment?.updatedAt ?? null
      });
      if (!result.ok) { setError(result.message); return; }
      if (await providers.refresh()) setDraft(null);
      else setError("The key was saved, but current provider keys could not be loaded. Reload before another change.");
    } finally { setBusy(false); }
  };
  return (
    <li className="flex min-w-0 flex-col gap-2 px-4 py-3">
      <p className="text-sm font-medium text-ink">{connection.displayName}{connection.enabled ? "" : " · Disabled"}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <select
          aria-label={`Key for ${connection.displayName}`}
          className={`${inputClass} min-w-0 flex-1 basis-56`}
          disabled={busy || users.actionsDisabled}
          onChange={(event) => {
            setDraft({
              expectedCredentialId: draft ? draft.expectedCredentialId : assignment?.credentialId ?? null,
              expectedUpdatedAt: draft ? draft.expectedUpdatedAt : assignment?.updatedAt ?? null,
              value: event.currentTarget.value
            });
            setError(null);
          }}
          value={value}
        >
          <option value="">Use group or provider default</option>
          {unavailable ? <option disabled value={unavailable.id}>{unavailable.label} · Unavailable</option> : null}
          {available.map((key) => <option key={key.id} value={key.id}>{key.label}</option>)}
        </select>
        <UiV2Button aria-label={`Save key for ${connection.displayName}`} busy={busy} disabled={busy || users.actionsDisabled || value === current} onClick={() => void save(value || null)} tone="primary" type="button">Save</UiV2Button>
        {assignment ? <UiV2Button disabled={busy || users.actionsDisabled} onClick={() => void save(null, true)} tone="ghost" type="button">Remove override</UiV2Button> : null}
      </div>
      {error ? <p className="text-xs leading-5 text-critical" role="alert">{error}</p> : null}
    </li>
  );
}

export function AdminUserDirectKeys({ providers, user, users }: Readonly<{
  providers: AdminUserPageProviders;
  user: AdminUserRecord;
  users: AdminUsersController;
}>) {
  if (providers.error) return <p className="text-xs leading-5 text-caution" role="alert">Provider keys could not be loaded. {providers.error}</p>;
  if (!providers.loaded) return <p className={helpClass} role="status">Loading provider keys…</p>;
  const connections = providers.connections.filter((connection) =>
    connection.userAssignments.some((assignment) => assignment.user.id === user.id) ||
    (user.status === "active" && connection.enabled && connection.activeConfig && connection.activeVersion > 0 && connection.credentials.some((key) => key.enabled && key.activeVersion && !key.activeVersion.revokedAt))
  );
  return (
    <>
      <p className={helpClass}>A direct key overrides group and provider defaults for this user. It does not grant model access.</p>
      {connections.length ? (
        <ul aria-label="Direct provider keys" className={listClass}>
          {connections.map((connection) => <CredentialRow connection={connection} key={connection.id} providers={providers} user={user} users={users} />)}
        </ul>
      ) : <p className={helpClass}>No provider keys are available for a direct override.</p>}
    </>
  );
}

function grantLabel(catalog: AdminCatalog, grant: Pick<AdminAccessGrantRecord, "modelId" | "provider" | "resourceDisplayName" | "searchStrategy">): string {
  if (!grantAvailable(catalog, grant) && grant.resourceDisplayName) return `${grant.resourceDisplayName}${grant.searchStrategy ? " · Search" : ""}`;
  if (grant.searchStrategy) return `${searchStrategyDisplayName(catalog, grant.searchStrategy)} · Search`;
  if (grant.provider && grant.modelId) return providerModelDisplayName(catalog, { provider: grant.provider, modelId: grant.modelId });
  return `${providerDisplayName(catalog, grant.provider ?? "")} · all models`;
}

function grantChange(grant: Pick<AdminAccessGrantRecord, "modelId" | "provider" | "searchStrategy">, enabled: boolean): AdminGroupGrantChange {
  return { enabled, modelId: grant.modelId, provider: grant.provider, searchStrategy: grant.searchStrategy };
}

function grantAvailable(catalog: AdminCatalog, grant: Pick<AdminAccessGrantRecord, "modelId" | "provider" | "searchStrategy">): boolean {
  if (grant.searchStrategy) return catalog.searchStrategies.some((source) => source.strategyId === grant.searchStrategy);
  if (grant.modelId) return catalog.models.some((model) => model.modelId === grant.modelId && model.provider === grant.provider);
  return catalog.providers.some((provider) => provider.id === grant.provider);
}

export function AdminUserDirectGrants({ catalog, user, users }: Readonly<{
  catalog: AdminCatalog;
  user: AdminUserRecord;
  users: AdminUsersController;
}>) {
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = [
    ...catalog.providers.map((provider) => ({ id: `provider:${provider.id}`, modelId: null, provider: provider.id, searchStrategy: null })),
    ...catalog.models.map((model) => ({ id: `model:${model.modelId}`, modelId: model.modelId, provider: model.provider, searchStrategy: null })),
    ...catalog.searchStrategies.map((search) => ({ id: `search:${search.strategyId}`, modelId: null, provider: null, searchStrategy: search.strategyId }))
  ].filter((target) => !user.directGrants.some((grant) => grant.enabled &&
    grant.modelId === target.modelId && grant.provider === target.provider && grant.searchStrategy === target.searchStrategy));
  const target = candidates.find(({ id }) => id === selected);
  const save = async (changes: AdminGroupGrantChange[]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await users.actions.saveGrants(user, changes);
      if (result.ok) setSelected("");
      else setError(result.message);
    } finally { setBusy(false); }
  };
  return (
    <>
      <p className={helpClass}>These grants belong directly to this user. Removing one preserves access granted by groups.</p>
      {user.directGrants.length ? (
        <ul aria-label="Direct grants" className={listClass}>
          {user.directGrants.map((grant) => (
            <li className="flex min-w-0 flex-wrap items-center gap-2 px-4 py-2.5" key={grant.id}>
              <span className="min-w-0 flex-1 basis-48 break-words text-sm text-ink [overflow-wrap:anywhere]">{grantLabel(catalog, grant)}{!grant.enabled ? " · Disabled grant" : !grantAvailable(catalog, grant) ? " · Unavailable" : ""}</span>
              <UiV2Button disabled={busy || users.actionsDisabled} onClick={() => void save([grantChange(grant, false)])} tone="ghost" type="button">Remove grant</UiV2Button>
            </li>
          ))}
        </ul>
      ) : <p className={helpClass}>No direct grants.</p>}
      {user.status === "active" && candidates.length ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <select aria-label="Resource to grant" className={`${inputClass} min-w-0 flex-1 basis-56`} disabled={busy || users.actionsDisabled} onChange={(event) => { setSelected(event.currentTarget.value); setError(null); }} value={selected}>
            <option value="">Choose a provider, model or Search source</option>
            {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{grantLabel(catalog, candidate)}</option>)}
          </select>
          <UiV2Button busy={busy} disabled={busy || users.actionsDisabled || !target} onClick={() => { if (target) void save([grantChange(target, true)]); }} tone="primary" type="button">Grant access</UiV2Button>
        </div>
      ) : null}
      {error ? <p className="text-xs leading-5 text-critical" role="alert">{error}</p> : null}
    </>
  );
}

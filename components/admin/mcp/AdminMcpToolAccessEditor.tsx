"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import { UiV2Button, UiV2Switch } from "@/components/ui-v2";
import type { AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import type { AdminMcpServer, McpToolAccessPolicy } from "@/lib/contracts/mcp";
import { useEffect, useId, useRef, useState } from "react";

export function mcpToolAccessSummary(policy: McpToolAccessPolicy | undefined): string {
  if (!policy?.restricted) return "Available to everyone with MCP access";
  if (!policy.userIds.length && !policy.groupIds.length) return "Restricted · No one has access";
  const users = `${policy.userIds.length} ${policy.userIds.length === 1 ? "user" : "users"}`;
  const groups = `${policy.groupIds.length} ${policy.groupIds.length === 1 ? "group" : "groups"}`;
  return `Restricted · ${users}, ${groups}`;
}

function policyKey(policy: McpToolAccessPolicy): string {
  return JSON.stringify([policy.restricted, [...policy.userIds].sort(), [...policy.groupIds].sort()]);
}

export function AdminMcpToolAccessEditor({ controller, groups, name, onClose, server, users }: Readonly<{
  controller: AdminMcpController;
  groups: readonly AdminGroup[];
  name: string;
  onClose(): void;
  server: AdminMcpServer;
  users: readonly AdminUserRecord[];
}>) {
  const currentPolicy = () => server.toolAccess?.find((policy) => policy.name === name) ?? {
    name, restricted: false, userIds: [], groupIds: []
  };
  const [draft, setDraft] = useState<McpToolAccessPolicy>(currentPolicy);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(server.updatedAt);
  const [expectedPolicy, setExpectedPolicy] = useState(() => policyKey(currentPolicy()));
  const [query, setQuery] = useState("");
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  useEffect(() => { heading.current?.focus(); }, []);
  const disabled = saving || controller.state.busy || Boolean(server.archivedAt);
  // Recipient deletion cascades grants without updating the MCP server row.
  const changedElsewhere = server.updatedAt !== expectedUpdatedAt || policyKey(currentPolicy()) !== expectedPolicy;
  const search = query.trim().toLocaleLowerCase();
  const matches = (value: string) => !search || value.toLocaleLowerCase().includes(search);
  const selectedGroups = groups.filter((group) => draft.groupIds.includes(group.id));
  const selectedUsers = users.filter((user) => draft.userIds.includes(user.id));
  const missingUsers = draft.userIds.filter((id) => !users.some((user) => user.id === id));
  const missingGroups = draft.groupIds.filter((id) => !groups.some((group) => group.id === id));
  const missingRecipients = missingUsers.length > 0 || missingGroups.length > 0;
  const candidateGroups = groups.filter((group) => !draft.groupIds.includes(group.id) && matches(group.name));
  const candidateUsers = users.filter((user) => !draft.userIds.includes(user.id) && matches(`${user.displayName} ${user.email ?? ""}`));
  const toggle = (field: "groupIds" | "userIds", id: string) => setDraft((value) => ({
    ...value,
    [field]: value[field].includes(id) ? value[field].filter((candidate) => candidate !== id) : [...value[field], id]
  }));
  const save = async () => {
    if (disabled || changedElsewhere || missingRecipients) return;
    setSaving(true);
    setError(false);
    try {
      if (await controller.actions.update(server.id, { expectedUpdatedAt, toolAccess: draft })) onClose();
      else setError(true);
    } catch { setError(true); }
    finally { setSaving(false); }
  };
  const userFact = (user: AdminUserRecord) => {
    if (user.status !== "active") return "Account is inactive";
    const inherited = selectedGroups.filter((group) => !group.archivedAt && user.groups.some(({ groupId }) => groupId === group.id));
    return [draft.userIds.includes(user.id) ? "Granted directly" : null,
      inherited.length ? `Via ${inherited.map(({ name }) => name).join(", ")}` : null].filter(Boolean).join(" · ");
  };

  return (
    <section aria-labelledby={headingId} className="min-w-0 rounded-panel border border-trace-subtle bg-control-surface p-4 sm:p-5">
      <h4 className="break-words text-sm font-semibold text-ink outline-none [overflow-wrap:anywhere]" id={headingId} ref={heading} tabIndex={-1}>
        Access to {name}
      </h4>
      <label className="mt-3 flex items-center justify-between gap-3 text-sm text-ink">
        Restrict access
        <UiV2Switch checked={draft.restricted} disabled={disabled} label={`Restrict access to ${name}`} onChange={(restricted) => setDraft((value) => ({ ...value, restricted }))} />
      </label>
      <p className="mt-2 text-xs text-ink-secondary" role="status">{mcpToolAccessSummary(draft)}</p>
      <p className="mt-1 text-xs leading-5 text-ink-muted">
        MCP access and an enabled connection are still required. Full access and administrators need an explicit tool grant too.
        {!draft.restricted && (draft.userIds.length > 0 || draft.groupIds.length > 0) ? " Saved recipients apply when you restrict access again." : ""}
      </p>
      {draft.restricted ? (
        <>
          <input aria-label="Search tool recipients" className={`${inputClass} mt-4 w-full`} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search users and groups…" type="search" value={query} />
          <div className="mt-3 grid min-w-0 gap-4 sm:grid-cols-2">
            <fieldset className="min-w-0" disabled={disabled}>
              <legend className="mb-2 text-xs font-medium text-ink-secondary">Groups</legend>
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {[...selectedGroups, ...candidateGroups].map((group) => (
                  <label className="flex min-h-10 items-start gap-2 rounded-control px-2 py-2 text-xs text-ink hover:bg-control-hover" key={group.id}>
                    <input aria-label={`Allow group ${group.name}`} checked={draft.groupIds.includes(group.id)} className="mt-0.5 size-4 shrink-0 accent-proof" disabled={!draft.groupIds.includes(group.id) && (Boolean(group.archivedAt) || draft.groupIds.length >= 256)} onChange={() => toggle("groupIds", group.id)} type="checkbox" />
                    <span className="min-w-0 break-words [overflow-wrap:anywhere]">{group.name}{group.archivedAt ? <span className="block text-ink-muted">Archived · no access</span> : null}</span>
                  </label>
                ))}
                {!selectedGroups.length && !candidateGroups.length ? <p className="text-xs text-ink-muted">No groups match.</p> : null}
              </div>
            </fieldset>
            <fieldset className="min-w-0" disabled={disabled}>
              <legend className="mb-2 text-xs font-medium text-ink-secondary">Users · direct grants</legend>
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {[...selectedUsers, ...candidateUsers].map((user) => (
                  <label className="flex min-h-10 items-start gap-2 rounded-control px-2 py-2 text-xs text-ink hover:bg-control-hover" key={user.id}>
                    <input aria-label={`Allow user ${user.displayName}`} checked={draft.userIds.includes(user.id)} className="mt-0.5 size-4 shrink-0 accent-proof" disabled={!draft.userIds.includes(user.id) && (user.status !== "active" || draft.userIds.length >= 256)} onChange={() => toggle("userIds", user.id)} type="checkbox" />
                    <span className="min-w-0 break-words [overflow-wrap:anywhere]">{user.displayName}<span className="block text-ink-muted">{userFact(user) || user.email}</span></span>
                  </label>
                ))}
                {!selectedUsers.length && !candidateUsers.length ? <p className="text-xs text-ink-muted">No users match.</p> : null}
              </div>
            </fieldset>
          </div>
        </>
      ) : null}
      {missingUsers.length || missingGroups.length ? <div className="mt-3 space-y-1 text-xs text-caution">
        <p>Some selected recipients were deleted or are unavailable. Remove them before saving.</p>
        {missingUsers.map((id, index) => <UiV2Button aria-label={`Remove unavailable user ${index + 1}`} disabled={disabled} key={id} onClick={() => toggle("userIds", id)} tone="ghost" type="button">Remove unavailable user</UiV2Button>)}
        {missingGroups.map((id, index) => <UiV2Button aria-label={`Remove unavailable group ${index + 1}`} disabled={disabled} key={id} onClick={() => toggle("groupIds", id)} tone="ghost" type="button">Remove unavailable group</UiV2Button>)}
      </div> : null}
      {error ? <p className="mt-3 text-xs text-critical" role="alert">Access could not be saved. Your selections are kept. Refresh server data to check for changes.</p> : null}
      {changedElsewhere ? <p className="mt-3 text-xs text-caution" role="alert">This server changed while you were editing. Load its saved access before making further changes.</p> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <UiV2Button busy={saving} disabled={disabled || changedElsewhere || missingRecipients} onClick={() => void save()} tone="primary" type="button">Save access</UiV2Button>
        <UiV2Button disabled={saving} onClick={onClose} tone="ghost" type="button">Cancel</UiV2Button>
        {error ? <UiV2Button disabled={disabled} onClick={() => void controller.actions.refresh()} tone="ghost" type="button">Refresh server data</UiV2Button> : null}
        {changedElsewhere ? <UiV2Button disabled={disabled} onClick={() => { setDraft(currentPolicy()); setExpectedUpdatedAt(server.updatedAt); setExpectedPolicy(policyKey(currentPolicy())); setError(false); }} tone="ghost" type="button">Load saved access</UiV2Button> : null}
      </div>
    </section>
  );
}

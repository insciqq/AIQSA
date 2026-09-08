"use client";

import { AdminGroupOptions, DeletionHint, GroupChips } from "@/components/admin/adminPrimitives";
import { AdminMcpUserAccessPanel } from "@/components/admin/mcp/AdminMcpGrantPanels";
import {
  providerDisplayName,
  providerModelDisplayName,
  searchStrategyDisplayName
} from "@/components/admin/adminViewUtils";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import type { AdminUsersController } from "@/components/admin/useAdminUsersController";
import {
  activeGroupIdsForUser,
  hasModelAccess,
  isFullAccessMember,
  userDeletionInfo,
  userInitials
} from "@/components/admin/users/usersView";
import { UserAvatar, UserStatusPill, sectionHeadingClass } from "@/components/admin/users/usersPrimitives";
import { AdminUserDirectGrants, AdminUserDirectKeys } from "@/components/admin/users/AdminUserDirectAccess";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminDashboard, AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import { useEffect, useRef, useState } from "react";

export type AdminUserPageProviders = Readonly<{
  connections: readonly AdminProviderConnection[];
  error: string | null;
  loaded: boolean;
  refresh(): Promise<boolean>;
}>;

export type AdminUserPageProps = Readonly<{
  catalog: AdminDashboard["catalog"];
  groups: readonly AdminGroup[];
  mcp: AdminMcpController;
  onDeleted(): void;
  providers: AdminUserPageProviders;
  user: AdminUserRecord;
  users: AdminUsersController;
}>;

const blockClass = "flex flex-col gap-3 border-t border-trace-subtle pt-5";
const helpClass = "text-xs leading-5 text-ink-muted";

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\u0000") === [...right].sort().join("\u0000");
}

function EffectiveAccess({ catalog, groups, user }: Readonly<{
  catalog: AdminDashboard["catalog"];
  groups: readonly AdminGroup[];
  user: AdminUserRecord;
}>) {
  const { models, providers, searchStrategies } = user.effectiveEntitlements;
  if (isFullAccessMember(user, groups)) {
    return <p className="text-sm text-ink-secondary">Everything: every provider, model and Search source, through Full access.</p>;
  }
  if (!hasModelAccess(user.effectiveEntitlements) && searchStrategies.length === 0) {
    return (
      <p className="border-l-2 border-caution bg-caution/5 px-3 py-2 text-xs leading-5 text-caution" data-testid="admin-user-no-access">
        No model access. Add the user to a group that grants models.
      </p>
    );
  }
  const modelLabels = models.map((model) => ({ key: `${model.provider}:${model.modelId}`, label: providerModelDisplayName(catalog, model) }));
  const known = modelLabels.filter(({ label }) => label !== "Unavailable model");
  const unknown = modelLabels.length - known.length;
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-x-6 sm:gap-y-2">
      {providers.length ? (
        <>
          <dt className="text-xs font-medium uppercase tracking-[0.06em] text-ink-muted sm:pt-0.5">Providers</dt>
          <dd className="break-words text-ink-secondary [overflow-wrap:anywhere]">
            {providers.map((provider) => providerDisplayName(catalog, provider)).join(", ")}
          </dd>
        </>
      ) : null}
      {models.length ? (
        <>
          <dt className="text-xs font-medium uppercase tracking-[0.06em] text-ink-muted sm:pt-0.5">Models</dt>
          <dd className="break-words text-ink-secondary [overflow-wrap:anywhere]">
            {known.map(({ label }) => label).join(", ")}
            {unknown ? (
              <span className="text-ink-muted">
                {known.length ? " · " : ""}{unknown} no longer in the catalog
              </span>
            ) : null}
          </dd>
        </>
      ) : null}
      {searchStrategies.length ? (
        <>
          <dt className="text-xs font-medium uppercase tracking-[0.06em] text-ink-muted sm:pt-0.5">Search</dt>
          <dd className="break-words text-ink-secondary [overflow-wrap:anywhere]">
            {searchStrategies.map((strategy) => searchStrategyDisplayName(catalog, strategy)).join(", ")}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

/**
 * One user's page (PRD 5.8): groups with Save, read-only effective access,
 * direct provider key and grant management, MCP
 * access and the account actions with their confirmations.
 */
export function AdminUserPage({ catalog, groups, mcp, onDeleted, providers, user, users }: AdminUserPageProps) {
  const articleRef = useRef<HTMLElement>(null);
  const [groupDraft, setGroupDraft] = useState<{ expectedGroupIds: string[]; groupIds: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const isSelf = user.id === users.adminUserId;
  const pending = user.status === "pending";
  const active = user.status === "active";
  const currentGroupIds = activeGroupIdsForUser(user, groups);
  const savedGroupIds = pending ? [] : currentGroupIds;
  const groupIds = groupDraft?.groupIds ?? savedGroupIds;
  const expectedGroupIds = groupDraft?.expectedGroupIds ?? currentGroupIds;
  const dirty = !sameIds(groupIds, savedGroupIds);
  const editable = pending || (active && !isSelf);
  const deletion = userDeletionInfo(user, users.adminUserId);
  const busy = users.actionsDisabled || saving;
  const initials = userInitials(user);
  const identity = [
    user.email ?? "No email",
    user.role === "admin" ? "admin" : null,
    user.hasVerifiedIdentity ? "verified email" : "email not verified",
    isSelf ? "you" : null
  ].filter((part): part is string => part !== null).join(" · ");

  useEffect(() => {
    articleRef.current?.focus({ preventScroll: true });
  }, []);

  const run = async (action: () => Promise<boolean>) => {
    setSaving(true);
    try {
      const ok = await action();
      if (ok) setGroupDraft(null);
      return ok;
    } finally {
      setSaving(false);
    }
  };

  return (
    <article
      aria-label={`User ${user.displayName}`}
      className="flex max-w-[1120px] flex-col gap-5 px-4 py-6 outline-none sm:px-6 lg:px-8"
      data-testid="admin-user-page"
      ref={articleRef}
      tabIndex={-1}
    >
      <header className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
        <UserAvatar initials={initials} size="header" />
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-xl font-semibold leading-tight text-ink [overflow-wrap:anywhere]">{user.displayName}</h2>
          <p className="mt-0.5 break-words text-[13px] text-ink-muted [overflow-wrap:anywhere]">{identity}</p>
        </div>
        <UserStatusPill status={user.status} />
      </header>

      <section aria-labelledby="admin-user-groups-heading" className={blockClass} data-testid="admin-user-groups">
        <h3 className={sectionHeadingClass} id="admin-user-groups-heading">Groups</h3>
        {editable ? (
          <>
            <fieldset className="min-w-0" disabled={busy}>
              <AdminGroupOptions
                groups={[...groups]}
                label={pending ? "Groups applied on approval" : "Group memberships"}
                onChange={(next) => setGroupDraft((previous) => ({ expectedGroupIds: previous?.expectedGroupIds ?? currentGroupIds, groupIds: next }))}
                selected={groupIds}
              />
            </fieldset>
            {pending ? (
              <p className={helpClass}>These groups are applied when the user is approved.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <UiV2Button
                  busy={saving}
                  disabled={busy || !dirty}
                  onClick={() => void run(() => users.actions.saveGroups(user, groupIds, expectedGroupIds))}
                  tone="primary"
                  type="button"
                >
                  Save
                </UiV2Button>
                <span className={helpClass} role="status">
                  {dirty ? "Unsaved group changes." : "Group changes apply to future catalog and run checks."}
                </span>
              </div>
            )}
          </>
        ) : (
          <>
            <GroupChips groups={user.groups} />
            {isSelf ? <p className={helpClass}>Your own memberships are managed from Groups.</p> : null}
          </>
        )}
      </section>

      <section aria-labelledby="admin-user-access-heading" className={blockClass}>
        <h3 className={sectionHeadingClass} id="admin-user-access-heading">Effective access</h3>
        {pending ? (
          <p className={helpClass}>Access follows the groups chosen at approval.</p>
        ) : (
          <EffectiveAccess catalog={catalog} groups={groups} user={user} />
        )}
      </section>

      <section aria-labelledby="admin-user-keys-heading" className={blockClass} data-testid="admin-user-direct-keys">
        <h3 className={sectionHeadingClass} id="admin-user-keys-heading">Direct provider keys</h3>
        <AdminUserDirectKeys providers={providers} user={user} users={users} />
      </section>

      <section aria-labelledby="admin-user-grants-heading" className={blockClass} data-testid="admin-user-direct-grants">
        <h3 className={sectionHeadingClass} id="admin-user-grants-heading">Direct grants</h3>
        <AdminUserDirectGrants catalog={catalog} user={user} users={users} />
      </section>

      <div className="border-t border-trace-subtle">
        <AdminMcpUserAccessPanel controller={mcp} groups={groups} user={user} />
      </div>

      <section aria-labelledby="admin-user-account-heading" className="flex flex-col gap-3" data-testid="admin-user-account">
        <h3 className={sectionHeadingClass} id="admin-user-account-heading">Account</h3>
        <div className="flex max-w-xl flex-wrap items-center gap-2">
          {pending ? (
            <>
              <UiV2Button
                busy={saving}
                disabled={busy || !user.hasVerifiedIdentity}
                onClick={() => void run(() => users.actions.approve(user, groupIds, expectedGroupIds))}
                tone="primary"
                type="button"
              >
                Approve
              </UiV2Button>
              <UiV2Button disabled={busy} onClick={() => users.actions.requestReject(user)} tone="destructive" type="button">
                Reject
              </UiV2Button>
            </>
          ) : null}
          {active && !isSelf ? (
            <>
              <UiV2Button disabled={busy} icon="logout" onClick={() => users.actions.requestRevokeSessions(user)} tone="ghost" type="button">
                Revoke sessions
              </UiV2Button>
              <UiV2Button disabled={busy} onClick={() => users.actions.requestDisable(user)} tone="destructive" type="button">
                Disable
              </UiV2Button>
            </>
          ) : null}
          {!active && !isSelf && deletion.canDelete ? (
            <UiV2Button
              disabled={busy}
              icon="trash"
              onClick={() => users.actions.requestDelete(user, onDeleted)}
              tone="destructive"
              type="button"
            >
              Delete stale
            </UiV2Button>
          ) : null}
        </div>
        {pending && !user.hasVerifiedIdentity ? (
          <p className={helpClass}>Approval waits until the email is verified.</p>
        ) : null}
        {isSelf ? (
          <p className="border-l-2 border-proof/35 bg-proof/5 px-3 py-2 text-xs leading-5 text-ink-secondary">
            This is your own account. Self-disable and self-delete are not exposed here.
          </p>
        ) : (
          <DeletionHint info={deletion} />
        )}
      </section>
    </article>
  );
}

"use client";

import { adminSectionPath } from "@/components/admin/adminSections";
import { AdminTopbarMenu, useAdminSectionTopbar, type AdminShellTopbar } from "@/components/admin/AdminShell";
import type { AdminAccessRulesController } from "@/components/admin/useAdminAccessRulesController";
import type { AdminInvitesController } from "@/components/admin/useAdminInvitesController";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import { useAdminProvidersController } from "@/components/admin/useAdminProvidersController";
import type { AdminUsersController } from "@/components/admin/useAdminUsersController";
import { AdminInviteSheet } from "@/components/admin/users/AdminInviteSheet";
import { AdminOpenInvites } from "@/components/admin/users/AdminOpenInvites";
import { AdminSignupRulesSheet } from "@/components/admin/users/AdminSignupRulesSheet";
import { AdminUserPage } from "@/components/admin/users/AdminUserPage";
import { AdminUsersList } from "@/components/admin/users/AdminUsersList";
import {
  adminUserFilterCounts,
  deriveAdminUserRows,
  parseAdminUserListFilter,
  type AdminUserListFilter
} from "@/components/admin/users/usersView";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import type { AdminDashboard } from "@/lib/contracts/admin";
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";

const crumbLink =
  "rounded-[6px] font-medium text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-focus";

export type AdminUsersSectionProps = Readonly<{
  accessRules: AdminAccessRulesController;
  dashboard: Pick<AdminDashboard, "catalog" | "groups" | "users">;
  /** The raw `?filter=` value; unknown values fall back to All. */
  filter: string | null;
  invites: AdminInvitesController;
  mcp: AdminMcpController;
  onSelectFilter(filter: string | null): void;
  onSelectResource(resource: string | null): void;
  /** Open user page from `?resource=`, or null for the list. */
  resource: string | null;
  users: AdminUsersController;
}>;

function Crumbs({ current, onBack }: Readonly<{ current: string; onBack(): void }>) {
  const href = adminSectionPath(typeof window === "undefined" ? "/admin" : window.location.href, "users");
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <a
        className={crumbLink}
        href={href}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onBack();
        }}
      >
        Users
      </a>
      <UiV2Icon className="size-3.5 shrink-0 text-ink-muted" name="chevron-right" />
      <span className="truncate">{current}</span>
    </span>
  );
}

/**
 * Users section (PRD 5.8): the table with search and filter pills, the open
 * invites under it, one user page per `?resource=`, and the Invite and
 * Sign-up rules sheets. The section owns the topbar; the panel owns the
 * controllers so the one-time invite link survives a section switch.
 */
export function AdminUsersSection({
  accessRules,
  dashboard,
  filter,
  invites,
  mcp,
  onSelectFilter,
  onSelectResource,
  resource,
  users
}: AdminUsersSectionProps) {
  const [query, setQuery] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [leaveDeletedPage, setLeaveDeletedPage] = useState(false);
  const listFilter = parseAdminUserListFilter(filter);
  const providers = useAdminProvidersController(resource !== null);
  const user = useMemo(
    () => (resource ? dashboard.users.find(({ id }) => id === resource) ?? null : null),
    [dashboard.users, resource]
  );
  const rows = useMemo(
    () => deriveAdminUserRows({ filter: listFilter, groups: dashboard.groups, query, users: dashboard.users }),
    [dashboard.groups, dashboard.users, listFilter, query]
  );
  const counts = useMemo(
    () => adminUserFilterCounts({ groups: dashboard.groups, openInviteCount: invites.open.length, users: dashboard.users }),
    [dashboard.groups, dashboard.users, invites.open.length]
  );
  const backToList = useCallback(() => onSelectResource(null), [onSelectResource]);
  // A confirmed delete settles while the panel still counts the action as
  // running; the return to the list waits for the next idle commit so the
  // navigation guard sees the finished state.
  const onDeleted = useCallback(() => setLeaveDeletedPage(true), []);
  useEffect(() => {
    if (!leaveDeletedPage || users.actionsDisabled) return;
    const timer = window.setTimeout(() => {
      setLeaveDeletedPage(false);
      onSelectResource(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [leaveDeletedPage, onSelectResource, users.actionsDisabled]);
  const changeFilter = useCallback(
    (next: AdminUserListFilter) => onSelectFilter(next === "all" ? null : next),
    [onSelectFilter]
  );
  const { requestRevokeAllSessions } = users.actions;
  const actionsDisabled = users.actionsDisabled;

  const topbar = useMemo<AdminShellTopbar>(() => {
    if (resource) {
      return { title: <Crumbs current={user?.displayName ?? "User"} onBack={backToList} /> };
    }
    return {
      actions: (
        <>
          <UiV2Button data-testid="users-signup-rules" onClick={() => setRulesOpen(true)} tone="ghost" type="button">
            Sign-up rules
          </UiV2Button>
          <UiV2Button data-testid="users-invite" icon="plus" onClick={() => setInviteOpen(true)} tone="primary" type="button">
            Invite
          </UiV2Button>
          <AdminTopbarMenu
            actions={[
              {
                disabled: actionsDisabled,
                icon: "logout",
                label: "Revoke all sessions",
                onSelect: requestRevokeAllSessions,
                tone: "destructive"
              }
            ]}
          />
        </>
      ),
      title: "Users"
    };
  }, [actionsDisabled, backToList, requestRevokeAllSessions, resource, user?.displayName]);
  useAdminSectionTopbar(topbar);

  const sheets = (
    <>
      <AdminInviteSheet
        controller={invites}
        groups={dashboard.groups}
        onClose={() => setInviteOpen(false)}
        open={inviteOpen}
      />
      <AdminSignupRulesSheet
        controller={accessRules}
        groups={dashboard.groups}
        onClose={() => setRulesOpen(false)}
        open={rulesOpen}
      />
    </>
  );

  if (resource) {
    if (!user) {
      return (
        <div className="px-4 py-12 text-center sm:px-6" role="alert">
          <p className="text-sm font-semibold text-ink-secondary">This user no longer exists.</p>
          <UiV2Button className="mt-4" onClick={backToList} tone="ghost" type="button">Back to users</UiV2Button>
        </div>
      );
    }
    return (
      <>
        <AdminUserPage
          catalog={dashboard.catalog}
          groups={dashboard.groups}
          key={user.id}
          mcp={mcp}
          onDeleted={onDeleted}
          providers={{
            connections: providers.state.connections,
            error: providers.state.error,
            loaded: providers.state.loaded,
            refresh: providers.actions.refresh
          }}
          user={user}
          users={users}
        />
        {sheets}
      </>
    );
  }

  return (
    <div className="flex max-w-[1200px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8" data-testid="admin-users-index">
      <AdminUsersList
        counts={counts}
        filter={listFilter}
        filterParam={filter}
        groups={dashboard.groups}
        nowMs={invites.nowMs}
        onChangeFilter={changeFilter}
        onChangeQuery={setQuery}
        onOpen={onSelectResource}
        query={query}
        rows={rows}
        totalUserCount={dashboard.users.length}
        users={users}
      />
      <AdminOpenInvites controller={invites} expanded={listFilter === "invited"} />
      {sheets}
    </div>
  );
}

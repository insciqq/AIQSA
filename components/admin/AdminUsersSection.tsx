import {
  AdminGroupOptions,
  AdminTaskBackButton,
  AdminTaskDetailPane,
  AdminTaskIndexPane,
  AdminTaskWorkspace,
  dangerButton,
  DeletionHint,
  EmptyState,
  GroupChips,
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import {
  entitlementCountLabel,
  hasEntitlements,
  type AdminSortDirection,
  type AdminUserSortKey,
  type AdminUserStatusFilter,
  userDeletionInfo,
  userStatusClass
} from "@/components/admin/adminUserView";
import {
  formatDate,
  modelDisplayName,
  providerDisplayName,
  searchStrategyDisplayName
} from "@/components/admin/adminViewUtils";
import type { AdminDashboard, AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Save,
  Search,
  Trash2,
  UserCheck,
  UserX
} from "lucide-react";
import type { ReactNode, Ref } from "react";

export type AdminUsersData = Readonly<{
  adminUserId: string;
  catalog: AdminDashboard["catalog"];
  groups: AdminGroup[];
  pageUsers: AdminUserRecord[];
  selectedUser: AdminUserRecord | null;
  selectedUserGroupIds: string[];
  totalUserCount: number;
}>;

export type AdminUsersView = Readonly<{
  compactDetailOpen: boolean;
  filteredCount: number;
  pageCount: number;
  pageEnd: number;
  pageIndex: number;
  pageStart: number;
  query: string;
  sortDirection: AdminSortDirection;
  sortKey: AdminUserSortKey;
  statusFilter: AdminUserStatusFilter;
}>;

export type AdminUsersStatus = Readonly<{
  actionsDisabled: boolean;
}>;

export type AdminUsersFocus = Readonly<{
  detail: Ref<HTMLElement>;
  groupsEditor: Ref<HTMLDivElement>;
}>;

export type AdminUsersActions = Readonly<{
  onApprove(user: AdminUserRecord): void;
  onBackToList(): void;
  onEditUserGroups(userId: string): void;
  onNextPage(): void;
  onPreviousPage(): void;
  onQueryChange(value: string): void;
  onRequestDelete(user: AdminUserRecord): void;
  onRequestDisable(user: AdminUserRecord): void;
  onRequestReject(user: AdminUserRecord): void;
  onRequestRevokeSessions(user: AdminUserRecord): void;
  onSaveGroups(user: AdminUserRecord): void;
  onSelectUser(userId: string): void;
  onSelectedUserGroupsChange(userId: string, groupIds: string[]): void;
  onSort(key: AdminUserSortKey): void;
  onStatusFilterChange(value: AdminUserStatusFilter): void;
}>;

export type AdminUsersSectionProps = Readonly<{
  actions: AdminUsersActions;
  data: AdminUsersData;
  focus: AdminUsersFocus;
  mcpAccess?: ReactNode;
  status: AdminUsersStatus;
  view: AdminUsersView;
}>;

const sortOptions: ReadonlyArray<Readonly<{ key: AdminUserSortKey; label: string }>> = [
  { key: "user", label: "User" },
  { key: "status", label: "Status" },
  { key: "role", label: "Role" },
  { key: "groups", label: "Groups" },
  { key: "access", label: "Access" },
  { key: "lastSession", label: "Last session" }
];

function UserListRow({
  active,
  adminUserId,
  onSelect,
  user
}: Readonly<{
  active: boolean;
  adminUserId: string;
  onSelect(): void;
  user: AdminUserRecord;
}>) {
  const isSelf = user.id === adminUserId;

  return (
    <article
      className={`min-w-0 border-b border-trace-subtle px-4 py-3 last:border-b-0 ${active ? "bg-control-selected" : "bg-transparent"}`}
      data-testid="admin-user-row"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">
            {user.displayName}
            {isSelf ? <span className="ml-2 text-[11px] font-medium text-proof">You</span> : null}
          </p>
          <p className="mt-0.5 break-words text-xs text-ink-muted [overflow-wrap:anywhere]">
            {user.email ?? "No email"}
          </p>
        </div>
        <span className={`shrink-0 rounded-pill border px-2 py-0.5 text-[11px] capitalize ${userStatusClass(user.status)}`}>
          {user.status}
        </span>
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted">
        <span className="capitalize">{user.role}</span>
        <span>{entitlementCountLabel(user.effectiveEntitlements)}</span>
        <span>{formatDate(user.lastSessionAt)}</span>
      </div>
      <div className="mt-2 flex min-w-0 items-end justify-between gap-3">
        <GroupChips groups={user.groups} />
        <button className={quietButton} onClick={onSelect} type="button">
          {user.status === "pending" ? "Review" : "Details"}
        </button>
      </div>
    </article>
  );
}

function EffectiveAccess({
  catalog,
  user
}: Readonly<{
  catalog: AdminDashboard["catalog"];
  user: AdminUserRecord;
}>) {
  if (!hasEntitlements(user.effectiveEntitlements)) {
    return (
      <p className="border-l-2 border-caution bg-caution/5 px-3 py-2 text-xs leading-5 text-caution">
        No model access
      </p>
    );
  }

  return (
    <div className="grid gap-4 text-xs text-ink-secondary">
      {user.effectiveEntitlements.providers.length ? (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">Providers</p>
          <p className="mt-1 break-words leading-5 [overflow-wrap:anywhere]">
            {user.effectiveEntitlements.providers.map((provider) => providerDisplayName(catalog, provider)).join(", ")}
          </p>
        </div>
      ) : null}
      {user.effectiveEntitlements.models.length ? (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">Models</p>
          <div className="mt-1 divide-y divide-trace-subtle border-y border-trace-subtle">
            {user.effectiveEntitlements.models.map((model) => (
              <p className="break-words py-2 [overflow-wrap:anywhere]" key={`${model.provider}:${model.modelId}`}>
                {providerDisplayName(catalog, model.provider)} / {modelDisplayName(catalog, model)}
              </p>
            ))}
          </div>
        </div>
      ) : null}
      {user.effectiveEntitlements.searchStrategies.length ? (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">Search</p>
          <p className="mt-1 break-words leading-5 [overflow-wrap:anywhere]">
            {user.effectiveEntitlements.searchStrategies
              .map((strategy) => searchStrategyDisplayName(catalog, strategy))
              .join(", ")}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function AdminUserDetail({ actions, data, detailRef, groupsEditorRef, mcpAccess, status }: Readonly<{
  actions: AdminUsersActions;
  data: AdminUsersData;
  detailRef: Ref<HTMLElement>;
  groupsEditorRef: Ref<HTMLDivElement>;
  mcpAccess?: ReactNode;
  status: AdminUsersStatus;
}>) {
  const { adminUserId, catalog, groups, selectedUser, selectedUserGroupIds } = data;

  if (!selectedUser) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <AdminTaskBackButton label="Back to users" onClick={actions.onBackToList} />
        <EmptyState detail="Select a user to review groups, access, and account actions." title="No user selected" />
      </div>
    );
  }

  const isSelf = selectedUser.id === adminUserId;
  const deletion = userDeletionInfo(selectedUser, adminUserId);

  return (
    <article
      aria-label={`Selected user ${selectedUser.displayName}`}
      className="min-w-0 px-4 py-5 outline-none sm:px-6 lg:px-8 lg:py-7"
      data-testid="admin-user-detail"
      ref={detailRef}
      tabIndex={-1}
    >
      <AdminTaskBackButton label="Back to users" onClick={actions.onBackToList} />
      <div className="flex min-w-0 items-start justify-between gap-4 border-b border-trace-subtle pb-5">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">Selected user</p>
          <h3 className="mt-2 break-words text-xl font-semibold tracking-tight text-ink [overflow-wrap:anywhere]">
            {selectedUser.displayName}
          </h3>
          <p className="mt-1 break-words text-sm text-ink-muted [overflow-wrap:anywhere]">
            {selectedUser.email ?? "No email"}
          </p>
          <p className="mt-2 text-xs text-ink-secondary">
            <span className="capitalize">{selectedUser.role}</span> · {selectedUser.hasVerifiedIdentity ? "Verified email" : "Email not verified"}
            {isSelf ? " · Acting admin" : ""}
          </p>
        </div>
        <span className={`shrink-0 rounded-pill border px-2 py-1 text-xs capitalize ${userStatusClass(selectedUser.status)}`}>
          {selectedUser.status}
        </span>
      </div>

      <section className="border-b border-trace-subtle py-5" data-testid="admin-user-groups-editor" ref={groupsEditorRef} tabIndex={-1}>
        <h4 className="text-sm font-semibold text-ink">Groups</h4>
        {selectedUser.status === "pending" || (selectedUser.status === "active" && !isSelf) ? (
          <div className="mt-3 grid gap-3">
            <AdminGroupOptions
              groups={groups}
              label={selectedUser.status === "pending" ? "Groups applied on approval" : "Group memberships"}
              onChange={(groupIds) => actions.onSelectedUserGroupsChange(selectedUser.id, groupIds)}
              selected={selectedUserGroupIds}
            />
            <p className="text-xs leading-5 text-ink-muted">
              {selectedUser.status === "pending"
                ? "These groups are applied when the pending user is approved."
                : "Group changes apply to future catalog and run entitlement checks."}
            </p>
          </div>
        ) : (
          <div className="mt-3"><GroupChips groups={selectedUser.groups} /></div>
        )}
      </section>

      <section className="border-b border-trace-subtle py-5">
        <h4 className="text-sm font-semibold text-ink">Effective access</h4>
        <p className="mt-1 text-xs leading-5 text-ink-muted">
          Read-only access resolved from current group memberships. Direct user model overrides are not available here.
        </p>
        <div className="mt-4"><EffectiveAccess catalog={catalog} user={selectedUser} /></div>
      </section>

      {mcpAccess}

      <section className="py-5">
        <h4 className="text-sm font-semibold text-ink">Account actions</h4>
        <div className="mt-3 grid max-w-xl gap-2">
          {selectedUser.status === "pending" ? (
            <>
              <button
                className={primaryButton}
                disabled={status.actionsDisabled || !selectedUser.hasVerifiedIdentity}
                onClick={() => actions.onApprove(selectedUser)}
                type="button"
              >
                <UserCheck aria-hidden="true" className="size-3.5" />
                Approve user
              </button>
              <button className={dangerButton} disabled={status.actionsDisabled} onClick={() => actions.onRequestReject(selectedUser)} type="button">
                <UserX aria-hidden="true" className="size-3.5" />
                Reject user
              </button>
            </>
          ) : null}

          {selectedUser.status === "active" && !isSelf ? (
            <>
              <button className={primaryButton} disabled={status.actionsDisabled} onClick={() => actions.onSaveGroups(selectedUser)} type="button">
                <Save aria-hidden="true" className="size-3.5" />
                Save groups
              </button>
              <button className={quietButton} disabled={status.actionsDisabled} onClick={() => actions.onRequestRevokeSessions(selectedUser)} type="button">
                <RotateCcw aria-hidden="true" className="size-3.5" />
                Revoke sessions
              </button>
              <button className={dangerButton} disabled={status.actionsDisabled} onClick={() => actions.onRequestDisable(selectedUser)} type="button">
                <Ban aria-hidden="true" className="size-3.5" />
                Disable user
              </button>
            </>
          ) : null}

          {selectedUser.status !== "active" && !isSelf ? (
            <>
              <DeletionHint info={deletion} />
              {deletion.canDelete ? (
                <button className={dangerButton} disabled={status.actionsDisabled} onClick={() => actions.onRequestDelete(selectedUser)} type="button">
                  <Trash2 aria-hidden="true" className="size-3.5" />
                  Delete stale user
                </button>
              ) : null}
            </>
          ) : null}

          {selectedUser.status === "active" && !isSelf ? <DeletionHint info={deletion} /> : null}
          {selectedUser.status === "active" && isSelf ? (
            <p className="border-l-2 border-proof/35 bg-proof/5 px-3 py-2 text-xs leading-5 text-ink-secondary">
              This is your current admin account. Self-disable and self-delete are not exposed in row or detail actions.
            </p>
          ) : null}
        </div>
      </section>
    </article>
  );
}

export function AdminUsersSection({ actions, data, focus, mcpAccess, status, view }: AdminUsersSectionProps) {
  return (
    <AdminTaskWorkspace indexWidth="23rem">
      <AdminTaskIndexPane compactDetailOpen={view.compactDetailOpen} testId="admin-users-index">
        <div className="border-b border-trace-subtle p-3">
          <label className="block text-xs font-medium text-ink-secondary" htmlFor="admin-users-search">Search users</label>
          <div className="relative mt-1.5">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
            <input
              className={`${inputClass} pl-9`}
              id="admin-users-search"
              onChange={(event) => actions.onQueryChange(event.currentTarget.value)}
              placeholder="Name, email, role, or group"
              value={view.query}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="User status filters">
            {(["all", "pending", "active", "disabled", "denied"] as const).map((userStatus) => (
              <button
                aria-pressed={view.statusFilter === userStatus}
                className={view.statusFilter === userStatus ? primaryButton : quietButton}
                key={userStatus}
                onClick={() => actions.onStatusFilterChange(userStatus)}
                type="button"
              >
                <span className="capitalize">{userStatus}</span>
              </button>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <label className="min-w-0 text-xs font-medium text-ink-secondary">
              Sort by
              <select
                aria-label="Sort users"
                className={`${inputClass} mt-1.5`}
                onChange={(event) => actions.onSort(event.currentTarget.value as AdminUserSortKey)}
                value={view.sortKey}
              >
                {sortOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select>
            </label>
            <button className={`${quietButton} self-end`} onClick={() => actions.onSort(view.sortKey)} type="button">
              {view.sortDirection === "asc" ? "Asc" : "Desc"}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-trace-subtle px-4 py-2 text-xs text-ink-muted">
          <span>
            <span className="font-mono text-ink-secondary">{view.pageStart}-{view.pageEnd}</span> of{" "}
            <span className="font-mono text-ink-secondary">{view.filteredCount}</span>
          </span>
          <div className="flex items-center gap-1.5">
            <button aria-label="Previous users page" className={quietButton} disabled={view.pageIndex <= 0} onClick={actions.onPreviousPage} type="button">
              <ChevronLeft aria-hidden="true" className="size-3.5" />
            </button>
            <span className="font-mono text-[11px] text-ink-secondary">{view.pageIndex + 1}/{view.pageCount}</span>
            <button aria-label="Next users page" className={quietButton} disabled={view.pageIndex >= view.pageCount - 1} onClick={actions.onNextPage} type="button">
              <ChevronRight aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        </div>

        <div className="min-w-0" data-testid="admin-users-list">
          {data.pageUsers.length ? data.pageUsers.map((user) => (
            <UserListRow
              active={data.selectedUser?.id === user.id}
              adminUserId={data.adminUserId}
              key={user.id}
              onSelect={() => actions.onSelectUser(user.id)}
              user={user}
            />
          )) : (
            <EmptyState
              detail={data.totalUserCount ? "Change the search or status filter to see other users." : "New access requests and accounts will appear here."}
              title={data.totalUserCount ? "No users match this view" : "No users yet"}
            />
          )}
        </div>
      </AdminTaskIndexPane>

      <AdminTaskDetailPane compactDetailOpen={view.compactDetailOpen} testId="admin-users-detail-pane">
        <AdminUserDetail
          actions={actions}
          data={data}
          detailRef={focus.detail}
          groupsEditorRef={focus.groupsEditor}
          mcpAccess={mcpAccess}
          status={status}
        />
      </AdminTaskDetailPane>
    </AdminTaskWorkspace>
  );
}

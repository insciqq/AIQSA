import {
  AdminGroupOptions,
  AdminTaskBackButton,
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
  providerDisplayName,
  providerModelDisplayName,
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

const userDirectoryColumns =
  "md:grid-cols-[minmax(9rem,1.45fr)_minmax(6.5rem,1fr)_minmax(4rem,0.55fr)_minmax(7rem,0.9fr)_minmax(9rem,0.9fr)]";

function UserListRow({
  adminUserId,
  onSelect,
  user
}: Readonly<{
  adminUserId: string;
  onSelect(): void;
  user: AdminUserRecord;
}>) {
  const isSelf = user.id === adminUserId;

  return (
    <button
      aria-label={`Open ${user.displayName}`}
      className={`group/user-row grid w-full min-w-0 gap-3 border-b border-trace-subtle bg-transparent px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-control-hover active:bg-control-pressed sm:px-5 ${userDirectoryColumns} md:items-center`}
      data-testid="admin-user-row"
      onClick={onSelect}
      type="button"
    >
      <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 md:items-center">
        <span className="min-w-0">
          <span className="block break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">
            {user.displayName}{isSelf ? <span className="ml-2 text-[11px] font-medium text-proof">You</span> : null}
          </span>
          <span className="mt-0.5 block break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{user.email ?? "No email"}</span>
        </span>
        <span className={`shrink-0 self-center rounded-pill border px-2 py-0.5 text-[11px] capitalize ${userStatusClass(user.status)}`}>
          {user.status}
        </span>
      </span>
      <span className="grid min-w-0 grid-cols-2 gap-2 md:contents">
        <span className="block min-w-0">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted md:hidden">Groups</span>
          <GroupChips groups={user.groups} />
        </span>
        <span className="block text-xs capitalize text-ink-secondary">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted md:hidden">Role</span>
          {user.role}
        </span>
        <span className="block text-xs text-ink-secondary">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted md:hidden">Access</span>
          {entitlementCountLabel(user.effectiveEntitlements)}
        </span>
        <span className="flex min-w-0 items-end justify-between gap-3 text-xs text-ink-muted md:items-center">
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">
            <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted md:hidden">Last session</span>
            {formatDate(user.lastSessionAt)}
          </span>
          <ChevronRight aria-hidden="true" className="mb-0.5 size-4 shrink-0 text-ink-muted transition-transform group-hover/user-row:translate-x-0.5 group-hover/user-row:text-ink-secondary md:mb-0" />
        </span>
      </span>
    </button>
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

  const modelGrants = user.effectiveEntitlements.models.map((model) => ({
    label: providerModelDisplayName(catalog, model),
    model
  }));
  const availableModelGrants = modelGrants.filter(({ label }) => label !== "Unavailable model");
  const catalogMissingModelGrants = modelGrants.filter(({ label }) => label === "Unavailable model");

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
            {availableModelGrants.map(({ label, model }) => (
              <p className="break-words py-2 [overflow-wrap:anywhere]" key={`${model.provider}:${model.modelId}`}>
                {label}
              </p>
            ))}
            {catalogMissingModelGrants.length ? (
              <details className="py-2">
                <summary className="cursor-pointer text-ink-secondary">
                  {catalogMissingModelGrants.length} unavailable model grant{catalogMissingModelGrants.length === 1 ? "" : "s"}
                </summary>
                <p className="mt-2 leading-5 text-ink-muted">
                  These grants remain effective records, but their provider/model pairs are absent from the current catalog.
                </p>
                <ul className="mt-2 grid gap-1 font-mono text-[11px] text-ink-muted">
                  {catalogMissingModelGrants.map(({ model }) => (
                    <li className="break-all" key={`${model.provider}:${model.modelId}`}>
                      {model.provider} / {model.modelId}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
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
        <AdminTaskBackButton alwaysVisible label="Back to users" onClick={actions.onBackToList} />
        <EmptyState detail="Select a user to review groups, access, and account actions." title="No user selected" />
      </div>
    );
  }

  const isSelf = selectedUser.id === adminUserId;
  const deletion = userDeletionInfo(selectedUser, adminUserId);

  return (
    <article
      aria-label={`Selected user ${selectedUser.displayName}`}
      className="mx-auto min-w-0 max-w-5xl px-4 py-5 outline-none sm:px-6 lg:px-8 lg:py-7"
      data-testid="admin-user-detail"
      ref={detailRef}
      tabIndex={-1}
    >
      <AdminTaskBackButton alwaysVisible label="Back to users" onClick={actions.onBackToList} />
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
  if (view.compactDetailOpen) {
    return (
      <div data-testid="admin-users-detail-pane">
        <AdminUserDetail
          actions={actions}
          data={data}
          detailRef={focus.detail}
          groupsEditorRef={focus.groupsEditor}
          mcpAccess={mcpAccess}
          status={status}
        />
      </div>
    );
  }

  return (
    <div className="min-w-0 px-4 pb-8 sm:px-6 lg:px-8" data-testid="admin-users-index">
      <div className="mx-auto max-w-7xl">
        <div className="grid gap-3 border-b border-trace-subtle py-4 lg:grid-cols-[minmax(18rem,1fr)_auto_auto] lg:items-end">
          <div>
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
          </div>
          <div className="flex flex-wrap gap-1.5 lg:col-start-2 lg:row-start-1 lg:self-end" role="group" aria-label="User status filters">
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
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 lg:col-start-3 lg:row-start-1">
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

        <div className="flex items-center justify-between gap-3 py-3 text-xs text-ink-muted">
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

        <div className="min-w-0 overflow-hidden rounded-panel border border-trace-subtle" data-testid="admin-users-list">
          {data.pageUsers.length ? (
            <div
              className={`hidden gap-3 border-b border-trace-subtle bg-control-surface px-5 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted ${userDirectoryColumns} md:grid`}
              data-testid="admin-users-header"
            >
              <span>User</span><span>Groups</span><span>Role</span><span>Access</span><span>Last session</span>
            </div>
          ) : null}
          {data.pageUsers.length ? data.pageUsers.map((user) => (
            <UserListRow
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
      </div>
    </div>
  );
}

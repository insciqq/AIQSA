import {
  AdminGroupOptions,
  AdminTableRegion,
  dangerButton,
  DeletionHint,
  EmptyState,
  focusRing,
  GroupChips,
  primaryButton,
  quietButton,
  touchTarget
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
  ArrowUpDown,
  Ban,
  ChevronLeft,
  ChevronRight,
  PanelRightOpen,
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

function SortHeader({
  active,
  direction,
  label,
  onClick
}: {
  active: boolean;
  direction: AdminSortDirection;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      className={[
        `inline-flex min-h-control-sm items-center gap-1.5 rounded-control px-2 text-xs font-medium ${focusRing} ${touchTarget}`,
        active ? "bg-surface-selected text-accent-cyan" : "text-content-muted hover:bg-surface-hover hover:text-content-secondary"
      ].join(" ")}
      type="button"
      onClick={onClick}
      aria-label={`Sort by ${label}`}
    >
      {label}
      <ArrowUpDown className="size-3" aria-hidden="true" />
      {active ? <span className="font-mono text-[11px]">{direction === "asc" ? "Asc" : "Desc"}</span> : null}
    </button>
  );
}

function AdminUserDetail({
  actions,
  data,
  detailRef,
  groupsEditorRef,
  mcpAccess,
  status
}: Readonly<{
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
      <aside className="border-t border-separator-subtle bg-surface-raised/40 p-3 lg:border-l lg:border-t-0">
        <EmptyState title="No user selected" detail="Select a row to review groups, access, and account actions." />
      </aside>
    );
  }

  const isSelf = selectedUser.id === adminUserId;
  const deletion = userDeletionInfo(selectedUser, adminUserId);
  const noAccess = !hasEntitlements(selectedUser.effectiveEntitlements);

  return (
    <aside
      aria-label={`Selected user ${selectedUser.displayName}`}
      className="border-t border-separator-subtle bg-surface-raised/40 p-3 outline-none focus-visible:border-accent-cyan focus-visible:ring-2 focus-visible:ring-accent-cyan/30 lg:border-l lg:border-t-0"
      data-testid="admin-user-detail"
      ref={detailRef}
      tabIndex={-1}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-content-secondary">Selected user</div>
          <h3 className="mt-1 break-words text-sm font-semibold text-content-primary [overflow-wrap:anywhere]">{selectedUser.displayName}</h3>
          <p className="mt-1 break-words text-xs text-content-muted [overflow-wrap:anywhere]">{selectedUser.email ?? "No email"}</p>
        </div>
        <span className={`shrink-0 rounded-pill border px-2 py-1 text-xs capitalize ${userStatusClass(selectedUser.status)}`}>
          {selectedUser.status}
        </span>
      </div>

      <div className="mt-3 grid gap-2 text-xs">
        <div className="rounded-control bg-surface-raised px-3 py-2">
          <div className="text-xs font-medium text-content-secondary mb-1">Identity</div>
          <div className="flex flex-wrap gap-2 text-content-secondary">
            <span>{selectedUser.role}</span>
            <span>{selectedUser.hasVerifiedIdentity ? "Verified email" : "Email not verified"}</span>
            {isSelf ? <span className="text-accent-cyan">Acting admin</span> : null}
          </div>
        </div>

        <div
          className="rounded-control bg-surface-raised px-3 py-2 outline-none focus-visible:border-accent-cyan focus-visible:ring-2 focus-visible:ring-accent-cyan/30"
          data-testid="admin-user-groups-editor"
          ref={groupsEditorRef}
          tabIndex={-1}
        >
          {selectedUser.status === "pending" || (selectedUser.status === "active" && !isSelf) ? (
            <div className="grid gap-2">
              <AdminGroupOptions
                groups={groups}
                label="Groups"
                onChange={(groupIds) => actions.onSelectedUserGroupsChange(selectedUser.id, groupIds)}
                selected={selectedUserGroupIds}
              />
              <p className="text-[11px] leading-5 text-content-muted">
                {selectedUser.status === "pending"
                  ? "These groups are applied when the pending user is approved."
                  : "Group changes apply to future catalog and run entitlement checks."}
              </p>
            </div>
          ) : (
            <>
              <div className="text-xs font-medium text-content-secondary mb-1">Groups</div>
              <GroupChips groups={selectedUser.groups} />
            </>
          )}
        </div>

        <div className="rounded-control bg-surface-raised px-3 py-2">
          <div className="text-xs font-medium text-content-secondary mb-2">Effective access</div>
          {noAccess ? (
            <div className="rounded-control border border-accent-amber/25 bg-accent-amber/10 px-2 py-1.5 text-accent-amber">
              No model access
            </div>
          ) : (
            <div className="grid gap-2 text-content-secondary">
              {selectedUser.effectiveEntitlements.providers.length ? (
                <div>
                  <div className="mb-1 text-[11px] text-content-muted">Providers</div>
                  <div className="flex flex-wrap gap-1">
                    {selectedUser.effectiveEntitlements.providers.map((provider) => (
                      <span
                        className="min-w-0 max-w-full break-words rounded-control bg-surface-raised px-1.5 py-px text-[11px] [overflow-wrap:anywhere]"
                        key={provider}
                      >
                        {providerDisplayName(catalog, provider)}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {selectedUser.effectiveEntitlements.models.length ? (
                <div>
                  <div className="mb-1 text-[11px] text-content-muted">Models</div>
                  <div className="grid gap-1">
                    {selectedUser.effectiveEntitlements.models.map((model) => (
                      <div
                        className="min-w-0 break-words rounded-control bg-surface-raised px-2 py-1 [overflow-wrap:anywhere]"
                        key={`${model.provider}:${model.modelId}`}
                      >
                        {providerDisplayName(catalog, model.provider)} / {modelDisplayName(catalog, model)}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {selectedUser.effectiveEntitlements.searchStrategies.length ? (
                <div>
                  <div className="mb-1 text-[11px] text-content-muted">Search</div>
                  <div className="flex flex-wrap gap-1">
                    {selectedUser.effectiveEntitlements.searchStrategies.map((strategy) => (
                      <span
                        className="min-w-0 max-w-full break-words rounded-control bg-surface-raised px-1.5 py-px text-[11px] [overflow-wrap:anywhere]"
                        key={strategy}
                      >
                        {searchStrategyDisplayName(catalog, strategy)}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {mcpAccess}

      <div className="mt-3 grid gap-2">
        {selectedUser.status !== "active" && !isSelf ? (
          <>
            <DeletionHint info={deletion} />
            {deletion.canDelete ? (
              <button
                className={dangerButton}
                disabled={status.actionsDisabled}
                onClick={() => actions.onRequestDelete(selectedUser)}
                type="button"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                Delete stale user
              </button>
            ) : null}
          </>
        ) : null}

        {selectedUser.status === "pending" ? (
          <>
            <button
              className={primaryButton}
              disabled={status.actionsDisabled || !selectedUser.hasVerifiedIdentity}
              onClick={() => actions.onApprove(selectedUser)}
              type="button"
            >
              <UserCheck className="size-3.5" aria-hidden="true" />
              Approve user
            </button>
            <button
              className={dangerButton}
              disabled={status.actionsDisabled}
              onClick={() => actions.onRequestReject(selectedUser)}
              type="button"
            >
              <UserX className="size-3.5" aria-hidden="true" />
              Reject user
            </button>
          </>
        ) : null}

        {selectedUser.status === "active" && !isSelf ? (
          <>
            <button
              className={quietButton}
              disabled={status.actionsDisabled}
              onClick={() => actions.onSaveGroups(selectedUser)}
              type="button"
            >
              <Save className="size-3.5" aria-hidden="true" />
              Save groups
            </button>
            <button
              className={quietButton}
              disabled={status.actionsDisabled}
              onClick={() => actions.onRequestRevokeSessions(selectedUser)}
              type="button"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              Revoke sessions
            </button>
            <button
              className={dangerButton}
              disabled={status.actionsDisabled}
              onClick={() => actions.onRequestDisable(selectedUser)}
              type="button"
            >
              <Ban className="size-3.5" aria-hidden="true" />
              Disable user
            </button>
            <DeletionHint info={deletion} />
          </>
        ) : null}

        {selectedUser.status === "active" && isSelf ? (
          <div className="rounded-control border border-accent-cyan/20 bg-accent-cyan/[0.07] px-2 py-2 text-xs text-content-secondary">
            This is your current admin account. Self-disable and self-delete are not exposed in row or detail actions.
          </div>
        ) : null}
      </div>
    </aside>
  );
}

export function AdminUsersSection({ actions, data, focus, mcpAccess, status, view }: AdminUsersSectionProps) {
  return (
    <div className="grid min-h-[420px] lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <div className="flex flex-col gap-2 border-b border-separator-subtle bg-surface-raised/40 px-3 py-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-h-control-sm min-w-0 flex-1 items-center gap-2 rounded-control border border-separator-subtle bg-surface-thread px-3 focus-within:ring-2 focus-within:ring-accent-cyan/55 [@media(hover:none)]:!min-h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!min-h-touch [@media(pointer:coarse)]:!min-w-touch">
            <Search className="size-3.5 shrink-0 text-content-muted" aria-hidden="true" />
            <input
              aria-label="Search users"
              className="min-h-control-sm min-w-0 flex-1 bg-transparent text-xs [@media(hover:none)]:!min-h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!min-h-touch [@media(pointer:coarse)]:!min-w-touch text-content-primary outline-none placeholder:text-content-disabled"
              onChange={(event) => actions.onQueryChange(event.currentTarget.value)}
              placeholder="Search users, emails, roles, groups"
              value={view.query}
            />
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="User status filters">
            {(["all", "pending", "active", "disabled", "denied"] as const).map((userStatus) => (
              <button
                aria-pressed={view.statusFilter === userStatus}
                className={[
                  "inline-flex min-h-control-sm items-center justify-center gap-1.5 rounded-control px-3 text-xs font-medium capitalize outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 [@media(hover:none)]:!min-h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!min-h-touch [@media(pointer:coarse)]:!min-w-touch",
                  view.statusFilter === userStatus
                    ? "bg-surface-selected text-accent-cyan"
                    : "bg-surface-raised text-content-secondary hover:bg-surface-hover hover:text-content-primary"
                ].join(" ")}
                key={userStatus}
                type="button"
                onClick={() => actions.onStatusFilterChange(userStatus)}
              >
                {userStatus}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-separator-subtle px-3 py-2 text-xs text-content-muted">
          <span>
            Showing <span className="font-mono text-content-secondary">{view.pageStart}-{view.pageEnd}</span> of{" "}
            <span className="font-mono text-content-secondary">{view.filteredCount}</span> users
          </span>
          <div className="flex items-center gap-1.5">
            <button
              className={`grid h-8 w-8 place-items-center rounded-control bg-surface-raised text-content-secondary disabled:opacity-50 ${focusRing} [@media(hover:none)]:!h-touch [@media(hover:none)]:!w-touch [@media(pointer:coarse)]:!h-touch [@media(pointer:coarse)]:!w-touch`}
              disabled={view.pageIndex <= 0}
              onClick={actions.onPreviousPage}
              aria-label="Previous users page"
              type="button"
            >
              <ChevronLeft className="size-3.5" aria-hidden="true" />
            </button>
            <span className="font-mono text-[11px] text-content-secondary">
              {view.pageIndex + 1}/{view.pageCount}
            </span>
            <button
              className={`grid h-8 w-8 place-items-center rounded-control bg-surface-raised text-content-secondary disabled:opacity-50 ${focusRing} [@media(hover:none)]:!h-touch [@media(hover:none)]:!w-touch [@media(pointer:coarse)]:!h-touch [@media(pointer:coarse)]:!w-touch`}
              disabled={view.pageIndex >= view.pageCount - 1}
              onClick={actions.onNextPage}
              aria-label="Next users page"
              type="button"
            >
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        <AdminTableRegion label="Users table">
          <table className="w-full min-w-[900px] border-collapse text-left text-xs">
            <thead className="bg-surface-thread">
              <tr>
                <th
                  aria-sort={view.sortKey === "user" ? (view.sortDirection === "asc" ? "ascending" : "descending") : "none"}
                  className="px-3 py-2 font-medium"
                >
                  <SortHeader
                    active={view.sortKey === "user"}
                    direction={view.sortDirection}
                    label="User"
                    onClick={() => actions.onSort("user")}
                  />
                </th>
                <th
                  aria-sort={view.sortKey === "status" ? (view.sortDirection === "asc" ? "ascending" : "descending") : "none"}
                  className="px-3 py-2 font-medium"
                >
                  <SortHeader
                    active={view.sortKey === "status"}
                    direction={view.sortDirection}
                    label="Status"
                    onClick={() => actions.onSort("status")}
                  />
                </th>
                <th
                  aria-sort={view.sortKey === "role" ? (view.sortDirection === "asc" ? "ascending" : "descending") : "none"}
                  className="px-3 py-2 font-medium"
                >
                  <SortHeader
                    active={view.sortKey === "role"}
                    direction={view.sortDirection}
                    label="Role"
                    onClick={() => actions.onSort("role")}
                  />
                </th>
                <th
                  aria-sort={view.sortKey === "groups" ? (view.sortDirection === "asc" ? "ascending" : "descending") : "none"}
                  className="px-3 py-2 font-medium"
                >
                  <SortHeader
                    active={view.sortKey === "groups"}
                    direction={view.sortDirection}
                    label="Groups"
                    onClick={() => actions.onSort("groups")}
                  />
                </th>
                <th
                  aria-sort={view.sortKey === "access" ? (view.sortDirection === "asc" ? "ascending" : "descending") : "none"}
                  className="px-3 py-2 font-medium"
                >
                  <SortHeader
                    active={view.sortKey === "access"}
                    direction={view.sortDirection}
                    label="Access"
                    onClick={() => actions.onSort("access")}
                  />
                </th>
                <th
                  aria-sort={view.sortKey === "lastSession" ? (view.sortDirection === "asc" ? "ascending" : "descending") : "none"}
                  className="px-3 py-2 font-medium"
                >
                  <SortHeader
                    active={view.sortKey === "lastSession"}
                    direction={view.sortDirection}
                    label="Last session"
                    onClick={() => actions.onSort("lastSession")}
                  />
                </th>
                <th className="px-3 py-2 font-medium text-content-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.pageUsers.length === 0 ? (
                <tr>
                  <td className="px-3 py-8 text-center text-content-muted" colSpan={7}>
                    {data.totalUserCount ? "No users match this view" : "No users yet"}
                  </td>
                </tr>
              ) : null}
              {data.pageUsers.map((user) => {
                const isSelf = user.id === data.adminUserId;
                const active = data.selectedUser?.id === user.id;
                const deletion = userDeletionInfo(user, data.adminUserId);

                return (
                  <tr
                    aria-current={active ? "true" : undefined}
                    className={[
                      "border-b border-separator-subtle align-top last:border-b-0",
                      active ? "bg-accent-cyan/[0.07]" : ""
                    ].join(" ")}
                    key={user.id}
                  >
                    <td className="px-3 py-3">
                      <div className="break-words font-medium text-content-primary [overflow-wrap:anywhere]">
                        {user.displayName}
                        {isSelf ? <span className="ml-2 text-[11px] text-accent-cyan">You</span> : null}
                      </div>
                      <div className="mt-1 break-words text-content-muted [overflow-wrap:anywhere]">{user.email ?? "No email"}</div>
                      {!user.hasVerifiedIdentity ? <div className="mt-1 text-accent-amber">Unverified email</div> : null}
                    </td>
                    <td className="px-3 py-3">
                      <span className={`inline-flex rounded-pill border px-2 py-1 capitalize ${userStatusClass(user.status)}`}>
                        {user.status}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-content-secondary">{user.role}</td>
                    <td className="px-3 py-3 text-content-secondary">
                      <GroupChips groups={user.groups} />
                    </td>
                    <td className="px-3 py-3">
                      <span className={hasEntitlements(user.effectiveEntitlements) ? "text-content-secondary" : "text-accent-amber"}>
                        {entitlementCountLabel(user.effectiveEntitlements)}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-content-secondary">{formatDate(user.lastSessionAt)}</td>
                    <td className="px-3 py-3">
                      <div className="flex max-w-[320px] flex-wrap gap-2">
                        <button className={quietButton} onClick={() => actions.onSelectUser(user.id)} type="button">
                          <PanelRightOpen className="size-3.5" aria-hidden="true" />
                          {user.status === "pending" ? "Review" : "Details"}
                        </button>
                        {user.status === "pending" && user.hasVerifiedIdentity ? (
                          <button
                            className={primaryButton}
                            disabled={status.actionsDisabled}
                            onClick={() => actions.onApprove(user)}
                            type="button"
                          >
                            <UserCheck className="size-3.5" aria-hidden="true" />
                            Approve
                          </button>
                        ) : null}
                        {user.status === "pending" ? (
                          <button
                            className={dangerButton}
                            disabled={status.actionsDisabled}
                            onClick={() => actions.onRequestReject(user)}
                            type="button"
                          >
                            <UserX className="size-3.5" aria-hidden="true" />
                            Reject
                          </button>
                        ) : null}
                        {user.status === "active" && !isSelf ? (
                          <button className={quietButton} onClick={() => actions.onEditUserGroups(user.id)} type="button">
                            <Save className="size-3.5" aria-hidden="true" />
                            Edit groups
                          </button>
                        ) : null}
                        {user.status === "active" && !isSelf ? (
                          <button
                            className={quietButton}
                            disabled={status.actionsDisabled}
                            onClick={() => actions.onRequestRevokeSessions(user)}
                            type="button"
                          >
                            <RotateCcw className="size-3.5" aria-hidden="true" />
                            Revoke
                          </button>
                        ) : null}
                        {user.status === "active" && !isSelf ? (
                          <button
                            className={dangerButton}
                            disabled={status.actionsDisabled}
                            onClick={() => actions.onRequestDisable(user)}
                            type="button"
                          >
                            <Ban className="size-3.5" aria-hidden="true" />
                            Disable
                          </button>
                        ) : null}
                        {user.status !== "active" && !isSelf && deletion.canDelete ? (
                          <button
                            className={dangerButton}
                            disabled={status.actionsDisabled}
                            onClick={() => actions.onRequestDelete(user)}
                            type="button"
                          >
                            <Trash2 className="size-3.5" aria-hidden="true" />
                            Delete
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </AdminTableRegion>
      </div>
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

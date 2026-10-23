"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { adminSectionPath } from "@/components/admin/adminSections";
import type { AdminUsersController } from "@/components/admin/useAdminUsersController";
import {
  ADMIN_USER_FILTER_LABEL,
  ADMIN_USERS_PAGE_SIZE,
  activeGroupIdsForUser,
  formatLastSeen,
  userAccessSummary,
  userInitials,
  visibleAdminUserFilters,
  type AdminUserListFilter
} from "@/components/admin/users/usersView";
import { FilterPill, UserAvatar, UsersTag } from "@/components/admin/users/usersPrimitives";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import type { AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import { Search } from "lucide-react";
import { useId, useState, type MouseEvent } from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-answer-paper";
const compactInput = `${inputClass} h-8 min-h-0 py-0 text-[13px]`;
const compactSelect = `${inputClass} h-8 min-h-0 py-0 pr-8 text-[13px]`;

/** One set of tracks for the header and every row (PRD 5.8). */
const gridTracks =
  "xl:grid-cols-[2rem_minmax(12rem,1fr)_minmax(8rem,12rem)_5rem_4rem_9rem]";

function currentHref(): string {
  return typeof window === "undefined" ? "/admin" : window.location.href;
}

function primaryClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

const accessTone = {
  caution: "text-caution",
  muted: "text-ink-muted",
  normal: "text-ink-secondary"
} as const;

export type AdminUsersListProps = Readonly<{
  counts: Record<AdminUserListFilter, number>;
  filter: AdminUserListFilter;
  /** The raw `?filter=` value kept in row links so Back returns to the same view. */
  filterParam: string | null;
  groups: readonly AdminGroup[];
  nowMs: number;
  onChangeFilter(filter: AdminUserListFilter): void;
  onChangeQuery(query: string): void;
  onOpen(userId: string): void;
  query: string;
  rows: readonly AdminUserRecord[];
  totalUserCount: number;
  users: AdminUsersController;
}>;

function GroupTags({ user }: Readonly<{ user: AdminUserRecord }>) {
  if (user.status === "disabled") return <UsersTag dot>Disabled</UsersTag>;
  if (user.status === "denied") return <UsersTag dot tone="critical">Denied</UsersTag>;
  if (!user.groups.length) return <UsersTag dot tone="caution">No groups</UsersTag>;
  const shown = user.groups.slice(0, 2);
  const hidden = user.groups.length - shown.length;
  return (
    <>
      {shown.map((group) => <UsersTag key={group.groupId}>{group.name}</UsersTag>)}
      {hidden > 0 ? <UsersTag>+{hidden}</UsersTag> : null}
    </>
  );
}

function GroupSelect({
  disabled,
  groups,
  id,
  label,
  onChange,
  value
}: Readonly<{
  disabled: boolean;
  groups: readonly AdminGroup[];
  id?: string;
  label: string;
  onChange(groupId: string): void;
  value: string;
}>) {
  return (
    <select
      aria-label={label}
      className={`${compactSelect} w-full xl:max-w-[15rem]`}
      disabled={disabled}
      id={id}
      onChange={(event) => onChange(event.currentTarget.value)}
      value={value}
    >
      <option value="">No group</option>
      {groups.filter((group) => !group.archivedAt).map((group) => (
        <option key={group.id} value={group.id}>{group.name}</option>
      ))}
    </select>
  );
}

function UserRow({
  filterParam,
  groups,
  nowMs,
  onOpen,
  user,
  users
}: Readonly<{
  filterParam: string | null;
  groups: readonly AdminGroup[];
  nowMs: number;
  onOpen(userId: string): void;
  user: AdminUserRecord;
  users: AdminUsersController;
}>) {
  const [groupId, setGroupId] = useState("");
  const [expectedGroupIds, setExpectedGroupIds] = useState<string[] | null>(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [busy, setBusy] = useState(false);
  const isSelf = user.id === users.adminUserId;
  const pending = user.status === "pending";
  const currentGroupIds = activeGroupIdsForUser(user, groups);
  const canAddToGroup = user.status === "active" && currentGroupIds.length === 0;
  const access = userAccessSummary(user, groups);
  const lastSeen = formatLastSeen(user.lastSessionAt, new Date(nowMs));
  const disabled = users.actionsDisabled || busy;
  const href = adminSectionPath(currentHref(), "users", user.id, filterParam);
  const identity = [user.email ?? "no email", isSelf ? "you" : null, user.role === "admin" ? "admin" : null]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const selectGroup = (next: string) => {
    setExpectedGroupIds((previous) => previous ?? currentGroupIds);
    setGroupId(next);
  };

  const run = async (action: () => Promise<boolean>) => {
    setBusy(true);
    try {
      return await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className={[
        "relative grid grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-4 py-3 sm:px-5 xl:min-h-14 xl:items-center xl:gap-x-4 xl:py-2.5",
        gridTracks,
        pending ? "bg-caution/5" : user.status === "disabled" ? "opacity-65" : ""
      ].join(" ")}
      data-testid="admin-user-row"
      data-user-status={user.status}
    >
      <UserAvatar initials={userInitials(user)} />
      <div className="min-w-0">
        <a
          aria-label={`Open ${user.displayName}`}
          className={`block break-words text-sm font-medium text-ink [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-[''] hover:text-proof ${focusRing}`}
          href={href}
          onClick={(event) => {
            if (!primaryClick(event)) return;
            event.preventDefault();
            onOpen(user.id);
          }}
        >
          {user.displayName}
        </a>
        <p className="break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{identity}</p>
        <p className={`mt-0.5 text-xs xl:hidden ${accessTone[access.tone]}`}>
          {access.label} · <span className="text-ink-muted">{lastSeen}</span>
        </p>
      </div>
      <div className="relative z-[1] col-start-2 flex min-w-0 flex-wrap items-center gap-1 xl:col-start-auto">
        {pending ? (
          <GroupSelect
            disabled={disabled}
            groups={groups}
            label={`Group for ${user.displayName}`}
            onChange={selectGroup}
            value={groupId}
          />
        ) : addingGroup ? (
          <GroupSelect
            disabled={disabled}
            groups={groups}
            label={`Group for ${user.displayName}`}
            onChange={selectGroup}
            value={groupId}
          />
        ) : (
          <GroupTags user={user} />
        )}
      </div>
      <span className={`hidden truncate text-sm xl:block ${accessTone[access.tone]}`}>{access.label}</span>
      <span className="hidden truncate text-sm text-ink-muted xl:block">{lastSeen}</span>
      <div className="relative z-[1] col-start-3 row-start-1 flex shrink-0 items-center justify-end gap-1.5 xl:col-start-auto xl:row-start-auto">
        {pending ? (
          <>
            <UiV2Button
              busy={busy}
              disabled={disabled || !user.hasVerifiedIdentity}
              onClick={() => void run(() => users.actions.approve(user, groupId ? [groupId] : [], expectedGroupIds ?? currentGroupIds))}
              title={user.hasVerifiedIdentity ? undefined : "The email is not verified yet"}
              tone="primary"
              type="button"
            >
              Approve
            </UiV2Button>
            <UiV2Button disabled={disabled} onClick={() => users.actions.requestReject(user)} tone="ghost" type="button">
              Reject
            </UiV2Button>
          </>
        ) : canAddToGroup && addingGroup ? (
          <>
            <UiV2Button
              busy={busy}
              disabled={disabled || !groupId}
              onClick={() => void run(async () => {
                const ok = await users.actions.saveGroups(user, [groupId], expectedGroupIds ?? currentGroupIds);
                if (ok) { setAddingGroup(false); setExpectedGroupIds(null); }
                return ok;
              })}
              tone="primary"
              type="button"
            >
              Add
            </UiV2Button>
            <UiV2Button disabled={busy} onClick={() => { setAddingGroup(false); setExpectedGroupIds(null); }} tone="ghost" type="button">Cancel</UiV2Button>
          </>
        ) : canAddToGroup ? (
          <UiV2Button
            disabled={disabled}
            onClick={() => { setAddingGroup(true); setExpectedGroupIds(currentGroupIds); }}
            tone="ghost"
            type="button"
          >
            Add to group
          </UiV2Button>
        ) : (
          <UiV2Icon className="text-ink-muted" name="chevron-right" />
        )}
      </div>
    </li>
  );
}

/** Toolbar, the users table and its `Show N more` (PRD 5.8). */
export function AdminUsersList({
  counts,
  filter,
  filterParam,
  groups,
  nowMs,
  onChangeFilter,
  onChangeQuery,
  onOpen,
  query,
  rows,
  totalUserCount,
  users
}: AdminUsersListProps) {
  const [expanded, setExpanded] = useState(false);
  const searchId = useId();
  const shown = expanded ? rows : rows.slice(0, ADMIN_USERS_PAGE_SIZE);
  const hidden = rows.length - shown.length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-80">
          <label className="sr-only" htmlFor={searchId}>Search users</label>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
          <input
            className={`${compactInput} pl-9`}
            id={searchId}
            onChange={(event) => onChangeQuery(event.currentTarget.value)}
            placeholder="Name, email or group"
            type="search"
            value={query}
          />
        </div>
        <div aria-label="User filters" className="flex flex-wrap items-center gap-1.5" role="group">
          {visibleAdminUserFilters(counts, filter).map((candidate) => (
            <FilterPill
              count={counts[candidate]}
              key={candidate}
              label={ADMIN_USER_FILTER_LABEL[candidate]}
              onSelect={() => onChangeFilter(candidate)}
              selected={filter === candidate}
              tone={candidate === "pending" || candidate === "no-model-access" ? "caution" : "neutral"}
            />
          ))}
        </div>
      </div>

      {filter === "invited" ? null : (
        <div className="overflow-hidden rounded-[12px] border border-trace-subtle bg-answer-paper" data-testid="admin-users-list">
          {rows.length ? (
            <>
              <div
                aria-hidden="true"
                className={`hidden items-center gap-x-4 border-b border-trace-subtle px-5 py-2 text-metadata font-semibold uppercase tracking-[0.06em] text-ink-muted xl:grid ${gridTracks}`}
              >
                <span />
                <span>User</span>
                <span>Groups</span>
                <span>Access</span>
                <span>Last seen</span>
                <span />
              </div>
              <ul aria-label="Users" className="divide-y divide-trace-subtle">
                {shown.map((user) => (
                  <UserRow
                    filterParam={filterParam}
                    groups={groups}
                    key={user.id}
                    nowMs={nowMs}
                    onOpen={onOpen}
                    user={user}
                    users={users}
                  />
                ))}
              </ul>
              {hidden > 0 ? (
                <div className="flex justify-center border-t border-trace-subtle px-4 py-2.5">
                  <UiV2Button onClick={() => setExpanded(true)} tone="ghost" type="button">
                    Show {hidden} more
                  </UiV2Button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="px-5 py-10 text-center" role="status">
              <p className="text-sm font-semibold text-ink-secondary">
                {totalUserCount ? "No users match this view" : "No users yet"}
              </p>
              <p className="mx-auto mt-1 max-w-xl text-sm leading-6 text-ink-muted">
                {totalUserCount
                  ? "Change the search or pick another filter to see other users."
                  : "New sign-ups and invited people appear here."}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

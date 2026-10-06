"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { NotSet, UsageMeter, type UsageMeterTone } from "@/components/admin/limits/UsageLimitControls";
import {
  formatLimitValue,
  formatSpend,
  limitSourceLabel,
  sortUsersByBudgetShare,
  usageBudgetState,
  usagePercent,
  type UsageBudgetState
} from "@/components/admin/limits/usageLimitsView";
import { cardClass, sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import { UsersTag } from "@/components/admin/users/usersPrimitives";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminUsageLimitGroupRow, AdminUsageLimitUserRow } from "@/lib/contracts/usageLimits";
import { Search } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";

const USERS_PAGE_SIZE = 50;

const headerClass =
  "hidden items-center gap-x-4 border-b border-trace-subtle px-5 py-2 text-metadata font-semibold uppercase tracking-[0.06em] text-ink-muted xl:grid";
const rowClass =
  "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 px-4 py-3 sm:px-5 xl:items-center xl:gap-x-4";
const factsClass = "col-span-2 grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 xl:contents";
const actionClass = "col-start-2 row-start-1 flex justify-end xl:col-start-auto xl:row-start-auto";

/** One set of tracks for the header and every row once the shell leaves room (xl, as the Users list). */
const groupTracks = "xl:grid-cols-[minmax(12rem,1.6fr)_5rem_minmax(8rem,1fr)_minmax(7rem,0.8fr)_minmax(7rem,0.8fr)_4.5rem]";
const userTracks = "xl:grid-cols-[minmax(12rem,1.3fr)_minmax(9rem,1fr)_minmax(11rem,1.2fr)_minmax(10rem,1fr)_4.5rem]";

/** A labelled value: the label shows on narrow screens, where there is no header row. */
function Fact({ children, label, wide = false }: Readonly<{ children: ReactNode; label: string; wide?: boolean }>) {
  return (
    <div className={`min-w-0 ${wide ? "col-span-2 sm:col-span-2 xl:col-span-1" : ""}`}>
      <p className="text-metadata font-medium uppercase tracking-[0.06em] text-ink-muted xl:sr-only">{label}</p>
      <div className="mt-0.5 min-w-0 break-words text-sm text-ink [overflow-wrap:anywhere] xl:mt-0">{children}</div>
    </div>
  );
}

function LimitValue({ field, value }: Readonly<{ field: "messagesPerDay" | "messagesPerHour" | "monthlyBudgetMicros"; value: number | null }>) {
  const text = formatLimitValue(field, value);
  return text === null ? <NotSet /> : <span className="font-mono tabular-nums">{text}</span>;
}

export function UsageLimitGroupsList({
  busy,
  groups,
  onEdit
}: Readonly<{
  busy: boolean;
  groups: readonly AdminUsageLimitGroupRow[];
  onEdit(group: AdminUsageLimitGroupRow): void;
}>) {
  const headingId = useId();
  // Archived groups grant nothing, so they follow the ones that apply.
  const ordered = useMemo(
    () => [...groups.filter((group) => !group.archivedAt), ...groups.filter((group) => group.archivedAt)],
    [groups]
  );
  return (
    <section aria-labelledby={headingId} className="min-w-0" data-testid="admin-usage-limit-groups">
      <div className="border-b border-trace-subtle pb-3">
        <h2 className={sectionHeadingClass} id={headingId}>Group allowances</h2>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-ink-muted">
          What each member of a group gets. Someone in several groups gets the most generous value of each limit; groups that leave a limit empty don&apos;t take part.
        </p>
      </div>
      {ordered.length === 0 ? (
        <p className="py-6 text-sm text-ink-muted" role="status">
          No groups yet. Create groups in Groups to give their members an allowance.
        </p>
      ) : (
        <div className={`${cardClass} mt-3 overflow-hidden`}>
          <div aria-hidden="true" className={`${headerClass} ${groupTracks}`}>
            <span>Group</span>
            <span>Members</span>
            <span>Budget per member</span>
            <span>Per hour</span>
            <span>Per day</span>
            <span />
          </div>
          <ul aria-label="Group allowances" className="divide-y divide-trace-subtle">
            {ordered.map((group) => (
              <li
                className={`${rowClass} ${groupTracks} ${group.archivedAt ? "bg-control-surface/40" : ""}`}
                data-archived={group.archivedAt ? true : undefined}
                data-testid="admin-usage-group-row"
                key={group.groupId}
              >
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{group.name}</p>
                  {group.archivedAt ? (
                    <p className="mt-1 flex flex-wrap gap-1"><UsersTag dot>Archived · does not apply</UsersTag></p>
                  ) : null}
                </div>
                <div className={factsClass}>
                  <Fact label="Members"><span className="font-mono tabular-nums">{group.memberCount.toLocaleString("en-US")}</span></Fact>
                  <Fact label="Budget per member"><LimitValue field="monthlyBudgetMicros" value={group.monthlyBudgetMicros} /></Fact>
                  <Fact label="Messages per hour"><LimitValue field="messagesPerHour" value={group.messagesPerHour} /></Fact>
                  <Fact label="Messages per day"><LimitValue field="messagesPerDay" value={group.messagesPerDay} /></Fact>
                </div>
                <div className={actionClass}>
                  {group.archivedAt ? null : (
                    <UiV2Button aria-label={`Edit allowance for ${group.name}`} disabled={busy} onClick={() => onEdit(group)} type="button">
                      Edit
                    </UiV2Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const stateTone: Record<Exclude<UsageBudgetState, "none">, UsageMeterTone> = {
  near: "near",
  ok: "ok",
  reached: "reached",
  zero: "reached"
};

function stateText(state: UsageBudgetState, percent: number): Readonly<{ className: string; text: string }> | null {
  switch (state) {
    case "none":
      return null;
    case "ok":
      return { className: "text-ink-muted", text: `${percent}% of budget` };
    case "near":
      return { className: "text-caution", text: `${percent}% · near budget` };
    case "reached":
      return { className: "text-critical", text: `Budget reached · ${percent}%` };
    case "zero":
      return { className: "text-caution", text: "Budget is $0 · no spending" };
  }
}

function SpendCell({ user }: Readonly<{ user: AdminUsageLimitUserRow }>) {
  const budget = user.effective.monthlyBudgetMicros.value;
  const state = usageBudgetState(user.monthSpentMicros, budget);
  const percent = budget === null ? 0 : usagePercent(user.monthSpentMicros, budget);
  const status = stateText(state, percent);
  return (
    <>
      <span className="font-mono tabular-nums">{formatSpend(user.monthSpentMicros)}</span>
      {state === "none" ? null : (
        <span className="mt-1.5 block">
          <UsageMeter
            label={`Budget used by ${user.displayName}`}
            percent={state === "zero" ? 100 : percent}
            tone={stateTone[state]}
            valueText={status?.text ?? ""}
          />
        </span>
      )}
      {status ? <span className={`mt-1 block text-xs ${status.className}`} data-budget-state={state}>{status.text}</span> : null}
    </>
  );
}

function MessageLine({ count, label, limit }: Readonly<{ count: number; label: string; limit: number | null }>) {
  const reached = limit !== null && count >= limit;
  return (
    <span className="block text-xs text-ink-secondary">
      {label}: <span className="font-mono tabular-nums text-ink">{count.toLocaleString("en-US")}</span>
      {limit === null ? null : <> of <span className="font-mono tabular-nums">{limit.toLocaleString("en-US")}</span></>}
      {reached ? <span className="text-critical"> · limit reached</span> : null}
    </span>
  );
}

const statusLabel: Record<string, string> = { denied: "Denied", disabled: "Disabled", pending: "Pending" };

function UserRow({ busy, onEdit, user }: Readonly<{ busy: boolean; onEdit(user: AdminUsageLimitUserRow): void; user: AdminUsageLimitUserRow }>) {
  const budget = user.effective.monthlyBudgetMicros;
  const exempt = user.effective.exempt;
  return (
    <li
      className={`${rowClass} ${userTracks} ${user.status === "active" ? "" : "opacity-75"}`}
      data-testid="admin-usage-user-row"
      data-user-id={user.userId}
    >
      <div className="min-w-0">
        <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{user.displayName}</p>
        {user.email ? <p className="break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{user.email}</p> : null}
        {user.status !== "active" || user.override ? (
          <p className="mt-1 flex flex-wrap gap-1">
            {user.status === "active" ? null : <UsersTag dot>{statusLabel[user.status] ?? user.status}</UsersTag>}
            {user.override ? <UsersTag>{exempt ? "Exempt" : "Override"}</UsersTag> : null}
          </p>
        ) : null}
      </div>
      <div className={factsClass}>
        <Fact label="Monthly budget">
          {budget.value === null ? (
            <span className="text-ink-secondary">{limitSourceLabel(budget, exempt)}</span>
          ) : (
            <>
              <LimitValue field="monthlyBudgetMicros" value={budget.value} />
              <span className="block text-xs text-ink-muted">{limitSourceLabel(budget, exempt)}</span>
            </>
          )}
        </Fact>
        <Fact label="Spent this month"><SpendCell user={user} /></Fact>
        <Fact label="Messages" wide>
          <MessageLine count={user.messagesLastHour} label="Last hour" limit={user.effective.messagesPerHour.value} />
          <MessageLine count={user.messagesLastDay} label="Last day" limit={user.effective.messagesPerDay.value} />
        </Fact>
      </div>
      <div className={actionClass}>
        <UiV2Button aria-label={`Edit limits for ${user.displayName}`} disabled={busy} onClick={() => onEdit(user)} type="button">
          Edit
        </UiV2Button>
      </div>
    </li>
  );
}

export function UsageLimitUsersList({
  busy,
  onEdit,
  users
}: Readonly<{
  busy: boolean;
  onEdit(user: AdminUsageLimitUserRow): void;
  users: readonly AdminUsageLimitUserRow[];
}>) {
  const headingId = useId();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const sorted = useMemo(() => sortUsersByBudgetShare(users), [users]);
  const needle = query.trim().toLocaleLowerCase();
  const rows = needle
    ? sorted.filter((user) => `${user.displayName} ${user.email ?? ""}`.toLocaleLowerCase().includes(needle))
    : sorted;
  const shown = expanded ? rows : rows.slice(0, USERS_PAGE_SIZE);
  const hidden = rows.length - shown.length;
  return (
    <section aria-labelledby={headingId} className="min-w-0" data-testid="admin-usage-limit-users">
      <div className="flex min-w-0 flex-col gap-3 border-b border-trace-subtle pb-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className={sectionHeadingClass} id={headingId}>Users</h2>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            Effective limits and use this month, most of their budget used first.
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <label className="sr-only" htmlFor={searchId}>Search users</label>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
          <input
            className={`${inputClass} h-8 min-h-0 py-0 pl-9 text-[13px]`}
            id={searchId}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Name or email"
            type="search"
            value={query}
          />
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-sm text-ink-muted" role="status">
          {users.length ? "No users match this search." : "No users yet."}
        </p>
      ) : (
        <div className={`${cardClass} mt-3 overflow-hidden`}>
          <div aria-hidden="true" className={`${headerClass} ${userTracks}`}>
            <span>User</span>
            <span>Monthly budget</span>
            <span>Spent this month</span>
            <span>Messages</span>
            <span />
          </div>
          <ul aria-label="Users and their limits" className="divide-y divide-trace-subtle">
            {shown.map((user) => <UserRow busy={busy} key={user.userId} onEdit={onEdit} user={user} />)}
          </ul>
          {hidden > 0 ? (
            <div className="flex justify-center border-t border-trace-subtle px-4 py-2.5">
              <UiV2Button onClick={() => setExpanded(true)} tone="ghost" type="button">Show {hidden} more</UiV2Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

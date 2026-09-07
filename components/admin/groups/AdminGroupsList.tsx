"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { adminSectionPath } from "@/components/admin/adminSections";
import {
  ADMIN_GROUP_FILTER_LABEL,
  ADMIN_GROUPS_PAGE_SIZE,
  adminGroupStatusFilters,
  groupAccessSummary,
  isFullAccessGroup,
  type AdminGroupStatusFilter
} from "@/components/admin/groups/groupsView";
import { formatShortDay } from "@/components/admin/users/usersView";
import { FilterPill, UsersTag } from "@/components/admin/users/usersPrimitives";
import { UiV2Button, UiV2Icon, UiV2Monogram } from "@/components/ui-v2";
import type { AdminCatalog, AdminGroup } from "@/lib/contracts/admin";
import { Search } from "lucide-react";
import { useId, useState, type MouseEvent } from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-answer-paper";
const compactInput = `${inputClass} h-8 min-h-0 py-0 text-[13px]`;

/** One set of tracks for the header and every row; the grid stacks below `md`. */
const gridTracks = "md:grid-cols-[2rem_minmax(0,1fr)_7rem_minmax(0,1fr)_1rem] lg:grid-cols-[2rem_minmax(0,1.2fr)_8rem_minmax(0,1fr)_1rem]";

function currentHref(): string {
  return typeof window === "undefined" ? "/admin" : window.location.href;
}

function primaryClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function count(n: number, singular: string): string {
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

export type AdminGroupsListProps = Readonly<{
  catalog: AdminCatalog;
  counts: Record<AdminGroupStatusFilter, number>;
  filter: AdminGroupStatusFilter;
  nowMs: number;
  onChangeFilter(filter: AdminGroupStatusFilter): void;
  onChangeQuery(query: string): void;
  onOpen(groupId: string): void;
  query: string;
  rows: readonly AdminGroup[];
  totalGroupCount: number;
}>;

function GroupRow({ catalog, group, nowMs, onOpen }: Readonly<{
  catalog: AdminCatalog;
  group: AdminGroup;
  nowMs: number;
  onOpen(groupId: string): void;
}>) {
  const archived = group.archivedAt !== null;
  const access = groupAccessSummary(group, catalog);
  return (
    <li
      className={[
        "relative grid grid-cols-[2rem_minmax(0,1fr)_1rem] items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-control-hover sm:px-5 md:min-h-14 md:gap-x-4 md:py-2.5",
        gridTracks,
        archived ? "opacity-65" : ""
      ].join(" ")}
      data-group-status={archived ? "archived" : isFullAccessGroup(group) ? "built-in" : "active"}
      data-testid="admin-group-row"
    >
      <UiV2Monogram label={group.name} />
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <a
            aria-label={`Open ${group.name}`}
            className={`min-w-0 break-words text-sm font-medium text-ink [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-[''] hover:text-proof ${focusRing}`}
            href={adminSectionPath(currentHref(), "groups", group.id)}
            onClick={(event) => {
              if (!primaryClick(event)) return;
              event.preventDefault();
              onOpen(group.id);
            }}
          >
            {group.name}
          </a>
          {isFullAccessGroup(group) ? <UsersTag>Built-in</UsersTag> : null}
          {archived ? <UsersTag dot>Archived {formatShortDay(group.archivedAt!, new Date(nowMs))}</UsersTag> : null}
        </div>
        <p className="truncate text-xs text-ink-muted md:hidden">
          {count(group.userCount, "member")} · {access}
        </p>
      </div>
      <span className="hidden truncate text-sm text-ink-secondary md:block">{count(group.userCount, "member")}</span>
      <span className="hidden truncate text-sm text-ink-secondary md:block">{access}</span>
      <UiV2Icon className="text-ink-muted" name="chevron-right" />
    </li>
  );
}

/** Search, the Active / All / Archived pills and the groups table (PRD 5.9). */
export function AdminGroupsList({
  catalog,
  counts,
  filter,
  nowMs,
  onChangeFilter,
  onChangeQuery,
  onOpen,
  query,
  rows,
  totalGroupCount
}: AdminGroupsListProps) {
  const [expanded, setExpanded] = useState(false);
  const searchId = useId();
  const shown = expanded ? rows : rows.slice(0, ADMIN_GROUPS_PAGE_SIZE);
  const hidden = rows.length - shown.length;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-80">
          <label className="sr-only" htmlFor={searchId}>Search groups</label>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
          <input
            className={`${compactInput} pl-9`}
            id={searchId}
            onChange={(event) => onChangeQuery(event.currentTarget.value)}
            placeholder="Group name"
            type="search"
            value={query}
          />
        </div>
        <div aria-label="Group filters" className="flex flex-wrap items-center gap-1.5" role="group">
          {adminGroupStatusFilters.map((candidate) => (
            <FilterPill
              count={counts[candidate]}
              key={candidate}
              label={ADMIN_GROUP_FILTER_LABEL[candidate]}
              onSelect={() => onChangeFilter(candidate)}
              selected={filter === candidate}
            />
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-[12px] border border-trace-subtle bg-answer-paper" data-testid="admin-groups-list">
        {rows.length ? (
          <>
            <div
              aria-hidden="true"
              className={`hidden items-center gap-x-4 border-b border-trace-subtle px-5 py-2 text-metadata font-semibold uppercase tracking-[0.06em] text-ink-muted md:grid ${gridTracks}`}
            >
              <span />
              <span>Group</span>
              <span>Members</span>
              <span>Access</span>
              <span />
            </div>
            <ul aria-label="Groups" className="divide-y divide-trace-subtle">
              {shown.map((group) => (
                <GroupRow catalog={catalog} group={group} key={group.id} nowMs={nowMs} onOpen={onOpen} />
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
              {totalGroupCount ? "No groups match this view" : "No groups yet"}
            </p>
            <p className="mx-auto mt-1 max-w-xl text-sm leading-6 text-ink-muted">
              {totalGroupCount
                ? "Change the search or pick another filter to see other groups."
                : "Create a group, add people to it and choose which models, Search sources and MCP servers they can use."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

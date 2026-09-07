"use client";

import { adminSectionPath } from "@/components/admin/adminSections";
import { AdminTopbarMenu, useAdminSectionTopbar, type AdminShellTopbar } from "@/components/admin/AdminShell";
import { AdminGroupNameSheet, type AdminGroupNameSheetMode } from "@/components/admin/groups/AdminGroupNameSheet";
import { AdminGroupPage } from "@/components/admin/groups/AdminGroupPage";
import { AdminGroupsList } from "@/components/admin/groups/AdminGroupsList";
import {
  adminGroupFilterCounts,
  deriveAdminGroupRows,
  groupDeletionInfo,
  isFullAccessGroup,
  type AdminGroupStatusFilter
} from "@/components/admin/groups/groupsView";
import type { AdminGroupsController } from "@/components/admin/useAdminGroupsController";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import { useAdminProvidersController } from "@/components/admin/useAdminProvidersController";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import type { AdminDashboard } from "@/lib/contracts/admin";
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";

const crumbLink =
  "rounded-[6px] font-medium text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-focus";

export type AdminGroupsSectionProps = Readonly<{
  dashboard: Pick<AdminDashboard, "catalog" | "groups" | "users">;
  groups: AdminGroupsController;
  mcp: AdminMcpController;
  nowMs: number;
  onSelectResource(resource: string | null): void;
  /** Open group page from `?resource=`, or null for the list. */
  resource: string | null;
}>;

type OpenSheet = Readonly<{ kind: "create" }> | Readonly<{ groupId: string; kind: "rename" }>;

function Crumbs({ current, onBack }: Readonly<{ current: string; onBack(): void }>) {
  const href = adminSectionPath(typeof window === "undefined" ? "/admin" : window.location.href, "groups");
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
        Groups
      </a>
      <UiV2Icon className="size-3.5 shrink-0 text-ink-muted" name="chevron-right" />
      <span className="truncate">{current}</span>
    </span>
  );
}

/**
 * Groups section (PRD 5.9): the list with search and status pills, one group
 * page per `?resource=`, and the name sheet behind `New group` and Rename.
 * The section owns the topbar; the panel owns the controllers.
 */
export function AdminGroupsSection({
  dashboard,
  groups,
  mcp,
  nowMs,
  onSelectResource,
  resource
}: AdminGroupsSectionProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AdminGroupStatusFilter>("active");
  // Keyed by the open page so a page change never carries a sheet along.
  const [openSheet, setOpenSheet] = useState<OpenSheet | null>(null);
  const [leaveDeletedPage, setLeaveDeletedPage] = useState(false);
  const providers = useAdminProvidersController(resource !== null);
  const group = useMemo(
    () => (resource ? dashboard.groups.find(({ id }) => id === resource) ?? null : null),
    [dashboard.groups, resource]
  );
  const rows = useMemo(
    () => deriveAdminGroupRows({ catalog: dashboard.catalog, filter, groups: dashboard.groups, query }),
    [dashboard.catalog, dashboard.groups, filter, query]
  );
  const counts = useMemo(() => adminGroupFilterCounts(dashboard.groups), [dashboard.groups]);
  const backToList = useCallback(() => onSelectResource(null), [onSelectResource]);
  // A confirmed delete settles while the panel still counts the action as
  // running; the return to the list waits for the next idle commit so the
  // navigation guard sees the finished state.
  useEffect(() => {
    if (!leaveDeletedPage || groups.actionsDisabled) return;
    const timer = window.setTimeout(() => {
      setLeaveDeletedPage(false);
      onSelectResource(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [groups.actionsDisabled, leaveDeletedPage, onSelectResource]);

  const { requestArchive, requestDelete } = groups.actions;
  const actionsDisabled = groups.actionsDisabled;
  const createOpen = openSheet?.kind === "create" && resource === null;
  const renameOpen = resource !== null && openSheet?.kind === "rename" && openSheet.groupId === resource;
  const sheetMode: AdminGroupNameSheetMode | null = createOpen
    ? { kind: "create" }
    : renameOpen && group
      ? { group, kind: "rename" }
      : null;

  const topbar = useMemo<AdminShellTopbar>(() => {
    if (resource && group) {
      const archived = group.archivedAt !== null;
      const deletion = groupDeletionInfo(group);
      return {
        actions: isFullAccessGroup(group) ? null : (
          <AdminTopbarMenu
            actions={[
              {
                disabled: actionsDisabled || archived,
                icon: "edit",
                label: "Rename",
                onSelect: () => setOpenSheet({ groupId: group.id, kind: "rename" })
              },
              ...(archived ? [] : [{
                disabled: actionsDisabled,
                icon: "archive" as const,
                label: "Archive",
                onSelect: () => requestArchive(group),
                separatorBefore: true
              }]),
              {
                disabled: actionsDisabled || !deletion.canDelete,
                icon: "trash",
                label: "Delete",
                onSelect: () => requestDelete(group, () => setLeaveDeletedPage(true)),
                separatorBefore: archived,
                tone: "destructive"
              }
            ]}
            label={`More actions for ${group.name}`}
          />
        ),
        title: <Crumbs current={group.name} onBack={backToList} />
      };
    }
    if (resource) {
      return { title: <Crumbs current="Group" onBack={backToList} /> };
    }
    return {
      actions: (
        <UiV2Button
          data-testid="groups-new-group"
          disabled={actionsDisabled}
          icon="plus"
          onClick={() => setOpenSheet({ kind: "create" })}
          tone="primary"
          type="button"
        >
          New group
        </UiV2Button>
      ),
      title: "Groups"
    };
  }, [actionsDisabled, backToList, group, requestArchive, requestDelete, resource]);
  useAdminSectionTopbar(topbar);

  const sheet = sheetMode ? (
    <AdminGroupNameSheet
      controller={groups}
      key={sheetMode.kind === "rename" ? `rename:${sheetMode.group.id}` : "create"}
      mode={sheetMode}
      onClose={() => setOpenSheet(null)}
      onSaved={(groupId) => {
        setOpenSheet(null);
        if (sheetMode.kind === "create" && groupId) onSelectResource(groupId);
      }}
      open
    />
  ) : null;

  if (resource) {
    if (!group) {
      return (
        <div className="px-4 py-12 text-center sm:px-6" data-testid="admin-groups-section" role="alert">
          <p className="text-sm font-semibold text-ink-secondary">This group no longer exists.</p>
          <UiV2Button className="mt-4" onClick={backToList} tone="ghost" type="button">Back to groups</UiV2Button>
        </div>
      );
    }
    return (
      <div className="min-w-0" data-testid="admin-groups-section">
        <AdminGroupPage
          catalog={dashboard.catalog}
          controller={groups}
          group={group}
          key={group.id}
          mcp={mcp}
          nowMs={nowMs}
          onRename={() => setOpenSheet({ groupId: group.id, kind: "rename" })}
          providers={{
            connections: providers.state.connections,
            error: providers.state.error,
            loaded: providers.state.loaded
          }}
          users={dashboard.users}
        />
        {sheet}
      </div>
    );
  }

  return (
    <div className="flex max-w-[1120px] min-w-0 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8" data-testid="admin-groups-index">
      <AdminGroupsList
        catalog={dashboard.catalog}
        counts={counts}
        filter={filter}
        nowMs={nowMs}
        onChangeFilter={setFilter}
        onChangeQuery={setQuery}
        onOpen={onSelectResource}
        query={query}
        rows={rows}
        totalGroupCount={dashboard.groups.length}
      />
      <p className="text-xs leading-5 text-ink-muted">
        A group gives its members models, Search sources and MCP servers. Provider keys for a group are chosen on the provider page.
      </p>
      {sheet}
    </div>
  );
}

import {
  grantCounts,
  groupAccessState,
  groupAccessSummary,
  groupDeletionInfo,
  type AdminGroupStatusFilter
} from "@/components/admin/adminGroupView";
import {
  AdminTaskBackButton,
  AdminTaskDetailPane,
  AdminTaskIndexPane,
  AdminTaskWorkspace,
  dangerButton,
  DeletionHint,
  EmptyState,
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import { formatDate } from "@/components/admin/adminViewUtils";
import type { AdminCatalog, AdminGroup } from "@/lib/contracts/admin";
import { Archive, Plus, Save, Search, Trash2 } from "lucide-react";
import type { Ref } from "react";

export type AdminGroupsSectionData = Readonly<{
  allGroups: readonly AdminGroup[];
  catalog: AdminCatalog;
  selectedGroup: AdminGroup | null;
  visibleGroups: readonly AdminGroup[];
}>;

export type AdminGroupsSectionDraft = Readonly<{
  compactDetailOpen: boolean;
  createFormOpen: boolean;
  createName: string;
  query: string;
  renameName: string;
  renamingGroupId: string | null;
  statusFilter: AdminGroupStatusFilter;
}>;

export type AdminGroupsSectionStatus = Readonly<{
  actionsDisabled: boolean;
  createError: string | null;
  renameError: string | null;
}>;

export type AdminGroupsSectionRefs = Readonly<{
  detail: Ref<HTMLElement>;
}>;

export type AdminGroupsSectionActions = Readonly<{
  onBackToList(): void;
  onCreateNameChange(value: string): void;
  onCreateSubmit(): Promise<void> | void;
  onQueryChange(value: string): void;
  onRenameNameChange(value: string): void;
  onRenameSubmit(group: AdminGroup): Promise<void> | void;
  onRequestArchive(group: AdminGroup): void;
  onRequestDelete(group: AdminGroup): void;
  onSelectGroup(groupId: string): void;
  onStartRenaming(group: AdminGroup): void;
  onStatusFilterChange(status: AdminGroupStatusFilter): void;
}>;

export type AdminGroupsSectionProps = Readonly<{
  actions: AdminGroupsSectionActions;
  data: AdminGroupsSectionData;
  draft: AdminGroupsSectionDraft;
  refs: AdminGroupsSectionRefs;
  status: AdminGroupsSectionStatus;
}>;

function GroupListRow({ active, catalog, group, onSelect }: Readonly<{
  active: boolean;
  catalog: AdminCatalog;
  group: AdminGroup;
  onSelect(): void;
}>) {
  const accessState = groupAccessState(group);

  return (
    <article
      className={`min-w-0 border-b border-trace-subtle px-4 py-3 last:border-b-0 ${active ? "bg-control-selected" : "bg-transparent"}`}
      data-testid="admin-group"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{group.name}</p>
          <p className="mt-1 break-words text-xs leading-5 text-ink-muted [overflow-wrap:anywhere]">
            {groupAccessSummary(catalog, group)}
          </p>
        </div>
        <span className={`shrink-0 rounded-pill border px-2 py-0.5 text-[11px] capitalize ${accessState.className}`}>
          {accessState.label}
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-[11px] text-ink-muted">
          <span className="font-mono text-ink-secondary">{group.userCount}</span> user{group.userCount === 1 ? "" : "s"}
          {group.archivedAt ? ` · Archived ${formatDate(group.archivedAt)}` : " · Active"}
        </p>
        <button className={quietButton} onClick={onSelect} type="button">Details</button>
      </div>
    </article>
  );
}

function CreateGroupTask({ actions, draft, status }: Readonly<{
  actions: AdminGroupsSectionActions;
  draft: AdminGroupsSectionDraft;
  status: AdminGroupsSectionStatus;
}>) {
  return (
    <div className="px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <AdminTaskBackButton label="Back to groups" onClick={actions.onBackToList} />
      <div className="max-w-2xl border-b border-trace-subtle pb-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">New group</p>
        <h3 className="mt-2 text-xl font-semibold tracking-tight text-ink">Create a group</h3>
        <p className="mt-2 text-sm leading-6 text-ink-secondary">
          Groups collect users before model, search, and MCP access is assigned.
        </p>
      </div>
      <form
        className="mt-5 grid max-w-xl gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void actions.onCreateSubmit();
        }}
      >
        <label className="text-xs font-medium text-ink-secondary" htmlFor="group-name">Group name</label>
        <input
          aria-describedby={status.createError ? "group-name-error" : undefined}
          aria-invalid={Boolean(status.createError) || undefined}
          className={inputClass}
          id="group-name"
          onChange={(event) => actions.onCreateNameChange(event.currentTarget.value)}
          value={draft.createName}
        />
        {status.createError ? <p className="text-xs text-critical" id="group-name-error">{status.createError}</p> : null}
        <div className="flex flex-wrap gap-2 pt-2">
          <button className={primaryButton} disabled={status.actionsDisabled} type="submit">
            <Plus aria-hidden="true" className="size-3.5" />
            Create
          </button>
          <button className={quietButton} onClick={actions.onBackToList} type="button">Cancel</button>
        </div>
      </form>
    </div>
  );
}

function AdminGroupDetail({ actions, data, detailRef, draft, status }: Readonly<{
  actions: AdminGroupsSectionActions;
  data: Pick<AdminGroupsSectionData, "catalog" | "selectedGroup">;
  detailRef: Ref<HTMLElement>;
  draft: Pick<AdminGroupsSectionDraft, "renameName" | "renamingGroupId">;
  status: Pick<AdminGroupsSectionStatus, "actionsDisabled" | "renameError">;
}>) {
  const selectedGroup = data.selectedGroup;

  if (!selectedGroup) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <AdminTaskBackButton label="Back to groups" onClick={actions.onBackToList} />
        <EmptyState detail="Select a group to inspect membership and access." title="No group selected" />
      </div>
    );
  }

  const archived = Boolean(selectedGroup.archivedAt);
  const counts = grantCounts(selectedGroup);
  const deletion = groupDeletionInfo(selectedGroup);
  const accessState = groupAccessState(selectedGroup);

  return (
    <article
      aria-label={`Selected group ${selectedGroup.name}`}
      className="min-w-0 px-4 py-5 outline-none sm:px-6 lg:px-8 lg:py-7"
      data-testid="admin-group-detail"
      ref={detailRef}
      tabIndex={-1}
    >
      <AdminTaskBackButton label="Back to groups" onClick={actions.onBackToList} />
      <div className="flex min-w-0 items-start justify-between gap-4 border-b border-trace-subtle pb-5">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">Selected group</p>
          <h3 className="mt-2 break-words text-xl font-semibold tracking-tight text-ink [overflow-wrap:anywhere]">{selectedGroup.name}</h3>
          <p className="mt-1 text-sm text-ink-muted">{selectedGroup.userCount} user{selectedGroup.userCount === 1 ? "" : "s"}</p>
        </div>
        <span className={`shrink-0 rounded-pill border px-2 py-1 text-xs capitalize ${accessState.className}`}>{accessState.label}</span>
      </div>

      <section className="border-b border-trace-subtle py-5">
        <h4 className="text-sm font-semibold text-ink">Access summary</h4>
        <p className="mt-1 text-xs leading-5 text-ink-muted">{groupAccessSummary(data.catalog, selectedGroup)}</p>
        <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
          {[
            ["Provider-wide", counts.providers],
            ["Models", counts.models],
            ["Search", counts.search],
            ["State", archived ? "Archived" : "Active"]
          ].map(([label, value]) => (
            <div className="min-w-0" key={String(label)}>
              <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">{label}</dt>
              <dd className="mt-1 break-words font-mono text-sm text-ink [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {!archived && draft.renamingGroupId === selectedGroup.id ? (
        <form
          className="border-b border-trace-subtle py-5"
          onSubmit={(event) => {
            event.preventDefault();
            void actions.onRenameSubmit(selectedGroup);
          }}
        >
          <label className="text-xs font-medium text-ink-secondary" htmlFor="rename-selected-group">Rename group</label>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <input
              aria-describedby={status.renameError ? "rename-selected-group-error" : undefined}
              aria-invalid={Boolean(status.renameError) || undefined}
              className={inputClass}
              id="rename-selected-group"
              name="name"
              onChange={(event) => actions.onRenameNameChange(event.currentTarget.value)}
              value={draft.renameName}
            />
            <button className={primaryButton} disabled={status.actionsDisabled} type="submit">
              <Save aria-hidden="true" className="size-3.5" /> Save
            </button>
          </div>
          {status.renameError ? <p className="mt-2 text-xs text-critical" id="rename-selected-group-error">{status.renameError}</p> : null}
        </form>
      ) : null}

      <section className="py-5">
        <h4 className="text-sm font-semibold text-ink">Group lifecycle</h4>
        <div className="mt-3 grid max-w-xl gap-2">
          <DeletionHint info={deletion} />
          {deletion.canDelete ? (
            <button className={dangerButton} disabled={status.actionsDisabled} onClick={() => actions.onRequestDelete(selectedGroup)} type="button">
              <Trash2 aria-hidden="true" className="size-3.5" /> Delete group
            </button>
          ) : null}
          {archived ? (
            <p className="border-l-2 border-caution bg-caution/5 px-3 py-2 text-xs leading-5 text-caution">
              Archived groups remain visible for history. Their grants no longer apply, and grant editing is disabled.
            </p>
          ) : (
            <>
              <button className={quietButton} disabled={status.actionsDisabled} onClick={() => actions.onStartRenaming(selectedGroup)} type="button">
                <Save aria-hidden="true" className="size-3.5" /> Rename group
              </button>
              <button className={dangerButton} disabled={status.actionsDisabled} onClick={() => actions.onRequestArchive(selectedGroup)} type="button">
                <Archive aria-hidden="true" className="size-3.5" /> Archive group
              </button>
            </>
          )}
        </div>
      </section>
    </article>
  );
}

export function AdminGroupsSection({ actions, data, draft, refs, status }: AdminGroupsSectionProps) {
  return (
    <AdminTaskWorkspace indexWidth="21rem">
      <AdminTaskIndexPane compactDetailOpen={draft.compactDetailOpen} testId="admin-groups-index">
        <div className="border-b border-trace-subtle p-3">
          <label className="block text-xs font-medium text-ink-secondary" htmlFor="admin-groups-search">Search groups</label>
          <div className="relative mt-1.5">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
            <input
              className={`${inputClass} pl-9`}
              id="admin-groups-search"
              onChange={(event) => actions.onQueryChange(event.currentTarget.value)}
              placeholder="Name or access state"
              value={draft.query}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Group status filters">
            {(["active", "all", "archived"] as const).map((filter) => (
              <button
                aria-pressed={draft.statusFilter === filter}
                className={draft.statusFilter === filter ? primaryButton : quietButton}
                key={filter}
                onClick={() => actions.onStatusFilterChange(filter)}
                type="button"
              >
                <span className="capitalize">{filter}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="border-b border-trace-subtle px-4 py-2 text-xs text-ink-muted">
          <span className="font-mono text-ink-secondary">{data.visibleGroups.length}</span> of{" "}
          <span className="font-mono text-ink-secondary">{data.allGroups.length}</span> groups
        </div>
        <div className="min-w-0" data-testid="admin-groups-list">
          {data.visibleGroups.length ? data.visibleGroups.map((group) => (
            <GroupListRow
              active={data.selectedGroup?.id === group.id}
              catalog={data.catalog}
              group={group}
              key={group.id}
              onSelect={() => actions.onSelectGroup(group.id)}
            />
          )) : (
            <EmptyState
              detail={data.allGroups.length ? "Change the search or status filter to see other groups." : "Create a group before assigning team access."}
              title={data.allGroups.length ? "No groups match this view" : "No groups"}
            />
          )}
        </div>
      </AdminTaskIndexPane>

      <AdminTaskDetailPane compactDetailOpen={draft.compactDetailOpen} testId="admin-groups-detail-pane">
        {draft.createFormOpen ? (
          <CreateGroupTask actions={actions} draft={draft} status={status} />
        ) : (
          <AdminGroupDetail
            actions={actions}
            data={{ catalog: data.catalog, selectedGroup: data.selectedGroup }}
            detailRef={refs.detail}
            draft={{ renameName: draft.renameName, renamingGroupId: draft.renamingGroupId }}
            status={{ actionsDisabled: status.actionsDisabled, renameError: status.renameError }}
          />
        )}
      </AdminTaskDetailPane>
    </AdminTaskWorkspace>
  );
}

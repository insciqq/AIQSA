import {
  grantCounts,
  groupAccessState,
  groupAccessSummary,
  groupDeletionInfo,
  type AdminGroupStatusFilter
} from "@/components/admin/adminGroupView";
import {
  AdminTableRegion,
  dangerButton,
  DeletionHint,
  EmptyState,
  focusRing,
  inputClass,
  primaryButton,
  quietButton,
  touchTarget
} from "@/components/admin/adminPrimitives";
import { formatDate } from "@/components/admin/adminViewUtils";
import type { AdminCatalog, AdminGroup } from "@/lib/contracts/admin";
import { Archive, Boxes, PanelRightOpen, Plus, Save, Search, Trash2 } from "lucide-react";
import type { Ref } from "react";

const compactInputClass =
  `min-h-control-sm w-full rounded-control border border-separator-subtle bg-surface-thread px-3 text-xs text-content-primary ${focusRing} ${touchTarget} placeholder:text-content-muted`;

export type AdminGroupsSectionData = Readonly<{
  allGroups: readonly AdminGroup[];
  catalog: AdminCatalog;
  selectedGroup: AdminGroup | null;
  visibleGroups: readonly AdminGroup[];
}>;

export type AdminGroupsSectionDraft = Readonly<{
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

function AdminGroupDetail({
  actions,
  data,
  detailRef,
  draft,
  status
}: Readonly<{
  actions: AdminGroupsSectionActions;
  data: Pick<AdminGroupsSectionData, "catalog" | "selectedGroup">;
  detailRef: Ref<HTMLElement>;
  draft: Pick<AdminGroupsSectionDraft, "renameName" | "renamingGroupId">;
  status: Pick<AdminGroupsSectionStatus, "actionsDisabled" | "renameError">;
}>) {
  const selectedGroup = data.selectedGroup;

  if (!selectedGroup) {
    return (
      <aside className="border-t border-separator-subtle bg-surface-raised/40 p-3 lg:border-l lg:border-t-0">
        <EmptyState title="No group selected" detail="Select a group row to inspect membership and access." />
      </aside>
    );
  }

  const archived = Boolean(selectedGroup.archivedAt);
  const counts = grantCounts(selectedGroup);
  const deletion = groupDeletionInfo(selectedGroup);
  const accessState = groupAccessState(selectedGroup);

  return (
    <aside
      aria-label={`Selected group ${selectedGroup.name}`}
      className="border-t border-separator-subtle bg-surface-raised/40 p-3 outline-none focus-visible:border-accent-cyan focus-visible:ring-2 focus-visible:ring-accent-cyan/30 lg:border-l lg:border-t-0"
      data-testid="admin-group-detail"
      ref={detailRef}
      tabIndex={-1}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-content-secondary">Selected group</div>
          <h3 className="mt-1 break-words text-sm font-semibold text-content-primary [overflow-wrap:anywhere]">
            {selectedGroup.name}
          </h3>
          <p className="mt-1 text-xs text-content-muted">
            {selectedGroup.userCount} user{selectedGroup.userCount === 1 ? "" : "s"}
          </p>
        </div>
        <span className={`shrink-0 rounded-pill border px-2 py-1 text-xs capitalize ${accessState.className}`}>
          {accessState.label}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-control bg-surface-raised px-3 py-2">
          <div className="text-xs font-medium text-content-secondary mb-1">Provider-wide</div>
          <div className="font-mono text-content-primary">{counts.providers}</div>
        </div>
        <div className="rounded-control bg-surface-raised px-3 py-2">
          <div className="text-xs font-medium text-content-secondary mb-1">Models</div>
          <div className="font-mono text-content-primary">{counts.models}</div>
        </div>
        <div className="rounded-control bg-surface-raised px-3 py-2">
          <div className="text-xs font-medium text-content-secondary mb-1">Search</div>
          <div className="font-mono text-content-primary">{counts.search}</div>
        </div>
        <div className="rounded-control bg-surface-raised px-3 py-2">
          <div className="text-xs font-medium text-content-secondary mb-1">State</div>
          <div className="text-content-primary">{archived ? "Archived" : "Active"}</div>
        </div>
      </div>

      <div className="mt-3 rounded-control bg-surface-raised px-3 py-2 text-xs text-content-secondary">
        <div className="text-xs font-medium text-content-secondary mb-1">Unlocks</div>
        {groupAccessSummary(data.catalog, selectedGroup)}
      </div>

      {draft.renamingGroupId === selectedGroup.id ? (
        <form
          className="mt-3 grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void actions.onRenameSubmit(selectedGroup);
          }}
        >
          <label className="text-xs font-medium text-content-secondary" htmlFor="rename-selected-group">
            Rename group
          </label>
          <div className="flex gap-2">
            <input
              aria-describedby={status.renameError ? "rename-selected-group-error" : undefined}
              aria-invalid={Boolean(status.renameError) || undefined}
              className={compactInputClass}
              id="rename-selected-group"
              name="name"
              onChange={(event) => actions.onRenameNameChange(event.currentTarget.value)}
              value={draft.renameName}
            />
            <button className={quietButton} disabled={status.actionsDisabled} type="submit">
              <Save className="size-3.5" aria-hidden="true" />
              Save
            </button>
          </div>
          {status.renameError ? (
            <p className="text-xs text-accent-rose" id="rename-selected-group-error">
              {status.renameError}
            </p>
          ) : null}
        </form>
      ) : null}

      <div className="mt-3 grid gap-2">
        <DeletionHint info={deletion} />
        {deletion.canDelete ? (
          <button
            className={dangerButton}
            disabled={status.actionsDisabled}
            onClick={() => actions.onRequestDelete(selectedGroup)}
            type="button"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            Delete group
          </button>
        ) : null}

        {archived ? (
          <div className="rounded-panel bg-surface-raised/50 px-2 py-2 text-xs text-content-muted">
            Archived groups remain visible for history. Their grants no longer apply, and grant editing is disabled.
          </div>
        ) : (
          <>
            <button
              className={quietButton}
              disabled={status.actionsDisabled}
              onClick={() => actions.onStartRenaming(selectedGroup)}
              type="button"
            >
              <Save className="size-3.5" aria-hidden="true" />
              Rename group
            </button>
            <button
              className={dangerButton}
              disabled={status.actionsDisabled}
              onClick={() => actions.onRequestArchive(selectedGroup)}
              type="button"
            >
              <Archive className="size-3.5" aria-hidden="true" />
              Archive group
            </button>
          </>
        )}
      </div>
    </aside>
  );
}

export function AdminGroupsSection({ actions, data, draft, refs, status }: AdminGroupsSectionProps) {
  return (
    <div className="grid min-h-[420px] lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        {draft.createFormOpen ? (
          <form
            className="grid gap-3 border-b border-separator-subtle bg-surface-raised/40 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void actions.onCreateSubmit();
            }}
          >
            <div className="grid gap-1.5">
              <label className="text-xs font-medium text-content-secondary" htmlFor="group-name">
                Group name
              </label>
              <div className="flex gap-2">
                <input
                  aria-describedby={status.createError ? "group-name-error" : undefined}
                  aria-invalid={Boolean(status.createError) || undefined}
                  className={inputClass}
                  id="group-name"
                  onChange={(event) => actions.onCreateNameChange(event.currentTarget.value)}
                  value={draft.createName}
                />
                <button className={primaryButton} disabled={status.actionsDisabled} type="submit">
                  <Plus className="size-3.5" aria-hidden="true" />
                  Create
                </button>
              </div>
              {status.createError ? (
                <p className="text-xs text-accent-rose" id="group-name-error">
                  {status.createError}
                </p>
              ) : null}
            </div>
          </form>
        ) : null}

        <div className="flex flex-col gap-2 border-b border-separator-subtle bg-surface-raised/40 px-3 py-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-h-control-sm min-w-0 flex-1 items-center gap-2 rounded-control border border-separator-subtle bg-surface-thread px-3 focus-within:ring-2 focus-within:ring-accent-cyan/55 [@media(hover:none)]:!min-h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!min-h-touch [@media(pointer:coarse)]:!min-w-touch">
            <Search className="size-3.5 shrink-0 text-content-muted" aria-hidden="true" />
            <input
              aria-label="Search groups"
              className="min-h-control-sm min-w-0 flex-1 bg-transparent text-xs [@media(hover:none)]:!min-h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!min-h-touch [@media(pointer:coarse)]:!min-w-touch text-content-primary outline-none placeholder:text-content-disabled"
              onChange={(event) => actions.onQueryChange(event.currentTarget.value)}
              placeholder="Search groups or access state"
              value={draft.query}
            />
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Group status filters">
            {(["active", "all", "archived"] as const).map((filter) => (
              <button
                aria-pressed={draft.statusFilter === filter}
                className={[
                  "inline-flex min-h-control-sm items-center justify-center gap-1.5 rounded-control px-3 text-xs font-medium capitalize outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 [@media(hover:none)]:!min-h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!min-h-touch [@media(pointer:coarse)]:!min-w-touch",
                  draft.statusFilter === filter
                    ? "bg-surface-selected text-accent-cyan"
                    : "bg-surface-raised text-content-secondary hover:bg-surface-hover hover:text-content-primary"
                ].join(" ")}
                key={filter}
                onClick={() => actions.onStatusFilterChange(filter)}
                type="button"
              >
                {filter}
              </button>
            ))}
          </div>
        </div>

        <AdminTableRegion label="Groups table">
          <table className="w-full min-w-[760px] border-collapse text-left text-xs">
            <thead className="bg-surface-thread text-content-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Group</th>
                <th className="px-3 py-2 font-medium">Users</th>
                <th className="px-3 py-2 font-medium">Access</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.visibleGroups.length ? (
                data.visibleGroups.map((group) => {
                  const archived = Boolean(group.archivedAt);
                  const accessState = groupAccessState(group);
                  const active = data.selectedGroup?.id === group.id;

                  return (
                    <tr
                      aria-current={active ? "true" : undefined}
                      className={[
                        "border-b border-separator-subtle align-top last:border-b-0",
                        active ? "bg-accent-cyan/[0.07]" : ""
                      ].join(" ")}
                      data-testid="admin-group"
                      key={group.id}
                    >
                      <td className="px-3 py-3">
                        <div className="flex min-w-0 items-center gap-2 text-content-primary">
                          <Boxes className="size-3.5 shrink-0 text-accent-cyan" aria-hidden="true" />
                          <span className="break-words font-medium [overflow-wrap:anywhere]">{group.name}</span>
                        </div>
                        <div className="mt-1 break-words text-content-muted [overflow-wrap:anywhere]">
                          {groupAccessSummary(data.catalog, group)}
                        </div>
                      </td>
                      <td className="px-3 py-3 font-mono text-content-secondary">{group.userCount}</td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex rounded-pill border px-2 py-1 capitalize ${accessState.className}`}>
                          {accessState.label}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-content-secondary">
                        {archived ? `Archived ${formatDate(group.archivedAt)}` : "Active"}
                      </td>
                      <td className="px-3 py-3">
                        <button className={quietButton} onClick={() => actions.onSelectGroup(group.id)} type="button">
                          <PanelRightOpen className="size-3.5" aria-hidden="true" />
                          Select
                        </button>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td className="px-3 py-8 text-center text-content-muted" colSpan={5}>
                    {data.allGroups.length ? "No groups match this view" : "No groups"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </AdminTableRegion>
      </div>
      <AdminGroupDetail
        actions={actions}
        data={{ catalog: data.catalog, selectedGroup: data.selectedGroup }}
        detailRef={refs.detail}
        draft={{ renameName: draft.renameName, renamingGroupId: draft.renamingGroupId }}
        status={{ actionsDisabled: status.actionsDisabled, renameError: status.renameError }}
      />
    </div>
  );
}

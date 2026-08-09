import {
  grantCounts,
  grantEnabled,
  groupAccessState,
  groupAccessSummary,
  groupDeletionInfo,
  providerModelCount,
  type AdminGrantTarget,
  type AdminGroupStatusFilter
} from "@/components/admin/adminGroupView";
import {
  AdminTaskBackButton,
  dangerButton,
  DeletionHint,
  EmptyState,
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import {
  useAdminDiscardAction,
  useAdminDraftProtection
} from "@/components/admin/AdminDraftProtection";
import { AdminUserStatus } from "@/components/admin/AdminUserStatus";
import { userStatusRowClass } from "@/components/admin/adminUserView";
import { formatDate } from "@/components/admin/adminViewUtils";
import type { AdminCatalog, AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import { Archive, Check, ChevronRight, Plus, RotateCcw, Save, Search, Trash2 } from "lucide-react";
import { useState, type ReactNode, type Ref } from "react";

export type AdminAccessGroupView = "members" | "models" | "overview" | "tools";

export type AdminAccessGroupsSectionData = Readonly<{
  allGroups: readonly AdminGroup[];
  allUsers: readonly AdminUserRecord[];
  catalog: AdminCatalog;
  selectedGroup: AdminGroup | null;
  selectedGroupMembers: readonly AdminUserRecord[];
  visibleGroups: readonly AdminGroup[];
}>;

export type AdminAccessGroupsSectionDraft = Readonly<{
  activeView: AdminAccessGroupView;
  createFormOpen: boolean;
  createName: string;
  detailOpen: boolean;
  query: string;
  renameName: string;
  renamingGroupId: string | null;
  statusFilter: AdminGroupStatusFilter;
}>;

export type AdminAccessGroupsSectionStatus = Readonly<{
  actionsDisabled: boolean;
  createError: string | null;
  renameError: string | null;
}>;

export type AdminAccessGroupsSectionRefs = Readonly<{
  detail: Ref<HTMLElement>;
}>;

export type AdminAccessGroupsSectionActions = Readonly<{
  onAddMember(group: AdminGroup, user: AdminUserRecord): Promise<boolean> | void;
  onBackToList(): void;
  onCreateNameChange(value: string): void;
  onCreateSubmit(): Promise<void> | void;
  onQueryChange(value: string): void;
  onRenameNameChange(value: string): void;
  onRenameSubmit(group: AdminGroup): Promise<void> | void;
  onRemoveMember(group: AdminGroup, user: AdminUserRecord): Promise<void> | void;
  onRequestArchive(group: AdminGroup): void;
  onRequestDelete(group: AdminGroup): void;
  onSelectGroup(groupId: string): void;
  onSelectView(view: AdminAccessGroupView): void;
  onStartRenaming(group: AdminGroup): void;
  onStatusFilterChange(status: AdminGroupStatusFilter): void;
  onToggleGrant(group: AdminGroup, target: AdminGrantTarget, enabled: boolean): void;
  onToggleProviderModels(group: AdminGroup, providerId: string, enabled: boolean): void;
}>;

export type AdminAccessGroupsSectionProps = Readonly<{
  actions: AdminAccessGroupsSectionActions;
  data: AdminAccessGroupsSectionData;
  draft: AdminAccessGroupsSectionDraft;
  mcpAccess?: ReactNode;
  refs: AdminAccessGroupsSectionRefs;
  status: AdminAccessGroupsSectionStatus;
}>;

function GrantToggle({ checked, disabled, label, onToggle }: Readonly<{
  checked: boolean;
  disabled?: boolean;
  label: string;
  onToggle(enabled: boolean): void;
}>) {
  return (
    <button
      aria-label={label}
      aria-pressed={checked}
      className={`${quietButton} ${
        checked
          ? "border-proof/35 bg-control-selected text-ink hover:bg-control-selected"
          : ""
      }`}
      disabled={disabled}
      onClick={() => onToggle(!checked)}
      type="button"
    >
      {checked ? <Check aria-hidden="true" className="size-3.5 text-proof" /> : null}
      {checked ? "Granted" : "Not granted"}
    </button>
  );
}

function AccessSection({ children, title }: Readonly<{ children: ReactNode; title: string }>) {
  return (
    <section className="border-b border-trace-subtle py-5 last:border-b-0">
      <h4 className="text-sm font-semibold text-ink">{title}</h4>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function AccessGroupRow({ catalog, group, onSelect }: Readonly<{
  catalog: AdminCatalog;
  group: AdminGroup;
  onSelect(): void;
}>) {
  const accessState = groupAccessState(group);
  const counts = grantCounts(group);

  return (
    <button
      aria-label={`Open ${group.name}`}
      className="group/access-row grid w-full min-w-0 gap-2 border-b border-trace-subtle bg-transparent px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-control-hover active:bg-control-pressed sm:px-5 md:grid-cols-[minmax(12rem,1.4fr)_minmax(7rem,0.55fr)_minmax(14rem,1fr)_minmax(8rem,0.6fr)_auto] md:items-center md:gap-4"
      data-testid="admin-access-group-row"
      onClick={onSelect}
      type="button"
    >
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{group.name}</span>
          {group.systemRole === "full_access" ? (
            <span className="rounded-pill border border-trace-subtle bg-control-surface px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
              Built-in
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-xs text-ink-muted">
          {group.archivedAt ? `Archived ${formatDate(group.archivedAt)}` : "Active group"}
        </span>
      </span>
      <span className="font-mono text-xs text-ink-secondary">
        {group.userCount} member{group.userCount === 1 ? "" : "s"}
      </span>
      <span className="min-w-0 text-xs leading-5 text-ink-secondary">
        {groupAccessSummary(catalog, group)}
        {!group.archivedAt && counts.providers + counts.models + counts.search > 0 ? (
          <span className="mt-0.5 block font-mono text-xs text-ink-muted">
            {counts.providers} provider · {counts.models} model · {counts.search} search
          </span>
        ) : null}
      </span>
      <span className={`w-fit rounded-pill border px-2 py-0.5 text-xs capitalize ${accessState.className}`}>
        {accessState.label}
      </span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-muted transition-transform group-hover/access-row:translate-x-0.5 group-hover/access-row:text-ink-secondary" />
    </button>
  );
}

function CreateGroupTask({ actions, draft, status }: Readonly<{
  actions: AdminAccessGroupsSectionActions;
  draft: AdminAccessGroupsSectionDraft;
  status: AdminAccessGroupsSectionStatus;
}>) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-5 sm:px-6 lg:px-8 lg:py-7" data-testid="admin-access-group-create">
      <AdminTaskBackButton alwaysVisible label="Back to access groups" onClick={actions.onBackToList} />
      <div className="max-w-2xl border-b border-trace-subtle pb-5">
        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-muted">New access group</p>
        <h3 className="mt-2 text-xl font-semibold tracking-tight text-ink">Create an access group</h3>
        <p className="mt-2 text-sm leading-6 text-ink-secondary">
          Create the group first, then add members and choose its model, search, and tool access.
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
            <Plus aria-hidden="true" className="size-3.5" /> Create
          </button>
          <button className={quietButton} onClick={actions.onBackToList} type="button">Cancel</button>
        </div>
      </form>
    </div>
  );
}

function GroupOverview({ actions, data, draft, status }: Readonly<{
  actions: AdminAccessGroupsSectionActions;
  data: AdminAccessGroupsSectionData & { selectedGroup: AdminGroup };
  draft: AdminAccessGroupsSectionDraft;
  status: AdminAccessGroupsSectionStatus;
}>) {
  const group = data.selectedGroup;
  const archived = Boolean(group.archivedAt);
  const builtIn = group.systemRole === "full_access";
  const counts = grantCounts(group);
  const deletion = groupDeletionInfo(group);

  return (
    <div>
      <section className="border-b border-trace-subtle py-5">
        <h4 className="text-sm font-semibold text-ink">Access overview</h4>
        <p className="mt-1 text-xs leading-5 text-ink-muted">{groupAccessSummary(data.catalog, group)}</p>
        {builtIn ? (
          <div className="mt-4 max-w-2xl border-l-2 border-positive bg-positive/5 px-3 py-2 text-xs leading-5 text-ink-secondary">
            <p>Entitlement updates automatically when a provider, model, Search source, or MCP server is added.</p>
            <p className="mt-1">Provider credentials and personal MCP setup remain separate.</p>
          </div>
        ) : (
          <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
            {[
              ["Members", group.userCount],
              ["Provider-wide", counts.providers],
              ["Models", counts.models],
              ["Search", counts.search]
            ].map(([label, value]) => (
              <div className="min-w-0" key={String(label)}>
                <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-muted">{label}</dt>
                <dd className="mt-1 font-mono text-sm text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {!archived && !builtIn && draft.renamingGroupId === group.id ? (
        <form
          className="border-b border-trace-subtle py-5"
          onSubmit={(event) => {
            event.preventDefault();
            void actions.onRenameSubmit(group);
          }}
        >
          <label className="text-xs font-medium text-ink-secondary" htmlFor="rename-selected-group">Rename group</label>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <input
              aria-describedby={status.renameError ? "rename-selected-group-error" : undefined}
              aria-invalid={Boolean(status.renameError) || undefined}
              className={inputClass}
              id="rename-selected-group"
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
          {builtIn ? (
            <p className="border-l-2 border-positive bg-positive/5 px-3 py-2 text-xs leading-5 text-ink-secondary">
              Full access is built in and always active. It cannot be renamed, archived, or deleted.
            </p>
          ) : <DeletionHint info={deletion} />}
          {!builtIn && deletion.canDelete ? (
            <button className={dangerButton} disabled={status.actionsDisabled} onClick={() => actions.onRequestDelete(group)} type="button">
              <Trash2 aria-hidden="true" className="size-3.5" /> Delete group
            </button>
          ) : null}
          {builtIn ? null : archived ? (
            <p className="border-l-2 border-caution bg-caution/5 px-3 py-2 text-xs leading-5 text-caution">
              Archived groups remain visible for history. Their grants no longer apply, and grant editing is disabled.
            </p>
          ) : (
            <>
              <button className={quietButton} disabled={status.actionsDisabled} onClick={() => actions.onStartRenaming(group)} type="button">
                <Save aria-hidden="true" className="size-3.5" /> Rename group
              </button>
              <button className={dangerButton} disabled={status.actionsDisabled} onClick={() => actions.onRequestArchive(group)} type="button">
                <Archive aria-hidden="true" className="size-3.5" /> Archive group
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function GroupMembers({ actions, data, status }: Readonly<{
  actions: AdminAccessGroupsSectionActions;
  data: AdminAccessGroupsSectionData & { selectedGroup: AdminGroup };
  status: AdminAccessGroupsSectionStatus;
}>) {
  const [candidateId, setCandidateId] = useState("");
  const memberIds = new Set(data.selectedGroupMembers.map((user) => user.id));
  const candidates = data.allUsers.filter(
    (user) => user.status === "active" && !memberIds.has(user.id)
  );
  const selectedCandidate = candidates.find((user) => user.id === candidateId) ?? null;
  const archived = Boolean(data.selectedGroup.archivedAt);
  useAdminDraftProtection({
    dirty: Boolean(selectedCandidate),
    onDiscard: () => setCandidateId(""),
    owner: "access-group-member-form",
    pending: Boolean(selectedCandidate) && status.actionsDisabled
  });

  return (
    <div className="py-5">
      <div className="max-w-2xl">
        <h4 className="text-sm font-semibold text-ink">Members</h4>
        <p className="mt-1 text-xs leading-5 text-ink-muted">
          {data.selectedGroup.systemRole === "full_access"
            ? "Members receive automatic entitlement to every current and future provider, model, Search source, and MCP server. Provider credentials and personal MCP setup remain separate."
            : "Members inherit this group’s model, search, and tool access."}
        </p>
      </div>

      {!archived ? (
        <form
          className="mt-4 grid max-w-2xl gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selectedCandidate) return;
            const candidate = selectedCandidate;
            void Promise.resolve(actions.onAddMember(data.selectedGroup, candidate)).then((ok) => {
              if (ok !== false) setCandidateId("");
            });
          }}
        >
          <label className="sr-only" htmlFor={`add-group-member-${data.selectedGroup.id}`}>Add member</label>
          <select
            className={inputClass}
            disabled={status.actionsDisabled || !candidates.length}
            id={`add-group-member-${data.selectedGroup.id}`}
            onChange={(event) => setCandidateId(event.currentTarget.value)}
            value={selectedCandidate?.id ?? ""}
          >
            <option value="">{candidates.length ? "Choose an active user" : "All active users are members"}</option>
            {candidates.map((user) => (
              <option key={user.id} value={user.id}>
                {user.displayName}{user.email ? ` · ${user.email}` : ""}
              </option>
            ))}
          </select>
          <button className={primaryButton} disabled={status.actionsDisabled || !selectedCandidate} type="submit">
            <Plus aria-hidden="true" className="size-3.5" /> Add member
          </button>
        </form>
      ) : null}

      <div className="mt-5 overflow-hidden rounded-panel border border-trace-subtle">
        {data.selectedGroupMembers.length ? data.selectedGroupMembers.map((user) => (
          <div
            className={`flex min-w-0 flex-col gap-3 border-b border-trace-subtle px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between ${userStatusRowClass(user.status)}`}
            data-user-lifecycle-row={user.status}
            key={user.id}
          >
            <div className="min-w-0">
              <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{user.displayName}</p>
              <p className="mt-0.5 break-words text-xs text-ink-muted [overflow-wrap:anywhere]">
                {user.email ?? "No email"}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <AdminUserStatus status={user.status} />
              {!archived ? (
                <button
                  className={quietButton}
                  disabled={status.actionsDisabled}
                  onClick={() => void actions.onRemoveMember(data.selectedGroup, user)}
                  type="button"
                >
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        )) : (
          <p className="px-4 py-6 text-sm text-ink-muted">No members in this group.</p>
        )}
      </div>
    </div>
  );
}

function ModelsAndSearch({ actions, catalog, group, status }: Readonly<{
  actions: AdminAccessGroupsSectionActions;
  catalog: AdminCatalog;
  group: AdminGroup;
  status: AdminAccessGroupsSectionStatus;
}>) {
  const archived = Boolean(group.archivedAt);

  if (group.systemRole === "full_access") {
    return (
      <div className="py-5">
        <h4 className="text-sm font-semibold text-ink">Automatic full access</h4>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-secondary">
          Members automatically receive entitlement to every current and future provider, model, and Search source. A model is usable only when an independently selected provider credential and its current availability check are valid. There are no per-resource switches for this built-in group.
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="border-b border-trace-subtle py-4 text-xs leading-5 text-ink-secondary">
        These grants control entitlement. Provider key assignment chooses authentication policy and never grants model access.
      </p>
      <AccessSection title="Provider-wide access">
        <div className="divide-y divide-trace-subtle border-y border-trace-subtle">
          {catalog.providers.map((provider) => {
            const checked = grantEnabled(group, { provider: provider.id });
            return (
              <div className="flex min-w-0 flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between" key={`${group.id}:provider:${provider.id}`}>
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{provider.name}</p>
                  <p className="mt-1 text-xs text-ink-muted">All provider models ({providerModelCount(catalog, provider.id)})</p>
                </div>
                <GrantToggle
                  checked={checked}
                  disabled={archived || status.actionsDisabled}
                  label={`Grant provider ${provider.name}`}
                  onToggle={(enabled) => actions.onToggleGrant(group, { provider: provider.id }, enabled)}
                />
              </div>
            );
          })}
          {!catalog.providers.length ? <p className="py-5 text-sm text-ink-muted">No providers in the catalog</p> : null}
        </div>
      </AccessSection>

      <AccessSection title="Explicit model grants">
        <div className="grid gap-6">
          {catalog.providers.map((provider) => {
            const models = catalog.models.filter((model) => model.provider === provider.id);
            return (
              <section className="min-w-0" key={`${group.id}:models:${provider.id}`}>
                <div className="flex min-w-0 flex-col gap-3 border-b border-trace-subtle pb-3 sm:flex-row sm:items-end sm:justify-between">
                  <div className="min-w-0">
                    <h5 className="break-words text-sm font-semibold text-ink [overflow-wrap:anywhere]">{provider.name}</h5>
                    <p className="mt-1 text-xs text-ink-muted">{models.length} model{models.length === 1 ? "" : "s"}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      aria-label={`Grant all ${provider.name} models to ${group.name}`}
                      className={quietButton}
                      disabled={archived || status.actionsDisabled || !models.length}
                      onClick={() => actions.onToggleProviderModels(group, provider.id, true)}
                      type="button"
                    >
                      <Check aria-hidden="true" className="size-3.5" /> Grant all models
                    </button>
                    <button
                      aria-label={`Clear ${provider.name} models from ${group.name}`}
                      className={quietButton}
                      disabled={archived || status.actionsDisabled || !models.length}
                      onClick={() => actions.onToggleProviderModels(group, provider.id, false)}
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" className="size-3.5" /> Clear models
                    </button>
                  </div>
                </div>
                <div className="divide-y divide-trace-subtle">
                  {models.length ? models.map((model) => {
                    const checked = grantEnabled(group, { modelId: model.modelId, provider: model.provider });
                    return (
                      <div className="flex min-w-0 flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between" key={`${group.id}:model:${model.provider}:${model.modelId}`}>
                        <p className="break-words text-sm text-ink-secondary [overflow-wrap:anywhere]">{model.displayName}</p>
                        <GrantToggle
                          checked={checked}
                          disabled={archived || status.actionsDisabled}
                          label={`Grant model ${provider.name} / ${model.displayName}`}
                          onToggle={(enabled) => actions.onToggleGrant(group, { modelId: model.modelId, provider: model.provider }, enabled)}
                        />
                      </div>
                    );
                  }) : <p className="py-4 text-sm text-ink-muted">No models for this provider</p>}
                </div>
              </section>
            );
          })}
        </div>
      </AccessSection>

      <AccessSection title="Search access">
        <div className="divide-y divide-trace-subtle border-y border-trace-subtle">
          {catalog.searchStrategies.map((strategy) => {
            const checked = grantEnabled(group, { searchStrategy: strategy.strategyId });
            return (
              <div className="flex min-w-0 flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between" key={`${group.id}:search:${strategy.strategyId}`}>
                <p className="min-w-0 break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{strategy.displayName}</p>
                <GrantToggle
                  checked={checked}
                  disabled={archived || status.actionsDisabled}
                  label={`Grant search ${strategy.displayName}`}
                  onToggle={(enabled) => actions.onToggleGrant(group, { searchStrategy: strategy.strategyId }, enabled)}
                />
              </div>
            );
          })}
          {!catalog.searchStrategies.length ? <p className="py-5 text-sm text-ink-muted">No Search sources in the catalog</p> : null}
        </div>
      </AccessSection>
    </div>
  );
}

function GroupDetail({
  actions,
  data,
  draft,
  mcpAccess,
  refs: { detail: detailRef },
  status
}: AdminAccessGroupsSectionProps) {
  const group = data.selectedGroup;
  if (!group) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <AdminTaskBackButton alwaysVisible label="Back to access groups" onClick={actions.onBackToList} />
        <EmptyState detail="Choose a group from the directory." title="Group unavailable" />
      </div>
    );
  }

  const accessState = groupAccessState(group);
  const selectedData = { ...data, selectedGroup: group };

  return (
    <article
      aria-label={`Access group ${group.name}`}
      className="mx-auto min-w-0 max-w-5xl px-4 py-5 outline-none sm:px-6 lg:px-8 lg:py-7"
      data-testid="admin-access-group-detail"
      ref={detailRef}
      tabIndex={-1}
    >
      <AdminTaskBackButton alwaysVisible label="Back to access groups" onClick={actions.onBackToList} />
      <div className="flex min-w-0 items-start justify-between gap-4 border-b border-trace-subtle pb-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-muted">Access group</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h3 className="break-words text-xl font-semibold tracking-tight text-ink [overflow-wrap:anywhere]">{group.name}</h3>
            {group.systemRole === "full_access" ? (
              <span className="rounded-pill border border-trace-subtle bg-control-surface px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
                Built-in
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-ink-muted">{group.userCount} member{group.userCount === 1 ? "" : "s"}</p>
        </div>
        <span className={`shrink-0 rounded-pill border px-2 py-1 text-xs capitalize ${accessState.className}`}>{accessState.label}</span>
      </div>

      <div className="grid grid-cols-2 border-b border-trace-subtle sm:flex" role="group" aria-label="Access group views">
        {([
          ["overview", "Overview"],
          ["members", "Members"],
          ["models", "Models & search"],
          ["tools", "Tools"]
        ] as const).map(([view, label]) => (
          <button
            aria-pressed={draft.activeView === view}
            className={`min-h-touch border-b-2 px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus sm:min-h-control ${
              draft.activeView === view
                ? "border-proof bg-control-selected text-ink"
                : "border-transparent text-ink-muted hover:border-trace-strong hover:bg-control-hover hover:text-ink-secondary"
            }`}
            key={view}
            onClick={() => actions.onSelectView(view)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      {group.archivedAt ? (
        <p className="border-b border-trace-subtle bg-caution/5 py-3 text-xs leading-5 text-caution">
          Archived groups do not apply grants. Access editing is disabled for this group.
        </p>
      ) : null}

      {draft.activeView === "overview" ? (
        <GroupOverview actions={actions} data={selectedData} draft={draft} status={status} />
      ) : draft.activeView === "members" ? (
        <GroupMembers
          actions={actions}
          data={selectedData}
          key={group.id}
          status={status}
        />
      ) : draft.activeView === "models" ? (
        <ModelsAndSearch actions={actions} catalog={data.catalog} group={group} status={status} />
      ) : (
        mcpAccess ?? <EmptyState detail="MCP server grants are unavailable right now." title="Tools unavailable" />
      )}
    </article>
  );
}

export function AdminAccessGroupsSection(props: AdminAccessGroupsSectionProps) {
  const { actions, data, draft } = props;
  const requestDiscardAction = useAdminDiscardAction();
  const protectedActions = {
    ...actions,
    onBackToList: () => requestDiscardAction(
      actions.onBackToList,
      ["access-groups-form", "access-group-member-form"]
    ),
    onSelectView: (view: AdminAccessGroupView) => requestDiscardAction(
      () => actions.onSelectView(view),
      ["access-group-member-form"]
    )
  };

  if (draft.createFormOpen) {
    return <CreateGroupTask actions={protectedActions} draft={draft} status={props.status} />;
  }

  if (draft.detailOpen) {
    return <GroupDetail {...props} actions={protectedActions} />;
  }

  return (
    <div className="min-w-0 px-4 pb-8 sm:px-6 lg:px-8" data-testid="admin-access-groups-index">
      <div className="mx-auto max-w-7xl">
        <div className="grid gap-3 border-b border-trace-subtle py-4 lg:grid-cols-[minmax(18rem,1fr)_auto] lg:items-end">
          <div>
            <label className="block text-xs font-medium text-ink-secondary" htmlFor="admin-access-groups-search">Search access groups</label>
            <div className="relative mt-1.5">
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
              <input
                className={`${inputClass} pl-9`}
                id="admin-access-groups-search"
                onChange={(event) => actions.onQueryChange(event.currentTarget.value)}
                placeholder="Name or access state"
                value={draft.query}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Group status filters">
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

        <div className="py-3 text-xs text-ink-muted">
          <span className="font-mono text-ink-secondary">{data.visibleGroups.length}</span> of{" "}
          <span className="font-mono text-ink-secondary">{data.allGroups.length}</span> access groups
        </div>

        <div className="min-w-0 overflow-hidden rounded-panel border border-trace-subtle" data-testid="admin-access-groups-list">
          {data.visibleGroups.length ? (
            <div className="hidden grid-cols-[minmax(12rem,1.4fr)_minmax(7rem,0.55fr)_minmax(14rem,1fr)_minmax(8rem,0.6fr)_auto] gap-4 border-b border-trace-subtle bg-control-surface px-5 py-2 text-xs font-medium uppercase tracking-[0.08em] text-ink-muted md:grid">
              <span>Group</span><span>Members</span><span>Models & search</span><span>Status</span><span aria-hidden="true" />
            </div>
          ) : null}
          {data.visibleGroups.length ? data.visibleGroups.map((group) => (
            <AccessGroupRow
              catalog={data.catalog}
              group={group}
              key={group.id}
              onSelect={() => actions.onSelectGroup(group.id)}
            />
          )) : (
            <EmptyState
              detail={data.allGroups.length ? "Change the search or status filter to see other groups." : "Create a group when multiple people need shared access."}
              title={data.allGroups.length ? "No groups match this view" : "No access groups"}
            />
          )}
        </div>
      </div>
    </div>
  );
}

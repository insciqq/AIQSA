import {
  grantCounts,
  grantEnabled,
  groupAccessState,
  groupAccessSummary,
  providerModelCount,
  type AdminGrantTarget
} from "@/components/admin/adminGroupView";
import {
  AdminTaskBackButton,
  AdminTaskDetailPane,
  AdminTaskIndexPane,
  AdminTaskWorkspace,
  EmptyState,
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import type { AdminCatalog, AdminGroup } from "@/lib/contracts/admin";
import { Check, RotateCcw, Search } from "lucide-react";
import type { ReactNode, Ref } from "react";

export type AdminModelAccessSectionData = Readonly<{
  catalog: AdminCatalog;
  selectedGroup: AdminGroup | null;
  totalGroupCount: number;
  visibleGroups: readonly AdminGroup[];
}>;

export type AdminModelAccessSectionDraft = Readonly<{
  compactDetailOpen: boolean;
  query: string;
}>;

export type AdminModelAccessSectionStatus = Readonly<{
  actionsDisabled: boolean;
}>;

export type AdminModelAccessSectionRefs = Readonly<{
  detail: Ref<HTMLDivElement>;
}>;

export type AdminModelAccessSectionActions = Readonly<{
  onBackToList(): void;
  onQueryChange(value: string): void;
  onSelectGroup(groupId: string): void;
  onToggleGrant(group: AdminGroup, target: AdminGrantTarget, enabled: boolean): void;
  onToggleProviderModels(group: AdminGroup, providerId: string, enabled: boolean): void;
}>;

export type AdminModelAccessSectionProps = Readonly<{
  actions: AdminModelAccessSectionActions;
  data: AdminModelAccessSectionData;
  draft: AdminModelAccessSectionDraft;
  mcpAccess?: ReactNode;
  refs: AdminModelAccessSectionRefs;
  status: AdminModelAccessSectionStatus;
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
      className={checked ? primaryButton : quietButton}
      disabled={disabled}
      onClick={() => onToggle(!checked)}
      type="button"
    >
      {checked ? <Check aria-hidden="true" className="size-3.5" /> : null}
      {checked ? "Enabled" : "Off"}
    </button>
  );
}

function AccessSection({ children, title }: Readonly<{
  children: ReactNode;
  title: string;
}>) {
  return (
    <section className="border-b border-trace-subtle py-5 last:border-b-0">
      <h4 className="text-sm font-semibold text-ink">{title}</h4>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function AdminModelAccessSection({ actions, data, draft, mcpAccess, refs: { detail: detailRef }, status }: AdminModelAccessSectionProps) {
  if (!data.totalGroupCount) {
    return <EmptyState detail="Create a group before assigning provider, model, search, or MCP access." title="No groups" />;
  }

  const group = data.selectedGroup;
  const archived = Boolean(group?.archivedAt);
  const counts = group ? grantCounts(group) : null;

  return (
    <AdminTaskWorkspace indexWidth="20rem">
      <AdminTaskIndexPane compactDetailOpen={draft.compactDetailOpen} testId="admin-model-access-group-list">
        <div className="border-b border-trace-subtle p-3">
          <label className="block text-xs font-medium text-ink-secondary" htmlFor="admin-model-access-search">Groups</label>
          <div className="relative mt-1.5">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
            <input
              aria-label="Search model access groups"
              className={`${inputClass} pl-9`}
              id="admin-model-access-search"
              onChange={(event) => actions.onQueryChange(event.currentTarget.value)}
              placeholder="Search groups"
              value={draft.query}
            />
          </div>
        </div>
        <div className="min-w-0 divide-y divide-trace-subtle">
          {data.visibleGroups.length ? data.visibleGroups.map((candidate) => {
            const accessState = groupAccessState(candidate);
            const active = group?.id === candidate.id;

            return (
              <button
                aria-controls="admin-model-access-selected-group"
                aria-label={`Select ${candidate.name}`}
                aria-pressed={active}
                className={`block w-full min-w-0 px-4 py-3 text-left ${active ? "bg-control-selected" : "bg-transparent hover:bg-control-hover"}`}
                key={candidate.id}
                onClick={() => actions.onSelectGroup(candidate.id)}
                type="button"
              >
                <span className="flex min-w-0 items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{candidate.name}</span>
                    <span className="mt-1 block font-mono text-[11px] text-ink-muted">{candidate.userCount} users</span>
                  </span>
                  <span className={`shrink-0 rounded-pill border px-2 py-0.5 text-[11px] capitalize ${accessState.className}`}>
                    {accessState.label}
                  </span>
                </span>
              </button>
            );
          }) : (
            <EmptyState detail="Change the search to see other groups." title="No groups match this view" />
          )}
        </div>
      </AdminTaskIndexPane>

      <AdminTaskDetailPane compactDetailOpen={draft.compactDetailOpen} testId="admin-model-access-detail-pane">
        {group ? (
          <div
            aria-label={`Model access for ${group.name}`}
            className="min-w-0 px-4 py-5 outline-none sm:px-6 lg:px-8 lg:py-7"
            data-testid="admin-model-access-group"
            id="admin-model-access-selected-group"
            ref={detailRef}
            role="region"
            tabIndex={-1}
          >
            <AdminTaskBackButton label="Back to groups" onClick={actions.onBackToList} />
            <div className="border-b border-trace-subtle pb-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">Model access</p>
              <h3 className="mt-2 break-words text-xl font-semibold tracking-tight text-ink [overflow-wrap:anywhere]">{group.name}</h3>
              <p className="mt-1 text-sm text-ink-muted">{group.userCount} users · {groupAccessSummary(data.catalog, group)}</p>
              <p className="mt-3 max-w-3xl border-l border-trace-strong pl-3 text-xs leading-5 text-ink-secondary">
                These grants control entitlement. Provider key assignment under Providers → Advanced chooses authentication policy and never grants model access.
              </p>
              <dl className="mt-4 grid grid-cols-3 gap-4">
                {[
                  ["Provider-wide", counts?.providers ?? 0],
                  ["Models", counts?.models ?? 0],
                  ["Search", counts?.search ?? 0]
                ].map(([label, value]) => (
                  <div className="min-w-0" key={String(label)}>
                    <dt className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">{label}</dt>
                    <dd className="mt-1 font-mono text-sm text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            {archived ? (
              <p className="border-b border-trace-subtle bg-caution/5 py-3 text-xs leading-5 text-caution">
                Archived groups do not apply grants. Grant editing is disabled for this group.
              </p>
            ) : null}

            <AccessSection title="Provider-wide access">
              <div className="divide-y divide-trace-subtle border-y border-trace-subtle">
                {data.catalog.providers.map((provider) => {
                  const checked = grantEnabled(group, { provider: provider.id });
                  return (
                    <div className="flex min-w-0 flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between" key={`${group.id}:provider:${provider.id}`}>
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{provider.name}</p>
                        <p className="mt-1 text-xs text-ink-muted">All provider models ({providerModelCount(data.catalog, provider.id)})</p>
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
                {!data.catalog.providers.length ? <p className="py-5 text-sm text-ink-muted">No providers in the catalog</p> : null}
              </div>
            </AccessSection>

            <AccessSection title="Explicit model grants">
              <div className="grid gap-6">
                {data.catalog.providers.map((provider) => {
                  const models = data.catalog.models.filter((model) => model.provider === provider.id);
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

            <AccessSection title="Search strategy grants">
              <div className="divide-y divide-trace-subtle border-y border-trace-subtle">
                {data.catalog.searchStrategies.map((strategy) => {
                  const checked = grantEnabled(group, { searchStrategy: strategy.strategyId });
                  return (
                    <div className="flex min-w-0 flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between" key={`${group.id}:search:${strategy.strategyId}`}>
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{strategy.displayName}</p>
                        <p className="mt-1 break-all font-mono text-[11px] text-ink-muted">{strategy.strategyId}</p>
                      </div>
                      <GrantToggle
                        checked={checked}
                        disabled={archived || status.actionsDisabled}
                        label={`Grant search ${strategy.displayName}`}
                        onToggle={(enabled) => actions.onToggleGrant(group, { searchStrategy: strategy.strategyId }, enabled)}
                      />
                    </div>
                  );
                })}
                {!data.catalog.searchStrategies.length ? <p className="py-5 text-sm text-ink-muted">No search strategies in the catalog</p> : null}
              </div>
            </AccessSection>

            {mcpAccess}
          </div>
        ) : (
          <div className="p-4 sm:p-6 lg:p-8">
            <AdminTaskBackButton label="Back to groups" onClick={actions.onBackToList} />
            <EmptyState detail="Select a group before editing provider, model, search, or MCP grants." title="No group selected" />
          </div>
        )}
      </AdminTaskDetailPane>
    </AdminTaskWorkspace>
  );
}

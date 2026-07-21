import {
  grantCounts,
  grantEnabled,
  groupAccessState,
  groupAccessSummary,
  providerModelCount,
  type AdminGrantTarget
} from "@/components/admin/adminGroupView";
import {
  AdminTableRegion,
  EmptyState,
  focusRing,
  quietButton,
  touchTarget
} from "@/components/admin/adminPrimitives";
import type { AdminCatalog, AdminGroup } from "@/lib/contracts/admin";
import { Check, RotateCcw, Search } from "lucide-react";
import type { Ref } from "react";

export type AdminModelAccessSectionData = Readonly<{
  catalog: AdminCatalog;
  selectedGroup: AdminGroup | null;
  totalGroupCount: number;
  visibleGroups: readonly AdminGroup[];
}>;

export type AdminModelAccessSectionDraft = Readonly<{
  query: string;
}>;

export type AdminModelAccessSectionStatus = Readonly<{
  actionsDisabled: boolean;
}>;

export type AdminModelAccessSectionRefs = Readonly<{
  detail: Ref<HTMLDivElement>;
}>;

export type AdminModelAccessSectionActions = Readonly<{
  onQueryChange(value: string): void;
  onSelectGroup(groupId: string): void;
  onToggleGrant(group: AdminGroup, target: AdminGrantTarget, enabled: boolean): void;
  onToggleProviderModels(group: AdminGroup, providerId: string, enabled: boolean): void;
}>;

export type AdminModelAccessSectionProps = Readonly<{
  actions: AdminModelAccessSectionActions;
  data: AdminModelAccessSectionData;
  draft: AdminModelAccessSectionDraft;
  refs: AdminModelAccessSectionRefs;
  status: AdminModelAccessSectionStatus;
}>;

function GrantToggle({
  checked,
  disabled,
  label,
  onToggle
}: Readonly<{
  checked: boolean;
  disabled?: boolean;
  label: string;
  onToggle(enabled: boolean): void;
}>) {
  return (
    <button
      aria-label={label}
      aria-pressed={checked}
      className={[
        `inline-flex min-h-control-sm min-w-20 items-center justify-center gap-1.5 rounded-control px-3 text-xs font-medium ${focusRing} ${touchTarget} disabled:cursor-not-allowed disabled:opacity-50`,
        checked
          ? "bg-surface-selected text-accent-cyan"
          : "bg-surface-raised text-content-secondary hover:bg-surface-hover hover:text-content-primary"
      ].join(" ")}
      disabled={disabled}
      onClick={() => onToggle(!checked)}
      type="button"
    >
      {checked ? <Check className="size-3.5" aria-hidden="true" /> : null}
      {checked ? "Enabled" : "Off"}
    </button>
  );
}

export function AdminModelAccessSection({
  actions,
  data,
  draft,
  refs: { detail: detailRef },
  status
}: AdminModelAccessSectionProps) {
  if (!data.totalGroupCount) {
    return <EmptyState title="No groups" detail="Create a group before assigning provider, model, or search access." />;
  }

  const group = data.selectedGroup;
  const archived = Boolean(group?.archivedAt);
  const selectedCounts = group ? grantCounts(group) : null;

  return (
    <div className="grid min-h-[460px] lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside
        className="border-b border-separator-subtle bg-surface-raised/40 p-3 lg:border-b-0 lg:border-r"
        data-testid="admin-model-access-group-list"
      >
        <div className="text-xs font-medium text-content-secondary mb-2">Groups</div>
        <div className="mb-2 flex items-center gap-2 rounded-control border border-separator-subtle bg-surface-thread px-2 focus-within:border-accent-cyan/60 focus-within:ring-2 focus-within:ring-accent-cyan/20">
          <Search className="size-3.5 shrink-0 text-content-muted" aria-hidden="true" />
          <input
            aria-label="Search model access groups"
            className="min-h-control-sm min-w-0 flex-1 bg-transparent text-xs [@media(hover:none)]:!min-h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!min-h-touch [@media(pointer:coarse)]:!min-w-touch text-content-primary outline-none placeholder:text-content-disabled"
            onChange={(event) => actions.onQueryChange(event.currentTarget.value)}
            placeholder="Search groups"
            value={draft.query}
          />
        </div>
        <div className="grid max-h-[560px] gap-1.5 overflow-y-auto pr-1">
          {data.visibleGroups.length ? (
            data.visibleGroups.map((candidate) => {
              const accessState = groupAccessState(candidate);
              const active = group?.id === candidate.id;

              return (
                <button
                  aria-label={`Select ${candidate.name}`}
                  aria-pressed={active}
                  className={[
                    "rounded-control border px-2 py-2 text-left text-xs outline-none focus-visible:border-accent-cyan focus-visible:ring-2 focus-visible:ring-accent-cyan/30",
                    active
                      ? "border-accent-cyan/40 bg-accent-cyan/[0.07]"
                      : "border-separator-subtle bg-surface-thread hover:border-accent-cyan/35"
                  ].join(" ")}
                  key={candidate.id}
                  onClick={() => actions.onSelectGroup(candidate.id)}
                  type="button"
                >
                  <span className="block break-words font-medium text-content-primary [overflow-wrap:anywhere]">
                    {candidate.name}
                  </span>
                  <span className="mt-1 flex items-center justify-between gap-2">
                    <span className="font-mono text-content-muted">{candidate.userCount} users</span>
                    <span
                      className={`shrink-0 rounded-pill border px-2 py-0.5 text-[11px] capitalize ${accessState.className}`}
                    >
                      {accessState.label}
                    </span>
                  </span>
                </button>
              );
            })
          ) : (
            <div className="rounded-control border border-separator-subtle bg-surface-thread px-2 py-6 text-center text-xs text-content-muted">
              No groups match this view
            </div>
          )}
        </div>
      </aside>

      {group ? (
        <div
          aria-label={`Model access for ${group.name}`}
          className={`min-w-0 ${focusRing}`}
          data-testid="admin-model-access-group"
          ref={detailRef}
          tabIndex={-1}
        >
          <div className="flex flex-col gap-3 border-b border-separator-subtle px-3 py-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <div className="text-xs font-medium text-content-secondary">Selected group</div>
              <h3 className="mt-1 break-words text-sm font-semibold text-content-primary [overflow-wrap:anywhere]">
                {group.name}
              </h3>
              <p className="mt-1 text-xs text-content-muted">
                {group.userCount} users / {groupAccessSummary(data.catalog, group)}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs sm:min-w-[360px]">
              <div className="rounded-control bg-surface-raised px-3 py-2">
                <div className="text-xs font-medium text-content-secondary mb-1">Provider-wide</div>
                <div className="font-mono text-content-primary">{selectedCounts?.providers ?? 0}</div>
              </div>
              <div className="rounded-control bg-surface-raised px-3 py-2">
                <div className="text-xs font-medium text-content-secondary mb-1">Models</div>
                <div className="font-mono text-content-primary">{selectedCounts?.models ?? 0}</div>
              </div>
              <div className="rounded-control bg-surface-raised px-3 py-2">
                <div className="text-xs font-medium text-content-secondary mb-1">Search</div>
                <div className="font-mono text-content-primary">{selectedCounts?.search ?? 0}</div>
              </div>
            </div>
          </div>

          {archived ? (
            <div className="border-b border-accent-amber/25 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber">
              Archived groups do not apply grants. Grant editing is disabled for this group.
            </div>
          ) : null}

          <div className="grid gap-3 p-3">
            <section className="rounded-panel bg-surface-raised/50">
              <div className="border-b border-separator-subtle px-3 py-2">
                <div className="text-xs font-medium text-content-secondary">Provider-wide access</div>
                <p className="mt-1 text-xs text-content-muted">
                  Provider-wide grants unlock every current and future model for that provider.
                </p>
              </div>
              <AdminTableRegion label="Provider-wide access grants">
                <table className="w-full min-w-[620px] border-collapse text-left text-xs">
                  <thead className="bg-surface-thread text-content-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">Provider</th>
                      <th className="px-3 py-2 font-medium">Scope</th>
                      <th className="px-3 py-2 font-medium">Grant</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.catalog.providers.map((provider) => {
                      const checked = grantEnabled(group, { provider: provider.id });

                      return (
                        <tr
                          className="border-b border-separator-subtle last:border-b-0"
                          key={`${group.id}:provider:${provider.id}`}
                        >
                          <td className="px-3 py-3 text-content-primary">{provider.name}</td>
                          <td className="px-3 py-3 text-content-secondary">
                            All provider models ({providerModelCount(data.catalog, provider.id)})
                          </td>
                          <td className="px-3 py-3">
                            <GrantToggle
                              checked={checked}
                              disabled={archived || status.actionsDisabled}
                              label={`Grant provider ${provider.name}`}
                              onToggle={(enabled) =>
                                actions.onToggleGrant(
                                  group,
                                  {
                                    provider: provider.id
                                  },
                                  enabled
                                )
                              }
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </AdminTableRegion>
            </section>

            <section className="rounded-panel bg-surface-raised/50">
              <div className="border-b border-separator-subtle px-3 py-2">
                <div className="text-xs font-medium text-content-secondary">Explicit model grants</div>
                <p className="mt-1 text-xs text-content-muted">
                  Individual model grants stay distinct from provider-wide access.
                </p>
              </div>
              <div className="grid gap-3 p-3">
                {data.catalog.providers.map((provider) => {
                  const models = data.catalog.models.filter((model) => model.provider === provider.id);

                  return (
                    <section
                      className="rounded-control border border-separator-subtle bg-surface-thread"
                      key={`${group.id}:models:${provider.id}`}
                    >
                      <div className="flex flex-col gap-2 border-b border-separator-subtle px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <h4 className="text-xs font-semibold text-content-primary">{provider.name}</h4>
                          <p className="mt-1 text-[11px] text-content-muted">
                            {models.length} model{models.length === 1 ? "" : "s"}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            className={quietButton}
                            aria-label={`Grant all ${provider.name} models to ${group.name}`}
                            disabled={archived || status.actionsDisabled || !models.length}
                            onClick={() => actions.onToggleProviderModels(group, provider.id, true)}
                            type="button"
                          >
                            <Check className="size-3.5" aria-hidden="true" />
                            Grant all models
                          </button>
                          <button
                            className={quietButton}
                            aria-label={`Clear ${provider.name} models from ${group.name}`}
                            disabled={archived || status.actionsDisabled || !models.length}
                            onClick={() => actions.onToggleProviderModels(group, provider.id, false)}
                            type="button"
                          >
                            <RotateCcw className="size-3.5" aria-hidden="true" />
                            Clear models
                          </button>
                        </div>
                      </div>
                      <AdminTableRegion label={`${provider.name} model grants`}>
                        <table className="w-full min-w-[680px] border-collapse text-left text-xs">
                          <thead className="bg-surface-raised/40 text-content-muted">
                            <tr>
                              <th className="px-3 py-2 font-medium">Model</th>
                              <th className="px-3 py-2 font-medium">API id</th>
                              <th className="px-3 py-2 font-medium">Grant</th>
                            </tr>
                          </thead>
                          <tbody>
                            {models.length ? (
                              models.map((model) => {
                                const checked = grantEnabled(group, {
                                  modelId: model.modelId,
                                  provider: model.provider
                                });

                                return (
                                  <tr
                                    className="border-b border-separator-subtle last:border-b-0"
                                    key={`${group.id}:model:${model.provider}:${model.modelId}`}
                                  >
                                    <td className="px-3 py-3 text-content-primary">{model.displayName}</td>
                                    <td className="break-words px-3 py-3 font-mono text-[11px] text-content-muted [overflow-wrap:anywhere]">
                                      {model.provider}:{model.modelId}
                                    </td>
                                    <td className="px-3 py-3">
                                      <GrantToggle
                                        checked={checked}
                                        disabled={archived || status.actionsDisabled}
                                        label={`Grant model ${model.provider} / ${model.displayName}`}
                                        onToggle={(enabled) =>
                                          actions.onToggleGrant(
                                            group,
                                            {
                                              modelId: model.modelId,
                                              provider: model.provider
                                            },
                                            enabled
                                          )
                                        }
                                      />
                                    </td>
                                  </tr>
                                );
                              })
                            ) : (
                              <tr>
                                <td className="px-3 py-6 text-center text-content-muted" colSpan={3}>
                                  No models for this provider
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </AdminTableRegion>
                    </section>
                  );
                })}
              </div>
            </section>

            <section className="rounded-panel bg-surface-raised/50">
              <div className="border-b border-separator-subtle px-3 py-2">
                <div className="text-xs font-medium text-content-secondary">Search strategy grants</div>
                <p className="mt-1 text-xs text-content-muted">
                  Search access is managed separately from model and provider grants.
                </p>
              </div>
              <AdminTableRegion label="Search strategy grants">
                <table className="w-full min-w-[620px] border-collapse text-left text-xs">
                  <thead className="bg-surface-thread text-content-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">Strategy</th>
                      <th className="px-3 py-2 font-medium">API id</th>
                      <th className="px-3 py-2 font-medium">Grant</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.catalog.searchStrategies.map((strategy) => {
                      const checked = grantEnabled(group, {
                        searchStrategy: strategy.strategyId
                      });

                      return (
                        <tr
                          className="border-b border-separator-subtle last:border-b-0"
                          key={`${group.id}:search:${strategy.strategyId}`}
                        >
                          <td className="px-3 py-3 text-content-primary">{strategy.displayName}</td>
                          <td className="break-words px-3 py-3 font-mono text-[11px] text-content-muted [overflow-wrap:anywhere]">
                            {strategy.strategyId}
                          </td>
                          <td className="px-3 py-3">
                            <GrantToggle
                              checked={checked}
                              disabled={archived || status.actionsDisabled}
                              label={`Grant search ${strategy.displayName}`}
                              onToggle={(enabled) =>
                                actions.onToggleGrant(
                                  group,
                                  {
                                    searchStrategy: strategy.strategyId
                                  },
                                  enabled
                                )
                              }
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </AdminTableRegion>
            </section>
          </div>
        </div>
      ) : (
        <EmptyState title="No group selected" detail="Select a group before editing provider, model, or search grants." />
      )}
    </div>
  );
}

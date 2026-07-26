import { AdminTableRegion } from "@/components/admin/adminPrimitives";
import {
  formatDate,
  formatNumber,
  providerModelDisplayName
} from "@/components/admin/adminViewUtils";
import type {
  AdminCatalog,
  AdminUsageDashboard,
  AdminUsageProviderModelRecord
} from "@/lib/contracts/admin";

type AdminUsageCatalog = Pick<AdminCatalog, "models" | "providers">;

export type AdminUsageSectionProps = Readonly<{
  catalog: AdminUsageCatalog;
  usage: AdminUsageDashboard;
}>;

function usageProviderModelLabel(catalog: AdminUsageCatalog, usage: AdminUsageProviderModelRecord): string {
  return providerModelDisplayName(catalog, usage);
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}

function UsageFact({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="min-w-0 bg-answer-paper px-3 py-3 sm:px-4">
      <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">{label}</dt>
      <dd className="mt-1 break-words font-mono text-sm font-medium tabular-nums text-ink [overflow-wrap:anywhere]">
        {value}
      </dd>
    </div>
  );
}

function MobileUsageFacts({
  facts
}: Readonly<{ facts: readonly Readonly<{ label: string; value: string }>[] }>) {
  return (
    <dl className="mt-3 grid min-w-0 grid-cols-2 gap-x-4 gap-y-3">
      {facts.map((fact) => (
        <div className="min-w-0" key={fact.label}>
          <dt className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">{fact.label}</dt>
          <dd className="mt-1 break-words font-mono text-xs tabular-nums text-ink-secondary [overflow-wrap:anywhere]">
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function AdminUsageSection({ catalog, usage }: AdminUsageSectionProps) {
  const usersWithUsage = usage.byUser.filter((user) => user.runCount > 0);
  const groupsWithUsage = usage.byGroup.filter((group) => group.runCount > 0);

  return (
    <div className="min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <section
        aria-label="Usage summary"
        className="min-w-0 border-y border-trace-subtle"
      >
        <div className="grid min-w-0 lg:grid-cols-[minmax(15rem,0.78fr)_minmax(0,2.22fr)]">
          <div className="min-w-0 border-b border-trace-subtle py-5 lg:border-b-0 lg:border-r lg:px-1 lg:pr-8">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
              Provider-reported
            </p>
            <p
              className="mt-2 break-words font-mono text-3xl font-semibold tracking-[-0.035em] tabular-nums text-ink [overflow-wrap:anywhere]"
              data-testid="usage-total-tokens"
            >
              {formatNumber(usage.totals.totalTokens)}
            </p>
            <p className="mt-1 text-sm text-ink-secondary">Total tokens</p>
            <p className="mt-4 max-w-sm text-xs leading-5 text-ink-muted">
              {countLabel(usage.totals.runCount, "retained run")} with reported usage across{" "}
              {countLabel(usersWithUsage.length, "user")} and {countLabel(groupsWithUsage.length, "group")}.
            </p>
          </div>

          <dl className="grid min-w-0 grid-cols-2 gap-px bg-trace-subtle sm:grid-cols-3">
            <UsageFact label="Input tokens" value={formatNumber(usage.totals.inputTokens)} />
            <UsageFact label="Cached input" value={formatNumber(usage.totals.cachedInputTokens)} />
            <UsageFact label="Cache write" value={formatNumber(usage.totals.cacheWriteInputTokens)} />
            <UsageFact label="Output tokens" value={formatNumber(usage.totals.outputTokens)} />
            <UsageFact label="Reasoning tokens" value={formatNumber(usage.totals.reasoningTokens)} />
            <UsageFact
              label="Last usage"
              value={usage.totals.lastUsedAt ? formatDate(usage.totals.lastUsedAt) : "Never"}
            />
          </dl>
        </div>
      </section>

      <div className="mt-4 max-w-5xl border-l border-trace-strong pl-3 text-xs leading-5 text-ink-muted">
        <p className="font-medium text-ink-secondary">How to read these numbers</p>
        <p className="mt-1">
          This view uses provider-reported usage rows. Failed or cancelled runs appear only when the provider reported
          usage before termination. Run counts cover retained run records; token totals can also include older detached
          usage. Group totals follow current membership: a user in multiple groups is counted once in each group, so
          this is attribution, not billing reconciliation.
        </p>
      </div>

      <div className="mt-8 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-9">
        <section className="min-w-0" data-testid="admin-usage-groups">
          <div className="flex min-w-0 flex-col gap-1 border-b border-trace-subtle pb-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-ink">Group attribution</h3>
              <p className="mt-1 text-xs leading-5 text-ink-muted">
                Current memberships with provider-reported token totals.
              </p>
            </div>
            <p className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
              {countLabel(usage.byGroup.length, "group")}
            </p>
          </div>
          <div className="divide-y divide-trace-subtle lg:hidden" data-testid="admin-usage-groups-mobile">
            {usage.byGroup.length ? (
              usage.byGroup.map((group) => (
                <article className="min-w-0 py-4" key={group.groupId}>
                  <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{group.name}</p>
                  <p className="mt-1 text-xs text-ink-muted">{group.archivedAt ? "Archived group" : "Active group"}</p>
                  <MobileUsageFacts
                    facts={[
                      {
                        label: "Users",
                        value: `${formatNumber(group.contributingUsers)} active / ${formatNumber(group.userCount)} total`
                      },
                      { label: "Runs", value: formatNumber(group.runCount) },
                      { label: "Tokens", value: formatNumber(group.totalTokens) },
                      { label: "Last usage", value: formatDate(group.lastUsedAt) }
                    ]}
                  />
                </article>
              ))
            ) : (
              <p className="py-7 text-sm text-ink-muted">No groups in this installation</p>
            )}
          </div>
          <div className="hidden lg:block">
            <AdminTableRegion label="Group usage table">
              <table className="w-full min-w-[680px] border-collapse text-left text-xs">
              <thead className="bg-workspace-rail/70 text-ink-muted">
                <tr className="border-b border-trace-subtle">
                  <th className="px-3 py-2 font-medium">Group</th>
                  <th className="px-3 py-2 font-medium">Users</th>
                  <th className="px-3 py-2 font-medium">Runs</th>
                  <th className="px-3 py-2 font-medium">Tokens</th>
                  <th className="px-3 py-2 font-medium">Last usage</th>
                </tr>
              </thead>
              <tbody>
                {usage.byGroup.length ? (
                  usage.byGroup.map((group) => (
                    <tr className="border-b border-trace-subtle align-top last:border-b-0" key={group.groupId}>
                      <td className="px-3 py-3">
                        <div className="break-words font-medium text-ink [overflow-wrap:anywhere]">{group.name}</div>
                        <div className="mt-1 text-ink-muted">{group.archivedAt ? "Archived group" : "Active group"}</div>
                      </td>
                      <td className="px-3 py-3 text-ink-secondary">
                        <span className="font-mono tabular-nums">{formatNumber(group.contributingUsers)}</span> active /{" "}
                        <span className="font-mono tabular-nums">{formatNumber(group.userCount)}</span> total
                      </td>
                      <td className="px-3 py-3 font-mono tabular-nums text-ink-secondary">{formatNumber(group.runCount)}</td>
                      <td className="px-3 py-3 font-mono font-medium tabular-nums text-ink">{formatNumber(group.totalTokens)}</td>
                      <td className="px-3 py-3 text-ink-secondary">{formatDate(group.lastUsedAt)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="px-3 py-8 text-center text-ink-muted" colSpan={5}>
                      No groups in this installation
                    </td>
                  </tr>
                )}
              </tbody>
              </table>
            </AdminTableRegion>
          </div>
        </section>

        <section className="min-w-0" data-testid="admin-usage-users">
          <div className="flex min-w-0 flex-col gap-1 border-b border-trace-subtle pb-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-ink">Usage by user</h3>
              <p className="mt-1 text-xs leading-5 text-ink-muted">
                Retained runs with reported usage, ordered by total tokens.
              </p>
            </div>
            <p className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
              {countLabel(usage.byUser.length, "user")}
            </p>
          </div>
          <div className="divide-y divide-trace-subtle lg:hidden" data-testid="admin-usage-users-mobile">
            {usage.byUser.length ? (
              usage.byUser.map((user) => {
                const topModel = user.providerModels[0] ?? null;
                const groups = user.groups.length ? user.groups.map((group) => group.name).join(", ") : "No groups";

                return (
                  <article className="min-w-0 py-4" key={user.userId}>
                    <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{user.displayName}</p>
                    <p className="mt-1 break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{user.email ?? "No email"}</p>
                    <p className="mt-2 break-words text-xs text-ink-secondary [overflow-wrap:anywhere]">{groups}</p>
                    <MobileUsageFacts
                      facts={[
                        { label: "Runs", value: formatNumber(user.runCount) },
                        { label: "Tokens", value: formatNumber(user.totalTokens) },
                        {
                          label: "Input / output",
                          value: `${formatNumber(user.inputTokens)} / ${formatNumber(user.outputTokens)}`
                        },
                        {
                          label: "Top model",
                          value: topModel
                            ? `${usageProviderModelLabel(catalog, topModel)} · ${formatNumber(topModel.totalTokens)}`
                            : "No reported usage"
                        },
                        { label: "Last usage", value: formatDate(user.lastUsedAt) }
                      ]}
                    />
                  </article>
                );
              })
            ) : (
              <p className="py-7 text-sm text-ink-muted">No users in this installation</p>
            )}
          </div>
          <div className="hidden lg:block">
            <AdminTableRegion label="User usage table">
              <table className="w-full min-w-[820px] border-collapse text-left text-xs">
              <thead className="bg-workspace-rail/70 text-ink-muted">
                <tr className="border-b border-trace-subtle">
                  <th className="px-3 py-2 font-medium">User</th>
                  <th className="px-3 py-2 font-medium">Groups</th>
                  <th className="px-3 py-2 font-medium">Runs</th>
                  <th className="px-3 py-2 font-medium">Tokens</th>
                  <th className="px-3 py-2 font-medium">Input / output</th>
                  <th className="px-3 py-2 font-medium">Top model</th>
                  <th className="px-3 py-2 font-medium">Last usage</th>
                </tr>
              </thead>
              <tbody>
                {usage.byUser.length ? (
                  usage.byUser.map((user) => {
                    const topModel = user.providerModels[0] ?? null;

                    return (
                      <tr className="border-b border-trace-subtle align-top last:border-b-0" key={user.userId}>
                        <td className="px-3 py-3">
                          <div className="break-words font-medium text-ink [overflow-wrap:anywhere]">{user.displayName}</div>
                          <div className="mt-1 break-words text-ink-muted [overflow-wrap:anywhere]">{user.email ?? "No email"}</div>
                        </td>
                        <td className="px-3 py-3 text-ink-secondary">
                          {user.groups.length ? (
                            user.groups.map((group, index) => (
                              <span className="break-words [overflow-wrap:anywhere]" key={group.groupId}>
                                {index > 0 ? ", " : null}
                                {group.name}
                              </span>
                            ))
                          ) : (
                            <span className="text-ink-muted">No groups</span>
                          )}
                        </td>
                        <td className="px-3 py-3 font-mono tabular-nums text-ink-secondary">{formatNumber(user.runCount)}</td>
                        <td className="px-3 py-3 font-mono font-medium tabular-nums text-ink">{formatNumber(user.totalTokens)}</td>
                        <td className="px-3 py-3 text-ink-secondary">
                          <span className="font-mono tabular-nums">{formatNumber(user.inputTokens)}</span>
                          {" / "}
                          <span className="font-mono tabular-nums">{formatNumber(user.outputTokens)}</span>
                        </td>
                        <td className="px-3 py-3">
                          {topModel ? (
                            <>
                              <div className="break-words text-ink-secondary [overflow-wrap:anywhere]">
                                {usageProviderModelLabel(catalog, topModel)}
                              </div>
                              <div className="mt-1 font-mono text-[11px] tabular-nums text-ink-muted">
                                {formatNumber(topModel.totalTokens)} tokens
                              </div>
                            </>
                          ) : (
                            <span className="text-ink-muted">No reported usage</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-ink-secondary">{formatDate(user.lastUsedAt)}</td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td className="px-3 py-8 text-center text-ink-muted" colSpan={7}>
                      No users in this installation
                    </td>
                  </tr>
                )}
              </tbody>
              </table>
            </AdminTableRegion>
          </div>
        </section>
      </div>
    </div>
  );
}

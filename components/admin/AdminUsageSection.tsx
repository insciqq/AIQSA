import {
  AdminTableRegion,
  GroupChips,
  SummaryMetric
} from "@/components/admin/adminPrimitives";
import {
  formatDate,
  formatNumber,
  modelDisplayName,
  providerDisplayName
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
  return `${providerDisplayName(catalog, usage.provider)} / ${modelDisplayName(catalog, usage)}`;
}

export function AdminUsageSection({ catalog, usage }: AdminUsageSectionProps) {
  const usersWithUsage = usage.byUser.filter((user) => user.runCount > 0);
  const groupsWithUsage = usage.byGroup.filter((group) => group.runCount > 0);

  return (
    <div className="grid gap-3 p-3">
      <section className="grid grid-cols-2 gap-2 xl:grid-cols-4" aria-label="Usage summary">
        <SummaryMetric
          detail={`${formatNumber(usage.totals.runCount)} linked runs with reported usage`}
          label="Total tokens"
          value={formatNumber(usage.totals.totalTokens)}
        />
        <SummaryMetric
          detail={`${formatNumber(usage.totals.cachedInputTokens)} cached / ${formatNumber(
            usage.totals.cacheWriteInputTokens
          )} cache write`}
          label="Input tokens"
          value={formatNumber(usage.totals.inputTokens)}
        />
        <SummaryMetric
          detail={`${formatNumber(usage.totals.reasoningTokens)} reasoning tokens`}
          label="Output tokens"
          value={formatNumber(usage.totals.outputTokens)}
        />
        <SummaryMetric
          detail={`${usersWithUsage.length} users / ${groupsWithUsage.length} groups`}
          label="Last usage"
          value={usage.totals.lastUsedAt ? formatDate(usage.totals.lastUsedAt) : "Never"}
        />
      </section>

      <div className="rounded-panel bg-surface-raised/50 px-3 py-2 text-xs leading-5 text-content-muted">
        This view uses provider-reported usage rows. Failed or cancelled runs appear only when the provider reported
        usage before termination. Run counts cover retained run records; token totals can also include older detached
        usage. Group totals are membership totals: a user in multiple groups is counted once in each current group, so
        group rows are for attribution, not billing reconciliation.
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <section className="rounded-panel bg-surface-raised/50" data-testid="admin-usage-groups">
          <div className="border-b border-separator-subtle px-3 py-2">
            <div className="text-xs font-medium text-content-secondary">Groups</div>
            <p className="mt-1 text-xs text-content-muted">Current group memberships with provider-reported token totals.</p>
          </div>
          <AdminTableRegion label="Group usage table">
            <table className="w-full min-w-[680px] border-collapse text-left text-xs">
              <thead className="bg-surface-thread text-content-muted">
                <tr>
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
                    <tr className="border-b border-separator-subtle align-top last:border-b-0" key={group.groupId}>
                      <td className="px-3 py-3">
                        <div className="break-words text-content-primary [overflow-wrap:anywhere]">{group.name}</div>
                        <div className="mt-1 text-content-muted">{group.archivedAt ? "Archived group" : "Active group"}</div>
                      </td>
                      <td className="px-3 py-3 text-content-secondary">
                        <span className="font-mono text-content-secondary">{formatNumber(group.contributingUsers)}</span> active /{" "}
                        <span className="font-mono text-content-secondary">{formatNumber(group.userCount)}</span> total
                      </td>
                      <td className="px-3 py-3 font-mono text-content-secondary">{formatNumber(group.runCount)}</td>
                      <td className="px-3 py-3 font-mono text-content-primary">{formatNumber(group.totalTokens)}</td>
                      <td className="px-3 py-3 text-content-secondary">{formatDate(group.lastUsedAt)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="px-3 py-8 text-center text-content-muted" colSpan={5}>
                      No groups
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </AdminTableRegion>
        </section>

        <section className="rounded-panel bg-surface-raised/50" data-testid="admin-usage-users">
          <div className="border-b border-separator-subtle px-3 py-2">
            <div className="text-xs font-medium text-content-secondary">Users</div>
            <p className="mt-1 text-xs text-content-muted">Completed-run usage by user, sorted by total tokens.</p>
          </div>
          <AdminTableRegion label="User usage table">
            <table className="w-full min-w-[820px] border-collapse text-left text-xs">
              <thead className="bg-surface-thread text-content-muted">
                <tr>
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
                      <tr className="border-b border-separator-subtle align-top last:border-b-0" key={user.userId}>
                        <td className="px-3 py-3">
                          <div className="break-words text-content-primary [overflow-wrap:anywhere]">{user.displayName}</div>
                          <div className="mt-1 break-words text-content-muted [overflow-wrap:anywhere]">{user.email ?? "No email"}</div>
                        </td>
                        <td className="px-3 py-3 text-content-secondary">
                          <GroupChips groups={user.groups} />
                        </td>
                        <td className="px-3 py-3 font-mono text-content-secondary">{formatNumber(user.runCount)}</td>
                        <td className="px-3 py-3 font-mono text-content-primary">{formatNumber(user.totalTokens)}</td>
                        <td className="px-3 py-3 text-content-secondary">
                          <span className="font-mono text-content-secondary">{formatNumber(user.inputTokens)}</span>
                          {" / "}
                          <span className="font-mono text-content-secondary">{formatNumber(user.outputTokens)}</span>
                        </td>
                        <td className="px-3 py-3">
                          {topModel ? (
                            <>
                              <div className="break-words text-content-secondary [overflow-wrap:anywhere]">{usageProviderModelLabel(catalog, topModel)}</div>
                              <div className="mt-1 font-mono text-[11px] text-content-muted">
                                {formatNumber(topModel.totalTokens)} tokens
                              </div>
                            </>
                          ) : (
                            <span className="text-content-muted">No reported usage</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-content-secondary">{formatDate(user.lastUsedAt)}</td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td className="px-3 py-8 text-center text-content-muted" colSpan={7}>
                      No users
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </AdminTableRegion>
        </section>
      </div>
    </div>
  );
}

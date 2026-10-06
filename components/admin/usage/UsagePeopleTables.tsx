"use client";

import { useState } from "react";
import { AdminTableRegion, quietButton } from "@/components/admin/adminPrimitives";
import { formatDate, groupLabel } from "@/components/admin/adminViewUtils";
import { cardClass } from "@/components/admin/roles/rolesControls";
import type { AdminUsageAnalytics, AdminUsageUserRecord } from "@/lib/contracts/adminUsageAnalytics";
import { usageShare, usageShareBasis } from "./UsageBreakdowns";
import { formatCount } from "./usageFormat";
import { MobileFacts, ShareCell, UsageBlockHeading, UsageCost } from "./usageParts";

export const INITIAL_USER_ROWS = 25;

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}

function topModelLabel(user: AdminUsageUserRecord): string {
  return user.topModels[0]?.label ?? "—";
}

export function UsageUsersTable({ usage }: Readonly<{ usage: AdminUsageAnalytics }>) {
  const [expanded, setExpanded] = useState(false);
  const basis = usageShareBasis(usage.totals);
  const users = expanded ? usage.byUser : usage.byUser.slice(0, INITIAL_USER_ROWS);
  const hidden = usage.byUser.length - users.length;
  const empty = <p className="py-7 text-sm text-ink-muted">No user had usage in this period.</p>;

  return (
    <section aria-label="Users" className="min-w-0" data-testid="admin-usage-users">
      <UsageBlockHeading
        detail="Users with usage in this period, most expensive first."
        title="Users"
        trailing={<p className="font-mono text-xs tabular-nums text-ink-muted">{countLabel(usage.byUser.length, "user")}</p>}
      />
      <div className="divide-y divide-trace-subtle lg:hidden" data-testid="admin-usage-users-mobile">
        {users.length ? users.map((user) => (
          <article className="min-w-0 py-4" key={user.userId}>
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{user.displayName}</p>
                <p className="mt-0.5 break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{user.email ?? "No email"}</p>
              </div>
              <div className="shrink-0 text-right text-sm text-ink"><UsageCost usage={user} /></div>
            </div>
            <ShareCell share={usageShare(user, usage.totals, basis)} />
            <MobileFacts
              facts={[
                { label: "Tokens", value: <span className="font-mono tabular-nums">{formatCount(user.totalTokens)}</span> },
                { label: "Runs", value: <span className="font-mono tabular-nums">{formatCount(user.runCount)}</span> },
                { label: "Top model", value: topModelLabel(user) },
                { label: "Last usage", value: formatDate(user.lastUsedAt) },
                { label: "Groups", value: groupLabel(user.groups) }
              ]}
            />
          </article>
        )) : empty}
      </div>
      <div className={`${cardClass} mt-3 hidden lg:block`}>
        <AdminTableRegion label="User usage table">
          <table className="w-full min-w-[860px] border-collapse text-left text-xs">
            <thead className="bg-control-surface/45 text-ink-muted">
              <tr className="border-b border-trace-subtle">
                <th className="px-3 py-2 font-medium" scope="col">User</th>
                <th className="px-3 py-2 font-medium" scope="col">Groups</th>
                <th className="w-48 px-3 py-2 font-medium" scope="col">Estimated cost</th>
                <th className="px-3 py-2 text-right font-medium" scope="col">Tokens</th>
                <th className="px-3 py-2 text-right font-medium" scope="col">Runs</th>
                <th className="px-3 py-2 font-medium" scope="col">Top model</th>
                <th className="px-3 py-2 font-medium" scope="col">Last usage</th>
              </tr>
            </thead>
            <tbody>
              {users.length ? users.map((user) => (
                <tr className="border-b border-trace-subtle align-top last:border-b-0" key={user.userId}>
                  <td className="px-3 py-3">
                    <div className="break-words font-medium text-ink [overflow-wrap:anywhere]">{user.displayName}</div>
                    <div className="mt-1 break-words text-ink-muted [overflow-wrap:anywhere]">{user.email ?? "No email"}</div>
                  </td>
                  <td className="break-words px-3 py-3 text-ink-secondary [overflow-wrap:anywhere]">{groupLabel(user.groups)}</td>
                  <td className="px-3 py-3 text-ink">
                    <UsageCost usage={user} />
                    <ShareCell share={usageShare(user, usage.totals, basis)} />
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-ink">{formatCount(user.totalTokens)}</td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-ink-secondary">{formatCount(user.runCount)}</td>
                  <td className="break-words px-3 py-3 text-ink-secondary [overflow-wrap:anywhere]">{topModelLabel(user)}</td>
                  <td className="px-3 py-3 text-ink-secondary">{formatDate(user.lastUsedAt)}</td>
                </tr>
              )) : (
                <tr>
                  <td className="px-3 py-8 text-center text-ink-muted" colSpan={7}>No user had usage in this period.</td>
                </tr>
              )}
            </tbody>
          </table>
        </AdminTableRegion>
      </div>
      {hidden > 0 ? (
        <button className={`${quietButton} mt-3`} onClick={() => setExpanded(true)} type="button">
          Show all {countLabel(usage.byUser.length, "user")}
        </button>
      ) : null}
    </section>
  );
}

export function UsageGroupsTable({ usage }: Readonly<{ usage: AdminUsageAnalytics }>) {
  const groups = usage.byGroup;
  const empty = <p className="py-7 text-sm text-ink-muted">No groups in this installation.</p>;
  return (
    <section aria-label="Groups" className="min-w-0" data-testid="admin-usage-groups">
      <UsageBlockHeading
        detail="Current memberships in this period. A user in several groups counts in each, so group totals can overlap."
        title="Groups"
        trailing={<p className="font-mono text-xs tabular-nums text-ink-muted">{countLabel(groups.length, "group")}</p>}
      />
      <div className="divide-y divide-trace-subtle lg:hidden" data-testid="admin-usage-groups-mobile">
        {groups.length ? groups.map((group) => (
          <article className="min-w-0 py-4" key={group.groupId}>
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{group.name}</p>
                <p className="mt-0.5 text-xs text-ink-muted">{group.archivedAt ? "Archived group" : "Active group"}</p>
              </div>
              <div className="shrink-0 text-right text-sm text-ink"><UsageCost usage={group} /></div>
            </div>
            <MobileFacts
              facts={[
                { label: "Users", value: `${formatCount(group.contributingUsers)} active of ${formatCount(group.userCount)}` },
                { label: "Runs", value: <span className="font-mono tabular-nums">{formatCount(group.runCount)}</span> },
                { label: "Tokens", value: <span className="font-mono tabular-nums">{formatCount(group.totalTokens)}</span> }
              ]}
            />
          </article>
        )) : empty}
      </div>
      <div className={`${cardClass} mt-3 hidden lg:block`}>
        <AdminTableRegion label="Group usage table">
          <table className="w-full min-w-[640px] border-collapse text-left text-xs">
            <thead className="bg-control-surface/45 text-ink-muted">
              <tr className="border-b border-trace-subtle">
                <th className="px-3 py-2 font-medium" scope="col">Group</th>
                <th className="px-3 py-2 font-medium" scope="col">Users</th>
                <th className="px-3 py-2 text-right font-medium" scope="col">Runs</th>
                <th className="px-3 py-2 text-right font-medium" scope="col">Tokens</th>
                <th className="px-3 py-2 font-medium" scope="col">Estimated cost</th>
              </tr>
            </thead>
            <tbody>
              {groups.length ? groups.map((group) => (
                <tr className="border-b border-trace-subtle align-top last:border-b-0" key={group.groupId}>
                  <td className="px-3 py-3">
                    <div className="break-words font-medium text-ink [overflow-wrap:anywhere]">{group.name}</div>
                    <div className="mt-1 text-ink-muted">{group.archivedAt ? "Archived group" : "Active group"}</div>
                  </td>
                  <td className="px-3 py-3 text-ink-secondary">
                    <span className="font-mono tabular-nums">{formatCount(group.contributingUsers)}</span> active of{" "}
                    <span className="font-mono tabular-nums">{formatCount(group.userCount)}</span>
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-ink-secondary">{formatCount(group.runCount)}</td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-ink">{formatCount(group.totalTokens)}</td>
                  <td className="px-3 py-3 text-ink"><UsageCost usage={group} /></td>
                </tr>
              )) : (
                <tr>
                  <td className="px-3 py-8 text-center text-ink-muted" colSpan={5}>No groups in this installation.</td>
                </tr>
              )}
            </tbody>
          </table>
        </AdminTableRegion>
      </div>
    </section>
  );
}

"use client";

import { AdminTableRegion } from "@/components/admin/adminPrimitives";
import { healthCount, healthTime } from "@/components/admin/health/healthFormat";
import type { AdminHealthErrorGroup } from "@/lib/contracts/adminHealth";

function where(group: AdminHealthErrorGroup): string {
  return [...group.events, ...group.codes].join(" · ") || "—";
}

function Identity({ group }: Readonly<{ group: AdminHealthErrorGroup }>) {
  return (
    <>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="break-words font-medium text-ink [overflow-wrap:anywhere]">{group.errorClass}</span>
        {group.isNew ? (
          <span className="shrink-0 rounded-pill bg-caution/10 px-1.5 py-px text-metadata font-semibold text-caution">New</span>
        ) : null}
      </span>
      <span className="mt-0.5 block break-words font-mono text-ink-muted [overflow-wrap:anywhere]">
        {group.site ?? "Outside application code"}
      </span>
    </>
  );
}

/**
 * Failures grouped by fingerprint: the error class and where in the
 * application it was thrown. New failures first, then the most frequent.
 */
export function AdminHealthErrorGroups({ groups, truncated }: Readonly<{ groups: readonly AdminHealthErrorGroup[]; truncated: boolean }>) {
  if (groups.length === 0) {
    return <p className="py-6 text-sm text-ink-muted" data-testid="admin-health-error-groups-empty">No failures with a code location in this period.</p>;
  }
  return (
    <div className="min-w-0" data-testid="admin-health-error-groups">
      <ul aria-label="Failures by location" className="divide-y divide-trace-subtle xl:hidden">
        {groups.map((group) => (
          <li className="min-w-0 py-3.5 text-xs" data-testid="admin-health-error-group-card" key={group.fingerprint}>
            <Identity group={group} />
            <dl className="mt-2.5 grid min-w-0 grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
              <div className="min-w-0"><dt className="text-ink-muted">Count</dt><dd className="mt-0.5 font-mono tabular-nums text-ink">{healthCount(group.count)}</dd></div>
              <div className="min-w-0"><dt className="text-ink-muted">Process</dt><dd className="mt-0.5 break-words text-ink-secondary [overflow-wrap:anywhere]">{group.roles.join(", ") || "—"}</dd></div>
              <div className="min-w-0"><dt className="text-ink-muted">Last seen</dt><dd className="mt-0.5 break-words text-ink-secondary">{healthTime(group.lastSeenAt)}</dd></div>
              <div className="min-w-0"><dt className="text-ink-muted">First seen</dt><dd className="mt-0.5 break-words text-ink-secondary">{healthTime(group.firstSeenAt)}</dd></div>
              <div className="col-span-full min-w-0"><dt className="text-ink-muted">Recorded as</dt><dd className="mt-0.5 break-words text-ink-secondary [overflow-wrap:anywhere]">{where(group)}</dd></div>
            </dl>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-hidden rounded-[12px] border border-trace-subtle xl:block">
        <AdminTableRegion label="Failures by location table">
          <table className="w-full min-w-[760px] border-collapse text-left text-xs">
            <thead className="bg-control-surface/45 text-ink-muted">
              <tr className="border-b border-trace-subtle">
                <th className="px-3 py-2 font-medium" scope="col">Error · location</th>
                <th className="px-3 py-2 text-right font-medium" scope="col">Count</th>
                <th className="px-3 py-2 font-medium" scope="col">Recorded as</th>
                <th className="px-3 py-2 font-medium" scope="col">Process</th>
                <th className="px-3 py-2 font-medium" scope="col">Last seen</th>
                <th className="px-3 py-2 font-medium" scope="col">First seen</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr className="border-b border-trace-subtle align-top last:border-b-0" data-testid="admin-health-error-group-row" key={group.fingerprint}>
                  <td className="max-w-[22rem] px-3 py-2.5"><Identity group={group} /></td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink">{healthCount(group.count)}</td>
                  <td className="max-w-[16rem] break-words px-3 py-2.5 text-ink-secondary [overflow-wrap:anywhere]">{where(group)}</td>
                  <td className="max-w-[10rem] break-words px-3 py-2.5 text-ink-secondary [overflow-wrap:anywhere]">{group.roles.join(", ") || "—"}</td>
                  <td className="px-3 py-2.5 text-ink-secondary">{healthTime(group.lastSeenAt)}</td>
                  <td className="px-3 py-2.5 text-ink-secondary">{healthTime(group.firstSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AdminTableRegion>
      </div>
      {truncated ? (
        <p className="mt-2 text-xs text-caution" role="status">Too many distinct failures to list at once; the least frequent are not shown.</p>
      ) : null}
    </div>
  );
}

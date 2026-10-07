"use client";

import { AdminTableRegion } from "@/components/admin/adminPrimitives";
import {
  healthCount,
  healthDuration,
  healthFailureClassLabels,
  healthPercent,
  healthStageLabel,
  healthTime
} from "@/components/admin/health/healthFormat";
import { adminHealthFailureClasses, type AdminHealthProviderRow } from "@/lib/contracts/adminHealth";

function breakdown(row: AdminHealthProviderRow): string {
  const parts = adminHealthFailureClasses
    .filter((key) => row.failuresByClass[key] > 0)
    .map((key) => `${healthCount(row.failuresByClass[key])} ${healthFailureClassLabels[key].toLowerCase()}`);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function Identity({ row }: Readonly<{ row: AdminHealthProviderRow }>) {
  return (
    <>
      <span className={`block break-words font-medium [overflow-wrap:anywhere] ${row.connectionState === "known" ? "text-ink" : "italic text-ink-muted"}`}>
        {row.connectionName}
      </span>
      <span className="mt-0.5 block break-words text-ink-muted [overflow-wrap:anywhere]">
        {row.modelName ?? "No model"} · {healthStageLabel(row.stage)}
      </span>
    </>
  );
}

function Failures({ row }: Readonly<{ row: AdminHealthProviderRow }>) {
  return (
    <span className="font-mono tabular-nums">
      <span className={row.failures > 0 ? "font-semibold text-ink" : "text-ink-secondary"}>{healthCount(row.failures)}</span>
      <span className="text-ink-muted"> ({healthPercent(row.failureRate)})</span>
    </span>
  );
}

/** Provider reliability per connection, model and stage, most failures first. */
export function AdminHealthProviders({ rows, truncated }: Readonly<{ rows: readonly AdminHealthProviderRow[]; truncated: boolean }>) {
  if (rows.length === 0) {
    return <p className="py-6 text-sm text-ink-muted" data-testid="admin-health-providers-empty">No provider calls in this period.</p>;
  }
  return (
    <div className="min-w-0" data-testid="admin-health-providers">
      <ul aria-label="Provider reliability" className="divide-y divide-trace-subtle xl:hidden">
        {rows.map((row) => (
          <li className="min-w-0 py-3.5 text-xs" data-testid="admin-health-provider-card" key={row.key}>
            <Identity row={row} />
            <dl className="mt-2.5 grid min-w-0 grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
              <div className="min-w-0"><dt className="text-ink-muted">Calls</dt><dd className="mt-0.5 font-mono tabular-nums text-ink-secondary">{healthCount(row.operations)}</dd></div>
              <div className="min-w-0"><dt className="text-ink-muted">Failures</dt><dd className="mt-0.5"><Failures row={row} /></dd></div>
              <div className="min-w-0"><dt className="text-ink-muted">p95 time</dt><dd className="mt-0.5 font-mono tabular-nums text-ink-secondary">{healthDuration(row.p95Ms)}</dd></div>
              <div className="min-w-0"><dt className="text-ink-muted">Last failure</dt><dd className="mt-0.5 break-words text-ink-secondary">{row.lastFailureAt ? healthTime(row.lastFailureAt) : "—"}</dd></div>
              {row.failures > 0 ? (
                <div className="col-span-full min-w-0"><dt className="text-ink-muted">Why</dt><dd className="mt-0.5 break-words text-ink-secondary">{breakdown(row)}</dd></div>
              ) : null}
            </dl>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-hidden rounded-[12px] border border-trace-subtle xl:block">
        <AdminTableRegion label="Provider reliability table">
          <table className="w-full min-w-[760px] border-collapse text-left text-xs">
            <thead className="bg-control-surface/45 text-ink-muted">
              <tr className="border-b border-trace-subtle">
                <th className="px-3 py-2 font-medium" scope="col">Connection · model · stage</th>
                <th className="px-3 py-2 text-right font-medium" scope="col">Calls</th>
                <th className="px-3 py-2 text-right font-medium" scope="col">Failures</th>
                <th className="px-3 py-2 font-medium" scope="col">Why</th>
                <th className="px-3 py-2 text-right font-medium" scope="col">p95 time</th>
                <th className="px-3 py-2 font-medium" scope="col">Last failure</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr className="border-b border-trace-subtle align-top last:border-b-0" data-testid="admin-health-provider-row" key={row.key}>
                  <td className="max-w-[18rem] px-3 py-2.5"><Identity row={row} /></td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-secondary">{healthCount(row.operations)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right"><Failures row={row} /></td>
                  <td className="max-w-[16rem] px-3 py-2.5 text-ink-secondary">{breakdown(row)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono tabular-nums text-ink-secondary">{healthDuration(row.p95Ms)}</td>
                  <td className="px-3 py-2.5 text-ink-secondary">{row.lastFailureAt ? healthTime(row.lastFailureAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AdminTableRegion>
      </div>
      {truncated ? (
        <p className="mt-2 text-xs text-caution" role="status">Too many provider combinations to list at once; some rows may be missing.</p>
      ) : null}
    </div>
  );
}

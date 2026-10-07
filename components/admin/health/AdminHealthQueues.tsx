"use client";

import { AdminTableRegion } from "@/components/admin/adminPrimitives";
import { healthCount, healthTime } from "@/components/admin/health/healthFormat";
import type { AdminHealthQueuesController } from "@/components/admin/health/useAdminHealthQueues";
import {
  adminHealthQueueCopy,
  type AdminHealthQueueRow,
  type AdminHealthQueueState
} from "@/lib/contracts/adminHealthQueues";

const stateLabels: Readonly<Record<AdminHealthQueueState, string>> = {
  ok: "OK",
  slow: "Slow",
  stalled: "Stalled",
  unavailable: "Unavailable"
};

const statePills: Readonly<Record<Exclude<AdminHealthQueueState, "ok">, string>> = {
  slow: "border-caution/25 bg-caution/10 text-caution",
  stalled: "border-critical/25 bg-critical/10 text-critical",
  unavailable: "border-trace-subtle bg-control-surface text-ink-muted"
};

/** A queue age: minutes under two hours, hours and minutes under two days, then days. */
export function queueAgeLabel(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return "<1 min";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

function countLabel(value: number | null): string {
  return value === null ? "—" : healthCount(value);
}

function stateNote(row: AdminHealthQueueRow): string | null {
  if (row.state === "unavailable") return "Could not be read just now";
  if (row.state === "stalled") return `Oldest over ${queueAgeLabel(row.stalledAfterSeconds)}`;
  if (row.state === "slow") return `Oldest over ${queueAgeLabel(row.slowAfterSeconds)}`;
  return null;
}

/** Only a queue that needs a look gets a pill; healthy rows stay quiet. */
function StatePill({ row }: Readonly<{ row: AdminHealthQueueRow }>) {
  if (row.state === "ok") {
    return <span className="shrink-0 text-ink-muted" data-state="ok" data-testid="admin-health-queue-state">{stateLabels.ok}</span>;
  }
  return (
    <span
      className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-pill border px-2 text-metadata font-semibold ${statePills[row.state]}`}
      data-state={row.state}
      data-testid="admin-health-queue-state"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {stateLabels[row.state]}
    </span>
  );
}

function Identity({ row }: Readonly<{ row: AdminHealthQueueRow }>) {
  const copy = adminHealthQueueCopy[row.queue];
  return (
    <>
      <span className="block break-words font-medium text-ink [overflow-wrap:anywhere]">{copy.label}</span>
      <span className="mt-0.5 block break-words text-ink-muted [overflow-wrap:anywhere]">{copy.purpose}</span>
    </>
  );
}

function Failed({ row }: Readonly<{ row: AdminHealthQueueRow }>) {
  if (row.failed24h === null) {
    return <span className="text-ink-muted" title={row.state === "unavailable" ? undefined : "This queue does not record failures"}>—</span>;
  }
  return <span className={row.failed24h > 0 ? "font-semibold text-ink" : "text-ink-secondary"}>{healthCount(row.failed24h)}</span>;
}

/** Background queue sizes and the age of each queue's oldest unfinished job. */
export function AdminHealthQueues({ controller }: Readonly<{ controller: AdminHealthQueuesController }>) {
  const { queues } = controller;
  if (controller.loading) {
    return <p className="py-4 text-sm text-ink-muted" data-testid="admin-health-queues-loading" role="status">Loading background queues…</p>;
  }
  if (!queues) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-critical/25 bg-critical/5 px-5 py-4" data-testid="admin-health-queues-unavailable">
        <p className="min-w-0 flex-1 text-sm text-ink">Background queues could not be read. The database may be busy or unavailable.</p>
        <button className="v2-button v2-focusable" data-tone="ghost" onClick={controller.refresh} type="button"><span>Try again</span></button>
      </div>
    );
  }
  const rows = queues.queues;
  return (
    <div className="min-w-0" data-testid="admin-health-queues">
      {controller.error ? (
        <p className="mb-2 text-xs text-caution" role="status">
          Refresh failed. Showing queues from {healthTime(queues.checkedAt)}; current state is unknown.
        </p>
      ) : null}
      <ul aria-label="Background queues" className="divide-y divide-trace-subtle xl:hidden">
        {rows.map((row) => (
          <li className="min-w-0 py-3.5 text-xs" data-queue={row.queue} data-testid="admin-health-queue-card" key={row.queue}>
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0"><Identity row={row} /></div>
              <StatePill row={row} />
            </div>
            {stateNote(row) ? <p className="mt-1.5 text-ink-muted">{stateNote(row)}</p> : null}
            <dl className="mt-2.5 grid min-w-0 grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
              <div className="min-w-0"><dt className="text-ink-muted">Waiting</dt><dd className="mt-0.5 font-mono tabular-nums text-ink-secondary">{countLabel(row.waiting)}</dd></div>
              <div className="min-w-0"><dt className="text-ink-muted">Running</dt><dd className="mt-0.5 font-mono tabular-nums text-ink-secondary">{countLabel(row.running)}</dd></div>
              <div className="min-w-0"><dt className="text-ink-muted">Oldest</dt><dd className="mt-0.5 font-mono tabular-nums text-ink-secondary">{queueAgeLabel(row.oldestSeconds)}</dd></div>
              <div className="min-w-0"><dt className="text-ink-muted">Failed (24 h)</dt><dd className="mt-0.5 font-mono tabular-nums"><Failed row={row} /></dd></div>
            </dl>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-hidden rounded-[12px] border border-trace-subtle xl:block">
        <AdminTableRegion label="Background queues table">
          <table className="w-full min-w-[760px] border-collapse text-left text-xs">
            <thead className="bg-control-surface/45 text-ink-muted">
              <tr className="border-b border-trace-subtle">
                <th className="px-3 py-2 font-medium" scope="col">Queue</th>
                <th className="px-3 py-2 font-medium" scope="col">State</th>
                <th className="px-3 py-2 text-right font-medium" scope="col">Waiting</th>
                <th className="px-3 py-2 text-right font-medium" scope="col">Running</th>
                <th className="px-3 py-2 text-right font-medium" scope="col">Oldest</th>
                <th className="px-3 py-2 text-right font-medium" scope="col">Failed (24 h)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr className="border-b border-trace-subtle align-top last:border-b-0" data-queue={row.queue} data-testid="admin-health-queue-row" key={row.queue}>
                  <td className="max-w-[22rem] px-3 py-2.5"><Identity row={row} /></td>
                  <td className="px-3 py-2.5">
                    <StatePill row={row} />
                    {stateNote(row) ? <span className="mt-1 block text-ink-muted">{stateNote(row)}</span> : null}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-secondary">{countLabel(row.waiting)}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-secondary">{countLabel(row.running)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono tabular-nums text-ink-secondary">{queueAgeLabel(row.oldestSeconds)}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums"><Failed row={row} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </AdminTableRegion>
      </div>
    </div>
  );
}

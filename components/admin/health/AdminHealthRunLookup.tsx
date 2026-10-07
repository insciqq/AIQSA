"use client";

import { healthCount, healthDuration, healthTime } from "@/components/admin/health/healthFormat";
import {
  requestAdminHealthRunLookup,
  type AdminHealthRunLookupRequest,
  type AdminHealthRunLookupResult
} from "@/components/admin/health/adminHealthRunLookupApi";
import type { AdminHealthRunStatus, AdminHealthRunSummary } from "@/lib/contracts/adminHealthRunLookup";
import { useEffect, useState } from "react";

const statusLabels: Readonly<Record<AdminHealthRunStatus, string>> = {
  preparing: "Preparing",
  queued: "Queued",
  streaming: "Answering",
  in_progress: "In progress",
  complete: "Completed",
  cancelled: "Stopped",
  error: "Failed"
};

function RunSummary({ run }: Readonly<{ run: AdminHealthRunSummary }>) {
  const facts: [string, string][] = [
    ["Run id", run.runId],
    ["Status", statusLabels[run.status]],
    ["Started", healthTime(run.startedAt)],
    [run.durationMs === null ? "Last update" : "Settled", healthTime(run.updatedAt)],
    ["Duration", run.durationMs === null ? "Still running" : healthDuration(run.durationMs)],
    ["Failure code", run.failureCode ?? "—"],
    ["Connection", run.connectionName ?? "—"],
    ["Model", run.modelName ?? "—"],
    ["Linked incidents", healthCount(run.incidentCount)]
  ];
  return (
    <li className="min-w-0 px-4 py-3" data-testid="admin-health-run">
      <dl className="grid min-w-0 grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
        {facts.map(([label, value]) => (
          <div className="contents" key={label}>
            <dt className="break-words text-ink-muted [overflow-wrap:anywhere]">{label}</dt>
            <dd className={`break-words [overflow-wrap:anywhere] ${label === "Run id" || label === "Failure code"
              ? "select-text font-mono text-ink" : "text-ink-secondary"}`}>{value}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

type LookupState = Readonly<{ key: string; result: AdminHealthRunLookupResult | null }>;

/**
 * The runs an error reference names: content-free summaries even when no
 * incident was recorded. Mounted beside the incident list while the search
 * holds a run reference; a new reference or Try again starts a fresh read.
 */
export function AdminHealthRunLookup({
  reference,
  request = requestAdminHealthRunLookup
}: Readonly<{ reference: string; request?: AdminHealthRunLookupRequest }>) {
  const [attempt, setAttempt] = useState(0);
  const key = `${reference}\u0000${attempt}`;
  const [state, setState] = useState<LookupState>({ key, result: null });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void request(reference, controller.signal)
      .catch((): AdminHealthRunLookupResult => ({ error: "unavailable", ok: false }))
      .then((result) => {
        if (active) setState({ key, result });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [key, reference, request]);

  const result = state.key === key ? state.result : null;
  return (
    <section aria-labelledby="admin-health-run-lookup-heading" className="mt-3 min-w-0 overflow-hidden rounded-[12px] border border-trace-subtle bg-answer-paper" data-testid="admin-health-run-lookup">
      <h3 className="px-4 pt-3 text-sm font-semibold text-ink" id="admin-health-run-lookup-heading">
        Run <code className="font-mono text-xs">{reference}</code>
      </h3>
      {result === null ? (
        <p className="px-4 py-3 text-sm text-ink-muted" role="status">Looking up the run…</p>
      ) : !result.ok ? (
        <div className="flex flex-wrap items-center gap-3 px-4 py-3" role="alert">
          <p className="text-sm text-ink">
            {result.error === "invalid" ? "This is not a run reference." : "The run could not be looked up."}
          </p>
          {result.error === "invalid" ? null : (
            <button className="v2-button v2-focusable" data-tone="ghost" onClick={() => setAttempt((value) => value + 1)} type="button">
              <span>Try again</span>
            </button>
          )}
        </div>
      ) : result.lookup.runs.length === 0 ? (
        <p className="px-4 py-3 text-sm text-ink-muted" data-testid="admin-health-run-lookup-empty" role="status">
          No run matches this reference. Deleting a chat removes its runs.
        </p>
      ) : (
        <>
          <ul aria-label="Matching runs" className="divide-y divide-trace-subtle">
            {result.lookup.runs.map((run) => <RunSummary key={run.runId} run={run} />)}
          </ul>
          {result.lookup.truncated ? (
            <p className="px-4 pb-3 text-xs text-ink-muted">More runs share this reference. Enter more characters of the run id.</p>
          ) : null}
        </>
      )}
    </section>
  );
}

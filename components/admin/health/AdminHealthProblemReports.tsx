"use client";

import { AdminHealthRunLookup } from "@/components/admin/health/AdminHealthRunLookup";
import type { AdminHealthRunLookupRequest } from "@/components/admin/health/adminHealthRunLookupApi";
import { healthCount, healthRangeLabel, healthTime } from "@/components/admin/health/healthFormat";
import type { AdminHealthProblemReportsController } from "@/components/admin/health/useAdminHealthProblemReports";
import type { AdminHealthRange } from "@/lib/contracts/adminHealth";
import type { AdminHealthProblemReport } from "@/lib/contracts/adminHealthProblemReports";
import { answerProblemReasonLabels } from "@/lib/contracts/answerProblemReports";
import { runReferenceLabel } from "@/lib/contracts/runReference";
import { useId, useState } from "react";

function ReportRow({ lookupId, onToggleRun, openRunId, report }: Readonly<{
  lookupId: string;
  onToggleRun(runId: string): void;
  openRunId: string | null;
  report: AdminHealthProblemReport;
}>) {
  const model = [report.modelName, report.connectionName].filter(Boolean).join(" · ");
  return (
    <li className="min-w-0 px-4 py-3 text-xs" data-testid="admin-health-problem-report">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">
          {answerProblemReasonLabels[report.reason]}
        </span>
        <time className="shrink-0 text-ink-muted" dateTime={report.reportedAt}>{healthTime(report.reportedAt)}</time>
      </div>
      <dl className="mt-1.5 grid min-w-0 grid-cols-[minmax(0,5rem)_minmax(0,1fr)] gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,7rem)_minmax(0,1fr)]">
        <dt className="text-ink-muted">User</dt>
        <dd className="min-w-0 break-words text-ink-secondary [overflow-wrap:anywhere]">
          {report.user.displayName}
          <span className="text-ink-muted"> · {report.user.email ?? "no email"}</span>
        </dd>
        <dt className="text-ink-muted">Model</dt>
        <dd className="min-w-0 break-words text-ink-secondary [overflow-wrap:anywhere]">{model || "—"}</dd>
        <dt className="text-ink-muted">Run</dt>
        <dd className="min-w-0">
          {report.runId ? (
            <button
              aria-controls={openRunId === report.runId ? lookupId : undefined}
              aria-expanded={openRunId === report.runId}
              aria-label={`Look up run ${runReferenceLabel(report.runId)}`}
              className="v2-focusable inline-flex min-h-6 items-center rounded-[6px] font-mono text-proof underline-offset-2 hover:underline [@media(pointer:coarse)]:min-h-touch [@media(pointer:coarse)]:min-w-touch"
              onClick={() => onToggleRun(report.runId!)}
              type="button"
            >
              {runReferenceLabel(report.runId)}
            </button>
          ) : <span className="text-ink-muted">—</span>}
        </dd>
      </dl>
      {report.comment ? (
        <p className="mt-2 select-text whitespace-pre-wrap break-words rounded-[8px] bg-control-surface/45 px-3 py-2 text-ink [overflow-wrap:anywhere]">
          {report.comment}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Problem reports users sent about answers in the selected range, newest
 * first. A run reference opens the existing run lookup below the list; the
 * question and the answer are never part of a report.
 */
export function AdminHealthProblemReports({
  controller,
  range,
  requestRunLookup
}: Readonly<{
  controller: AdminHealthProblemReportsController;
  range: AdminHealthRange;
  requestRunLookup?: AdminHealthRunLookupRequest;
}>) {
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const lookupId = useId();
  const { page } = controller;
  if (controller.loading) {
    return <p className="py-4 text-sm text-ink-muted" data-testid="admin-health-problem-reports-loading" role="status">Loading problem reports…</p>;
  }
  if (!page) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-critical/25 bg-critical/5 px-5 py-4" data-testid="admin-health-problem-reports-unavailable">
        <p className="min-w-0 flex-1 text-sm text-ink">Problem reports could not be loaded.</p>
        <button className="v2-button v2-focusable" data-tone="ghost" onClick={controller.refresh} type="button"><span>Try again</span></button>
      </div>
    );
  }
  const shownRunId = openRunId && page.reports.some((report) => report.runId === openRunId) ? openRunId : null;
  return (
    <div className="min-w-0" data-testid="admin-health-problem-reports">
      {controller.error ? (
        <p className="mb-2 text-xs text-caution" role="status">
          Refresh failed. Showing reports from {healthTime(page.generatedAt)}.
        </p>
      ) : null}
      <div className="min-w-0 overflow-hidden rounded-[12px] border border-trace-subtle bg-answer-paper">
        {page.reports.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted" data-testid="admin-health-problem-reports-empty" role="status">
            No problem reports in the {healthRangeLabel(range)}.
          </p>
        ) : (
          <ul aria-label="Problem reports" className="divide-y divide-trace-subtle">
            {page.reports.map((report) => (
              <ReportRow
                key={report.id}
                lookupId={lookupId}
                onToggleRun={(runId) => setOpenRunId((current) => current === runId ? null : runId)}
                openRunId={shownRunId}
                report={report}
              />
            ))}
          </ul>
        )}
      </div>
      {page.truncated ? (
        <p className="mt-2 text-xs text-ink-muted">
          Showing the newest {healthCount(page.reports.length)} of {healthCount(page.total)} reports.
        </p>
      ) : null}
      {shownRunId ? (
        <div id={lookupId}>
          <AdminHealthRunLookup reference={shownRunId} request={requestRunLookup} />
        </div>
      ) : null}
    </div>
  );
}

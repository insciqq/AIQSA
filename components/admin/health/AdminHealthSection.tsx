"use client";

import { useAdminSectionTopbar } from "@/components/admin/AdminShell";
import { AdminHealthChart } from "@/components/admin/health/AdminHealthChart";
import {
  AdminHealthIncidents,
  emptyIncidentFilters,
  type AdminHealthIncidentFilterState
} from "@/components/admin/health/AdminHealthIncidents";
import { AdminHealthErrorGroups } from "@/components/admin/health/AdminHealthErrorGroups";
import { AdminHealthProviders } from "@/components/admin/health/AdminHealthProviders";
import { AdminHealthQueues } from "@/components/admin/health/AdminHealthQueues";
import type { AdminHealthIncidentsResult, AdminHealthResult } from "@/components/admin/health/adminHealthApi";
import {
  healthCount,
  healthPercent,
  healthRangeLabel,
  healthRangeOptions,
  healthTime
} from "@/components/admin/health/healthFormat";
import { useAdminHealth, useAdminHealthIncidents } from "@/components/admin/health/useAdminHealth";
import { useAdminHealthQueues, type AdminHealthQueuesResult } from "@/components/admin/health/useAdminHealthQueues";
import { SettingsSegmentV2 } from "@/features/settings-v2/ChatDefaultsRowsV2";
import { UiV2Button } from "@/components/ui-v2";
import {
  defaultAdminHealthRange,
  isAdminHealthRange,
  type AdminHealth,
  type AdminHealthIncidentFilters,
  type AdminHealthRange
} from "@/lib/contracts/adminHealth";
import { useMemo, useState, type ReactNode } from "react";

const headingClass = "text-[13px] font-semibold tracking-[0.02em] text-ink-secondary";
const cardClass = "min-w-0 rounded-[12px] border border-trace-subtle bg-answer-paper";

function Tile({ detail, label, testId, value }: Readonly<{ detail?: ReactNode; label: string; testId: string; value: string }>) {
  return (
    <div className="min-w-0 bg-answer-paper px-4 py-3.5" data-testid={testId}>
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd className="mt-1 break-words font-mono text-xl font-semibold tabular-nums text-ink [overflow-wrap:anywhere]">{value}</dd>
      {detail ? <dd className="mt-0.5 break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{detail}</dd> : null}
    </div>
  );
}

function previousCopy(health: AdminHealth): string {
  const { errors, previousErrors } = health.summary;
  if (previousErrors === null) return "No earlier period to compare";
  if (previousErrors === errors) return "Same as the period before";
  const difference = errors - previousErrors;
  return `${difference > 0 ? "+" : "−"}${healthCount(Math.abs(difference))} vs the period before (${healthCount(previousErrors)})`;
}

function Summary({ health }: Readonly<{ health: AdminHealth }>) {
  const { summary } = health;
  const restarted = summary.roleStarts.filter((item) => item.restarts > 0);
  return (
    <dl
      aria-label="Health summary"
      className="grid min-w-0 grid-cols-2 gap-px overflow-hidden rounded-[12px] border border-trace-subtle bg-trace-subtle sm:grid-cols-3 xl:grid-cols-6"
      data-testid="admin-health-summary"
    >
      <Tile detail={previousCopy(health)} label="Errors" testId="admin-health-tile-errors" value={healthCount(summary.errors)} />
      <Tile
        detail={summary.providerOperations > 0
          ? `${healthCount(summary.providerFailures)} of ${healthCount(summary.providerOperations)} calls`
          : "No provider calls"}
        label="Provider failures"
        testId="admin-health-tile-providers"
        value={healthPercent(summary.providerFailureRate)}
      />
      <Tile detail="Responses 500 and above" label="Server errors" testId="admin-health-tile-http" value={healthCount(summary.http5xx)} />
      <Tile
        detail={restarted.length > 0
          ? restarted.map((item) => `${item.role.replaceAll("_", " ")} ×${healthCount(item.restarts)}`).join(", ")
          : "Includes deploys and updates"}
        label="Restarts"
        testId="admin-health-tile-restarts"
        value={healthCount(summary.restarts)}
      />
      <Tile detail="Log lines dropped under load" label="Dropped logs" testId="admin-health-tile-dropped" value={healthCount(summary.droppedLogRecords)} />
      <Tile detail="Crashes reported by browsers" label="Browser errors" testId="admin-health-tile-client" value={healthCount(summary.clientErrors)} />
    </dl>
  );
}

function Unavailable({ forbidden, onRetry }: Readonly<{ forbidden: boolean; onRetry(): void }>) {
  return (
    <div className={`${cardClass} flex flex-wrap items-center gap-3 border-critical/25 bg-critical/5 px-5 py-4`} data-testid="admin-health-unavailable" role="alert">
      <p className="min-w-0 flex-1 text-sm text-ink">
        {forbidden
          ? "Only active administrators can see installation health."
          : "Health data could not be loaded. The database may be unavailable; the rest of the Control Center keeps working."}
      </p>
      {forbidden ? null : (
        <button className="v2-button v2-focusable" data-tone="ghost" onClick={onRetry} type="button"><span>Try again</span></button>
      )}
    </div>
  );
}

export type AdminHealthSectionProps = Readonly<{
  /** `?filter=` carries the range so the view has a URL; anything else means 24 hours. */
  filter: string | null;
  onSelectFilter(filter: string | null): void;
  requestHealth?: (range: AdminHealthRange, signal?: AbortSignal) => Promise<AdminHealthResult>;
  requestIncidents?: (filters: AdminHealthIncidentFilters, signal?: AbortSignal) => Promise<AdminHealthIncidentsResult>;
  requestQueues?: (signal?: AbortSignal) => Promise<AdminHealthQueuesResult>;
}>;

export function AdminHealthSection({ filter, onSelectFilter, requestHealth, requestIncidents, requestQueues }: AdminHealthSectionProps) {
  const range: AdminHealthRange = isAdminHealthRange(filter) ? filter : defaultAdminHealthRange;
  const controller = useAdminHealth(range, requestHealth);
  const [incidentFilters, setIncidentFilters] = useState<AdminHealthIncidentFilterState>(emptyIncidentFilters);
  const incidents = useAdminHealthIncidents({ ...incidentFilters, event: null, range }, requestIncidents);
  const { refresh } = controller;
  const refreshIncidents = incidents.refresh;
  const queues = useAdminHealthQueues(requestQueues);
  const refreshQueues = queues.refresh;

  const topbar = useMemo(() => ({
    actions: (
      <UiV2Button
        busy={controller.refreshing}
        disabled={controller.loading}
        icon="regenerate"
        onClick={() => {
          refresh();
          refreshIncidents();
          refreshQueues();
        }}
      >
        Refresh
      </UiV2Button>
    ),
    title: "Health"
  }), [controller.loading, controller.refreshing, refresh, refreshIncidents, refreshQueues]);
  useAdminSectionTopbar(topbar);

  const { health } = controller;
  return (
    <div className="flex min-w-0 max-w-[1440px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8" data-testid="admin-health">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <SettingsSegmentV2
          label="Time range"
          onChange={(next) => onSelectFilter(next === defaultAdminHealthRange ? null : next)}
          options={healthRangeOptions}
          value={range}
        />
        {health ? (
          <p className="text-xs text-ink-muted">
            Updated <time dateTime={health.generatedAt}>{healthTime(health.generatedAt)}</time>
          </p>
        ) : null}
      </div>

      {controller.loading ? (
        <p className="text-sm text-ink-muted" data-testid="admin-health-loading" role="status">Loading health for the {healthRangeLabel(range)}…</p>
      ) : !health ? (
        <Unavailable forbidden={controller.error === "forbidden" || controller.error === "unauthorized"} onRetry={refresh} />
      ) : (
        <>
          {controller.error ? (
            <p className="text-xs text-caution" role="status">
              Refresh failed. Showing results from {healthTime(health.generatedAt)}; current health is unknown.
            </p>
          ) : null}
          {!health.hasTelemetry ? (
            <div className={`${cardClass} px-5 py-6`} data-testid="admin-health-empty" role="status">
              <p className="text-sm font-semibold text-ink-secondary">No telemetry yet</p>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-muted">
                AIQSA records content-free counts of errors, provider calls and restarts inside this installation.
                They appear here within a minute of the first activity.
              </p>
            </div>
          ) : (
            <>
              <Summary health={health} />
              <section aria-labelledby="admin-health-errors-heading" className={`${cardClass} p-4 sm:p-5`}>
                <h2 className={`${headingClass} mb-3`} id="admin-health-errors-heading">
                  Errors {health.interval === "hour" ? "per hour" : "per day (UTC)"}
                </h2>
                <AdminHealthChart interval={health.interval} series={health.series} />
              </section>
              <section aria-labelledby="admin-health-error-groups-heading" className="min-w-0">
                <div className="mb-2 flex min-w-0 flex-col gap-0.5">
                  <h2 className={headingClass} id="admin-health-error-groups-heading">Failures by location</h2>
                  <p className="text-xs text-ink-muted">The error class and where in AIQSA it was thrown; messages are never recorded.</p>
                </div>
                <AdminHealthErrorGroups groups={health.errorGroups} truncated={health.errorGroupsTruncated} />
              </section>
              <section aria-labelledby="admin-health-providers-heading" className="min-w-0">
                <div className="mb-2 flex min-w-0 flex-col gap-0.5">
                  <h2 className={headingClass} id="admin-health-providers-heading">Provider reliability</h2>
                  <p className="text-xs text-ink-muted">Finished calls per connection, model and stage; cancelled calls are not counted.</p>
                </div>
                <AdminHealthProviders rows={health.providers} truncated={health.providersTruncated} />
              </section>
            </>
          )}
        </>
      )}

      {controller.error === "forbidden" || controller.error === "unauthorized" ? null : (
        <section aria-labelledby="admin-health-queues-heading" className="min-w-0">
          <div className="mb-2 flex min-w-0 flex-col gap-0.5">
            <h2 className={headingClass} id="admin-health-queues-heading">Background queues</h2>
            <p className="text-xs text-ink-muted">Unfinished jobs right now; the oldest counts from when its job became due.</p>
          </div>
          <AdminHealthQueues controller={queues} />
        </section>
      )}

      {controller.error === "forbidden" || controller.error === "unauthorized" ? null : (
        <section aria-labelledby="admin-health-incidents-heading" className="min-w-0">
          <h2 className={`${headingClass} mb-2`} id="admin-health-incidents-heading">Recent incidents</h2>
          <AdminHealthIncidents
            controller={incidents}
            filters={incidentFilters}
            onChangeFilters={setIncidentFilters}
            retentionNote={range === "30d"}
          />
        </section>
      )}
    </div>
  );
}

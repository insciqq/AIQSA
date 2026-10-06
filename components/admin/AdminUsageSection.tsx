"use client";

import { Download } from "lucide-react";
import { useState, type ReactNode } from "react";
import { focusRing, quietButton, touchTarget } from "@/components/admin/adminPrimitives";
import { useAdminSectionTopbar } from "@/components/admin/AdminShell";
import { cardClass, compactSelectClass, sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import { adminUsageErrorMessage, adminUsageExportHref } from "@/components/admin/usage/adminUsageApi";
import { UsageByModel, UsageBySource } from "@/components/admin/usage/UsageBreakdowns";
import { UsageGroupsTable, UsageUsersTable } from "@/components/admin/usage/UsagePeopleTables";
import { UsageSpendChart } from "@/components/admin/usage/UsageSpendChart";
import {
  browserTimeZone,
  formatBucketDate,
  formatCount,
  formatUsageDelta,
  USAGE_PERIOD_LABELS,
  type UsageChartMetric
} from "@/components/admin/usage/usageFormat";
import { useAdminUsageAnalytics } from "@/components/admin/usage/useAdminUsageAnalytics";
import {
  ADMIN_USAGE_PERIODS,
  DEFAULT_ADMIN_USAGE_PERIOD,
  isAdminUsagePeriod,
  type AdminUsageAnalytics,
  type AdminUsagePeriod
} from "@/lib/contracts/adminUsageAnalytics";
import { costCoverageNote, formatEstimatedCostMicros } from "@/lib/domain/formatEstimatedCost";

const topbar = { title: "Usage" };

export type AdminUsageSectionProps = Readonly<{
  /** Raw `?filter=` value of the section; anything but a known period means the default. */
  period: string | null;
  onPeriodChange(period: AdminUsagePeriod): void;
}>;

function windowRange(usage: AdminUsageAnalytics): string {
  const { from, timeZone, to } = usage.window;
  // `to` is exclusive: name the last included day.
  const last = formatBucketDate(new Date(Date.parse(to) - 1).toISOString(), timeZone, "day", true);
  return from ? `${formatBucketDate(from, timeZone, "day", true)} – ${last}` : `Until ${last}`;
}

function KpiTile({ delta, label, note, testId, value }: Readonly<{
  delta: string;
  label: string;
  note?: ReactNode;
  testId: string;
  value: ReactNode;
}>) {
  return (
    <div className="min-w-0 rounded-[12px] border border-trace-subtle bg-answer-paper px-4 py-3.5" data-testid={testId}>
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd className="mt-1.5 min-w-0">
        <span className="block break-words text-xl font-semibold text-ink [overflow-wrap:anywhere] sm:text-2xl">{value}</span>
        {note ? <span className="mt-0.5 block text-xs leading-5 text-ink-muted">{note}</span> : null}
        <span className="mt-1.5 block text-xs leading-5 text-ink-secondary" data-testid={`${testId}-delta`}>{delta}</span>
      </dd>
    </div>
  );
}

function UsageKpis({ usage }: Readonly<{ usage: AdminUsageAnalytics }>) {
  const { previous, totals, window } = usage;
  const coverage = costCoverageNote(totals.knownCostRecordCount, totals.recordCount);
  const costNote = coverage ?? (totals.recordCount > 0 && totals.knownCostRecordCount === 0 ? "prices unknown for this usage" : null);
  return (
    <dl aria-label="Usage summary" className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiTile
        delta={formatUsageDelta(totals.estimatedCostMicros, previous?.estimatedCostMicros ?? null, window, previous)}
        label="Estimated cost"
        note={costNote}
        testId="usage-kpi-cost"
        value={formatEstimatedCostMicros(totals.estimatedCostMicros)}
      />
      <KpiTile
        delta={formatUsageDelta(totals.totalTokens, previous?.totalTokens ?? null, window, previous)}
        label="Tokens"
        testId="usage-kpi-tokens"
        value={formatCount(totals.totalTokens)}
      />
      <KpiTile
        delta={formatUsageDelta(totals.runCount, previous?.runCount ?? null, window, previous)}
        label="Runs"
        testId="usage-kpi-runs"
        value={formatCount(totals.runCount)}
      />
      <KpiTile
        delta={formatUsageDelta(totals.activeUserCount, previous?.activeUserCount ?? null, window, previous)}
        label="Active users"
        testId="usage-kpi-users"
        value={<>{formatCount(totals.activeUserCount)}<span className="text-sm font-normal text-ink-secondary"> of {formatCount(usage.userCount)} users</span></>}
      />
    </dl>
  );
}

function MetricToggle({ metric, onChange }: Readonly<{ metric: UsageChartMetric; onChange(metric: UsageChartMetric): void }>) {
  const option = (value: UsageChartMetric, label: string) => (
    <button
      aria-pressed={metric === value}
      className={`min-h-control-sm rounded-[8px] px-3 text-xs font-medium ${focusRing} ${touchTarget} ${
        metric === value ? "bg-answer-paper text-ink shadow-sm" : "text-ink-secondary hover:text-ink"
      }`}
      onClick={() => onChange(value)}
      type="button"
    >
      {label}
    </button>
  );
  return (
    <div aria-label="Chart metric" className="inline-flex shrink-0 gap-0.5 rounded-control bg-control-surface p-0.5" role="group">
      {option("cost", "Cost")}
      {option("tokens", "Tokens")}
    </div>
  );
}

function SpendOverTime({ usage }: Readonly<{ usage: AdminUsageAnalytics }>) {
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
  const empty = usage.totals.recordCount === 0;
  const metricEmpty = !empty && usage.series.every((point) => Object.values(point.categories).every((value) =>
    (metric === "cost" ? value.estimatedCostMicros : value.totalTokens) === 0));
  return (
    <section aria-label="Spend over time" className={`${cardClass} min-w-0 p-4 sm:p-5`} data-testid="admin-usage-spend">
      <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className={sectionHeadingClass}>Spend over time</h3>
          <p className="mt-1 text-xs text-ink-muted">
            {metric === "cost" ? "Known estimated cost" : "Provider-reported tokens"} per {usage.window.bucket} by source.
          </p>
        </div>
        <MetricToggle metric={metric} onChange={setMetric} />
      </div>
      {empty ? (
        <div className="py-12 text-center" role="status">
          <p className="text-sm font-semibold text-ink-secondary">No usage in this period</p>
          <p className="mt-1 text-sm text-ink-muted">Choose a longer period to see earlier usage.</p>
        </div>
      ) : metricEmpty ? (
        <div className="py-12 text-center" role="status">
          <p className="text-sm font-semibold text-ink-secondary">No known cost in this period</p>
          <p className="mt-1 text-sm text-ink-muted">Prices are unknown for this usage. Switch to Tokens to see it.</p>
        </div>
      ) : (
        <UsageSpendChart bucket={usage.window.bucket} metric={metric} series={usage.series} timeZone={usage.window.timeZone} />
      )}
    </section>
  );
}

function UsageSkeleton() {
  const block = "rounded-[12px] border border-trace-subtle bg-control-surface/60";
  return (
    <div aria-busy="true" data-testid="admin-usage-loading">
      <p className="sr-only" role="status">Loading usage</p>
      <div aria-hidden="true" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((tile) => <div className={`${block} h-[104px]`} key={tile} />)}
      </div>
      <div aria-hidden="true" className={`${block} mt-6 h-[320px]`} />
    </div>
  );
}

function UsageContent({ usage }: Readonly<{ usage: AdminUsageAnalytics }>) {
  return (
    <>
      <UsageKpis usage={usage} />
      <div className="mt-6"><SpendOverTime usage={usage} /></div>
      <div className="mt-8 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-2">
        <UsageByModel usage={usage} />
        <UsageBySource usage={usage} />
      </div>
      <div className="mt-9 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-9">
        <UsageUsersTable usage={usage} />
        <UsageGroupsTable usage={usage} />
      </div>
      <div className="mt-8 max-w-5xl text-xs leading-5 text-ink-muted">
        <p className="font-medium text-ink-secondary">How to read these numbers</p>
        <p className="mt-1">
          Amounts are estimates from provider-reported usage, including usage kept after a failure or cancellation.
          Usage with unknown prices is left out of cost and counted in tokens. Group totals follow current membership,
          so a user in several groups counts in each and group sums can overlap. Days and months follow the
          {" "}{usage.window.timeZone} time zone.
        </p>
      </div>
    </>
  );
}

export function AdminUsageSection({ onPeriodChange, period: requestedPeriod }: AdminUsageSectionProps) {
  useAdminSectionTopbar(topbar);
  const [timeZone] = useState(browserTimeZone);
  const period = isAdminUsagePeriod(requestedPeriod) ? requestedPeriod : DEFAULT_ADMIN_USAGE_PERIOD;
  const { data, error, pending, retry } = useAdminUsageAnalytics(period, timeZone);
  const updating = pending && data !== null;

  return (
    <div className="max-w-[1440px] min-w-0 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-5 flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-end gap-3">
          <label className="w-48 min-w-0 max-w-full">
            <span className="block text-xs font-medium text-ink-secondary">Period</span>
            <select
              className={`${compactSelectClass} mt-1`}
              onChange={(event) => {
                if (isAdminUsagePeriod(event.currentTarget.value)) onPeriodChange(event.currentTarget.value);
              }}
              value={period}
            >
              {ADMIN_USAGE_PERIODS.map((value) => <option key={value} value={value}>{USAGE_PERIOD_LABELS[value]}</option>)}
            </select>
          </label>
          {data && !error ? (
            <p className="pb-1.5 text-xs text-ink-muted" data-testid="admin-usage-window">
              {updating ? <span role="status">Updating…</span> : windowRange(data)}
            </p>
          ) : null}
        </div>
        <a className={`${quietButton} no-underline`} download href={adminUsageExportHref(period, timeZone)}>
          <Download aria-hidden="true" className="size-3.5" />
          Download CSV
        </a>
      </div>

      {error ? (
        <div className={`${cardClass} px-4 py-8 text-center`} role="alert">
          <p className="text-sm font-semibold text-ink-secondary">Usage could not be loaded</p>
          <p className="mx-auto mt-1 max-w-xl text-sm text-ink-muted">{adminUsageErrorMessage(error)}</p>
          <button className={`${quietButton} mt-4`} onClick={retry} type="button">Retry</button>
        </div>
      ) : data ? (
        <div
          aria-busy={updating || undefined}
          className={`min-w-0 transition-opacity motion-reduce:transition-none ${updating ? "opacity-60" : ""}`}
          data-testid="admin-usage-content"
        >
          <UsageContent usage={data} />
        </div>
      ) : (
        <UsageSkeleton />
      )}
    </div>
  );
}

"use client";

import { AdminTableRegion } from "@/components/admin/adminPrimitives";
import { cardClass } from "@/components/admin/roles/rolesControls";
import type {
  AdminUsageAmounts,
  AdminUsageAnalytics,
  AdminUsageSystemModelRecord
} from "@/lib/contracts/adminUsageAnalytics";
import { BreakdownRow, categoryRecord } from "./UsageBreakdowns";
import {
  formatCount,
  systemPurposeList,
  unknownCostCount,
  usageShare,
  usageShareBasis,
  USAGE_SYSTEM_PURPOSE_LABELS,
  type UsageShareBasis
} from "./usageFormat";
import { ShareCell, UsageBlockHeading, UsageCost } from "./usageParts";

const subheadingClass = "text-xs font-semibold text-ink-secondary";

function requests(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "request" : "requests"}`;
}

function facts(row: AdminUsageAmounts): string {
  const unknown = unknownCostCount(row);
  return [`${formatCount(row.totalTokens)} tokens`, requests(row.recordCount), unknown > 0 ? `${formatCount(unknown)} with unknown cost` : null]
    .filter((part): part is string => part !== null).join(" · ");
}

function shareDetail(basis: UsageShareBasis): string {
  return `Share of system ${basis === "cost" ? "estimated cost" : "tokens"} in this period.`;
}

function SystemFunctions({ basis, usage, whole }: Readonly<{ basis: UsageShareBasis; usage: AdminUsageAnalytics; whole: AdminUsageAmounts }>) {
  return (
    <div aria-label="System by function" className="min-w-0" data-testid="admin-usage-system-functions" role="group">
      <h4 className={subheadingClass}>By function</h4>
      <p className="mt-0.5 text-xs leading-5 text-ink-muted">{shareDetail(basis)}</p>
      <ul className="divide-y divide-trace-subtle">
        {usage.bySystemFunction.map((row) => (
          <BreakdownRow
            basis={basis}
            detail={facts(row)}
            key={row.purpose}
            label={USAGE_SYSTEM_PURPOSE_LABELS[row.purpose]}
            row={row}
            whole={whole}
          />
        ))}
      </ul>
    </div>
  );
}

function modelKey(row: AdminUsageSystemModelRecord): string {
  return `${row.provider}\u0000${row.modelId}`;
}

function SystemModels({ basis, usage, whole }: Readonly<{ basis: UsageShareBasis; usage: AdminUsageAnalytics; whole: AdminUsageAmounts }>) {
  const rows = usage.bySystemModel;
  return (
    <div aria-label="System by model" className="min-w-0" data-testid="admin-usage-system-models" role="group">
      <h4 className={subheadingClass}>By model</h4>
      <p className="mt-0.5 text-xs leading-5 text-ink-muted">Models that did this work and the functions they served.</p>
      <ul className="divide-y divide-trace-subtle lg:hidden" data-testid="admin-usage-system-models-mobile">
        {rows.map((row) => (
          <BreakdownRow
            basis={basis}
            detail={<><span className="block text-ink-secondary">{systemPurposeList(row.purposes)}</span>{facts(row)}</>}
            key={modelKey(row)}
            label={row.label}
            row={row}
            title={row.modelId}
            whole={whole}
          />
        ))}
      </ul>
      <div className={`${cardClass} mt-3 hidden lg:block`}>
        <AdminTableRegion label="System model usage table">
          <table className="w-full min-w-[460px] border-collapse text-left text-xs">
            <thead className="bg-control-surface/45 text-ink-muted">
              <tr className="border-b border-trace-subtle">
                <th className="px-3 py-2 font-medium" scope="col">Model</th>
                <th className="px-3 py-2 font-medium" scope="col">Functions</th>
                <th className="w-36 px-3 py-2 font-medium" scope="col">Estimated cost</th>
                <th className="px-3 py-2 text-right font-medium" scope="col">Tokens</th>
                <th className="px-3 py-2 text-right font-medium" scope="col">Requests</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr className="border-b border-trace-subtle align-top last:border-b-0" key={modelKey(row)}>
                  <td className="break-words px-3 py-3 font-medium text-ink [overflow-wrap:anywhere]" title={row.modelId}>{row.label}</td>
                  <td className="break-words px-3 py-3 text-ink-secondary [overflow-wrap:anywhere]">{systemPurposeList(row.purposes)}</td>
                  <td className="px-3 py-3 text-ink">
                    <UsageCost usage={row} />
                    <ShareCell share={usageShare(row, whole, basis)} />
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-ink">{formatCount(row.totalTokens)}</td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-ink-secondary">{formatCount(row.recordCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AdminTableRegion>
      </div>
    </div>
  );
}

/**
 * System spend apart from what people's own models cost: by system function
 * and by the model that served it. Shares are of the System total.
 */
export function UsageSystemPanel({ usage }: Readonly<{ usage: AdminUsageAnalytics }>) {
  const whole = categoryRecord(usage.byCategory, "system");
  const basis = usageShareBasis(whole);
  return (
    <section aria-label="System" className="min-w-0" data-testid="admin-usage-system">
      <UsageBlockHeading
        detail="Work done by system models rather than the models people chose: chat titles and summaries, image and PDF reading, Skill selection, Memory, Knowledge and model checks."
        title="System"
      />
      {whole.recordCount === 0 ? (
        <p className="py-6 text-sm text-ink-muted">No system usage in this period.</p>
      ) : (
        <div className="mt-4 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-7 xl:grid-cols-2">
          <SystemFunctions basis={basis} usage={usage} whole={whole} />
          <SystemModels basis={basis} usage={usage} whole={whole} />
        </div>
      )}
    </section>
  );
}

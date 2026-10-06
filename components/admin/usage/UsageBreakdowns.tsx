"use client";

import type {
  AdminUsageAmounts,
  AdminUsageAnalytics,
  AdminUsageCategoryRecord,
  AdminUsageModelRecord
} from "@/lib/contracts/adminUsageAnalytics";
import { formatCount, shareOf, sumUsageAmounts, USAGE_CATEGORY_META, USAGE_CATEGORY_ORDER } from "./usageFormat";
import { ShareCell, UsageBlockHeading, UsageCost } from "./usageParts";

export const TOP_MODEL_ROWS = 8;

/** Shares follow known cost when the period has any, otherwise tokens. */
export type UsageShareBasis = "cost" | "tokens";

export function usageShareBasis(totals: AdminUsageAmounts): UsageShareBasis {
  return (totals.estimatedCostMicros ?? 0) > 0 ? "cost" : "tokens";
}

export function usageShare(row: AdminUsageAmounts, totals: AdminUsageAmounts, basis: UsageShareBasis): number {
  return basis === "cost"
    ? shareOf(row.estimatedCostMicros, totals.estimatedCostMicros)
    : shareOf(row.totalTokens, totals.totalTokens);
}

function rankModels(rows: readonly AdminUsageModelRecord[]): AdminUsageModelRecord[] {
  return [...rows].sort((left, right) =>
    (right.estimatedCostMicros ?? -1) - (left.estimatedCostMicros ?? -1) ||
    (right.totalTokens ?? -1) - (left.totalTokens ?? -1) ||
    left.label.localeCompare(right.label));
}

type ModelRow = AdminUsageAmounts & Readonly<{ key: string; label: string; modelId: string | null; userCount: number | null }>;

export function foldModelRows(rows: readonly AdminUsageModelRecord[]): ModelRow[] {
  const ranked = rankModels(rows);
  const top: ModelRow[] = ranked.slice(0, TOP_MODEL_ROWS).map((row) => ({
    ...row, key: `${row.provider}\u0000${row.modelId}`
  }));
  const rest = ranked.slice(TOP_MODEL_ROWS);
  if (!rest.length) return top;
  return [...top, {
    ...sumUsageAmounts(rest),
    key: "other",
    label: `Other models (${rest.length})`,
    modelId: null,
    // Distinct users cannot be summed across models.
    userCount: null
  }];
}

function BreakdownRow({
  basis,
  color,
  detail,
  label,
  row,
  title,
  totals
}: Readonly<{
  basis: UsageShareBasis;
  color?: string;
  detail: string;
  label: string;
  row: AdminUsageAmounts;
  title?: string;
  totals: AdminUsageAmounts;
}>) {
  return (
    <li className="min-w-0 py-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          {color ? (
            <span aria-hidden="true" className="mt-1 size-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />
          ) : null}
          <div className="min-w-0">
            <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]" title={title}>{label}</p>
            <p className="mt-0.5 text-xs leading-5 text-ink-muted">{detail}</p>
          </div>
        </div>
        <div className="shrink-0 text-right text-sm text-ink"><UsageCost usage={row} /></div>
      </div>
      <ShareCell color={color} share={usageShare(row, totals, basis)} />
    </li>
  );
}

function tokensLine(row: AdminUsageAmounts): string {
  return row.recordCount === 0 ? "no usage in this period" : `${formatCount(row.totalTokens)} tokens`;
}

export function UsageByModel({ usage }: Readonly<{ usage: AdminUsageAnalytics }>) {
  const basis = usageShareBasis(usage.totals);
  const rows = foldModelRows(usage.byModel);
  return (
    <section aria-label="By model" className="min-w-0" data-testid="admin-usage-by-model">
      <UsageBlockHeading
        detail={`Share of ${basis === "cost" ? "estimated cost" : "tokens"} in this period.`}
        title="By model"
      />
      {rows.length ? (
        <ul className="divide-y divide-trace-subtle">
          {rows.map((row) => (
            <BreakdownRow
              basis={basis}
              detail={row.userCount === null
                ? tokensLine(row)
                : `${tokensLine(row)} · ${formatCount(row.userCount)} ${row.userCount === 1 ? "user" : "users"}`}
              key={row.key}
              label={row.label}
              row={row}
              title={row.modelId ?? undefined}
              totals={usage.totals}
            />
          ))}
        </ul>
      ) : (
        <p className="py-6 text-sm text-ink-muted">No model usage in this period.</p>
      )}
    </section>
  );
}

function categoryRecord(rows: readonly AdminUsageCategoryRecord[], category: AdminUsageCategoryRecord["category"]): AdminUsageCategoryRecord {
  return rows.find((row) => row.category === category) ?? { ...sumUsageAmounts([]), category };
}

export function UsageBySource({ usage }: Readonly<{ usage: AdminUsageAnalytics }>) {
  const basis = usageShareBasis(usage.totals);
  return (
    <section aria-label="By source" className="min-w-0" data-testid="admin-usage-by-source">
      <UsageBlockHeading
        detail={`Share of ${basis === "cost" ? "estimated cost" : "tokens"} in this period.`}
        title="By source"
      />
      <ul className="divide-y divide-trace-subtle">
        {USAGE_CATEGORY_ORDER.map((category) => {
          const row = categoryRecord(usage.byCategory, category);
          const meta = USAGE_CATEGORY_META[category];
          return (
            <BreakdownRow
              basis={basis}
              color={meta.color}
              detail={`${meta.meaning} · ${tokensLine(row)}`}
              key={category}
              label={meta.label}
              row={row}
              totals={usage.totals}
            />
          );
        })}
      </ul>
    </section>
  );
}

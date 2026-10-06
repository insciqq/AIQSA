"use client";

import { costCoverageNote, formatEstimatedCostMicros } from "@/lib/domain/formatEstimatedCost";
import type { AdminUsageAmounts } from "@/lib/contracts/adminUsageAnalytics";
import type { ReactNode } from "react";
import { sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import { formatShare } from "./usageFormat";

/** Known estimate plus how much of the usage it covers. */
export function UsageCost({ usage }: Readonly<{ usage: Pick<AdminUsageAmounts, "estimatedCostMicros" | "knownCostRecordCount" | "recordCount"> }>) {
  const note = costCoverageNote(usage.knownCostRecordCount, usage.recordCount);
  return (
    <>
      <span className="font-mono tabular-nums">{formatEstimatedCostMicros(usage.estimatedCostMicros)}</span>
      {note ? <span className="mt-0.5 block font-sans text-xs font-normal text-ink-muted">{note}</span> : null}
    </>
  );
}

/** Horizontal share of a whole; the percentage is always printed beside it. */
export function ShareBar({ color, share }: Readonly<{ color?: string; share: number }>) {
  return (
    <span aria-hidden="true" className="block h-1.5 w-full min-w-0 overflow-hidden rounded-full bg-control-surface">
      <span
        className={`block h-full rounded-full ${color ? "" : "bg-ink-muted"}`}
        style={{ width: `${Math.round(Math.min(1, Math.max(0, share)) * 1000) / 10}%`, ...(color ? { background: color } : {}) }}
      />
    </span>
  );
}

export function ShareCell({ color, share }: Readonly<{ color?: string; share: number }>) {
  return (
    <span className="mt-1.5 flex min-w-0 items-center gap-2">
      <ShareBar color={color} share={share} />
      <span className="w-9 shrink-0 text-right font-mono text-xs tabular-nums text-ink-muted">{formatShare(share)}</span>
    </span>
  );
}

export function UsageBlockHeading({ detail, title, trailing }: Readonly<{ detail?: ReactNode; title: string; trailing?: ReactNode }>) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-b border-trace-subtle pb-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h3 className={sectionHeadingClass}>{title}</h3>
        {detail ? <p className="mt-1 text-xs leading-5 text-ink-muted">{detail}</p> : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
}

export function MobileFacts({ facts }: Readonly<{ facts: readonly Readonly<{ label: string; value: ReactNode }>[] }>) {
  return (
    <dl className="mt-3 grid min-w-0 grid-cols-2 gap-x-4 gap-y-3">
      {facts.map((fact) => (
        <div className="min-w-0" key={fact.label}>
          <dt className="text-xs font-medium text-ink-muted">{fact.label}</dt>
          <dd className="mt-1 break-words text-xs text-ink-secondary [overflow-wrap:anywhere]">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

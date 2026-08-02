import type {
  FactualRunReceipt,
  RunReceiptSegmentKind
} from "@/components/app-shell/runReceiptModel";
import { memo } from "react";

const statusClass: Record<FactualRunReceipt["status"], string> = {
  cancelled: "text-ink-secondary",
  complete: "text-positive",
  error: "text-critical",
  running: "text-proof"
};

const dotClass: Record<FactualRunReceipt["status"], string> = {
  cancelled: "bg-ink-muted",
  complete: "bg-positive",
  error: "bg-critical",
  running: "bg-proof"
};

function RunReceiptComponent({
  actionableSegments,
  contained = false,
  disclosureSegments = new Set(),
  expandedSegments = new Set(),
  onActivate,
  receipt,
  settled = false
}: Readonly<{
  actionableSegments: ReadonlySet<RunReceiptSegmentKind>;
  contained?: boolean;
  disclosureSegments?: ReadonlySet<RunReceiptSegmentKind>;
  expandedSegments?: ReadonlySet<RunReceiptSegmentKind>;
  onActivate(kind: RunReceiptSegmentKind): void;
  receipt: FactualRunReceipt;
  settled?: boolean;
}>) {
  return (
    <footer
      className={
        contained
          ? "text-xs leading-5 text-ink-muted"
          : "mt-5 border-t border-trace-subtle pt-3 text-xs leading-5 text-ink-muted"
      }
      data-run-receipt-status={receipt.status}
      data-run-settled={settled ? "true" : undefined}
      data-testid="run-receipt"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {actionableSegments.has("status") ? (
          <button
            aria-label={`Run ${receipt.statusLabel}`}
            className="-mx-1 inline-flex min-h-7 items-center gap-1.5 rounded-control px-1 font-medium outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-proof/45 [@media(hover:none)]:min-h-touch [@media(pointer:coarse)]:min-h-touch"
            data-run-segment="status"
            type="button"
            onClick={() => onActivate("status")}
          >
            <span className={`size-1.5 rounded-full ${dotClass[receipt.status]}`} aria-hidden="true" />
            <span>Run{" "}</span>
            <span className={statusClass[receipt.status]}>{receipt.statusLabel}</span>
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5 font-medium" data-run-segment="status">
            <span className={`size-1.5 rounded-full ${dotClass[receipt.status]}`} aria-hidden="true" />
            <span>Run{" "}</span>
            <span className={statusClass[receipt.status]}>{receipt.statusLabel}</span>
          </span>
        )}
        {receipt.facts.map((fact) => (
          <span className="inline-flex min-w-0 items-baseline gap-2" data-run-fact={fact.kind} key={fact.kind}>
            <span aria-hidden="true">{" · "}</span>
            {actionableSegments.has(fact.kind) ? (
              <button
                className="-mx-1 min-h-7 min-w-0 rounded-control px-1 text-left text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-proof/45 [overflow-wrap:anywhere] [@media(hover:none)]:min-h-touch [@media(pointer:coarse)]:min-h-touch"
                data-run-segment={fact.kind}
                type="button"
                aria-label={fact.label}
                aria-expanded={disclosureSegments.has(fact.kind) ? expandedSegments.has(fact.kind) : undefined}
                onClick={() => onActivate(fact.kind)}
              >
                <span>{fact.label}</span>
                {fact.detail ? <span className="text-ink-muted">{" · "}{fact.detail}</span> : null}
              </button>
            ) : (
              <span
                className="min-w-0 text-ink-secondary [overflow-wrap:anywhere]"
                data-run-segment={fact.kind}
              >
                {fact.label}
                {fact.detail ? <span className="text-ink-muted">{" · "}{fact.detail}</span> : null}
              </span>
            )}
          </span>
        ))}
      </div>
    </footer>
  );
}

export const RunReceipt = memo(RunReceiptComponent);

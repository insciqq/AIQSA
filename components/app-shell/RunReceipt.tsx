import type { FactualRunReceipt } from "@/components/app-shell/runReceipt";
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
  receipt,
  settled = false
}: Readonly<{
  receipt: FactualRunReceipt;
  settled?: boolean;
}>) {
  return (
    <footer
      className="mt-5 border-t border-trace-subtle pt-3 text-xs leading-5 text-ink-muted"
      data-run-receipt-status={receipt.status}
      data-run-settled={settled ? "true" : undefined}
      data-testid="run-receipt"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <span className={`size-1.5 rounded-full ${dotClass[receipt.status]}`} aria-hidden="true" />
          <span>Run{" "}</span>
          <span className={statusClass[receipt.status]}>{receipt.statusLabel}</span>
        </span>
        {receipt.facts.map((fact) => (
          <span className="inline-flex min-w-0 items-baseline gap-2" data-run-fact={fact.kind} key={fact.kind}>
            <span aria-hidden="true">{" · "}</span>
            <span className="break-words text-ink-secondary [overflow-wrap:anywhere]">{fact.label}</span>
          </span>
        ))}
      </div>
    </footer>
  );
}

export const RunReceipt = memo(RunReceiptComponent);

import {
  memoryReceiptItemTypeLabel,
  memoryReceiptLifecycleLabel,
  memoryReceiptScopeLabel,
  memoryReceiptSourceModeLabel,
  memoryUiCopy
} from "@/components/app-shell/memoryUiCopy";
import type { RunReceiptFact } from "@/components/app-shell/runReceiptModel";
import type {
  MemoryActionFeedback,
  MemoryReceipt,
  MemoryUiLocale
} from "@/lib/contracts/memory";
import { Brain, Check, ChevronDown, ChevronRight } from "lucide-react";

export function visibleMemoryReceipt(receipt: MemoryReceipt | null | undefined): boolean {
  return Boolean(
    receipt && receipt.items.length > 0 &&
    (receipt.outcome === "USED" || receipt.outcome === "DEGRADED")
  );
}

export function memoryReceiptFact(
  receipt: MemoryReceipt,
  locale: MemoryUiLocale
): RunReceiptFact {
  const label = receipt.itemCount === 1
    ? memoryUiCopy(locale, "receipt.usedOne")
    : `${memoryUiCopy(locale, "receipt.usedMany")}: ${receipt.itemCount}`;
  return {
    ...(receipt.outcome === "DEGRADED"
      ? { detail: memoryUiCopy(locale, "receipt.degraded") }
      : {}),
    kind: "memory",
    label
  };
}

function outcomeLabel(receipt: MemoryReceipt, locale: MemoryUiLocale): string {
  const used = receipt.itemCount === 1
    ? memoryUiCopy(locale, "receipt.usedOne")
    : `${memoryUiCopy(locale, "receipt.usedMany")}: ${receipt.itemCount}`;
  return receipt.outcome === "DEGRADED"
    ? `${used} · ${memoryUiCopy(locale, "receipt.degraded")}`
    : used;
}

export function MemoryEvidenceBlock({
  expanded,
  locale,
  onExpandedChange,
  onOpenSourceChat,
  receipt
}: Readonly<{
  expanded: boolean;
  locale: MemoryUiLocale;
  onExpandedChange(expanded: boolean): void;
  onOpenSourceChat?(chatId: string): void;
  receipt: MemoryReceipt;
}>) {
  return (
    <section
      aria-label={memoryUiCopy(locale, "receipt.label")}
      className="mt-2 border-t border-trace-subtle pt-2 text-xs text-ink-secondary"
      data-testid="thread-memory-evidence"
    >
      <button
        aria-expanded={expanded}
        aria-label={`${memoryUiCopy(locale, "receipt.label")}. ${outcomeLabel(receipt, locale)}`}
        className="-mx-2 flex min-h-control w-[calc(100%+1rem)] items-center gap-2 rounded-control px-2 text-left outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus [@media(hover:none)]:min-h-touch [@media(pointer:coarse)]:min-h-touch"
        type="button"
        onClick={() => onExpandedChange(!expanded)}
      >
        {expanded
          ? <ChevronDown className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
          : <ChevronRight className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />}
        <Brain className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
        <span className="font-semibold text-ink">{memoryUiCopy(locale, "receipt.label")}</span>
        <span className="min-w-0 truncate text-ink-muted">{outcomeLabel(receipt, locale)}</span>
      </button>
      {expanded ? (
        <div className="mt-2 border-b border-trace-subtle pb-3" data-testid="thread-memory-details">
          <dl className="grid gap-x-4 gap-y-2 px-2 py-3 sm:grid-cols-2">
            <div>
              <dt className="text-ink-muted">{memoryUiCopy(locale, "receipt.outcome")}</dt>
              <dd className="font-medium text-ink">{outcomeLabel(receipt, locale)}</dd>
            </div>
            {receipt.degradationCode ? (
              <div>
                <dt className="text-ink-muted">{memoryUiCopy(locale, "receipt.degraded")}</dt>
                <dd className="break-words font-mono text-ink [overflow-wrap:anywhere]">
                  {receipt.degradationCode}
                </dd>
              </div>
            ) : null}
          </dl>
          <ol className="divide-y divide-trace-subtle border-t border-trace-subtle">
            {receipt.items.map((item) => (
              <li className="grid gap-3 px-2 py-4" key={`${item.ordinal}:${item.versionId ?? item.itemType}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">{item.ordinal + 1}</span>
                  <span className="rounded-control bg-control-surface px-2 py-0.5 text-metadata font-medium text-ink-secondary">
                    {memoryReceiptItemTypeLabel(locale, item.itemType)}
                  </span>
                  {item.lifecycleState !== "CURRENT" ? (
                    <span className="rounded-control bg-caution/[0.10] px-2 py-0.5 text-metadata font-semibold text-caution">
                      {memoryReceiptLifecycleLabel(locale, item.lifecycleState)}
                    </span>
                  ) : null}
                </div>
                <div>
                  <div className="text-metadata font-semibold uppercase tracking-wide text-ink-muted">
                    {memoryUiCopy(locale, "receipt.exactText")}
                  </div>
                  <pre className="mt-1 max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-control bg-control-surface p-3 font-sans text-xs leading-5 text-ink [overflow-wrap:anywhere]">
                    {item.includedText}
                  </pre>
                </div>
                <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                  <div>
                    <dt className="text-ink-muted">{memoryUiCopy(locale, "receipt.type")}</dt>
                    <dd className="text-ink">{memoryReceiptItemTypeLabel(locale, item.itemType)}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">{memoryUiCopy(locale, "receipt.source")}</dt>
                    <dd className="text-ink">
                      {memoryReceiptSourceModeLabel(locale, item.sourceMode)}
                      {item.lifecycleState === "SOURCE_DELETED" ? (
                        <> · {memoryReceiptLifecycleLabel(locale, "SOURCE_DELETED")}</>
                      ) : item.sourceChatId && onOpenSourceChat ? (
                        <button
                          className="ml-1 rounded-control font-semibold text-proof outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                          type="button"
                          onClick={() => onOpenSourceChat(item.sourceChatId!)}
                        >
                          {item.sourceMessageIds.length > 0
                            ? `${memoryUiCopy(locale, "receipt.source")} · ${item.sourceMessageIds.length}`
                            : memoryUiCopy(locale, "receipt.source")}
                        </button>
                      ) : null}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">{memoryUiCopy(locale, "receipt.scope")}</dt>
                    <dd className="text-ink">
                      {item.scopeType
                        ? memoryReceiptScopeLabel(locale, item.scopeType)
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">{memoryUiCopy(locale, "receipt.version")}</dt>
                    <dd className="break-words font-mono text-ink [overflow-wrap:anywhere]">
                      {item.versionId ?? "—"}
                    </dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-ink-muted">{memoryUiCopy(locale, "receipt.selection")}</dt>
                    <dd className="break-words font-mono text-ink [overflow-wrap:anywhere]">
                      {item.selectionReason}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

export function MemoryActionConfirmation({
  action,
  locale
}: Readonly<{ action: MemoryActionFeedback; locale: MemoryUiLocale }>) {
  const copyKey = action.operation === "SAVE"
    ? "action.saved"
    : action.operation === "UPDATE" ? "action.updated" : "action.forgotten";
  return (
    <div
      aria-live="polite"
      className="mt-4 flex items-center gap-2 border-l-2 border-positive/45 bg-positive/[0.05] px-3 py-2 text-xs font-medium text-ink-secondary"
      data-memory-action={action.operation.toLowerCase()}
      data-testid="memory-action-confirmation"
      role="status"
    >
      <Check className="size-3.5 shrink-0 text-positive" aria-hidden="true" />
      <span>{memoryUiCopy(locale, copyKey)}</span>
    </div>
  );
}

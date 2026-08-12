import {
  memoryReceiptItemTypeLabel,
  memoryReceiptLifecycleLabel,
  memoryReceiptScopeLabel,
  memoryReceiptSourceModeLabel,
  memoryReceiptUsageLabel,
  memoryUiCopy
} from "@/components/app-shell/memoryUiCopy";
import {
  authorizeMemoryMutation,
  forgetMemory,
  memoryRequestId,
  memoryStatementHash,
  recordMemoryFeedback,
  undoForgetMemory,
  updateMemory
} from "@/components/app-shell/memoryApi";
import type { RunReceiptFact } from "@/components/app-shell/runReceiptModel";
import type {
  MemoryActionFeedback,
  MemoryReceipt,
  MemoryUiLocale
} from "@/lib/contracts/memory";
import { memoryPresentationIsRussian } from "@/lib/contracts/memoryPresentation";
import { Brain, Check, ChevronDown, ChevronRight, Pencil, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";

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
  const label = memoryReceiptUsageLabel(locale, receipt);
  return {
    ...(receipt.outcome === "DEGRADED"
      ? { detail: memoryUiCopy(locale, "receipt.degraded") }
      : {}),
    kind: "memory",
    label
  };
}

function outcomeLabel(receipt: MemoryReceipt, locale: MemoryUiLocale): string {
  const used = memoryReceiptUsageLabel(locale, receipt);
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
  const [feedbackState, setFeedbackState] = useState<Record<number, "AVAILABLE" | "ERROR" | "PENDING" | "RECORDED" | "UNDO_ERROR">>(() =>
    Object.fromEntries(receipt.items.map((item) => [
      item.ordinal,
      item.feedbackState === "RECORDED" ? "RECORDED" : "AVAILABLE"
    ])));
  const [feedbackUndo, setFeedbackUndo] = useState<Record<number, string>>({});
  const ru = memoryPresentationIsRussian(locale);

  const markIncorrect = async (item: MemoryReceipt["items"][number]) => {
    if (!item.factId || !item.versionId || !item.runId || !item.runItemId) return;
    setFeedbackState((current) => ({ ...current, [item.ordinal]: "PENDING" }));
    try {
      const response = await recordMemoryFeedback(item.factId, {
        expectedVersionId: item.versionId,
        feedbackType: "INCORRECT",
        modelRunId: item.runId,
        modelRunMemoryItemId: item.runItemId,
        requestId: memoryRequestId()
      });
      setFeedbackUndo((current) => ({
        ...current,
        [item.ordinal]: response.feedbackId
      }));
      setFeedbackState((current) => ({ ...current, [item.ordinal]: "RECORDED" }));
    } catch {
      setFeedbackState((current) => ({ ...current, [item.ordinal]: "ERROR" }));
    }
  };

  const undoIncorrect = async (item: MemoryReceipt["items"][number]) => {
    const feedbackId = feedbackUndo[item.ordinal];
    if (!feedbackId || !item.factId || !item.versionId) return;
    setFeedbackState((current) => ({ ...current, [item.ordinal]: "PENDING" }));
    try {
      await recordMemoryFeedback(item.factId, {
        expectedVersionId: item.versionId,
        feedbackType: "RETRACT",
        modelRunId: item.runId ?? undefined,
        modelRunMemoryItemId: item.runItemId ?? undefined,
        requestId: memoryRequestId(),
        retractsFeedbackId: feedbackId
      });
      setFeedbackUndo((current) => {
        const next = { ...current };
        delete next[item.ordinal];
        return next;
      });
      setFeedbackState((current) => ({ ...current, [item.ordinal]: "AVAILABLE" }));
    } catch {
      setFeedbackState((current) => ({ ...current, [item.ordinal]: "UNDO_ERROR" }));
    }
  };

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
                {item.itemType === "FACT_VERSION" && item.sourceMode === "AUTOMATIC" &&
                item.lifecycleState === "CURRENT" && item.feedbackState !== "UNAVAILABLE" &&
                item.factId && item.versionId && item.runId && item.runItemId ? (
                  <div className="flex flex-wrap items-center gap-2 border-t border-trace-subtle pt-3">
                    {feedbackState[item.ordinal] === "RECORDED" ||
                    feedbackState[item.ordinal] === "UNDO_ERROR" ? (
                      <span className="inline-flex flex-wrap items-center gap-2" role="status">
                        <span className="inline-flex items-center gap-1.5 font-medium text-positive">
                          <Check className="size-3.5" aria-hidden="true" />
                          {ru ? "Отмечено как неверное" : "Marked incorrect"}
                        </span>
                        {feedbackUndo[item.ordinal] ? (
                          <button
                            className="min-h-control rounded-control px-2 font-semibold text-proof outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus [@media(pointer:coarse)]:min-h-touch"
                            type="button"
                            onClick={() => void undoIncorrect(item)}
                          >
                            {ru ? "Отменить" : "Undo"}
                          </button>
                        ) : null}
                      </span>
                    ) : (
                      <button
                        className="min-h-control rounded-control px-2 font-semibold text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60 [@media(pointer:coarse)]:min-h-touch"
                        disabled={feedbackState[item.ordinal] === "PENDING"}
                        type="button"
                        onClick={() => void markIncorrect(item)}
                      >
                        {feedbackState[item.ordinal] === "PENDING"
                          ? (ru ? "Сохраняем…" : "Saving…")
                          : (ru ? "Это неверно" : "This is incorrect")}
                      </button>
                    )}
                    {feedbackState[item.ordinal] === "ERROR" ||
                    feedbackState[item.ordinal] === "UNDO_ERROR" ? (
                      <span className="text-critical" role="alert">
                        {feedbackState[item.ordinal] === "UNDO_ERROR"
                          ? (ru ? "Не удалось отменить отметку." : "Could not undo feedback.")
                          : (ru ? "Не удалось сохранить отметку." : "Could not save feedback.")}
                      </span>
                    ) : null}
                  </div>
                ) : null}
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
  const [state, setState] = useState<"CHANGED" | "ERROR" | "IDLE" | "PENDING" | "REMOVED" | "RESTORED">("IDLE");
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState(() => action.factId && action.versionId && action.statement
    ? { factId: action.factId, statement: action.statement, versionId: action.versionId }
    : null);
  const [draft, setDraft] = useState(action.statement ?? "");
  const [forgetUndo, setForgetUndo] = useState(() =>
    action.operation === "FORGET" && action.deletionId && action.expiresAt
      ? { deletionId: action.deletionId, expiresAt: action.expiresAt }
      : null);
  const [expiredForgetDeletionId, setExpiredForgetDeletionId] = useState<string | null>(null);
  useEffect(() => {
    if (!forgetUndo) return;
    const remaining = Date.parse(forgetUndo.expiresAt) - Date.now();
    const delay = Number.isFinite(remaining)
      ? Math.min(Math.max(remaining, 0), 2_147_483_647)
      : 0;
    const deletionId = forgetUndo.deletionId;
    const timer = window.setTimeout(() => setExpiredForgetDeletionId(deletionId), delay);
    return () => window.clearTimeout(timer);
  }, [forgetUndo]);
  const copyKey = action.operation === "SAVE"
    ? "action.saved"
    : action.operation === "UPDATE"
      ? "action.updated"
      : action.operation === "MARK_INCORRECT"
        ? "action.markedIncorrect"
        : "action.forgotten";
  const pending = state === "PENDING";
  const undoOpen = Boolean(
    forgetUndo && expiredForgetDeletionId !== forgetUndo.deletionId
  );
  const canEdit = Boolean(
    target && (action.operation === "SAVE" || action.operation === "UPDATE") &&
    state !== "REMOVED"
  );
  const canUndoSave = Boolean(
    target && action.operation === "SAVE" && state !== "REMOVED"
  );

  const restoreForgotten = async () => {
    if (!target || !forgetUndo || !undoOpen) return;
    setState("PENDING");
    try {
      const authorization = await authorizeMemoryMutation({
        action: "SAVE",
        exactStatementHash: await memoryStatementHash(target.statement)
      });
      const response = await undoForgetMemory(target.factId, {
        deletionId: forgetUndo.deletionId,
        mutationAuthorizationId: authorization.mutationAuthorizationId
      });
      if (!response.memory.currentVersionId || !response.memory.displayText) {
        throw new Error("memory_response_invalid");
      }
      setTarget({
        factId: response.memory.id,
        statement: response.memory.displayText,
        versionId: response.memory.currentVersionId
      });
      setDraft(response.memory.displayText);
      setForgetUndo(null);
      setState("RESTORED");
    } catch {
      setState("ERROR");
    }
  };

  const undoSaved = async () => {
    if (!target) return;
    setState("PENDING");
    try {
      const authorization = await authorizeMemoryMutation({
        action: "FORGET",
        expectedTargetVersionId: target.versionId,
        targetFactId: target.factId
      });
      const response = await forgetMemory(target.factId, {
        expectedVersionId: target.versionId,
        mutationAuthorizationId: authorization.mutationAuthorizationId
      });
      setForgetUndo({
        deletionId: response.undo.deletionId,
        expiresAt: response.undo.expiresAt
      });
      setState("REMOVED");
    } catch {
      setState("ERROR");
    }
  };

  const saveEdit = async () => {
    if (!target) return;
    const statement = draft.trim();
    if (!statement || statement === target.statement) {
      setDraft(target.statement);
      setEditing(false);
      return;
    }
    setState("PENDING");
    try {
      const authorization = await authorizeMemoryMutation({
        action: "EDIT",
        expectedTargetVersionId: target.versionId,
        targetFactId: target.factId
      });
      const response = await updateMemory(target.factId, {
        expectedVersionId: target.versionId,
        mutationAuthorizationId: authorization.mutationAuthorizationId,
        statement
      });
      if (!response.memory.currentVersionId || !response.memory.displayText) {
        throw new Error("memory_response_invalid");
      }
      setTarget({
        factId: response.memory.id,
        statement: response.memory.displayText,
        versionId: response.memory.currentVersionId
      });
      setDraft(response.memory.displayText);
      setEditing(false);
      setState("CHANGED");
    } catch {
      setState("ERROR");
    }
  };

  const statusText = state === "PENDING"
    ? memoryUiCopy(locale, "action.working")
    : state === "REMOVED"
      ? memoryUiCopy(locale, "action.removed")
      : state === "RESTORED"
        ? memoryUiCopy(locale, "action.restored")
        : state === "CHANGED"
          ? memoryUiCopy(locale, "action.changed")
          : state === "ERROR"
            ? memoryUiCopy(locale, "action.changeFailed")
            : memoryUiCopy(locale, copyKey);
  return (
    <div
      aria-live="polite"
      className="mt-4 flex items-start gap-2 border-l-2 border-positive/45 bg-positive/[0.05] px-3 py-2 text-xs font-medium text-ink-secondary"
      data-memory-action={action.operation.toLowerCase()}
      data-testid="memory-action-confirmation"
      role="status"
    >
      <Check className="mt-0.5 size-3.5 shrink-0 text-positive" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className={state === "ERROR" ? "text-critical" : undefined}>{statusText}</div>
        {target && action.operation !== "FORGET" && state !== "REMOVED" ? (
          <div className="mt-1 break-words text-ink" data-testid="memory-action-statement">
            “{target.statement}”
          </div>
        ) : null}
        {editing && target ? (
          <form
            className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start"
            onSubmit={(event) => {
              event.preventDefault();
              void saveEdit();
            }}
          >
            <label className="sr-only" htmlFor={`memory-action-edit-${target.factId}`}>
              {memoryUiCopy(locale, "action.edit")}
            </label>
            <textarea
              autoFocus
              className="min-h-20 flex-1 resize-y rounded-control border border-trace bg-control-surface px-2 py-1.5 text-sm font-normal text-ink outline-none focus-visible:ring-2 focus-visible:ring-focus"
              disabled={pending}
              id={`memory-action-edit-${target.factId}`}
              maxLength={2_000}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="flex gap-1">
              <button
                className="min-h-control rounded-control bg-proof px-2 font-semibold text-proof-contrast outline-none focus-visible:ring-2 focus-visible:ring-focus"
                disabled={pending || !draft.trim()}
                type="submit"
              >
                {memoryUiCopy(locale, "action.saveEdit")}
              </button>
              <button
                className="min-h-control rounded-control px-2 font-semibold text-ink-secondary outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus"
                disabled={pending}
                type="button"
                onClick={() => {
                  setDraft(target.statement);
                  setEditing(false);
                }}
              >
                {memoryUiCopy(locale, "action.cancelEdit")}
              </button>
            </div>
          </form>
        ) : null}
        {!editing && (canEdit || canUndoSave || undoOpen || state === "REMOVED") ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {canEdit ? (
              <button
                className="inline-flex min-h-control items-center gap-1 rounded-control px-2 font-semibold text-proof outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus"
                disabled={pending}
                type="button"
                onClick={() => {
                  setDraft(target!.statement);
                  setEditing(true);
                }}
              >
                <Pencil className="size-3" aria-hidden="true" />
                {memoryUiCopy(locale, "action.edit")}
              </button>
            ) : null}
            {canUndoSave ? (
              <button
                className="inline-flex min-h-control items-center gap-1 rounded-control px-2 font-semibold text-proof outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus"
                disabled={pending}
                type="button"
                onClick={() => void undoSaved()}
              >
                <Undo2 className="size-3" aria-hidden="true" />
                {memoryUiCopy(locale, "action.undo")}
              </button>
            ) : null}
            {undoOpen && (action.operation === "FORGET" || state === "REMOVED") ? (
              <button
                className="inline-flex min-h-control items-center gap-1 rounded-control px-2 font-semibold text-proof outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus"
                disabled={pending}
                type="button"
                onClick={() => void restoreForgotten()}
              >
                <Undo2 className="size-3" aria-hidden="true" />
                {state === "REMOVED"
                  ? memoryUiCopy(locale, "action.restore")
                  : memoryUiCopy(locale, "action.undo")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

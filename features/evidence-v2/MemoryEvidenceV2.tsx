"use client";

import {
  authorizeMemoryMutation,
  forgetMemory,
  memoryRequestId,
  memoryStatementHash,
  recordMemoryFeedback,
  undoForgetMemory,
  updateMemory
} from "@/components/app-shell/memoryApi";
import {
  memoryReceiptItemTypeLabel,
  memoryReceiptLifecycleLabel,
  memoryReceiptScopeLabel,
  memoryReceiptSourceModeLabel,
  memoryReceiptUsageLabel,
  memoryUiCopy
} from "@/components/app-shell/memoryUiCopy";
import { UiV2Button, UiV2Chip, UiV2Icon } from "@/components/ui-v2";
import type {
  MemoryActionFeedback,
  MemoryReceipt,
  MemoryUiLocale
} from "@/lib/contracts/memory";
import { memoryPresentationIsRussian } from "@/lib/contracts/memoryPresentation";
import { useEffect, useState } from "react";

type FeedbackState = "AVAILABLE" | "ERROR" | "PENDING" | "RECORDED" | "UNDO_ERROR";

export function visibleMemoryReceiptV2(
  receipt: MemoryReceipt | null | undefined
): receipt is MemoryReceipt {
  return Boolean(
    receipt &&
    receipt.items.length > 0 &&
    (receipt.outcome === "USED" || receipt.outcome === "DEGRADED")
  );
}

function outcomeLabel(receipt: MemoryReceipt, locale: MemoryUiLocale): string {
  const used = memoryReceiptUsageLabel(locale, receipt);
  return receipt.outcome === "DEGRADED"
    ? `${used} · ${memoryUiCopy(locale, "receipt.degraded")}`
    : used;
}

export function MemoryEvidenceV2({
  locale,
  onOpenSourceChat,
  receipt
}: Readonly<{
  locale: MemoryUiLocale;
  onOpenSourceChat?(chatId: string): void;
  receipt: MemoryReceipt;
}>) {
  const [open, setOpen] = useState(false);
  const [feedbackState, setFeedbackState] = useState<Record<number, FeedbackState>>(() =>
    Object.fromEntries(receipt.items.map((item) => [
      item.ordinal,
      item.feedbackState === "RECORDED" ? "RECORDED" : "AVAILABLE"
    ]))
  );
  const [feedbackUndo, setFeedbackUndo] = useState<Record<number, string>>({});
  if (!visibleMemoryReceiptV2(receipt)) return null;

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
      className="v2-evidence-disclosure"
      data-testid="thread-memory-evidence"
    >
      <button
        aria-expanded={open}
        aria-label={`${memoryUiCopy(locale, "receipt.label")}. ${outcomeLabel(receipt, locale)}`}
        className="v2-evidence-disclosure-trigger"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <UiV2Icon name={open ? "chevron-down" : "chevron-right"} />
        <UiV2Icon name="memory" />
        <strong>{memoryUiCopy(locale, "receipt.label")}</strong>
        <span>{outcomeLabel(receipt, locale)}</span>
        <span className="v2-evidence-disclosure-count">{receipt.items.length}</span>
      </button>
      {open ? (
        <div className="v2-evidence-disclosure-body" data-testid="thread-memory-details">
          {receipt.degradationCode ? (
            <p className="v2-evidence-warning">
              {memoryUiCopy(locale, "receipt.degraded")}: {receipt.degradationCode}
            </p>
          ) : null}
          <ol className="v2-memory-receipt-list">
            {receipt.items.map((item) => {
              const state = feedbackState[item.ordinal] ?? "AVAILABLE";
              const canReview = item.itemType === "FACT_VERSION" &&
                item.sourceMode === "AUTOMATIC" &&
                item.lifecycleState === "CURRENT" &&
                item.feedbackState !== "UNAVAILABLE" &&
                Boolean(item.factId && item.versionId && item.runId && item.runItemId);
              return (
                <li key={`${item.ordinal}:${item.versionId ?? item.itemType}`}>
                  <header>
                    <strong>{item.ordinal + 1}. {memoryReceiptItemTypeLabel(locale, item.itemType)}</strong>
                    {item.lifecycleState !== "CURRENT" ? (
                      <UiV2Chip tone="warn">
                        {memoryReceiptLifecycleLabel(locale, item.lifecycleState)}
                      </UiV2Chip>
                    ) : null}
                  </header>
                  <p className="v2-memory-receipt-label">{memoryUiCopy(locale, "receipt.exactText")}</p>
                  <pre className="v2-memory-receipt-text">{item.includedText}</pre>
                  <dl className="v2-memory-receipt-facts">
                    <div>
                      <dt>{memoryUiCopy(locale, "receipt.source")}</dt>
                      <dd>
                        {memoryReceiptSourceModeLabel(locale, item.sourceMode)}
                        {item.lifecycleState === "SOURCE_DELETED" ? (
                          <> · {memoryReceiptLifecycleLabel(locale, "SOURCE_DELETED")}</>
                        ) : item.sourceChatId && onOpenSourceChat ? (
                          <button type="button" onClick={() => onOpenSourceChat(item.sourceChatId!)}>
                            {memoryUiCopy(locale, "receipt.source")} · {item.sourceMessageIds.length}
                          </button>
                        ) : null}
                      </dd>
                    </div>
                    <div>
                      <dt>{memoryUiCopy(locale, "receipt.scope")}</dt>
                      <dd>{item.scopeType ? memoryReceiptScopeLabel(locale, item.scopeType) : "—"}</dd>
                    </div>
                    <div>
                      <dt>{memoryUiCopy(locale, "receipt.version")}</dt>
                      <dd><code>{item.versionId ?? "—"}</code></dd>
                    </div>
                    <div>
                      <dt>{memoryUiCopy(locale, "receipt.selection")}</dt>
                      <dd><code>{item.selectionReason}</code></dd>
                    </div>
                  </dl>
                  {canReview ? (
                    <div className="v2-memory-receipt-actions">
                      {state === "RECORDED" || state === "UNDO_ERROR" ? (
                        <>
                          <span role="status"><UiV2Icon name="check" />
                            {memoryPresentationIsRussian(locale)
                              ? "Отмечено как неверное"
                              : "Marked incorrect"}
                          </span>
                          {feedbackUndo[item.ordinal] ? (
                            <UiV2Button
                              onClick={() => void undoIncorrect(item)}
                            >
                              {memoryPresentationIsRussian(locale) ? "Отменить" : "Undo"}
                            </UiV2Button>
                          ) : null}
                        </>
                      ) : (
                        <UiV2Button
                          busy={state === "PENDING"}
                          onClick={() => void markIncorrect(item)}
                        >
                          {memoryPresentationIsRussian(locale) ? "Это неверно" : "This is incorrect"}
                        </UiV2Button>
                      )}
                      {state === "ERROR" || state === "UNDO_ERROR" ? (
                        <span className="v2-memory-receipt-error" role="alert">
                          {state === "UNDO_ERROR"
                            ? (memoryPresentationIsRussian(locale)
                                ? "Не удалось отменить отметку."
                                : "Could not undo feedback.")
                            : (memoryPresentationIsRussian(locale)
                                ? "Не удалось сохранить отметку."
                                : "Could not save feedback.")}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

type MutationState = "CHANGED" | "ERROR" | "IDLE" | "PENDING" | "REMOVED" | "RESTORED";

export function MemoryActionConfirmationV2({
  action,
  locale
}: Readonly<{ action: MemoryActionFeedback; locale: MemoryUiLocale }>) {
  const [state, setState] = useState<MutationState>("IDLE");
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
  const undoOpen = Boolean(forgetUndo && expiredForgetDeletionId !== forgetUndo.deletionId);
  const canEdit = Boolean(
    target &&
    (action.operation === "SAVE" || action.operation === "UPDATE") &&
    state !== "REMOVED"
  );
  const canUndoSave = Boolean(target && action.operation === "SAVE" && state !== "REMOVED");

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
    <section
      aria-live="polite"
      className="v2-memory-action-confirmation"
      data-memory-action={action.operation.toLowerCase()}
      data-testid="memory-action-confirmation"
      role="status"
    >
      <UiV2Icon name="check" />
      <div>
        <p className={state === "ERROR" ? "v2-memory-action-error" : undefined}>
          {statusText}
        </p>
        {target && action.operation !== "FORGET" && state !== "REMOVED" ? (
          <blockquote data-testid="memory-action-statement">“{target.statement}”</blockquote>
        ) : null}
        {editing && target ? (
          <form onSubmit={(event) => {
            event.preventDefault();
            void saveEdit();
          }}>
            <label htmlFor={`v2-memory-action-edit-${target.factId}`}>
              {memoryUiCopy(locale, "action.edit")}
            </label>
            <textarea
              autoFocus
              disabled={pending}
              id={`v2-memory-action-edit-${target.factId}`}
              maxLength={2_000}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="v2-memory-action-buttons">
              <UiV2Button busy={pending} disabled={!draft.trim()} tone="primary" type="submit">
                {memoryUiCopy(locale, "action.saveEdit")}
              </UiV2Button>
              <UiV2Button disabled={pending} type="button" onClick={() => {
                setDraft(target.statement);
                setEditing(false);
              }}>
                {memoryUiCopy(locale, "action.cancelEdit")}
              </UiV2Button>
            </div>
          </form>
        ) : null}
        {!editing && (canEdit || canUndoSave || undoOpen || state === "REMOVED") ? (
          <div className="v2-memory-action-buttons">
            {canEdit ? (
              <UiV2Button icon="edit" disabled={pending} onClick={() => {
                setDraft(target!.statement);
                setEditing(true);
              }}>
                {memoryUiCopy(locale, "action.edit")}
              </UiV2Button>
            ) : null}
            {canUndoSave ? (
              <UiV2Button disabled={pending} onClick={() => void undoSaved()}>
                {memoryUiCopy(locale, "action.undo")}
              </UiV2Button>
            ) : null}
            {undoOpen && (action.operation === "FORGET" || state === "REMOVED") ? (
              <UiV2Button disabled={pending} onClick={() => void restoreForgotten()}>
                {state === "REMOVED"
                  ? memoryUiCopy(locale, "action.restore")
                  : memoryUiCopy(locale, "action.undo")}
              </UiV2Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

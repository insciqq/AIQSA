"use client";

import {
  authorizeMemoryMutation,
  forgetMemory,
  memoryStatementHash,
  undoForgetMemory,
  updateMemory
} from "@/components/app-shell/memoryApi";
import { memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import type { MemoryActionFeedback } from "@/lib/contracts/memory";
import { useEffect, useState } from "react";

type MutationState = "CHANGED" | "ERROR" | "IDLE" | "PENDING" | "REMOVED" | "RESTORED";

export function MemoryActionConfirmationV2({
  action
}: Readonly<{ action: MemoryActionFeedback }>) {
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
    ? memoryUiCopy("action.working")
    : state === "REMOVED"
      ? memoryUiCopy("action.removed")
      : state === "RESTORED"
        ? memoryUiCopy("action.restored")
        : state === "CHANGED"
          ? memoryUiCopy("action.changed")
          : state === "ERROR"
            ? memoryUiCopy("action.changeFailed")
            : memoryUiCopy(copyKey);

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
              {memoryUiCopy("action.edit")}
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
                {memoryUiCopy("action.saveEdit")}
              </UiV2Button>
              <UiV2Button disabled={pending} type="button" onClick={() => {
                setDraft(target.statement);
                setEditing(false);
              }}>
                {memoryUiCopy("action.cancelEdit")}
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
                {memoryUiCopy("action.edit")}
              </UiV2Button>
            ) : null}
            {canUndoSave ? (
              <UiV2Button disabled={pending} onClick={() => void undoSaved()}>
                {memoryUiCopy("action.undo")}
              </UiV2Button>
            ) : null}
            {undoOpen && (action.operation === "FORGET" || state === "REMOVED") ? (
              <UiV2Button disabled={pending} onClick={() => void restoreForgotten()}>
                {state === "REMOVED"
                  ? memoryUiCopy("action.restore")
                  : memoryUiCopy("action.undo")}
              </UiV2Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

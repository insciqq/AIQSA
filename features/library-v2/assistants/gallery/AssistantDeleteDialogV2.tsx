"use client";

import type { AssistantDeleteDialogView } from "@/components/assistants/libraryViewContracts";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { useId } from "react";
import { createPortal } from "react-dom";
import { assistantDeletionConsequenceLines } from "./assistantDetailCopy";
import "../assistants.css";

/**
 * Deleting names its target and lists what it changes before the owner
 * confirms (FRONTEND: destructive actions name targets and consequences).
 * The list comes from the server at the version the delete is sent with; a
 * changed Assistant reloads it and asks again.
 */
export function AssistantDeleteDialogV2({ view }: Readonly<{ view: AssistantDeleteDialogView }>) {
  const titleId = useId();
  const deleting = view.state === "deleting";
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({
    closeBlocked: deleting,
    onClose: view.onCancel
  });
  if (!portalReady) return null;
  const lines = view.consequences ? assistantDeletionConsequenceLines(view.consequences) : [];
  return createPortal(
    <div className="v2-assistants-dialog-layer" data-testid="assistant-delete-dialog" role="presentation">
      <button
        aria-label="Dismiss"
        className="v2-assistants-dialog-scrim"
        disabled={deleting}
        tabIndex={-1}
        type="button"
        onClick={view.onCancel}
      />
      <section
        aria-busy={view.state === "loading" || deleting || undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className="v2-assistants-dialog"
        ref={dialogRef as React.RefObject<HTMLElement>}
        role="dialog"
        onKeyDown={onDialogKeyDown}
      >
        <header className="v2-assistants-dialog-head">
          <span aria-hidden="true" className="v2-assistants-dialog-icon"><UiV2Icon name="trash" /></span>
          <h2 id={titleId}>Delete “{view.name}”?</h2>
        </header>
        <p>Deleting can&apos;t be undone. Past answers keep their text.</p>
        {view.error ? <p className="v2-assistants-dialog-error" role="alert">{view.error}</p> : null}
        {view.state === "loading" ? (
          <p className="v2-assistants-dialog-loading" role="status">
            <span aria-hidden="true" className="v2-spinner" />
            Checking what deleting it changes…
          </p>
        ) : view.consequences ? (
          <>
            <p className="v2-assistants-dialog-label">What changes:</p>
            <ul className="v2-assistants-dialog-consequences">
              {lines.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </>
        ) : null}
        <footer className="v2-assistants-dialog-actions">
          {view.state === "error" ? (
            <UiV2Button icon="regenerate" onClick={view.onRetry}>Retry</UiV2Button>
          ) : null}
          <UiV2Button disabled={deleting} ref={initialFocusRef} onClick={view.onCancel}>Cancel</UiV2Button>
          <UiV2Button
            busy={deleting}
            disabled={view.state !== "ready" || !view.consequences}
            icon="trash"
            tone="destructive"
            onClick={view.onConfirm}
          >
            Delete
          </UiV2Button>
        </footer>
      </section>
    </div>,
    document.body
  );
}

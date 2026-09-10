"use client";

import { CodeEditor } from "@/components/admin/CodeEditor";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { validateJsonParameters, type JsonValidation } from "./modelJsonEditor";

export function ModelJsonDialog({
  example = "{}",
  modelLabel,
  onApply,
  onClose,
  providerLabel,
  value
}: Readonly<{
  example?: string;
  modelLabel: string;
  onApply(text: string): void;
  onClose(): void;
  providerLabel: string;
  value: string;
}>) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<Extract<JsonValidation, { ok: false }> | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const exampleId = useId();
  const errorId = useId();
  const lineCount = draft.split("\n").length;
  const requestClose = () => {
    if (draft !== value) setDiscarding(true);
    else onClose();
  };
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({ closeBlocked: discarding, onClose: requestClose });

  const validate = () => {
    const result = validateJsonParameters(draft);
    if (result.ok) {
      setError(null);
      return true;
    }
    setError(result);
    const node = textareaRef.current;
    node?.focus();
    node?.setSelectionRange(result.offset, result.offset);
    return false;
  };

  if (!portalReady) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center sm:p-4" data-testid="model-json-dialog">
      <button aria-label="Dismiss JSON editor" className="absolute inset-0 bg-scrim/70" disabled={discarding} onClick={requestClose} tabIndex={-1} type="button" />
      <section
        aria-describedby={exampleId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="relative flex h-[100dvh] min-h-0 w-full min-w-0 flex-col overflow-hidden bg-answer-paper text-ink sm:h-[min(90dvh,56rem)] sm:w-[94vw] sm:max-w-[80rem] sm:rounded-panel sm:border sm:border-trace-strong"
        onKeyDown={onDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-trace-subtle px-4 pb-3 pt-[max(.75rem,env(safe-area-inset-top))] sm:px-6">
          <div className="min-w-0">
            <h2 className="text-base font-semibold" id={titleId}>Default parameters · JSON</h2>
            <p className="mt-1 max-h-16 overflow-y-auto break-words text-xs text-ink-muted [overflow-wrap:anywhere]">
              {modelLabel || "New model"} · {providerLabel}
            </p>
          </div>
          <UiV2IconButton disabled={discarding} icon="close" label="Close JSON editor" onClick={requestClose} ref={initialFocusRef} />
        </header>
        <div className="shrink-0 border-b border-trace-subtle px-4 py-2 text-xs text-ink-secondary sm:px-6" id={exampleId}>
          <p>Enter one JSON object of generation defaults. Supported options depend on the model and provider.</p>
          <p className="mt-1 text-ink-muted">Example only; not applied automatically:</p>
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-ink" data-testid="model-json-example">{example}</pre>
        </div>
        <CodeEditor
          describedBy={`${exampleId}${error ? ` ${errorId}` : ""}`}
          helpText="Changes apply to the model form."
          invalid={Boolean(error)}
          label="Default parameters JSON"
          onChange={setDraft}
          onValidation={setError}
          textareaRef={textareaRef}
          testId="model-json-editor"
          value={draft}
        />
        <footer className="shrink-0 border-t border-trace-subtle px-4 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">
          {error ? <p className="mb-2 max-h-20 overflow-y-auto text-xs text-critical" id={errorId} role="alert">Line {error.line}, column {error.column}: {error.message}</p> : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto text-xs text-ink-muted">{lineCount} {lineCount === 1 ? "line" : "lines"}</span>
            <UiV2Button onClick={requestClose} tone="ghost" type="button">Cancel</UiV2Button>
            <UiV2Button onClick={() => { if (validate()) onApply(draft); }} tone="primary" type="button">Apply to model</UiV2Button>
          </div>
        </footer>
      </section>
      {discarding ? (
        <ConfirmationDialog
          cancelLabel="Keep editing"
          confirmLabel="Discard JSON changes"
          dialogLabel="Discard JSON changes"
          icon="x"
          onCancel={() => setDiscarding(false)}
          onConfirm={onClose}
          restoreFocus={() => textareaRef.current}
          testId="model-json-discard"
          title="Discard JSON changes?"
          tone="warning"
        >
          The model form keeps its previous parameters and other unsaved changes.
        </ConfirmationDialog>
      ) : null}
    </div>,
    document.body
  );
}

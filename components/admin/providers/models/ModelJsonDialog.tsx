"use client";

import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatJsonParameters, indentJsonSelection, jsonTokens, validateJsonParameters, type JsonToken, type JsonValidation } from "./modelJsonEditor";

const tokenColor: Record<JsonToken["kind"], string> = {
  invalid: "text-critical",
  key: "text-proof",
  literal: "text-[var(--v2-color-accent2)]",
  number: "text-caution",
  punctuation: "text-ink-secondary",
  space: "",
  string: "text-positive"
};

export function ModelJsonDialog({
  modelLabel,
  onApply,
  onClose,
  providerLabel,
  value
}: Readonly<{
  modelLabel: string;
  onApply(text: string): void;
  onClose(): void;
  providerLabel: string;
  value: string;
}>) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<Extract<JsonValidation, { ok: false }> | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [tabMovesFocus, setTabMovesFocus] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const codeRef = useRef<HTMLPreElement>(null);
  const numbersRef = useRef<HTMLPreElement>(null);
  const titleId = useId();
  const helpId = useId();
  const errorId = useId();
  const tokens = useMemo(() => jsonTokens(draft), [draft]);
  const lineCount = draft.split("\n").length;
  const requestClose = () => {
    if (draft !== value) setDiscarding(true);
    else onClose();
  };
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({ closeBlocked: discarding, onClose: requestClose });

  const syncScroll = () => {
    const node = textareaRef.current;
    if (!node) return;
    if (codeRef.current) codeRef.current.style.transform = `translate(${-node.scrollLeft}px, ${-node.scrollTop}px)`;
    if (numbersRef.current) numbersRef.current.style.transform = `translateY(${-node.scrollTop}px)`;
  };
  const editRange = (start: number, end: number, replacement: string, selectionStart: number, selectionEnd: number) => {
    const node = textareaRef.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    node.setSelectionRange(start, end);
    // Native insertion keeps typing, indentation and Format in the browser's undo history.
    let inserted = false;
    try {
      inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, replacement);
    } catch {
      // Non-browser renderers may expose the method without implementing editing commands.
    }
    if (!inserted) node.setRangeText(replacement, start, end, "end");
    setDraft(node.value);
    node.setSelectionRange(selectionStart, selectionEnd);
    setError(null);
    syncScroll();
  };
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
        aria-describedby={helpId}
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
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-trace-subtle px-4 py-2 sm:px-6">
          <UiV2Button onClick={() => {
            if (!validate()) return;
            const formatted = formatJsonParameters(draft);
            if (formatted !== draft) editRange(0, draft.length, formatted, 0, 0);
          }} tone="ghost" type="button">Format</UiV2Button>
          <button
            aria-pressed={tabMovesFocus}
            className="min-h-control rounded-control px-2 text-xs text-ink-secondary outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus"
            onClick={() => setTabMovesFocus((current) => !current)}
            type="button"
          >
            Tab: {tabMovesFocus ? "move focus" : "indent"}
          </button>
          <p className="min-w-0 text-xs text-ink-muted" id={helpId}>
            Ctrl+M switches Tab behavior. Shift+Tab outdents. Changes apply to the model form.
          </p>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--v2-color-code-bg)]" data-testid="model-json-editor">
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-14 overflow-hidden border-r border-trace-subtle">
            <pre className="py-3 pr-3 text-right font-mono text-[13px] leading-6 text-ink-muted" ref={numbersRef}>
              {Array.from({ length: lineCount }, (_, index) => index + 1).join("\n")}
            </pre>
          </div>
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-14 right-0 overflow-hidden">
            <pre className="min-h-full min-w-full whitespace-pre px-3 py-3 font-mono text-[13px] leading-6 [tab-size:2]" ref={codeRef}>
              {tokens.map((token) => <span className={tokenColor[token.kind]} key={token.offset}>{token.text}</span>)}{"\n"}
            </pre>
          </div>
          <textarea
            aria-describedby={`${helpId}${error ? ` ${errorId}` : ""}`}
            aria-invalid={Boolean(error)}
            aria-label="Default parameters JSON"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className="absolute inset-y-0 left-14 h-full w-[calc(100%_-_3.5rem)] resize-none overflow-auto overscroll-contain whitespace-pre border-0 bg-transparent px-3 py-3 font-mono text-[13px] leading-6 text-transparent caret-ink outline-none selection:bg-proof/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [tab-size:2] [@media(forced-colors:active)]:text-ink"
            onChange={(event) => { setDraft(event.currentTarget.value); setError(null); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "m") {
                event.preventDefault();
                setTabMovesFocus((current) => !current);
              }
              if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) {
                event.preventDefault();
                const node = event.currentTarget;
                const before = draft.slice(0, node.selectionStart);
                const indent = /^[\t ]*/u.exec(before.slice(before.lastIndexOf("\n") + 1))?.[0] ?? "";
                const opens = /[\[{][\t ]*$/u.test(before);
                const innerIndent = `${indent}${opens ? "  " : ""}`;
                const closes = opens && /^[\t ]*[\]}]/u.test(draft.slice(node.selectionEnd));
                const replacement = `\n${innerIndent}${closes ? `\n${indent}` : ""}`;
                const caret = node.selectionStart + innerIndent.length + 1;
                editRange(node.selectionStart, node.selectionEnd, replacement, caret, caret);
                return;
              }
              if (event.key !== "Tab" || tabMovesFocus || event.ctrlKey || event.metaKey || event.altKey) return;
              event.preventDefault();
              const node = event.currentTarget;
              const edit = indentJsonSelection(draft, node.selectionStart, node.selectionEnd, event.shiftKey);
              editRange(edit.start, edit.end, edit.replacement, edit.selectionStart, edit.selectionEnd);
            }}
            onScroll={syncScroll}
            ref={textareaRef}
            spellCheck={false}
            value={draft}
            wrap="off"
          />
        </div>
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

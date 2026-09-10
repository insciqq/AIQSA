"use client";

import { CodeEditor } from "@/components/admin/CodeEditor";
import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

function ExpandedEditor({ children, disabled, onClose }: { children: ReactNode; disabled: boolean; onClose(): void }) {
  const titleId = useId();
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({ closeBlocked: disabled, onClose });
  if (!portalReady) return null;
  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center sm:p-4">
    <button aria-label="Collapse configuration editor" className="absolute inset-0 bg-scrim/70" disabled={disabled} onClick={onClose} tabIndex={-1} type="button" />
    <section aria-labelledby={titleId} aria-modal="true"
      className="relative flex h-[100dvh] min-h-0 w-full min-w-0 flex-col overflow-hidden bg-answer-paper text-ink sm:h-[min(90dvh,56rem)] sm:w-[94vw] sm:max-w-[80rem] sm:rounded-panel sm:border sm:border-trace-strong"
      onKeyDown={onDialogKeyDown} ref={dialogRef} role="dialog">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-trace-subtle px-4 py-3">
        <h2 className="text-base font-semibold" id={titleId}>MCP configuration</h2>
        <UiV2IconButton disabled={disabled} icon="close" label="Return to configuration form" onClick={onClose} ref={initialFocusRef} />
      </header>
      {children}
      <footer className="flex shrink-0 items-center justify-end border-t border-trace-subtle px-4 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-3">
        <UiV2Button disabled={disabled} onClick={onClose} tone="primary" type="button">Return to form</UiV2Button>
      </footer>
    </section>
  </div>, document.body);
}

export function McpConfigurationEditor({ disabled, error, id, onChange, onError, textareaRef, value }: {
  disabled: boolean;
  error: string | null;
  id: string;
  onChange(value: string): void;
  onError(error: string | null): void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const helpId = useId();
  const errorId = useId();
  const selection = useRef({ start: 0, end: 0, scrollTop: 0, scrollLeft: 0 });
  const restoring = useRef(false);
  const changePresentation = (next: boolean) => {
    const node = textareaRef.current;
    if (node) selection.current = { start: node.selectionStart, end: node.selectionEnd, scrollTop: node.scrollTop, scrollLeft: node.scrollLeft };
    restoring.current = true;
    setExpanded(next);
  };
  useLayoutEffect(() => {
    if (!restoring.current || !textareaRef.current) return;
    const node = textareaRef.current;
    let current = true;
    // Restore after the modal's own focus setup, including development effect replay.
    queueMicrotask(() => {
      if (!current || !node.isConnected || textareaRef.current !== node) return;
      node.focus({ preventScroll: true });
      node.setSelectionRange(selection.current.start, selection.current.end);
      node.scrollTop = selection.current.scrollTop;
      node.scrollLeft = selection.current.scrollLeft;
      node.dispatchEvent(new Event("scroll"));
      restoring.current = false;
    });
    return () => { current = false; };
  }, [expanded, textareaRef]);

  const content = <>
    <CodeEditor allowPlainText className={expanded ? "" : "h-72 flex-none rounded-control border border-trace-strong"}
      describedBy={`${helpId}${error ? ` ${errorId}` : ""}`} disabled={disabled} id={id} invalid={Boolean(error)}
      label="Configuration JSON, URL, or install command" onChange={onChange}
      onValidation={(result) => onError(result ? `Line ${result.line}, column ${result.column}: ${result.message}` : null)}
      placeholder={'{\n  "mcpServers": {\n    "example": { "command": "npx", "args": ["-y", "@example/mcp"] }\n  }\n}\n\nor paste: npx -y @example/mcp@latest'}
      textareaRef={textareaRef} textareaTestId="mcp-configuration-document"
      toolbar={!expanded ? <UiV2Button aria-label="Expand configuration editor" className="ml-auto" disabled={disabled} onClick={() => changePresentation(true)} tone="ghost" type="button">Expand</UiV2Button> : undefined}
      value={value} />
    <div className={`shrink-0 text-xs leading-5 text-ink-muted ${expanded ? "px-4 py-2" : "mt-2"}`}>
      <p id={helpId}>Paste JSON, a URL, or an install command. Format changes JSON only. Trailing commas are accepted on Parse. Nothing is saved until you review the settings.</p>
      {error ? <p className="mt-2 max-h-24 overflow-auto text-critical" id={errorId} role="alert">{error}</p> : null}
    </div>
  </>;
  return expanded ? <ExpandedEditor disabled={disabled} onClose={() => changePresentation(false)}>{content}</ExpandedEditor> : content;
}

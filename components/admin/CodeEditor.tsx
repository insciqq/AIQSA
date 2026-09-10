"use client";

import { UiV2Button } from "@/components/ui-v2";
import { useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { formatJsonParameters, indentJsonSelection, jsonTokens, validateJsonParameters, type JsonToken, type JsonValidation } from "./providers/models/modelJsonEditor";

const tokenColor: Record<JsonToken["kind"], string> = {
  invalid: "text-critical", key: "text-proof", literal: "text-[var(--v2-color-accent2)]",
  number: "text-caution", punctuation: "text-ink-secondary", space: "", string: "text-positive"
};

export type CodeEditorError = Extract<JsonValidation, { ok: false }>;

/** Controlled text; instruction examples and modal presentation never become its value. */
export function CodeEditor({
  allowPlainText = false, className = "", describedBy, disabled = false, helpText, id, invalid = false,
  label, onChange, onValidation, placeholder, textareaRef, textareaTestId, testId, toolbar, value
}: Readonly<{
  allowPlainText?: boolean;
  className?: string;
  describedBy?: string;
  disabled?: boolean;
  helpText?: string;
  id?: string;
  invalid?: boolean;
  label: string;
  onChange(value: string): void;
  onValidation(error: CodeEditorError | null): void;
  placeholder?: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  textareaTestId?: string;
  testId?: string;
  toolbar?: ReactNode;
  value: string;
}>) {
  const [tabMovesFocus, setTabMovesFocus] = useState(false);
  const codeRef = useRef<HTMLPreElement>(null);
  const numbersRef = useRef<HTMLPreElement>(null);
  const helpId = useId();
  const json = !allowPlainText || /^[\s]*[\[{]/u.test(value);
  const tokens = useMemo(() => json ? jsonTokens(value) : [], [json, value]);
  const lineCount = value.split("\n").length;
  const syncScroll = () => {
    const node = textareaRef.current;
    if (!node) return;
    if (codeRef.current) codeRef.current.style.transform = `translate(${-node.scrollLeft}px, ${-node.scrollTop}px)`;
    if (numbersRef.current) numbersRef.current.style.transform = `translateY(${-node.scrollTop}px)`;
  };
  const editRange = (start: number, end: number, replacement: string, selectionStart: number, selectionEnd: number) => {
    const node = textareaRef.current;
    if (!node || disabled) return;
    node.focus({ preventScroll: true });
    node.setSelectionRange(start, end);
    let inserted = false;
    try {
      inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, replacement);
    } catch {
      // Non-browser renderers may expose this without native editing support.
    }
    if (!inserted) node.setRangeText(replacement, start, end, "end");
    onChange(node.value);
    node.setSelectionRange(selectionStart, selectionEnd);
    onValidation(null);
    syncScroll();
  };

  return <div className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${className}`}>
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-trace-subtle px-4 py-2 sm:px-6">
      <UiV2Button disabled={disabled || !json} onClick={() => {
        const result = validateJsonParameters(value, allowPlainText ? "Configuration" : "Default parameters");
        if (!result.ok) {
          onValidation(result);
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(result.offset, result.offset);
          return;
        }
        onValidation(null);
        const formatted = formatJsonParameters(value);
        if (formatted !== value) editRange(0, value.length, formatted, 0, 0);
      }} tone="ghost" type="button">Format</UiV2Button>
      <button aria-pressed={tabMovesFocus}
        className="min-h-control rounded-control px-2 text-xs text-ink-secondary outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus"
        disabled={disabled} onClick={() => setTabMovesFocus((current) => !current)} type="button">
        Tab: {tabMovesFocus ? "move focus" : "indent"}
      </button>
      {toolbar}
      <p className="min-w-0 text-xs text-ink-muted" id={helpId}>
        Ctrl+M switches Tab behavior. Shift+Tab outdents.{helpText ? ` ${helpText}` : ""}
      </p>
    </div>
    <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--v2-color-code-bg)]" data-testid={testId}>
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-14 overflow-hidden border-r border-trace-subtle">
        <pre className="py-3 pr-3 text-right font-mono text-[13px] leading-6 text-ink-muted" ref={numbersRef}>
          {Array.from({ length: lineCount }, (_, index) => index + 1).join("\n")}
        </pre>
      </div>
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-14 right-0 overflow-hidden">
        <pre className="min-h-full min-w-full whitespace-pre px-3 py-3 font-mono text-[13px] leading-6 text-ink [tab-size:2]" ref={codeRef}>
          {json ? tokens.map((token) => <span className={tokenColor[token.kind]} key={token.offset}>{token.text}</span>) : value}{"\n"}
        </pre>
      </div>
      <textarea aria-describedby={`${helpId}${describedBy ? ` ${describedBy}` : ""}`} aria-invalid={invalid}
        aria-label={label} autoCapitalize="off" autoComplete="off" autoCorrect="off"
        className="absolute inset-y-0 left-14 h-full w-[calc(100%_-_3.5rem)] resize-none overflow-auto overscroll-contain whitespace-pre border-0 bg-transparent px-3 py-3 font-mono text-[13px] leading-6 text-transparent caret-ink outline-none placeholder:text-ink-muted selection:bg-proof/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [tab-size:2] [@media(forced-colors:active)]:text-ink"
        data-testid={textareaTestId} disabled={disabled} id={id} onChange={(event) => { onChange(event.currentTarget.value); onValidation(null); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || disabled) return;
          if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "m") {
            event.preventDefault();
            setTabMovesFocus((current) => !current);
          }
          if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            const node = event.currentTarget;
            const before = value.slice(0, node.selectionStart);
            const indent = /^[\t ]*/u.exec(before.slice(before.lastIndexOf("\n") + 1))?.[0] ?? "";
            const opens = json && /[\[{][\t ]*$/u.test(before);
            const innerIndent = `${indent}${opens ? "  " : ""}`;
            const closes = opens && /^[\t ]*[\]}]/u.test(value.slice(node.selectionEnd));
            const replacement = `\n${innerIndent}${closes ? `\n${indent}` : ""}`;
            const caret = node.selectionStart + innerIndent.length + 1;
            editRange(node.selectionStart, node.selectionEnd, replacement, caret, caret);
            return;
          }
          if (event.key !== "Tab" || tabMovesFocus || event.ctrlKey || event.metaKey || event.altKey) return;
          event.preventDefault();
          const node = event.currentTarget;
          const edit = indentJsonSelection(value, node.selectionStart, node.selectionEnd, event.shiftKey);
          editRange(edit.start, edit.end, edit.replacement, edit.selectionStart, edit.selectionEnd);
        }} onScroll={syncScroll} placeholder={placeholder} ref={textareaRef} spellCheck={false} value={value} wrap="off" />
    </div>
  </div>;
}

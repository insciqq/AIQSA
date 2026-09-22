"use client";

import { useEffect, useId, useRef, useState } from "react";
import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import { MarkdownPreviewBoundary } from "@/components/chat/MarkdownPreviewBoundary";
import "./markdown-editor.css";

type Mode = "write" | "split" | "preview";
const inertHref = () => "text" as const;
export const editorCharacterCount = (value: string, limit: number) =>
  `${value.length.toLocaleString("en-US").replaceAll(",", " ")} / ${limit.toLocaleString("en-US").replaceAll(",", " ")}`;

/** Controlled source text; layout and preview never own or replace the draft. */
export function MarkdownEditorV2({ value, onChange, label, previewLabel, help, maxLength, disabled = false }: Readonly<{
  value: string;
  onChange(value: string): void;
  label: string;
  previewLabel: string;
  help?: string;
  maxLength: number;
  disabled?: boolean;
}>) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const modeGroup = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [chosenMode, setChosenMode] = useState<Mode | null>(null);
  const mode = chosenMode === "split" && !wide ? "write" : chosenMode ?? (wide ? "split" : "write");
  const modes: Mode[] = wide ? ["write", "split", "preview"] : ["write", "preview"];

  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const measure = () => {
      const nextWide = node.getBoundingClientRect().width >= 880;
      if (!nextWide && document.activeElement?.getAttribute("data-editor-mode") === "split" && modeGroup.current?.contains(document.activeElement)) {
        modeGroup.current.querySelector<HTMLButtonElement>("[data-editor-mode='write']")?.focus();
      }
      setWide(nextWide);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  return <div ref={container} className="v2-markdown-editor" data-mode={mode}>
    <div className="v2-markdown-editor-toolbar">
      <label htmlFor={id}>{label}</label>
      <div ref={modeGroup} className="v2-markdown-editor-modes" role="radiogroup" aria-label="Editor mode" onKeyDown={event => {
        const index = modes.indexOf(mode);
        const next = event.key === "Home" ? 0 : event.key === "End" ? modes.length - 1
          : ["ArrowRight", "ArrowDown"].includes(event.key) ? (index + 1) % modes.length
          : ["ArrowLeft", "ArrowUp"].includes(event.key) ? (index + modes.length - 1) % modes.length : null;
        if (next === null || disabled) return;
        event.preventDefault();
        setChosenMode(modes[next]);
        modeGroup.current?.querySelector<HTMLButtonElement>(`[data-editor-mode='${modes[next]}']`)?.focus();
      }}>
        {modes.map(option => <button key={option} type="button" role="radio" aria-checked={mode === option}
          className="v2-focusable" data-editor-mode={option} tabIndex={mode === option ? 0 : -1} disabled={disabled}
          onClick={() => setChosenMode(option)}>{option[0].toUpperCase() + option.slice(1)}</button>)}
      </div>
      <span id={`${id}-count`} className="v2-markdown-editor-count">{editorCharacterCount(value, maxLength)}</span>
    </div>
    {help ? <p id={`${id}-help`} className="v2-markdown-editor-help">{help}</p> : null}
    <div className="v2-markdown-editor-panes">
      <textarea id={id} hidden={mode === "preview"} disabled={disabled} spellCheck={false}
        aria-describedby={`${id}-count${help ? ` ${id}-help` : ""}`} maxLength={maxLength}
        value={value} onChange={event => onChange(event.target.value)} />
      {mode !== "write" ? <div className="v2-markdown-editor-preview v2-focusable" role="region" aria-label={previewLabel} tabIndex={0}>
        <MarkdownPreviewBoundary resetKey={value} fallback={<p role="status">Preview is unavailable for this text.</p>}>
          {value ? <MarkdownMessage content={value} resolveHref={inertHref} /> : <p className="v2-markdown-editor-empty">Your text will appear here.</p>}
        </MarkdownPreviewBoundary>
      </div> : null}
    </div>
  </div>;
}

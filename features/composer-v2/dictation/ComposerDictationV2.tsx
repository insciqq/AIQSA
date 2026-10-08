"use client";

import "./dictation.css";
import { UiV2IconButton } from "@/components/ui-v2";
import type { CatalogDictation } from "@/lib/contracts/speechToText";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useDictationRecorder, useDictationSupportReason } from "./useDictationRecorder";

function elapsedLabel(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The draft with `text` inserted at the textarea's caret (replacing a
 * selection), separated from neighbouring words by single spaces, and the
 * caret position after it. Without a matching textarea the text is appended.
 */
export function insertDictatedText(draft: string, text: string, selection: Readonly<{ end: number; start: number }> | null) {
  const start = selection ? Math.min(Math.max(0, selection.start), draft.length) : draft.length;
  const end = selection ? Math.min(Math.max(start, selection.end), draft.length) : draft.length;
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const lead = before && !/\s$/u.test(before) ? " " : "";
  const trail = after && !/^\s/u.test(after) ? " " : "";
  const inserted = `${before}${lead}${text}`;
  return { caret: inserted.length, draft: `${inserted}${trail}${after}` };
}

/**
 * Composer dictation: a microphone button beside Send, a recording pill with
 * the elapsed time, Cancel and Stop (Esc also cancels), a transcribing spinner,
 * and the transcript inserted at the caret. Hidden without the administrator
 * role; disabled with the reason on plain HTTP, without browser recording, or
 * while the composer itself is blocked. The draft is never replaced.
 */
export function useComposerDictationV2(input: Readonly<{
  blockedReason: string | null;
  dictation: CatalogDictation | null | undefined;
  draft: string;
  onDraftChange(value: string): void;
  sessionKey: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}>): Readonly<{ control: ReactNode; status: ReactNode }> {
  const support = useDictationSupportReason();
  const [error, setError] = useState<Readonly<{ message: string; sessionKey: string }> | null>(null);
  const describedBy = useId();
  const latest = useRef(input);
  useEffect(() => { latest.current = input; });
  const pendingCaret = useRef<Readonly<{ caret: number; draft: string }> | null>(null);

  const recorder = useDictationRecorder({
    onError: (message) => setError({ message, sessionKey: latest.current.sessionKey }),
    onText: (text) => {
      const { draft, onDraftChange, textareaRef } = latest.current;
      const textarea = textareaRef.current;
      const selection = textarea && textarea.value === draft ? { end: textarea.selectionEnd, start: textarea.selectionStart } : null;
      const next = insertDictatedText(draft, text, selection);
      pendingCaret.current = next;
      onDraftChange(next.draft);
    }
  });
  // Focus returns to the textarea with the caret after the inserted text once
  // the new draft is on screen; any other draft change drops the request.
  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    if (!pending) return;
    pendingCaret.current = null;
    const field = input.textareaRef.current;
    if (pending.draft !== input.draft || !field || field.disabled || field.value !== pending.draft) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(pending.caret, pending.caret);
  }, [input.draft, input.textareaRef]);
  const { cancel, phase } = recorder;

  // A dictation belongs to the chat it started in: switching chats discards it.
  const startedIn = useRef(input.sessionKey);
  useEffect(() => {
    if (phase === "idle") startedIn.current = input.sessionKey;
    else if (startedIn.current !== input.sessionKey) cancel();
  }, [cancel, input.sessionKey, phase]);

  useEffect(() => {
    if (phase !== "recording" && phase !== "starting") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      cancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [cancel, phase]);

  const dictation = input.dictation;
  if (!dictation || dictation.unavailableReason === "not_configured") return { control: null, status: null };

  const shownError = error && error.sessionKey === input.sessionKey ? error.message : null;
  const status = shownError ? (
    <div className="v2-composer-status" role="alert" data-testid="composer-dictation-error">
      <span>{shownError}</span>
      <button className="v2-focusable" type="button" onClick={() => setError(null)}>Dismiss</button>
    </div>
  ) : null;

  if (phase === "recording" || phase === "starting") {
    return {
      control: (
        <span className="v2-composer-dictation" data-phase={phase} role="group" aria-label="Dictation">
          <span className="v2-composer-dictation-timer" aria-hidden="true">
            <span className="v2-composer-dictation-dot" />
            {phase === "recording" ? elapsedLabel(recorder.elapsedMs) : "…"}
          </span>
          <span className="v2-sr-only" role="status">
            {phase === "recording" ? "Recording. Stop to transcribe, or press Escape to cancel." : "Starting the microphone…"}
          </span>
          <UiV2IconButton icon="close" label="Cancel dictation" onClick={cancel} className="v2-composer-dictation-cancel" />
          <UiV2IconButton icon="stop" label="Stop dictation and transcribe" disabled={phase !== "recording"}
            onClick={recorder.stop} className="v2-composer-dictation-stop" />
        </span>
      ),
      status
    };
  }

  if (phase === "transcribing") {
    return {
      control: (
        <span className="v2-composer-dictation" data-phase="transcribing">
          <button className="v2-icon-button v2-focusable v2-composer-dictation-mic" type="button" disabled aria-busy="true"
            aria-label="Transcribing dictation" title="Transcribing…">
            <span className="v2-spinner" aria-hidden="true" />
          </button>
          <span className="v2-sr-only" role="status">Transcribing…</span>
        </span>
      ),
      status
    };
  }

  const disabledReason = support === "pending" ? "Checking the microphone…"
    : support ?? (dictation.available ? null : "Dictation is unavailable right now. Ask your administrator to check Speech to text.") ??
      input.blockedReason;
  return {
    control: (
      <span className="v2-composer-dictation" data-phase="idle">
        <UiV2IconButton icon="mic" label="Dictate" className="v2-composer-dictation-mic"
          title={disabledReason ?? "Dictate"} disabled={Boolean(disabledReason)}
          aria-describedby={disabledReason ? describedBy : undefined}
          onClick={() => { setError(null); void recorder.start(); }} />
        {disabledReason ? <span className="v2-sr-only" id={describedBy}>{disabledReason}</span> : null}
      </span>
    ),
    status
  };
}

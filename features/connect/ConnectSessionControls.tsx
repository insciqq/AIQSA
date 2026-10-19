"use client";

import { UiV2IconButton } from "@/components/ui-v2";
import { useComposerDictationV2 } from "@/features/composer-v2/dictation/ComposerDictationV2";
import type { ConnectSessionOption } from "@/lib/contracts/connect";
import type { CatalogDictation } from "@/lib/contracts/speechToText";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { loadConnectSessionOptions } from "./connectApi";
import { CONNECT_FALLBACK_ANSWERS, type ConnectKey } from "./connectKeys";

/** Taps on the controls keep the focus (and the software keyboard) where it is. */
function keepFocus(event: MouseEvent) {
  event.preventDefault();
}

const KEYS: readonly Readonly<{ key: ConnectKey; label: string; name: string }>[] = [
  { key: "escape", label: "Esc", name: "Escape" },
  { key: "tab", label: "Tab", name: "Tab" },
  { key: "shift_tab", label: "⇧Tab", name: "Shift Tab" }
];
const ARROWS: readonly Readonly<{ key: ConnectKey; label: string; name: string }>[] = [
  { key: "left", label: "←", name: "Left" },
  { key: "up", label: "↑", name: "Up" },
  { key: "down", label: "↓", name: "Down" },
  { key: "right", label: "→", name: "Right" }
];
const TAIL: readonly Readonly<{ key: ConnectKey; label: string; name: string }>[] = [
  { key: "ctrl_c", label: "^C", name: "Control C" },
  { key: "enter", label: "⏎", name: "Enter" }
];

/** Keys a phone keyboard lacks: Esc, Tab, ⇧Tab, a Ctrl that holds for one key, arrows, ^C and Enter. */
export function ConnectKeyBar({
  ctrl,
  disabled,
  onCtrl,
  onKey
}: Readonly<{
  ctrl: boolean;
  disabled: boolean;
  onCtrl(): void;
  onKey(key: ConnectKey): void;
}>) {
  const key = (item: (typeof KEYS)[number]) => (
    <button
      aria-label={item.name}
      className="v2-connect-key v2-focusable"
      disabled={disabled}
      key={item.key}
      onClick={() => onKey(item.key)}
      onMouseDown={keepFocus}
      type="button"
    >
      {item.label}
    </button>
  );
  return (
    <div aria-label="Terminal keys" className="v2-connect-keybar" data-testid="connect-key-bar" role="toolbar">
      {KEYS.map(key)}
      <button
        aria-label="Control, for the next key"
        aria-pressed={ctrl}
        className="v2-connect-key v2-focusable"
        disabled={disabled}
        onClick={onCtrl}
        onMouseDown={keepFocus}
        type="button"
      >
        Ctrl
      </button>
      {ARROWS.map(key)}
      {TAIL.map(key)}
    </div>
  );
}

type OptionsState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; options: readonly ConnectSessionOption[] }>;

/** The agent may draw its menu a moment after it asks: an empty answer is read once more. */
export const CONNECT_OPTIONS_RETRY_MS = 1_500;

function useSessionOptions(deviceId: string, sessionId: string, askedAt: string | null): OptionsState {
  const [state, setState] = useState<Readonly<{ askedAt: string; value: OptionsState }> | null>(null);
  useEffect(() => {
    if (askedAt === null) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const read = async (again: boolean) => {
      const result = await loadConnectSessionOptions(deviceId, sessionId, controller.signal);
      if (controller.signal.aborted) return;
      const options = result.ok ? result.data.options : [];
      if (result.ok && options.length === 0 && again) {
        retry = setTimeout(() => void read(false), CONNECT_OPTIONS_RETRY_MS);
        return;
      }
      setState({ askedAt, value: { kind: "ready", options } });
    };
    void read(true);
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [askedAt, deviceId, sessionId]);
  return state && state.askedAt === askedAt ? state.value : { kind: "loading" };
}

/**
 * Answer buttons while the session needs approval: the numbered choices on
 * its screen, or Enter, Esc, y and n when none could be read. A button sends
 * its key only when tapped.
 */
export function ConnectAnswerStrip({
  askedAt,
  deviceId,
  disabled,
  onAnswer,
  sessionId
}: Readonly<{
  /** When the session started asking (its status time). */
  askedAt: string;
  deviceId: string;
  disabled: boolean;
  onAnswer(data: string): void;
  sessionId: string;
}>) {
  const state = useSessionOptions(deviceId, sessionId, askedAt);
  const answers = state.kind === "loading"
    ? []
    : state.options.length > 0
      ? state.options.map((option) => ({ data: option.key, label: `${option.key} ${option.label}`, number: option.key, text: option.label }))
      : CONNECT_FALLBACK_ANSWERS.map((answer) => ({ data: answer.data, label: answer.label, number: null, text: answer.label }));
  return (
    <div aria-label="Answer the agent" className="v2-connect-answers" data-testid="connect-answer-strip" role="group">
      {state.kind === "loading" ? (
        <p className="v2-connect-answers-status" role="status">Reading the choices…</p>
      ) : answers.map((answer) => (
        <button
          aria-label={answer.label}
          className="v2-connect-answer v2-focusable"
          disabled={disabled}
          key={answer.label}
          onClick={() => onAnswer(answer.data)}
          onMouseDown={keepFocus}
          title={answer.label}
          type="button"
        >
          {answer.number ? <span className="v2-connect-answer-key" aria-hidden="true">{answer.number}</span> : null}
          <span className="v2-connect-answer-label" aria-hidden="true">{answer.text}</span>
        </button>
      ))}
    </div>
  );
}

/** Compose drafts live in this page's memory, per session, until sent. */
const drafts = new Map<string, string>();

/**
 * A text field for the terminal: autocorrect, pasting and the system's own
 * dictation work as in any field, the microphone uses AIQSA dictation, and
 * Send pastes the text into the session and presses Enter.
 */
export function ConnectComposeBar({
  dictation,
  draftKey,
  live,
  onSend,
  takeCtrlKey
}: Readonly<{
  dictation: CatalogDictation | null;
  draftKey: string;
  live: boolean;
  onSend(text: string): void;
  /**
   * A character typed into the field; true when the key bar's armed Ctrl
   * took it for the terminal, so the field does not insert it.
   */
  takeCtrlKey(data: string): boolean;
}>) {
  const [draft, setDraftState] = useState(() => drafts.get(draftKey) ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const setDraft = (value: string) => {
    if (value) drafts.set(draftKey, value);
    else drafts.delete(draftKey);
    setDraftState(value);
  };
  const dictationUi = useComposerDictationV2({
    blockedReason: null,
    dictation,
    draft,
    onDraftChange: setDraft,
    sessionKey: draftKey,
    textareaRef
  });

  // The field grows with its text up to a few lines (CSS caps it), then scrolls.
  useLayoutEffect(() => {
    const field = textareaRef.current;
    if (!field) return;
    const fit = () => {
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [draft]);

  const latest = useRef(takeCtrlKey);
  useEffect(() => { latest.current = takeCtrlKey; });
  useEffect(() => {
    const field = textareaRef.current;
    if (!field) return;
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType !== "insertText" || !event.data) return;
      if (latest.current(event.data)) event.preventDefault();
    };
    field.addEventListener("beforeinput", onBeforeInput);
    return () => field.removeEventListener("beforeinput", onBeforeInput);
  }, []);

  const canSend = live && draft.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    onSend(draft);
    setDraft("");
  };

  return (
    <div className="v2-connect-compose" data-testid="connect-compose-bar">
      {dictationUi.status}
      <form
        className="v2-connect-compose-row"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          aria-label="Text for the terminal"
          className="v2-connect-compose-field"
          data-testid="connect-compose-field"
          enterKeyHint="send"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            send();
          }}
          placeholder="Type or dictate, then Send"
          ref={textareaRef}
          rows={1}
          value={draft}
        />
        {dictationUi.control}
        <UiV2IconButton
          className="v2-connect-compose-send"
          disabled={!canSend}
          icon="arrow-up"
          label="Send to the terminal"
          onMouseDown={keepFocus}
          round
          type="submit"
        />
      </form>
    </div>
  );
}

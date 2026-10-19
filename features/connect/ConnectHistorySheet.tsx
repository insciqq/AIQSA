"use client";

import { UiV2Button } from "@/components/ui-v2";
import { UiV2Sheet } from "@/components/ui-v2/SheetV2";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { loadConnectSessionHistory, type ConnectFailureCode } from "./connectApi";
import { useConnectShell } from "./connectShellContext";
import { connectErrorMessage } from "./connectText";
import { loadConnectXterm } from "./connectXtermLoader";

const HISTORY_FONTS = "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, 'DejaVu Sans Mono'";

/** The terminal's symbols font, which the session page has loaded already, so `⎿` and `❯` render here too. */
function useSymbolsFontFamily(): string | undefined {
  const [family, setFamily] = useState<string | undefined>(undefined);
  useEffect(() => {
    let current = true;
    loadConnectXterm().then(
      (module) => {
        if (current) setFamily(module.CONNECT_TERMINAL_SYMBOLS_FONT_FAMILY);
      },
      () => undefined
    );
    return () => {
      current = false;
    };
  }, []);
  return family;
}

type HistoryState =
  | Readonly<{ kind: "loading"; text: string | null }>
  | Readonly<{ kind: "ready"; text: string }>
  | Readonly<{ code: ConnectFailureCode; kind: "failed"; text: string | null }>;

/**
 * The session's recent lines as plain, natively scrolling text: reading back
 * inside the terminal is unreliable on touch screens. Opens at the newest
 * line; Refresh reads it again.
 */
export function ConnectHistorySheet({
  deviceId,
  onClose,
  sessionId,
  title
}: Readonly<{
  deviceId: string;
  onClose(): void;
  sessionId: string;
  title: string;
}>) {
  const { leave } = useConnectShell();
  const [state, setState] = useState<HistoryState>({ kind: "loading", text: null });
  const [generation, setGeneration] = useState(0);
  const scrollerRef = useRef<HTMLPreElement>(null);
  const jumpPending = useRef(true);
  const symbols = useSymbolsFontFamily();

  useEffect(() => {
    const controller = new AbortController();
    void loadConnectSessionHistory(deviceId, sessionId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        jumpPending.current = true;
        setState({ kind: "ready", text: result.data.text });
        return;
      }
      if (result.code === "connect_disabled") return leave("disabled");
      if (result.code === "connect_unauthorized") return leave("signed_out");
      setState((previous) => ({ code: result.code, kind: "failed", text: previous.text }));
    });
    return () => controller.abort();
  }, [deviceId, generation, leave, sessionId]);

  const jumpToBottom = useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    if (state.kind !== "ready" || !jumpPending.current) return;
    jumpPending.current = false;
    jumpToBottom();
  }, [jumpToBottom, state]);

  const refresh = () => {
    setState((previous) => ({ kind: "loading", text: previous.text }));
    setGeneration((value) => value + 1);
  };

  const text = state.text;
  return (
    <UiV2Sheet
      description={title}
      footer={(
        <>
          <UiV2Button busy={state.kind === "loading"} icon="regenerate" onClick={refresh}>Refresh</UiV2Button>
          <UiV2Button disabled={!text} icon="chevron-down" onClick={jumpToBottom}>Jump to bottom</UiV2Button>
        </>
      )}
      onClose={onClose}
      open
      phoneFullScreen
      testId="connect-history-sheet"
      title="History"
      width="wide"
    >
      <div className="flex h-full min-h-0 flex-col gap-3">
        {state.kind === "failed" ? (
          <p className="v2-connect-alert" role="alert">{connectErrorMessage(state.code)}</p>
        ) : null}
        {text === null ? (
          state.kind === "loading" ? <p className="text-sm text-ink-muted" role="status">Loading the history…</p> : null
        ) : text.trim() ? (
          <pre
            className="v2-connect-history"
            data-testid="connect-history-text"
            ref={scrollerRef}
            style={symbols ? { fontFamily: `${HISTORY_FONTS}, ${symbols}, monospace` } : undefined}
            tabIndex={0}
          >
            {text}
          </pre>
        ) : (
          <p className="text-sm text-ink-muted">This session has no output yet.</p>
        )}
      </div>
    </UiV2Sheet>
  );
}

"use client";

import { UiV2Button } from "@/components/ui-v2";
import { CONNECT_PAGE_PATH } from "@/lib/contracts/connect";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ConnectTerminalInput } from "./connectKeys";
import {
  ConnectTerminalSession,
  type ConnectViewState,
  type ConnectViewTransport
} from "./connectTerminalSession";
import { connectErrorMessage, connectLastSeenLabel } from "./connectText";
import { loadConnectXterm } from "./connectXtermLoader";
import { useConnectShell } from "./connectShellContext";
import { useConnectNow } from "./useConnectNow";

/** Fitting waits for the window to settle, so a drag sends one resize. */
export const CONNECT_RESIZE_DEBOUNCE_MS = 150;
const TERMINAL_SCROLLBACK = 5_000;
/**
 * System monospace fonts carry the box-drawing and block glyphs agents draw
 * with; the bundled code font is subset to Latin and Cyrillic, and glyphs
 * falling back to another font break the terminal grid. The symbols font of
 * the terminal module comes last, for the technical symbols (`⎿`) and
 * dingbats (`❯`) that a system without them would show as empty boxes.
 */
const TERMINAL_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'DejaVu Sans Mono', 'Liberation Mono'";
/** Glyphs the symbols font is loaded for before the terminal measures its cells. */
const TERMINAL_SYMBOL_SAMPLE = "⎿❯";
const FONT_LOAD_WAIT_MS = 1_500;
/** Phones, also in landscape, get the smaller terminal font. */
const SMALL_TERMINAL_QUERY = "(max-width: 639px), (max-height: 500px)";

function terminalFontFamily(symbols: string | undefined): string {
  return `${TERMINAL_FONT_FAMILY}, ${symbols ? `${symbols}, ` : ""}monospace`;
}

/** Waits briefly for the symbols font, so the first screen measures with it; a slow network does not hold the terminal. */
async function loadSymbolsFont(family: string | undefined, fontSize: number): Promise<void> {
  if (!family || typeof document === "undefined" || !document.fonts?.load) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    document.fonts.load(`${fontSize}px ${family}`, TERMINAL_SYMBOL_SAMPLE).catch(() => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, FONT_LOAD_WAIT_MS); })
  ]);
  clearTimeout(timer);
}

/** What the touch controls of a live terminal use: its input. */
export type ConnectTerminalHandle = Readonly<{
  input: ConnectTerminalInput;
}>;

function cssValue(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** OSC 8 links open only as web pages, after the browser's confirmation. */
const linkHandler = {
  activate(_event: MouseEvent, uri: string) {
    if (!/^https?:\/\//iu.test(uri)) return;
    if (!window.confirm(`Open this link from the terminal?\n\n${uri}`)) return;
    window.open(uri, "_blank", "noopener,noreferrer");
  },
  allowNonHttpProtocols: false
};

function pageVisible(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function useCountdown(retryAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [retryAt]);
  return retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));
}

const INPUT_LOST_MESSAGE = "Your last keystrokes may not have reached the computer.";

/** Stays over a live terminal until dismissed: the line on screen may miss part of what was typed. */
function InputLostNotice({ onDismiss }: Readonly<{ onDismiss(): void }>) {
  return (
    <div className="v2-connect-terminal-notice" data-testid="connect-terminal-input-lost" role="alert">
      <p>{INPUT_LOST_MESSAGE} Check the command line before you press Enter.</p>
      <UiV2Button onClick={onDismiss}>Got it</UiV2Button>
    </div>
  );
}

function StateOverlay({
  deviceName,
  lastSeenAt,
  onRetry,
  state
}: Readonly<{
  deviceName: string;
  lastSeenAt: string | null;
  onRetry(): void;
  state: ConnectViewState;
}>) {
  const seconds = useCountdown(state.kind === "reconnecting" ? state.retryAt : null);
  const now = useConnectNow();
  if (state.kind === "live" || state.kind === "left") return null;
  const back = (
    <Link className="v2-connect-link v2-focusable text-sm" href={CONNECT_PAGE_PATH}>Back to sessions</Link>
  );
  let content: React.ReactNode;
  switch (state.kind) {
    case "connecting":
      content = <p role="status">Connecting to the session…</p>;
      break;
    case "reconnecting":
      content = (
        <>
          <p role={state.cause === "input_lost" ? "alert" : "status"}>
            {state.cause === "connect_view_limit"
              ? `${connectErrorMessage("connect_view_limit")} `
              : state.cause === "input_lost"
                ? `${INPUT_LOST_MESSAGE} Typing is paused until the terminal shows the real screen again. `
                : "The connection was interrupted. "}
            {seconds > 0 ? `Reconnecting in ${seconds} s…` : "Reconnecting…"}
          </p>
          <UiV2Button onClick={onRetry}>Reconnect now</UiV2Button>
        </>
      );
      break;
    case "offline":
      content = (
        <>
          <p role="status">
            {deviceName} is offline ({connectLastSeenLabel(false, lastSeenAt, now).toLowerCase()}). The session keeps running
            on the computer; this terminal reconnects when the computer is back.
          </p>
          <UiV2Button onClick={onRetry}>Try again</UiV2Button>
        </>
      );
      break;
    case "ended":
      content = (
        <>
          <p role="status">This session has ended.</p>
          {back}
        </>
      );
      break;
    case "not_found":
      content = (
        <>
          <p role="status">This session is not available.</p>
          {back}
        </>
      );
      break;
    case "failed":
      content = (
        <>
          <p role="alert">
            {connectErrorMessage(state.code)}
            {state.inputLost ? " Some of what you typed was not sent; check the command line before you continue." : null}
          </p>
          <UiV2Button onClick={onRetry}>Try again</UiV2Button>
        </>
      );
      break;
  }
  return (
    <div className="v2-connect-terminal-overlay" data-state={state.kind} data-testid="connect-terminal-state">
      <div className="v2-connect-terminal-overlay-card">{content}</div>
    </div>
  );
}

/**
 * The browser terminal of one session: xterm.js sized to its box, attached
 * through `ConnectTerminalSession`. Keyboard input reaches the session only
 * while the view is live.
 */
export function ConnectTerminalPane({
  deviceId,
  deviceName,
  deviceOnline,
  lastSeenAt,
  onCtrlChange,
  onHandle,
  onViewState,
  sessionId,
  transport
}: Readonly<{
  deviceId: string;
  deviceName: string;
  /** From the device list; null while it loads. */
  deviceOnline: boolean | null;
  lastSeenAt: string | null;
  /** The key bar's sticky Ctrl was armed or used up. */
  onCtrlChange?(armed: boolean): void;
  /** The terminal's input for the touch controls, once it exists; null when it is gone. */
  onHandle?(handle: ConnectTerminalHandle | null): void;
  onViewState?(state: ConnectViewState): void;
  sessionId: string;
  transport?: ConnectViewTransport;
}>) {
  const { leave } = useConnectShell();
  const hostRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<ConnectTerminalSession | null>(null);
  const focusRef = useRef<(() => void) | null>(null);
  const deviceOnlineRef = useRef(deviceOnline);
  const leaveRef = useRef(leave);
  const callbacksRef = useRef({ onCtrlChange, onHandle, onViewState });
  const [state, setState] = useState<ConnectViewState>({ kind: "connecting" });
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    deviceOnlineRef.current = deviceOnline;
    leaveRef.current = leave;
    callbacksRef.current = { onCtrlChange, onHandle, onViewState };
    if (deviceOnline !== null) sessionRef.current?.setDeviceOnline(deviceOnline);
  });

  useEffect(() => {
    let disposed = false;
    let teardown: (() => void) | null = null;
    void loadConnectXterm().then(async ({ CONNECT_TERMINAL_SYMBOLS_FONT_FAMILY: symbols, FitAddon, Terminal }) => {
      const fontSize = window.matchMedia?.(SMALL_TERMINAL_QUERY).matches ? 13 : 14;
      await loadSymbolsFont(symbols, fontSize);
      const host = hostRef.current;
      if (disposed || !host) return;
      const terminal = new Terminal({
        allowProposedApi: false,
        cursorBlink: true,
        disableStdin: true,
        fontFamily: terminalFontFamily(symbols),
        fontSize,
        linkHandler,
        scrollback: TERMINAL_SCROLLBACK,
        theme: {
          background: cssValue("--v2-dark-color-code-bg", "#10161f"),
          cursor: cssValue("--v2-dark-color-accent", "#38dfd0"),
          cursorAccent: cssValue("--v2-dark-color-code-bg", "#10161f"),
          foreground: cssValue("--v2-dark-color-text", "#e7edf5"),
          selectionBackground: cssValue("--v2-dark-color-selection", "rgba(56, 223, 208, 0.3)")
        }
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host);
      fit.fit();
      const session = new ConnectTerminalSession({
        deviceId,
        onState: (next) => {
          terminal.options.disableStdin = next.kind !== "live";
          setState(next);
          callbacksRef.current.onViewState?.(next);
          if (next.kind === "live") terminal.focus();
          if (next.kind === "left") leaveRef.current(next.reason);
        },
        sessionId,
        size: () => ({ cols: terminal.cols, rows: terminal.rows }),
        terminal: {
          reset: () => terminal.reset(),
          write: (bytes) => terminal.write(bytes)
        },
        ...(transport ? { transport } : {})
      });
      sessionRef.current = session;
      focusRef.current = () => terminal.focus();
      const input = new ConnectTerminalInput({
        modes: () => ({
          applicationCursorKeys: terminal.modes.applicationCursorKeysMode,
          bracketedPaste: terminal.modes.bracketedPasteMode
        }),
        onCtrlChange: (armed) => callbacksRef.current.onCtrlChange?.(armed),
        send: (data) => session.input(data)
      });
      const subscriptions = [
        // Typed keys pass the sticky Ctrl of the key bar.
        terminal.onData((data) => input.typed(data)),
        terminal.onResize(({ cols, rows }) => session.resize(cols, rows))
      ];
      let resizeTimer: ReturnType<typeof setTimeout> | undefined;
      const refit = () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          try {
            fit.fit();
          } catch {
            // A detached or zero-sized box keeps the previous size.
          }
        }, CONNECT_RESIZE_DEBOUNCE_MS);
      };
      const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refit);
      observer?.observe(host);
      // A keyboard over the page or a turned phone changes the box without
      // always resizing it in a way the observer sees first.
      const viewport = window.visualViewport;
      viewport?.addEventListener("resize", refit);
      window.addEventListener("orientationchange", refit);
      const visibility = () => session.setVisible(pageVisible());
      document.addEventListener("visibilitychange", visibility);
      window.addEventListener("focus", visibility);
      window.addEventListener("blur", visibility);
      session.setVisible(pageVisible());
      if (deviceOnlineRef.current !== null) session.setDeviceOnline(deviceOnlineRef.current);
      session.start();
      callbacksRef.current.onHandle?.({ input });
      teardown = () => {
        callbacksRef.current.onHandle?.(null);
        clearTimeout(resizeTimer);
        observer?.disconnect();
        viewport?.removeEventListener("resize", refit);
        window.removeEventListener("orientationchange", refit);
        document.removeEventListener("visibilitychange", visibility);
        window.removeEventListener("focus", visibility);
        window.removeEventListener("blur", visibility);
        for (const subscription of subscriptions) subscription.dispose();
        session.dispose();
        terminal.dispose();
      };
    }).catch(() => {
      if (!disposed) setLoadFailed(true);
    });
    return () => {
      disposed = true;
      teardown?.();
      sessionRef.current = null;
      focusRef.current = null;
    };
  }, [deviceId, sessionId, transport]);

  return (
    <div className="v2-connect-terminal" data-testid="connect-terminal" data-view-state={state.kind}>
      <div
        aria-label="Terminal"
        className="v2-connect-terminal-host"
        data-testid="connect-terminal-host"
        ref={hostRef}
      />
      {loadFailed ? (
        <div className="v2-connect-terminal-overlay" data-state="failed" data-testid="connect-terminal-state">
          <div className="v2-connect-terminal-overlay-card">
            <p role="alert">The terminal could not be loaded. Reload the page to try again.</p>
          </div>
        </div>
      ) : state.kind === "live" && state.inputLost ? (
        <InputLostNotice
          onDismiss={() => {
            sessionRef.current?.dismissInputNotice();
            focusRef.current?.();
          }}
        />
      ) : (
        <StateOverlay
          deviceName={deviceName}
          lastSeenAt={lastSeenAt}
          onRetry={() => {
            sessionRef.current?.retryNow();
            focusRef.current?.();
          }}
          state={state}
        />
      )}
    </div>
  );
}

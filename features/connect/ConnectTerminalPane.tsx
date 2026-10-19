"use client";

import { UiV2Button } from "@/components/ui-v2";
import { CONNECT_PAGE_PATH } from "@/lib/contracts/connect";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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
 * falling back to another font break the terminal grid.
 */
const TERMINAL_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace";

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
  sessionId,
  transport
}: Readonly<{
  deviceId: string;
  deviceName: string;
  /** From the device list; null while it loads. */
  deviceOnline: boolean | null;
  lastSeenAt: string | null;
  sessionId: string;
  transport?: ConnectViewTransport;
}>) {
  const { leave } = useConnectShell();
  const hostRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<ConnectTerminalSession | null>(null);
  const focusRef = useRef<(() => void) | null>(null);
  const deviceOnlineRef = useRef(deviceOnline);
  const leaveRef = useRef(leave);
  const [state, setState] = useState<ConnectViewState>({ kind: "connecting" });
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    deviceOnlineRef.current = deviceOnline;
    leaveRef.current = leave;
    if (deviceOnline !== null) sessionRef.current?.setDeviceOnline(deviceOnline);
  });

  useEffect(() => {
    let disposed = false;
    let teardown: (() => void) | null = null;
    void loadConnectXterm().then(async ({ FitAddon, Terminal }) => {
      const fontSize = window.matchMedia?.("(max-width: 639px)").matches ? 13 : 14;
      const host = hostRef.current;
      if (disposed || !host) return;
      const terminal = new Terminal({
        allowProposedApi: false,
        cursorBlink: true,
        disableStdin: true,
        fontFamily: TERMINAL_FONT_FAMILY,
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
      const subscriptions = [
        terminal.onData((data) => session.input(data)),
        terminal.onResize(({ cols, rows }) => session.resize(cols, rows))
      ];
      let resizeTimer: ReturnType<typeof setTimeout> | undefined;
      const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          try {
            fit.fit();
          } catch {
            // A detached or zero-sized box keeps the previous size.
          }
        }, CONNECT_RESIZE_DEBOUNCE_MS);
      });
      observer?.observe(host);
      const visibility = () => session.setVisible(pageVisible());
      document.addEventListener("visibilitychange", visibility);
      window.addEventListener("focus", visibility);
      window.addEventListener("blur", visibility);
      session.setVisible(pageVisible());
      if (deviceOnlineRef.current !== null) session.setDeviceOnline(deviceOnlineRef.current);
      session.start();
      teardown = () => {
        clearTimeout(resizeTimer);
        observer?.disconnect();
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

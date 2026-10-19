"use client";

import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2IconButton, type UiV2MenuAction } from "@/components/ui-v2";
import { useVisualViewportInset } from "@/components/ui-v2/useVisualViewportInset";
import { CONNECT_PAGE_PATH, type ConnectSession } from "@/lib/contracts/connect";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { endConnectSession } from "./connectApi";
import { ConnectHistorySheet } from "./ConnectHistorySheet";
import { ConnectPageHeader } from "./ConnectHomeView";
import { ConnectMenu } from "./ConnectMenu";
import { ConnectAnswerStrip, ConnectComposeBar, ConnectKeyBar } from "./ConnectSessionControls";
import { findConnectDevice, useConnectShell } from "./connectShellContext";
import { ConnectStatusBadge } from "./ConnectStatusBadge";
import { ConnectTerminalPane, type ConnectTerminalHandle } from "./ConnectTerminalPane";
import type { ConnectViewState, ConnectViewTransport } from "./connectTerminalSession";
import { CONNECT_PROGRAM_LABELS, connectErrorMessage, connectFolderName } from "./connectText";
import { useConnectDictation } from "./useConnectDictation";

export type ConnectSessionViewProps = Readonly<{
  deviceId: string;
  sessionId: string;
  transport?: ConnectViewTransport;
}>;

/** Touch screens and narrow windows get the key bar and an open text field. */
const TOUCH_LAYOUT_QUERY = "(hover: none), (pointer: coarse), (max-width: 767px)";

function subscribeTouchLayout(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const query = window.matchMedia(TOUCH_LAYOUT_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readTouchLayout(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(TOUCH_LAYOUT_QUERY).matches;
}

/** Ids that are not a device or session id get the same answer as unknown ones. */
export function ConnectSessionNotFound() {
  return (
    <>
      <ConnectPageHeader title="Session not available" />
      <div className="px-4 py-8 sm:px-8" data-testid="connect-session-not-found">
        <p className="text-sm leading-6 text-ink-secondary">This session is not available. It may have ended, or it belongs to a computer that is no longer connected.</p>
        <Link className="v2-connect-link v2-focusable mt-3 inline-block text-sm" href={CONNECT_PAGE_PATH}>Back to sessions</Link>
      </div>
    </>
  );
}

/**
 * `/connect/<deviceId>/<sessionId>`: the session's header, its live terminal
 * and, under it, the answer buttons while the agent asks, the text field
 * and (on touch screens) the key bar. Everything sent goes through the
 * terminal's one input queue.
 */
export function ConnectSessionView({ deviceId, sessionId, transport }: ConnectSessionViewProps) {
  const router = useRouter();
  const { leave, snapshot, source } = useConnectShell();
  const device = findConnectDevice(snapshot, deviceId);
  const session = device?.sessions.find((candidate) => candidate.id === sessionId) ?? null;
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [terminal, setTerminal] = useState<ConnectTerminalHandle | null>(null);
  const [viewState, setViewState] = useState<ConnectViewState>({ kind: "connecting" });
  const [ctrl, setCtrl] = useState(false);
  const [composeChoice, setComposeChoice] = useState<boolean | null>(null);
  const touchLayout = useSyncExternalStore(subscribeTouchLayout, readTouchLayout, () => false);
  const composeOpen = composeChoice ?? touchLayout;
  const dictation = useConnectDictation(composeOpen);
  const keyboardInset = useVisualViewportInset();

  // An offline computer lists no sessions: the header keeps what it last showed.
  const [lastKnown, setLastKnown] = useState<ConnectSession | null>(session);
  if (session && session !== lastKnown) setLastKnown(session);
  const shown = session ?? (device && !device.online ? lastKnown : null);

  if (snapshot.devices !== null && !device) return <ConnectSessionNotFound />;

  const title = shown?.title ?? "Session";
  const deviceName = device?.name ?? "The computer";
  const live = viewState.kind === "live" && terminal !== null;
  const asking = device?.online && session?.status === "needs_approval" ? session.statusAt : null;

  async function endSession() {
    setEnding(true);
    setError(null);
    const result = await endConnectSession(deviceId, sessionId);
    setEnding(false);
    setConfirmingEnd(false);
    if (result.ok || result.code === "connect_session_not_found") {
      source.removeSession(deviceId, sessionId);
      router.push(CONNECT_PAGE_PATH);
      return;
    }
    if (result.code === "connect_disabled") return leave("disabled");
    if (result.code === "connect_unauthorized") return leave("signed_out");
    setError(connectErrorMessage(result.code, result.retryAfterSeconds));
  }

  const actions: UiV2MenuAction[] = [
    { icon: "history", label: "History", onSelect: () => setHistoryOpen(true) },
    {
      icon: "stop",
      label: "End session…",
      onSelect: () => setConfirmingEnd(true),
      separatorBefore: true,
      tone: "destructive"
    }
  ];

  return (
    <div
      className="v2-connect-session flex min-h-0 flex-1 flex-col"
      data-keyboard={keyboardInset > 0 ? "open" : undefined}
      data-testid="connect-session-view"
      style={keyboardInset > 0 ? { paddingBottom: keyboardInset } : undefined}
    >
      <ConnectPageHeader
        title={(
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate">{title}</span>
            <span className="min-w-0 truncate text-metadata font-normal text-ink-muted max-sm:hidden">
              {[device?.name, shown ? CONNECT_PROGRAM_LABELS[shown.program] : null, shown ? connectFolderName(shown.cwd) : null]
                .filter(Boolean).join(" · ")}
            </span>
          </span>
        )}
      >
        {shown ? <ConnectStatusBadge status={shown.status} /> : null}
        <UiV2IconButton
          aria-pressed={composeOpen}
          icon="type"
          label="Text field"
          onClick={() => setComposeChoice(!composeOpen)}
          tooltip={composeOpen ? "Hide the text field" : "Show the text field"}
        />
        <ConnectMenu actions={actions} label="Session actions" />
      </ConnectPageHeader>
      {error ? <p className="v2-connect-alert mx-3 mt-2" role="alert">{error}</p> : null}
      <ConnectTerminalPane
        deviceId={deviceId}
        deviceName={deviceName}
        deviceOnline={device ? device.online : null}
        key={`${deviceId}/${sessionId}`}
        lastSeenAt={device?.lastSeenAt ?? null}
        onCtrlChange={setCtrl}
        onHandle={setTerminal}
        onViewState={setViewState}
        sessionId={sessionId}
        {...(transport ? { transport } : {})}
      />
      <div className="v2-connect-session-controls" data-testid="connect-session-controls">
        {asking ? (
          <ConnectAnswerStrip
            askedAt={asking}
            deviceId={deviceId}
            disabled={!live}
            key={asking}
            onAnswer={(data) => terminal?.input.answer(data)}
            sessionId={sessionId}
          />
        ) : null}
        {composeOpen ? (
          <ConnectComposeBar
            dictation={dictation}
            draftKey={`${deviceId}/${sessionId}`}
            live={live}
            onSend={(text) => terminal?.input.compose(text)}
            takeCtrlKey={(data) => {
              if (!live || !terminal?.input.ctrl) return false;
              terminal.input.typed(data);
              return true;
            }}
          />
        ) : null}
        {touchLayout ? (
          <ConnectKeyBar
            ctrl={ctrl}
            disabled={!live}
            onCtrl={() => terminal?.input.toggleCtrl()}
            onKey={(key) => terminal?.input.key(key)}
          />
        ) : null}
      </div>
      {historyOpen ? (
        <ConnectHistorySheet
          deviceId={deviceId}
          onClose={() => setHistoryOpen(false)}
          sessionId={sessionId}
          title={title}
        />
      ) : null}
      {confirmingEnd ? (
        <ConfirmationDialog
          busy={ending}
          confirmLabel="End session"
          dialogLabel={`End ${title}`}
          icon="x"
          onCancel={() => setConfirmingEnd(false)}
          onConfirm={() => void endSession()}
          portal
          testId="connect-end-session-dialog"
          title={`End ${title}?`}
        >
          {`The session and every program running in it stop on ${deviceName}. Anything not saved in it is lost.`}
        </ConfirmationDialog>
      ) : null}
    </div>
  );
}

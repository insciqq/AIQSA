"use client";

import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import type { UiV2MenuAction } from "@/components/ui-v2";
import { CONNECT_PAGE_PATH } from "@/lib/contracts/connect";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { endConnectSession } from "./connectApi";
import { ConnectPageHeader } from "./ConnectHomeView";
import { ConnectMenu } from "./ConnectMenu";
import { findConnectDevice, useConnectShell } from "./connectShellContext";
import { ConnectStatusBadge } from "./ConnectStatusBadge";
import { ConnectTerminalPane } from "./ConnectTerminalPane";
import type { ConnectViewTransport } from "./connectTerminalSession";
import { CONNECT_PROGRAM_LABELS, connectErrorMessage, connectFolderName } from "./connectText";

export type ConnectSessionViewProps = Readonly<{
  /**
   * Below-terminal controls (key bar, compose field, answer buttons) of the
   * touch layout; empty on the desktop.
   */
  controls?: ReactNode;
  deviceId: string;
  /** Opens the session's scrollable history; the menu omits History without it. */
  onOpenHistory?(): void;
  sessionId: string;
  transport?: ConnectViewTransport;
}>;

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

/** `/connect/<deviceId>/<sessionId>`: the session's header and its live terminal. */
export function ConnectSessionView({ controls, deviceId, onOpenHistory, sessionId, transport }: ConnectSessionViewProps) {
  const router = useRouter();
  const { leave, snapshot, source } = useConnectShell();
  const device = findConnectDevice(snapshot, deviceId);
  const session = device?.sessions.find((candidate) => candidate.id === sessionId) ?? null;
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (snapshot.devices !== null && !device) return <ConnectSessionNotFound />;

  const title = session?.title ?? "Session";
  const deviceName = device?.name ?? "The computer";

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
    ...(onOpenHistory ? [{ icon: "history" as const, label: "History", onSelect: onOpenHistory }] : []),
    {
      icon: "stop",
      label: "End session…",
      onSelect: () => setConfirmingEnd(true),
      separatorBefore: Boolean(onOpenHistory),
      tone: "destructive"
    }
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="connect-session-view">
      <ConnectPageHeader
        title={(
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate">{title}</span>
            <span className="min-w-0 truncate text-metadata font-normal text-ink-muted max-sm:hidden">
              {[device?.name, session ? CONNECT_PROGRAM_LABELS[session.program] : null, session ? connectFolderName(session.cwd) : null]
                .filter(Boolean).join(" · ")}
            </span>
          </span>
        )}
      >
        {session ? <ConnectStatusBadge status={session.status} /> : null}
        <ConnectMenu actions={actions} label="Session actions" />
      </ConnectPageHeader>
      {error ? <p className="v2-connect-alert mx-3 mt-2" role="alert">{error}</p> : null}
      <ConnectTerminalPane
        deviceId={deviceId}
        deviceName={deviceName}
        deviceOnline={device ? device.online : null}
        key={`${deviceId}/${sessionId}`}
        lastSeenAt={device?.lastSeenAt ?? null}
        sessionId={sessionId}
        {...(transport ? { transport } : {})}
      />
      {/* The touch layout's controls mount here, under the terminal. */}
      <div className="v2-connect-session-controls" data-testid="connect-session-controls">{controls}</div>
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

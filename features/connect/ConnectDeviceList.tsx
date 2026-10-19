"use client";

import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import type { UiV2MenuAction } from "@/components/ui-v2";
import { connectSessionPath, type ConnectDevice, type ConnectSession } from "@/lib/contracts/connect";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { revokeConnectDevice } from "./connectApi";
import { ConnectMenu } from "./ConnectMenu";
import { ConnectStatusBadge } from "./ConnectStatusBadge";
import { useConnectShell } from "./connectShellContext";
import { useConnectNow } from "./useConnectNow";
import {
  CONNECT_PROGRAM_LABELS,
  connectErrorMessage,
  connectFolderName,
  connectLastSeenLabel
} from "./connectText";

function newestFirst(left: ConnectSession, right: ConnectSession): number {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt);
}

function SessionRow({ device, session }: Readonly<{ device: ConnectDevice; session: ConnectSession }>) {
  const href = connectSessionPath(device.id, session.id);
  const active = usePathname() === href;
  return (
    <li>
      <Link
        aria-current={active ? "page" : undefined}
        className="v2-connect-session-row v2-focusable"
        data-testid="connect-session-row"
        href={href}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink" title={session.title}>{session.title}</span>
          <span className="mt-0.5 block truncate text-metadata text-ink-muted">
            {CONNECT_PROGRAM_LABELS[session.program]} · {connectFolderName(session.cwd)}
          </span>
        </span>
        <ConnectStatusBadge status={session.status} />
      </Link>
    </li>
  );
}

function DeviceGroup({
  device,
  now,
  onRevoke
}: Readonly<{ device: ConnectDevice; now: number; onRevoke(device: ConnectDevice): void }>) {
  const { openNewSession } = useConnectShell();
  const sessions = [...device.sessions].sort(newestFirst);
  const actions: UiV2MenuAction[] = [
    ...(device.online ? [{ icon: "plus" as const, label: "New session here", onSelect: () => openNewSession(device.id) }] : []),
    { icon: "trash", label: "Revoke…", onSelect: () => onRevoke(device), separatorBefore: device.online, tone: "destructive" }
  ];
  return (
    <section aria-label={device.name} className="v2-connect-device" data-testid="connect-device">
      <header className="flex min-w-0 items-center gap-2 px-2 py-1.5">
        <span
          aria-hidden="true"
          className="v2-connect-online-dot"
          data-online={device.online || undefined}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-ink">{device.name}</span>
          <span className="block truncate text-metadata text-ink-muted" data-testid="connect-device-presence">
            {connectLastSeenLabel(device.online, device.lastSeenAt, now)}
          </span>
        </span>
        <ConnectMenu actions={actions} label={`${device.name} actions`} />
      </header>
      {sessions.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {sessions.map((session) => <SessionRow device={device} key={session.id} session={session} />)}
        </ul>
      ) : (
        <p className="px-2 pb-1 text-metadata text-ink-muted">No sessions</p>
      )}
    </section>
  );
}

/** The user's computers with their sessions, live from the device feed. */
export function ConnectDeviceList() {
  const { snapshot, source } = useConnectShell();
  const now = useConnectNow();
  const router = useRouter();
  const pathname = usePathname();
  const [revoking, setRevoking] = useState<ConnectDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke(device: ConnectDevice) {
    setBusy(true);
    setError(null);
    const result = await revokeConnectDevice(device.id);
    setBusy(false);
    if (!result.ok && result.code !== "connect_not_found") {
      setError(connectErrorMessage(result.code, result.retryAfterSeconds));
      setRevoking(null);
      return;
    }
    setRevoking(null);
    source.removeDevice(device.id);
    if (pathname.startsWith(`/connect/${device.id}/`)) router.push("/connect");
  }

  const devices = snapshot.devices;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="connect-device-list">
      {error ? <p className="v2-connect-alert" role="alert">{error}</p> : null}
      {snapshot.connection === "reconnecting" ? (
        <p className="px-2 text-metadata text-ink-muted" role="status">Reconnecting… The list may be out of date.</p>
      ) : null}
      {devices === null ? (
        snapshot.loadError ? (
          <p className="px-2 text-sm text-ink-secondary" role="alert">
            {connectErrorMessage(snapshot.loadError)} Retrying automatically.
          </p>
        ) : (
          <p className="px-2 text-sm text-ink-muted" role="status">Loading your computers…</p>
        )
      ) : devices.length === 0 ? (
        <p className="px-2 text-sm text-ink-muted">No computers yet. Install aiqsa-connect to add one.</p>
      ) : (
        devices.map((device) => (
          <DeviceGroup device={device} key={device.id} now={now} onRevoke={(target) => setRevoking(target)} />
        ))
      )}
      {revoking ? (
        <ConfirmationDialog
          busy={busy}
          confirmLabel="Revoke"
          dialogLabel={`Revoke ${revoking.name}`}
          onCancel={() => setRevoking(null)}
          onConfirm={() => void revoke(revoking)}
          portal
          testId="connect-revoke-dialog"
          title={`Revoke ${revoking.name}?`}
        >
          {`The computer is disconnected at once and can no longer reach AIQSA. Its sessions keep running on the computer, but you cannot open them here until you run aiqsa-connect login on it again.`}
        </ConfirmationDialog>
      ) : null}
    </div>
  );
}

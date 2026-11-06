"use client";

import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import type { ConnectComputerWire } from "@/lib/contracts/computer";
import { useState } from "react";
import { revokeConnectComputer } from "./connectApi";
import { useConnectShell } from "./connectShellContext";
import { connectComputerSystemLabel, connectErrorMessage, connectLastSeenLabel } from "./connectText";
import { useConnectNow } from "./useConnectNow";

function ComputerRow({
  computer,
  now,
  onRevoke
}: Readonly<{ computer: ConnectComputerWire; now: number; onRevoke(computer: ConnectComputerWire): void }>) {
  return (
    <li className="v2-connect-computer" data-online={computer.online || undefined} data-testid="connect-computer">
      <span aria-hidden="true" className="v2-connect-computer-icon">
        <UiV2Icon name="monitor" />
        <span className="v2-connect-online-dot" data-online={computer.online || undefined} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink" title={computer.name}>{computer.name}</span>
        <span className="block text-metadata text-ink-muted [overflow-wrap:anywhere]" data-testid="connect-computer-facts">
          {connectComputerSystemLabel(computer)} · AIQSA Connect {computer.clientVersion}
        </span>
        <span className="block text-metadata text-ink-secondary" data-testid="connect-computer-presence">
          {connectLastSeenLabel(computer.online, computer.lastSeenAt, now)}
        </span>
      </span>
      <UiV2Button aria-label={`Revoke ${computer.name}`} className="shrink-0" onClick={() => onRevoke(computer)}>
        Revoke…
      </UiV2Button>
    </li>
  );
}

/** The user's computers, live from the feed, each with Revoke behind a confirmation. */
export function ConnectComputerList() {
  const { snapshot, source } = useConnectShell();
  const now = useConnectNow();
  const [revoking, setRevoking] = useState<ConnectComputerWire | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke(computer: ConnectComputerWire) {
    setBusy(true);
    setError(null);
    const result = await revokeConnectComputer(computer.id);
    setBusy(false);
    setRevoking(null);
    // A computer that is already gone is what the user asked for.
    if (!result.ok && result.code !== "connect_not_found" && result.code !== "connect_device_unavailable") {
      setError(connectErrorMessage(result.code, result.retryAfterSeconds));
      return;
    }
    source.removeComputer(computer.id);
  }

  const computers = snapshot.computers;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="connect-computer-list">
      {error ? <p className="v2-connect-alert" role="alert">{error}</p> : null}
      {snapshot.connection === "reconnecting" ? (
        <p className="text-metadata text-ink-muted" role="status">Reconnecting… The list may be out of date.</p>
      ) : null}
      {computers === null ? (
        snapshot.loadError ? (
          <p className="text-sm text-ink-secondary" role="alert">
            {connectErrorMessage(snapshot.loadError)} Retrying automatically.
          </p>
        ) : (
          <p className="text-sm text-ink-muted" role="status">Loading your computers…</p>
        )
      ) : computers.length === 0 ? (
        <p className="text-sm text-ink-muted" data-testid="connect-no-computers">No computers yet. Add one below.</p>
      ) : (
        <ul className="v2-connect-computers">
          {computers.map((computer) => (
            <ComputerRow computer={computer} key={computer.id} now={now} onRevoke={(target) => setRevoking(target)} />
          ))}
        </ul>
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
          The computer is disconnected at once and the AIQSA agent can no longer work on it. Chats that use it
          show it as removed. To use it again, connect it again from this page.
        </ConfirmationDialog>
      ) : null}
    </div>
  );
}

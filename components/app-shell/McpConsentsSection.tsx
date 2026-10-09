"use client";

import { useEffect, useId, useState } from "react";
import { UiV2Button } from "@/components/ui-v2";
import type { McpToolConsentWire } from "@/lib/contracts/mcpApprovals";
import { listMcpToolConsents, revokeMcpToolConsent } from "@/features/answer-outputs-v2/mcpApprovalApi";

type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "error" }>
  | Readonly<{ kind: "ready"; consents: readonly McpToolConsentWire[] }>;

/**
 * Servers whose tools that may change data run without asking ("Always
 * allow for this server" on an approval card), each with Revoke. Answers
 * already running keep the permission they started with; later ones ask.
 * Nothing renders while there are none.
 */
export function McpConsentsSection() {
  const headingId = useId();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listMcpToolConsents(controller.signal)
      .then((consents) => { if (!controller.signal.aborted) setState({ consents, kind: "ready" }); })
      .catch(() => { if (!controller.signal.aborted) setState({ kind: "error" }); });
    return () => controller.abort();
  }, []);

  async function revoke(consent: McpToolConsentWire) {
    if (busy) return;
    setBusy(consent.serverId);
    setError(null);
    try {
      await revokeMcpToolConsent(consent.serverId);
      setState((current) => current.kind === "ready"
        ? { consents: current.consents.filter((entry) => entry.serverId !== consent.serverId), kind: "ready" }
        : current);
      setRevoked(consent.serverName);
    } catch {
      setError(`Always allow for ${consent.serverName} could not be revoked. Try again.`);
    } finally {
      setBusy(null);
    }
  }

  if (state.kind === "loading" || state.kind === "ready" && state.consents.length === 0 && !revoked) return null;
  return (
    <section className="v2-settings-mcp-consents" aria-labelledby={headingId} data-testid="mcp-consents">
      <h3 id={headingId}>Always allowed</h3>
      <p className="v2-settings-field-note">
        Tools of these servers that may change data run without asking you first. Revoking applies to answers started afterwards.
      </p>
      {state.kind === "error" ? (
        <p className="v2-settings-field-note">Always allowed servers could not be loaded. Reopen Studio to try again.</p>
      ) : state.consents.length ? (
        <ul>
          {state.consents.map((consent) => (
            <li key={consent.serverId}>
              <span title={consent.serverName}>{consent.serverName}</span>
              <UiV2Button aria-label={`Revoke always allow for ${consent.serverName}`} busy={busy === consent.serverId}
                disabled={busy !== null && busy !== consent.serverId} type="button" onClick={() => void revoke(consent)}>
                Revoke
              </UiV2Button>
            </li>
          ))}
        </ul>
      ) : null}
      {revoked ? <p className="v2-settings-field-note" role="status">{revoked} will ask for approval again.</p> : null}
      {error ? <p className="v2-settings-field-note" role="alert">{error}</p> : null}
    </section>
  );
}

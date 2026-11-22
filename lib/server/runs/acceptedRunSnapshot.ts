import { decodeConnectorTurn, type ConnectorTurn } from "../connectors/turn";
import type { MaterializedPreparedRunData } from "./runPreparation";

export type AcceptedRunSnapshot = Readonly<{
  /**
   * A native run's entry facts its execution needs besides `prepared`, kept
   * for the Workspace follow-up or PDF continuation that starts it: the Allow
   * an approval continuation names, a connector turn (no self-service tools;
   * Discord's rules), and `userRequest: false` for a turn that is not the
   * user's own request (`TurnProvenance.userRequest`), which takes no
   * self-service tools. `telegram` is how snapshots stored before
   * `connectorTurn` name a Telegram turn; only read.
   */
  native?: Readonly<{ approvalId?: string; connectorTurn?: ConnectorTurn; telegram?: true; userRequest?: false }>;
  prepared: MaterializedPreparedRunData;
  sourceMessageId?: string;
  version: 1;
}>;

/**
 * Whether a stored snapshot's turn is the user's own request. A snapshot stored before the entry facts named it offers
 * the tools it was admitted with, and the commit-time fences still refuse a turn the server wrote
 * (`selfServiceRunAllowedInTransaction`).
 */
export function nativeEntryUserRequest(native: AcceptedRunSnapshot["native"]): boolean {
  return native?.userRequest !== false;
}

/** The connector turn a stored snapshot's entry facts name, the earlier spelling of a Telegram turn included. */
export function nativeEntryConnectorTurn(native: AcceptedRunSnapshot["native"]): ConnectorTurn | undefined {
  return decodeConnectorTurn(native?.connectorTurn) ?? (native?.telegram === true ? "telegram" : undefined);
}

/** A private, immutable intent for a durably accepted preparation gate.
 * Binary originals stay in attachment storage and are revalidated at use. */
export function acceptedRunSnapshot(prepared: MaterializedPreparedRunData, sourceMessageId?: string): AcceptedRunSnapshot {
  return { prepared: { ...prepared, providerRequest: { ...prepared.providerRequest, attachments: [] } },
    ...(sourceMessageId ? { sourceMessageId } : {}), version: 1 };
}

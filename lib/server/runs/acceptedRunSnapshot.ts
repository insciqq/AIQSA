import type { MaterializedPreparedRunData } from "./runPreparation";

export type AcceptedRunSnapshot = Readonly<{
  /**
   * A native run's entry facts its execution needs besides `prepared`, kept
   * for the Workspace follow-up that starts it: the Allow an approval
   * continuation names, and a Telegram turn (no self-service tools).
   */
  native?: Readonly<{ approvalId?: string; telegram?: true }>;
  prepared: MaterializedPreparedRunData;
  sourceMessageId?: string;
  version: 1;
}>;

/** A private, immutable intent for a durably accepted preparation gate.
 * Binary originals stay in attachment storage and are revalidated at use. */
export function acceptedRunSnapshot(prepared: MaterializedPreparedRunData, sourceMessageId?: string): AcceptedRunSnapshot {
  return { prepared: { ...prepared, providerRequest: { ...prepared.providerRequest, attachments: [] } },
    ...(sourceMessageId ? { sourceMessageId } : {}), version: 1 };
}

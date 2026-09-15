import type { MaterializedPreparedRunData } from "./runPreparation";

export type AcceptedRunSnapshot = Readonly<{
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

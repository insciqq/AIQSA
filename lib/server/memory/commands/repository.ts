import { enqueueMemoryJob, type MemoryJobEnqueueResult } from "../persistence/jobs";
import { memorySha256 } from "../persistence/lexical";
import type { LockedMemorySettings, MemoryTransaction } from "../persistence/transaction";

export const MEMORY_COMMAND_PIPELINE_VERSION = "memory-command-v1";

export type MemoryCommandSource = Readonly<{
  activeLeafMessageId: string;
  branchGeneration: number;
  chatId: string;
  sourceHash: string;
  sourceMessageId: string;
  sourceRevision: number;
}>;

/** The caller holds the owner's settings lock in the acceptance transaction.
 * A normal append does not change the command's exact-message identity. */
export async function enqueueMemoryCommand(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  source: MemoryCommandSource
): Promise<MemoryJobEnqueueResult> {
  const sequence = await tx.memoryJob.aggregate({
    _max: { commandSequence: true },
    where: { userId: settings.userId }
  });
  return enqueueMemoryJob(tx, settings, {
    commandSequence: (sequence._max.commandSequence ?? 0) + 1,
    idempotencyFingerprint: memorySha256({
      pipelineVersion: MEMORY_COMMAND_PIPELINE_VERSION,
      sourceMessageId: source.sourceMessageId,
      sourceHash: source.sourceHash
    }),
    kind: "MEMORY_COMMAND",
    pipelineVersion: MEMORY_COMMAND_PIPELINE_VERSION,
    source
  });
}

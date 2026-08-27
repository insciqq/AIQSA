import type { MemoryRecallChunkMessageJoin } from "./chunking";

export const MEMORY_HISTORY_MAX_CHECKPOINT_MESSAGES = 8_192;

export type MemoryHistoryCheckpointMessageIdentity = Readonly<{
  messageId: string;
  sourceMessageUpdatedAt: string;
}>;

export type MemoryHistoryIncrementalChunk = Readonly<{
  id: string;
  messageJoins: readonly MemoryRecallChunkMessageJoin[];
  ordinal: number;
}>;

export type MemoryHistoryTailPlan = Readonly<{
  commonPathMessageCount: number;
  mode: "APPEND" | "DIVERGENCE" | "FULL_REBUILD" | "UNCHANGED";
  rebuildFromMessageOrdinal: number;
  reusedChunkIds: readonly string[];
}>;

// One ordinary chunk can contain twelve messages and one overlapping turn.
// Rewinding this bounded window on divergence preserves content from a chunk
// that source invalidation has already removed from the active-row query.
export const MEMORY_HISTORY_DIVERGENCE_REWIND_MESSAGES = 14;

function sameMessage(
  left: MemoryHistoryCheckpointMessageIdentity,
  right: MemoryHistoryCheckpointMessageIdentity
): boolean {
  return left.messageId === right.messageId &&
    left.sourceMessageUpdatedAt === right.sourceMessageUpdatedAt;
}

/**
 * Plans the expensive read before any message content is loaded. Checkpoint
 * identities prove the common path; stored chunk joins prove which artifacts
 * are wholly before the affected suffix.
 */
export function planMemoryHistoryTailUpdate(input: Readonly<{
  currentMessages: readonly MemoryHistoryCheckpointMessageIdentity[];
  previousChunks: readonly MemoryHistoryIncrementalChunk[];
  previousMessages: readonly MemoryHistoryCheckpointMessageIdentity[];
}>): MemoryHistoryTailPlan {
  const bounded = input.currentMessages.length <= MEMORY_HISTORY_MAX_CHECKPOINT_MESSAGES &&
    input.previousMessages.length <= MEMORY_HISTORY_MAX_CHECKPOINT_MESSAGES;
  let commonPathMessageCount = 0;
  if (bounded) {
    const maximum = Math.min(
      input.currentMessages.length,
      input.previousMessages.length
    );
    while (
      commonPathMessageCount < maximum &&
      sameMessage(
        input.previousMessages[commonPathMessageCount]!,
        input.currentMessages[commonPathMessageCount]!
      )
    ) {
      commonPathMessageCount += 1;
    }
  }
  const unchanged = bounded &&
    input.previousMessages.length > 0 &&
    commonPathMessageCount === input.previousMessages.length &&
    commonPathMessageCount === input.currentMessages.length;
  const append = bounded &&
    input.previousMessages.length > 0 &&
    commonPathMessageCount === input.previousMessages.length &&
    input.currentMessages.length > input.previousMessages.length;
  const mode: MemoryHistoryTailPlan["mode"] = !bounded ||
      input.previousMessages.length === 0
    ? "FULL_REBUILD"
    : unchanged
      ? "UNCHANGED"
      : append
        ? "APPEND"
        : "DIVERGENCE";
  const rebuildFromMessageOrdinal = mode === "FULL_REBUILD"
    ? 0
    : mode === "DIVERGENCE"
      ? Math.max(
          0,
          commonPathMessageCount - MEMORY_HISTORY_DIVERGENCE_REWIND_MESSAGES
        )
      : Math.max(0, commonPathMessageCount - 4);
  const currentOrdinals = new Map(
    input.currentMessages.map((message, ordinal) => [message.messageId, ordinal])
  );
  const reusable = mode === "FULL_REBUILD"
    ? []
    : input.previousChunks.flatMap((chunk) => {
        const proven = chunk.messageJoins.length > 0 &&
          chunk.messageJoins.every((join) => {
            const ordinal = currentOrdinals.get(join.messageId);
            const identity = ordinal === undefined
              ? undefined
              : input.currentMessages[ordinal];
            return ordinal !== undefined &&
              identity?.sourceMessageUpdatedAt === join.sourceMessageUpdatedAt &&
              (mode === "UNCHANGED" || mode === "APPEND" ||
                ordinal < rebuildFromMessageOrdinal);
          });
        return proven ? [chunk.id] : [];
      });
  return Object.freeze({
    commonPathMessageCount,
    mode,
    rebuildFromMessageOrdinal,
    reusedChunkIds: Object.freeze(reusable)
  });
}

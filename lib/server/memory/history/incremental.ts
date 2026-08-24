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

export type MemoryHistoryIncrementalPlan = Readonly<{
  commonPathMessageCount: number;
  mode: "APPEND" | "DIVERGENCE" | "FULL_REBUILD" | "UNCHANGED";
  rebuildFromMessageOrdinal: number;
  rebuiltChunkIds: readonly string[];
  reusedChunkIds: readonly string[];
}>;

function sameMessage(
  left: MemoryHistoryCheckpointMessageIdentity,
  right: MemoryHistoryCheckpointMessageIdentity
): boolean {
  return left.messageId === right.messageId &&
    left.sourceMessageUpdatedAt === right.sourceMessageUpdatedAt;
}

function sameJoin(
  left: MemoryRecallChunkMessageJoin,
  right: MemoryRecallChunkMessageJoin
): boolean {
  return left.messageId === right.messageId &&
    left.ordinal === right.ordinal &&
    left.role === right.role &&
    left.startOffset === right.startOffset &&
    left.endOffset === right.endOffset &&
    left.safeTextHash === right.safeTextHash &&
    left.sourceMessageContentHash === right.sourceMessageContentHash &&
    left.sourceMessageUpdatedAt === right.sourceMessageUpdatedAt;
}

function sameChunk(
  left: MemoryHistoryIncrementalChunk,
  right: MemoryHistoryIncrementalChunk
): boolean {
  return left.id === right.id &&
    left.ordinal === right.ordinal &&
    left.messageJoins.length === right.messageJoins.length &&
    left.messageJoins.every((join, index) => {
      const candidate = right.messageJoins[index];
      return candidate !== undefined && sameJoin(join, candidate);
    });
}

/**
 * Selects only the stable prefix that can reuse its classification and search
 * artifact. The expensive projection/classification/apply work starts one
 * complete user/assistant turn before the append or branch divergence point.
 */
export function planMemoryHistoryIncrementalUpdate(input: Readonly<{
  currentMessages: readonly MemoryHistoryCheckpointMessageIdentity[];
  nextChunks: readonly MemoryHistoryIncrementalChunk[];
  previousChunks: readonly MemoryHistoryIncrementalChunk[];
  previousMessages: readonly MemoryHistoryCheckpointMessageIdentity[];
}>): MemoryHistoryIncrementalPlan {
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
    commonPathMessageCount === input.previousMessages.length &&
    commonPathMessageCount === input.currentMessages.length;
  const append = bounded &&
    commonPathMessageCount === input.previousMessages.length &&
    input.currentMessages.length > input.previousMessages.length;
  const mode: MemoryHistoryIncrementalPlan["mode"] = !bounded ||
      input.previousMessages.length === 0
    ? "FULL_REBUILD"
    : unchanged
      ? "UNCHANGED"
      : append
        ? "APPEND"
        : "DIVERGENCE";
  // A recall turn is exactly one user and one assistant message. Rewinding by
  // one complete turn gives rechunking the configured overlap context.
  const rebuildFromMessageOrdinal = mode === "FULL_REBUILD"
    ? 0
    : Math.max(0, commonPathMessageCount - 2);
  const currentMessageOrdinals = new Map(
    input.currentMessages.map((message, ordinal) => [message.messageId, ordinal])
  );
  const reusable: string[] = [];
  const prefixLength = Math.min(
    input.previousChunks.length,
    input.nextChunks.length
  );
  if (mode !== "FULL_REBUILD" && mode !== "UNCHANGED") {
    for (let index = 0; index < prefixLength; index += 1) {
      const previous = input.previousChunks[index]!;
      const next = input.nextChunks[index]!;
      if (!sameChunk(previous, next)) break;
      const sourceOrdinals = next.messageJoins.map((join) =>
        currentMessageOrdinals.get(join.messageId));
      if (
        sourceOrdinals.some((ordinal) => ordinal === undefined) ||
        sourceOrdinals.some((ordinal) => ordinal! >= rebuildFromMessageOrdinal)
      ) break;
      reusable.push(next.id);
    }
  } else if (mode === "UNCHANGED") {
    for (let index = 0; index < prefixLength; index += 1) {
      const previous = input.previousChunks[index]!;
      const next = input.nextChunks[index]!;
      if (!sameChunk(previous, next)) break;
      reusable.push(next.id);
    }
  }
  const reused = new Set(reusable);
  return Object.freeze({
    commonPathMessageCount,
    mode,
    rebuildFromMessageOrdinal,
    rebuiltChunkIds: Object.freeze(
      input.nextChunks.flatMap((chunk) => reused.has(chunk.id) ? [] : [chunk.id])
    ),
    reusedChunkIds: Object.freeze(reusable)
  });
}

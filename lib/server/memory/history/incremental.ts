import {
  DEFAULT_MEMORY_HISTORY_CHUNKING_OPTIONS,
  type MemoryRecallChunkMessageJoin
} from "./chunking";
import { MEMORY_TOOL_EVENT_MAX_SOURCE_CALLS } from "./toolEvents";

// Explicit active-path ceiling. Every job proves the whole checkpoint path and
// retains its prefix rows, so this bounds per-job metadata and retained-row
// memory. A longer path fails with `memory_history_path_limit_exceeded`
// instead of being mistaken for a corrupt or cyclic path.
export const MEMORY_HISTORY_MAX_CHECKPOINT_MESSAGES = 8_192;
export const MEMORY_HISTORY_PATH_LIMIT_EXCEEDED_CODE =
  "memory_history_path_limit_exceeded";

/**
 * Work admitted by one INDEX_HISTORY commit. A longer uncovered tail is
 * indexed in consecutive pages: each committed page advances the checkpoint
 * cursor (`lastIndexedMessageId` plus checkpoint message rows) and the job's
 * next pass resumes with the ordinary APPEND proof. The bounds apply to
 * rebuilt work in one commit, never to retained history.
 */
export type MemoryHistoryIndexPageLimits = Readonly<{
  maxChunks: number;
  maxContentBytes: number;
  /** Estimated index writes (see `memoryHistoryIndexWriteCost`) one commit
   * applies while it holds the owner and source chat locks. */
  maxIndexWrites: number;
  maxMessages: number;
  maxToolCalls: number;
}>;

// Write statements a page sends while its commit holds the owner row and the
// source chat FOR SHARE, estimated before any content is read. Each message
// joins its recall round; about every 2.2 KB of stored content becomes one
// chunk and one round segment, each a row with its source map and search
// entry; a settled tool call becomes one observation with its entry. On a
// disposable database a statement took about 1.2 ms, and a page of 600
// estimated writes committed in about a second.
const MEMORY_HISTORY_INDEX_MESSAGE_WRITES = 3;
const MEMORY_HISTORY_INDEX_CONTENT_BYTES_PER_WRITE = 220;
const MEMORY_HISTORY_INDEX_TOOL_CALL_WRITES = 3;

export const DEFAULT_MEMORY_HISTORY_INDEX_PAGE_LIMITS: MemoryHistoryIndexPageLimits =
  Object.freeze({
    maxChunks: DEFAULT_MEMORY_HISTORY_CHUNKING_OPTIONS.maxChunks,
    maxContentBytes: 4 * 1024 * 1024,
    maxIndexWrites: 600,
    maxMessages: 1_024,
    maxToolCalls: MEMORY_TOOL_EVENT_MAX_SOURCE_CALLS
  });

export function memoryHistoryIndexPageLimitsAreValid(
  limits: MemoryHistoryIndexPageLimits
): boolean {
  return Number.isSafeInteger(limits.maxChunks) && limits.maxChunks >= 1 &&
    limits.maxChunks <= DEFAULT_MEMORY_HISTORY_CHUNKING_OPTIONS.maxChunks &&
    Number.isSafeInteger(limits.maxContentBytes) && limits.maxContentBytes >= 1 &&
    Number.isSafeInteger(limits.maxIndexWrites) && limits.maxIndexWrites >= 1 &&
    Number.isSafeInteger(limits.maxMessages) && limits.maxMessages >= 1 &&
    Number.isSafeInteger(limits.maxToolCalls) && limits.maxToolCalls >= 1;
}

/**
 * Index writes one message adds to a page: its content when the page
 * reprojects it (null when it does not), and its settled tool calls when the
 * page rebuilds their observations (zero when it does not).
 */
export function memoryHistoryIndexWriteCost(input: Readonly<{
  contentBytes: number | null;
  toolCalls: number;
}>): number {
  const content = input.contentBytes === null
    ? 0
    : MEMORY_HISTORY_INDEX_MESSAGE_WRITES +
      Math.ceil(Math.max(0, input.contentBytes) / MEMORY_HISTORY_INDEX_CONTENT_BYTES_PER_WRITE);
  return content + Math.max(0, input.toolCalls) * MEMORY_HISTORY_INDEX_TOOL_CALL_WRITES;
}

/**
 * The smallest page: the first uncovered recall unit, i.e. a prompt with its
 * reply, or one standalone message. A page never ends inside that unit.
 */
export function memoryHistoryIndexMinimumPageEnd(
  roles: readonly string[],
  firstUncoveredOrdinal: number
): number {
  if (firstUncoveredOrdinal >= roles.length) return roles.length;
  return roles[firstUncoveredOrdinal] === "user" &&
      roles[firstUncoveredOrdinal + 1] === "assistant"
    ? firstUncoveredOrdinal + 2
    : firstUncoveredOrdinal + 1;
}

/** Keeps a later prompt with its reply when a page would end between them. */
export function alignMemoryHistoryIndexPageEnd(
  roles: readonly string[],
  minimumEnd: number,
  end: number
): number {
  if (
    end < roles.length &&
    end - 1 >= minimumEnd &&
    roles[end - 1] === "user" &&
    roles[end] === "assistant"
  ) {
    return end - 1;
  }
  return end;
}

/**
 * Largest page end whose cumulative cost from `costStartOrdinal` fits
 * `limit`. The minimum recall unit is admitted even when it alone exceeds
 * the budget: it is the smallest checkpoint step.
 */
export function boundMemoryHistoryIndexPageEnd(input: Readonly<{
  cost: (ordinal: number) => number;
  costStartOrdinal: number;
  limit: number;
  maximumEnd: number;
  minimumEnd: number;
}>): number {
  let total = 0;
  for (let ordinal = input.costStartOrdinal; ordinal < input.maximumEnd; ordinal += 1) {
    total += input.cost(ordinal);
    if (total > input.limit) {
      return Math.min(input.maximumEnd, Math.max(input.minimumEnd, ordinal));
    }
  }
  return input.maximumEnd;
}

/** Halves the uncovered part of a page, or returns null at the minimum unit. */
export function shrinkMemoryHistoryIndexPageEnd(
  roles: readonly string[],
  firstUncoveredOrdinal: number,
  minimumEnd: number,
  end: number
): number | null {
  if (end <= minimumEnd) return null;
  return alignMemoryHistoryIndexPageEnd(
    roles,
    minimumEnd,
    Math.max(
      minimumEnd,
      firstUncoveredOrdinal + Math.ceil((end - firstUncoveredOrdinal) / 2)
    )
  );
}

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

import type { MemoryHistoryItemState } from "@prisma/client";
import type { MemoryTransaction } from "../persistence/transaction";
import {
  projectMemoryRecallRoundSegments,
  type MemoryRecallRoundSegmentMessageJoin,
  type MemoryRecallRoundSegmentProjection,
  type MemoryRecallRoundSegmentSource
} from "./segments";

/** A stored segment row with its ordered source map, read for comparison. */
export type PersistedMemoryRecallRoundSegment = Readonly<{
  approxTokens: number;
  contextualKeyPolicyVersion: string;
  contextualKeyState: string;
  contextualNarrativeText: string;
  contextualSearchHash: string;
  contextualSearchText: string;
  evidenceRootHash: string;
  id: string;
  languageCode: string;
  occurredFrom: Date;
  occurredTo: Date;
  position: string;
  projectionVersion: string;
  rawEndOffsetUtf16: number;
  rawSafeText: string;
  rawSafeTextHash: string;
  rawStartOffsetUtf16: number;
  redactionReasonCodes: string[];
  redactionState: "EXCLUDED" | "NOT_NEEDED" | "REDACTED";
  roundId: string;
  safetyClass: "HIGHLY_SENSITIVE" | "NORMAL" | "SECRET_TAINTED" | "SENSITIVE";
  segmentOrdinal: number;
  sourceRevisionAtCreation: number;
  state: MemoryHistoryItemState;
  supportingRoundIds: string[];
  messageJoins: readonly MemoryRecallRoundSegmentMessageJoin[];
}>;

/** The projection form of one stored source-map row. */
export function persistedMemoryRecallRoundSegmentJoin(row: Readonly<{
  messageId: string;
  ordinal: number;
  role: string;
  safeTextHash: string;
  segmentEndOffset: number;
  segmentStartOffset: number;
  sourceEndOffset: number;
  sourceMessageContentHash: string;
  sourceMessageUpdatedAt: Date;
  sourceStartOffset: number;
}>): MemoryRecallRoundSegmentMessageJoin {
  return {
    messageId: row.messageId,
    ordinal: row.ordinal,
    role: row.role as MemoryRecallRoundSegmentMessageJoin["role"],
    safeTextHash: row.safeTextHash,
    segmentEndOffset: row.segmentEndOffset,
    segmentStartOffset: row.segmentStartOffset,
    sourceEndOffset: row.sourceEndOffset,
    sourceMessageContentHash: row.sourceMessageContentHash,
    sourceMessageUpdatedAt: row.sourceMessageUpdatedAt.toISOString(),
    sourceStartOffset: row.sourceStartOffset
  };
}

export function memoryRecallRoundSegmentMatches(
  left: PersistedMemoryRecallRoundSegment,
  right: MemoryRecallRoundSegmentProjection
): boolean {
  return left.id === right.id &&
    left.approxTokens === right.approxTokens &&
    left.contextualKeyPolicyVersion === right.contextualKeyPolicyVersion &&
    left.contextualKeyState === right.contextualKeyState &&
    left.contextualNarrativeText === right.contextualNarrativeText &&
    left.contextualSearchHash === right.contextualSearchHash &&
    left.contextualSearchText === right.contextualSearchText &&
    left.evidenceRootHash === right.evidenceRootHash &&
    left.languageCode === right.languageCode &&
    left.occurredFrom.toISOString() === right.occurredFrom &&
    left.occurredTo.toISOString() === right.occurredTo &&
    left.position === right.position &&
    left.projectionVersion === right.projectionVersion &&
    left.rawEndOffsetUtf16 === right.rawEndOffsetUtf16 &&
    left.rawSafeText === right.rawSafeText &&
    left.rawSafeTextHash === right.rawSafeTextHash &&
    left.rawStartOffsetUtf16 === right.rawStartOffsetUtf16 &&
    JSON.stringify(left.redactionReasonCodes) === JSON.stringify(right.redactionReasonCodes) &&
    left.redactionState === right.redactionState &&
    left.roundId === right.roundId &&
    left.safetyClass === right.safetyClass &&
    left.segmentOrdinal === right.ordinal &&
    left.sourceRevisionAtCreation === right.sourceRevision &&
    left.state === right.publicationState &&
    JSON.stringify(left.supportingRoundIds) === JSON.stringify(right.supportingRoundIds);
}

/** True only when the stored rows already are exactly the expected projection,
 * including every ordered source-map row; a repair would then write nothing. */
export function memoryRecallRoundSegmentsMatch(
  current: readonly PersistedMemoryRecallRoundSegment[],
  expected: readonly MemoryRecallRoundSegmentProjection[]
): boolean {
  return current.length === expected.length && expected.every((segment) => {
    const stored = current.find((candidate) => candidate.id === segment.id);
    return stored !== undefined && memoryRecallRoundSegmentMatches(stored, segment) &&
      stored.messageJoins.length === segment.messageJoins.length &&
      segment.messageJoins.every((join, index) =>
        JSON.stringify(join) === JSON.stringify(stored.messageJoins[index]));
  });
}

/**
 * Repairs the versioned child projection without publishing it into any index
 * generation. Search generations remain independently rebuildable/rollbackable.
 */
export async function persistMemoryRecallRoundSegmentProjection(
  tx: MemoryTransaction,
  round: MemoryRecallRoundSegmentSource,
  invalidatedAt: Date
): Promise<readonly MemoryRecallRoundSegmentProjection[]> {
  const segments = projectMemoryRecallRoundSegments(round);
  const desiredIds = segments.map(({ id }) => id);
  const stale = await tx.memoryRecallRoundSegment.findMany({
    select: { id: true },
    where: {
      ...(desiredIds.length > 0 ? { id: { notIn: desiredIds } } : {}),
      roundId: round.id,
      state: { in: ["ACTIVE", "SUPPRESSED"] },
      userId: round.userId
    }
  });
  if (stale.length > 0) {
    const staleIds = stale.map(({ id }) => id);
    await tx.memorySearchEntry.deleteMany({
      where: { recallRoundSegmentId: { in: staleIds }, userId: round.userId }
    });
    await tx.memoryRecallRoundSegment.updateMany({
      data: { invalidatedAt, state: "INVALIDATED" },
      where: {
        id: { in: staleIds },
        state: { in: ["ACTIVE", "SUPPRESSED"] },
        userId: round.userId
      }
    });
  }
  for (const segment of segments) {
    await tx.memoryRecallRoundSegment.upsert({
      create: {
        approxTokens: segment.approxTokens,
        chatId: segment.chatId,
        contextualKeyPolicyVersion: segment.contextualKeyPolicyVersion,
        contextualKeyState: segment.contextualKeyState,
        contextualNarrativeText: segment.contextualNarrativeText,
        contextualSearchHash: segment.contextualSearchHash,
        contextualSearchText: segment.contextualSearchText,
        evidenceRootHash: segment.evidenceRootHash,
        id: segment.id,
        languageCode: segment.languageCode,
        occurredFrom: new Date(segment.occurredFrom),
        occurredTo: new Date(segment.occurredTo),
        position: segment.position,
        projectionVersion: segment.projectionVersion,
        rawEndOffsetUtf16: segment.rawEndOffsetUtf16,
        rawSafeText: segment.rawSafeText,
        rawSafeTextHash: segment.rawSafeTextHash,
        rawStartOffsetUtf16: segment.rawStartOffsetUtf16,
        redactionReasonCodes: [...segment.redactionReasonCodes],
        redactionState: segment.redactionState,
        roundId: segment.roundId,
        safetyClass: segment.safetyClass,
        segmentOrdinal: segment.ordinal,
        sourceRevisionAtCreation: segment.sourceRevision,
        state: segment.publicationState,
        supportingRoundIds: [...segment.supportingRoundIds],
        userId: segment.userId
      },
      update: {
        approxTokens: segment.approxTokens,
        contextualKeyPolicyVersion: segment.contextualKeyPolicyVersion,
        contextualKeyState: segment.contextualKeyState,
        contextualNarrativeText: segment.contextualNarrativeText,
        contextualSearchHash: segment.contextualSearchHash,
        contextualSearchText: segment.contextualSearchText,
        evidenceRootHash: segment.evidenceRootHash,
        invalidatedAt: null,
        languageCode: segment.languageCode,
        occurredFrom: new Date(segment.occurredFrom),
        occurredTo: new Date(segment.occurredTo),
        position: segment.position,
        projectionVersion: segment.projectionVersion,
        rawEndOffsetUtf16: segment.rawEndOffsetUtf16,
        rawSafeText: segment.rawSafeText,
        rawSafeTextHash: segment.rawSafeTextHash,
        rawStartOffsetUtf16: segment.rawStartOffsetUtf16,
        redactionReasonCodes: [...segment.redactionReasonCodes],
        redactionState: segment.redactionState,
        safetyClass: segment.safetyClass,
        segmentOrdinal: segment.ordinal,
        sourceRevisionAtCreation: segment.sourceRevision,
        state: segment.publicationState,
        supportingRoundIds: [...segment.supportingRoundIds]
      },
      where: { id: segment.id }
    });
    await tx.memoryRecallRoundSegmentMessage.deleteMany({
      where: { segmentId: segment.id, userId: segment.userId }
    });
    await tx.memoryRecallRoundSegmentMessage.createMany({
      data: segment.messageJoins.map((join) => ({
        chatId: segment.chatId,
        messageId: join.messageId,
        ordinal: join.ordinal,
        role: join.role,
        roundId: segment.roundId,
        safeTextHash: join.safeTextHash,
        segmentEndOffset: join.segmentEndOffset,
        segmentId: segment.id,
        segmentStartOffset: join.segmentStartOffset,
        sourceEndOffset: join.sourceEndOffset,
        sourceMessageContentHash: join.sourceMessageContentHash,
        sourceMessageUpdatedAt: new Date(join.sourceMessageUpdatedAt),
        sourceStartOffset: join.sourceStartOffset,
        userId: segment.userId
      }))
    });
  }
  return segments;
}

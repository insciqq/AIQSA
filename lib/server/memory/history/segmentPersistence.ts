import type { MemoryTransaction } from "../persistence/transaction";
import {
  projectMemoryRecallRoundSegments,
  type MemoryRecallRoundSegmentProjection,
  type MemoryRecallRoundSegmentSource
} from "./segments";

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

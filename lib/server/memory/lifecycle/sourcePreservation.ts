import { Prisma } from "@prisma/client";
import {
  loadPersonalEligibleFactVersionIds,
  memoryExactMessageEvidenceIsCurrent,
  memoryPersonalEvidenceRowPredicate
} from "../persistence/eligibility";
import { memoryPersistenceFailure } from "../persistence/errors";
import type { MemoryTransaction } from "../persistence/transaction";

export type MemoryForgetSource = Readonly<{
  branchGeneration: number;
  chatId: string;
  messageId: string;
  preservedEvidenceIds?: readonly string[];
}>;

type Evidence = Readonly<{
  branchGeneration: number;
  chatId: string;
  content: Prisma.JsonValue;
  evidenceFingerprint: string | null;
  factVersionId: string;
  id: string;
  messageId: string;
  safeExcerpt: string;
  safeSourceHash: string;
  sourceEndOffset: number | null;
  sourceMessageContentHash: string | null;
  sourceProjectionVersion: string;
  sourceStartOffset: number | null;
}>;

function sourceKey(source: MemoryForgetSource): string {
  return JSON.stringify([source.chatId, source.messageId, source.branchGeneration]);
}

/** A shared source can retain only a different, already admitted exact span.
 * Unknown/overlapping support needs a narrower command, never a broader delete. */
export function independentForgetEvidence(
  peer: Evidence,
  forgotten: readonly Evidence[]
): boolean {
  const sameSource = forgotten.filter((item) => sourceKey(item) === sourceKey(peer));
  return sameSource.length > 0 && memoryExactMessageEvidenceIsCurrent(peer) &&
    sameSource.every((item) => memoryExactMessageEvidenceIsCurrent(item) &&
      item.sourceMessageContentHash === peer.sourceMessageContentHash &&
      (peer.sourceEndOffset! <= item.sourceStartOffset! ||
        peer.sourceStartOffset! >= item.sourceEndOffset!));
}

export async function prepareMemoryForgetSourcePreservation(
  tx: MemoryTransaction,
  userId: string,
  factIds: readonly string[],
  versionIds: readonly string[],
  sources: readonly MemoryForgetSource[]
): Promise<Readonly<{
  peerVersionIds: readonly string[];
  sources: readonly MemoryForgetSource[];
}>> {
  if (sources.length === 0) return { peerVersionIds: [], sources };
  const unique = new Map(sources.map((source) => [sourceKey(source), source]));
  if (unique.size > 256) return memoryPersistenceFailure("memory_partial_forget_ambiguous");
  const messageIds = [...new Set(sources.map(({ messageId }) => messageId))];
  const forgotten = await tx.$queryRaw<Evidence[]>(Prisma.sql`
    SELECT support.*, message."content"
    FROM "MemoryEvidence" AS support
    INNER JOIN "Message" AS message
      ON message."id" = support."messageId" AND message."chatId" = support."chatId"
    WHERE support."userId" = ${userId}
      AND support."factVersionId" IN (${Prisma.join([...versionIds])})
      AND support."sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
  `);
  const peers = await tx.$queryRaw<Evidence[]>(Prisma.sql`
    SELECT support.*, evidence_message."content"
    FROM "MemoryEvidence" AS support
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = support."userId" AND version."id" = support."factVersionId"
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
    INNER JOIN "Chat" AS evidence_chat
      ON evidence_chat."userId" = support."userId" AND evidence_chat."id" = support."chatId"
      AND evidence_chat."projectId" IS NULL
      AND evidence_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND evidence_chat."permanentDeletionAt" IS NULL
    INNER JOIN "Message" AS evidence_message
      ON evidence_message."chatId" = support."chatId" AND evidence_message."id" = support."messageId"
      AND evidence_message."role" = 'user'
    WHERE support."messageId" IN (${Prisma.join(messageIds)})
      AND fact."id" NOT IN (${Prisma.join([...factIds])})
      AND fact."currentVersionId" = version."id"
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
      AND version."contentPurgedAt" IS NULL
      AND (version."expiresAt" IS NULL OR version."expiresAt" > CURRENT_TIMESTAMP)
      AND ${memoryPersonalEvidenceRowPredicate(userId)}
    ORDER BY support."id"
    LIMIT 257
  `);
  if (peers.length > 256) return memoryPersistenceFailure("memory_partial_forget_ambiguous");
  const eligible = await loadPersonalEligibleFactVersionIds(
    tx, userId, peers.map(({ factVersionId }) => factVersionId)
  );
  const retained = peers.filter((peer) => eligible.has(peer.factVersionId) && unique.has(sourceKey(peer)));
  if (retained.some((peer) => !independentForgetEvidence(peer, forgotten))) {
    return memoryPersistenceFailure("memory_partial_forget_ambiguous");
  }
  return {
    peerVersionIds: [...new Set(retained.map(({ factVersionId }) => factVersionId))],
    sources: [...unique].map(([key, source]) => ({
      ...source,
      preservedEvidenceIds: retained.filter((peer) => sourceKey(peer) === key).map(({ id }) => id)
    }))
  };
}

export async function assertMemoryForgetPeersRetained(
  tx: MemoryTransaction, userId: string, peerVersionIds: readonly string[]
): Promise<void> {
  const eligible = await loadPersonalEligibleFactVersionIds(tx, userId, peerVersionIds);
  if (peerVersionIds.some((id) => !eligible.has(id))) {
    memoryPersistenceFailure("memory_partial_forget_ambiguous");
  }
}

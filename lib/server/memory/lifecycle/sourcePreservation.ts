import { Prisma } from "@prisma/client";
import {
  loadPersonalEligibleFactVersionIds,
  memoryExactMessageEvidenceIsCurrent,
  memoryPersonalEvidenceRowPredicate,
  type MemoryEvidenceSourceProjections
} from "../persistence/eligibility";
import { memoryPersistenceFailure } from "../persistence/errors";
import type { MemoryTransaction } from "../persistence/transaction";

export type MemoryForgetSource = Readonly<{
  branchGeneration: number;
  chatId: string;
  messageId: string;
  preservedEvidenceIds?: readonly string[];
  retrievalOnly?: boolean;
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

/** Measured capacity of one synchronous Forget (issue #42 regression):
 * larger source or peer sets fail closed with a bounded reason. */
export const MEMORY_FORGET_SOURCE_CAPACITY = 4096;
export const MEMORY_FORGET_PEER_CAPACITY = 4096;
/** `MemorySuppression_preserved_evidence_check` bound per fenced message. */
const PRESERVED_EVIDENCE_PER_SOURCE = 256;
const QUERY_BATCH = 500;

function sourceKey(source: Pick<MemoryForgetSource, "branchGeneration" | "chatId" | "messageId">): string {
  return JSON.stringify([source.chatId, source.messageId, source.branchGeneration]);
}

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += QUERY_BATCH) {
    result.push(values.slice(index, index + QUERY_BATCH));
  }
  return result;
}

/** The database can preserve only evidence with exact provenance columns
 * (`MemorySuppression_preserved_source_guard`). */
function preservableEvidence(peer: Evidence): boolean {
  return peer.evidenceFingerprint !== null && peer.sourceStartOffset !== null &&
    peer.sourceEndOffset !== null && peer.sourceMessageContentHash !== null &&
    peer.sourceMessageContentHash === peer.safeSourceHash;
}

/** Whether a retained peer may keep its evidence in a fenced message.
 * A direct source was testimony for the forgotten fact: its whole message is
 * fenced against new extraction while another fact's admitted evidence keeps
 * attesting that fact, even when spans overlap or either side is inexact or
 * historical. A retrieval-only echo was never testimony for the forgotten
 * fact; there only exact current peer testimony stays independent. */
export function independentForgetEvidence(
  peer: Evidence,
  source: Pick<MemoryForgetSource, "retrievalOnly">,
  projections?: MemoryEvidenceSourceProjections
): boolean {
  return source.retrievalOnly !== true || memoryExactMessageEvidenceIsCurrent(peer, projections);
}

async function loadEligible(
  tx: MemoryTransaction,
  userId: string,
  versionIds: readonly string[]
): Promise<Set<string>> {
  const eligible = new Set<string>();
  for (const batch of batches([...new Set(versionIds)])) {
    for (const id of await loadPersonalEligibleFactVersionIds(tx, userId, batch)) eligible.add(id);
  }
  return eligible;
}

export async function prepareMemoryForgetSourcePreservation(
  tx: MemoryTransaction,
  userId: string,
  factIds: readonly string[],
  sources: readonly MemoryForgetSource[]
): Promise<Readonly<{
  peerVersionIds: readonly string[];
  sources: readonly MemoryForgetSource[];
}>> {
  if (sources.length === 0) return { peerVersionIds: [], sources };
  // A message is retrieval-only only when every route to it is an echo.
  const unique = new Map<string, MemoryForgetSource>();
  for (const source of sources) {
    const key = sourceKey(source);
    const prior = unique.get(key);
    unique.set(key, {
      branchGeneration: source.branchGeneration,
      chatId: source.chatId,
      messageId: source.messageId,
      retrievalOnly: (prior ? prior.retrievalOnly === true : true) && source.retrievalOnly === true
    });
  }
  if (unique.size > MEMORY_FORGET_SOURCE_CAPACITY) {
    return memoryPersistenceFailure("memory_forget_source_limit");
  }
  const messageIds = [...new Set([...unique.values()].map(({ messageId }) => messageId))];
  const peers: Evidence[] = [];
  for (const batch of batches(messageIds)) {
    peers.push(...await tx.$queryRaw<Evidence[]>(Prisma.sql`
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
      WHERE support."messageId" IN (${Prisma.join(batch)})
        AND fact."id" NOT IN (${Prisma.join([...factIds])})
        AND fact."currentVersionId" = version."id"
        AND fact."state" = 'ACTIVE'::"MemoryFactState"
        AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
        AND version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
        AND version."contentPurgedAt" IS NULL
        AND (version."expiresAt" IS NULL OR version."expiresAt" > CURRENT_TIMESTAMP)
        AND ${memoryPersonalEvidenceRowPredicate(userId)}
      ORDER BY support."id"
      LIMIT ${MEMORY_FORGET_PEER_CAPACITY + 1 - peers.length}
    `));
    if (peers.length > MEMORY_FORGET_PEER_CAPACITY) {
      return memoryPersistenceFailure("memory_forget_peer_limit");
    }
  }
  const eligible = await loadEligible(tx, userId, peers.map(({ factVersionId }) => factVersionId));
  const retained = peers.filter((peer) => eligible.has(peer.factVersionId) && unique.has(sourceKey(peer)));
  // One projection per message; a long message can carry many peer spans.
  const projections: MemoryEvidenceSourceProjections = new Map();
  const preserved = new Map<string, string[]>();
  for (const peer of retained) {
    const key = sourceKey(peer);
    if (!independentForgetEvidence(peer, unique.get(key)!, projections)) {
      return memoryPersistenceFailure("memory_forget_peer_retrieval_inexact");
    }
    // Unpreservable (legacy-shaped) support is fenced; if that removes the
    // peer's last support, the post-fence check refuses the whole Forget.
    if (!preservableEvidence(peer)) continue;
    const ids = preserved.get(key) ?? [];
    ids.push(peer.id);
    if (ids.length > PRESERVED_EVIDENCE_PER_SOURCE) {
      return memoryPersistenceFailure("memory_forget_peer_limit");
    }
    preserved.set(key, ids);
  }
  return {
    peerVersionIds: [...new Set(retained.map(({ factVersionId }) => factVersionId))],
    sources: [...unique].map(([key, source]) => ({
      ...source,
      preservedEvidenceIds: preserved.get(key) ?? []
    }))
  };
}

/** Peers that lost eligibility only because they depend on the forgotten
 * versions, on a fenced message, or on a source removed by automatic cleanup
 * whose cleanup fenced a message this Forget fences, are a legitimate cascade
 * (the same fence applies silently to dependents outside shared sources). Any
 * other loss is unexpected and refuses the whole Forget. Returns the cascaded
 * peer count. */
export async function assertMemoryForgetPeersRetained(
  tx: MemoryTransaction,
  userId: string,
  peerVersionIds: readonly string[],
  fenced: Readonly<{ messageIds: readonly string[]; versionIds: readonly string[] }>
): Promise<number> {
  const eligible = await loadEligible(tx, userId, peerVersionIds);
  const lost = [...new Set(peerVersionIds)].filter((id) => !eligible.has(id));
  if (lost.length === 0) return 0;
  const messageBatches = batches([...new Set(fenced.messageIds)]);
  const fencedSources = [
    ...(fenced.versionIds.length > 0
      ? [Prisma.sql`chain."sourceFactVersionId" IN (${Prisma.join([...fenced.versionIds])})`] : []),
    ...messageBatches.map((batch) => Prisma.sql`chain."sourceMessageId" IN (${Prisma.join(batch)})`),
    // A removed source stays a valid hint only while every message its
    // removal fenced passes the ordinary message fences.
    ...messageBatches.map((batch) => Prisma.sql`(
      chain."sourceFactVersionId" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "MemoryMaintenanceReview" AS removal
        INNER JOIN "MemoryMaintenanceSuppression" AS cleanup_fence
          ON cleanup_fence."userId" = removal."userId" AND cleanup_fence."memoryReviewId" = removal."id"
        WHERE removal."userId" = ${userId} AND removal."factVersionId" = chain."sourceFactVersionId"
          AND removal."disposition" = 'REMOVED'
          AND cleanup_fence."sourceMessageId" IN (${Prisma.join(batch)})
      )
      AND aiqsa_memory_dependency_source_removed(${userId}, chain."sourceFactVersionId")
    )`)
  ];
  if (fencedSources.length === 0) return memoryPersistenceFailure("memory_forget_peer_ineligible_after_fence");
  const cascaded = new Set<string>();
  for (const batch of batches(lost)) {
    const rows = await tx.$queryRaw<Array<{ peer: string }>>(Prisma.sql`
      WITH RECURSIVE dependency_chain AS (
        SELECT dependency."targetFactVersionId" AS peer, dependency."sourceFactVersionId",
          dependency."sourceMessageId", 1 AS depth
        FROM "MemoryFactVersionSourceDependency" AS dependency
        WHERE dependency."userId" = ${userId}
          AND dependency."targetFactVersionId" IN (${Prisma.join(batch)})
        UNION ALL
        SELECT chain.peer, nested."sourceFactVersionId", nested."sourceMessageId", chain.depth + 1
        FROM dependency_chain AS chain
        INNER JOIN "MemoryFactVersionSourceDependency" AS nested
          ON nested."userId" = ${userId}
          AND nested."targetFactVersionId" = chain."sourceFactVersionId"
        WHERE chain."sourceFactVersionId" IS NOT NULL AND chain.depth < 3
      )
      SELECT DISTINCT chain.peer
      FROM dependency_chain AS chain
      WHERE ${Prisma.join(fencedSources, " OR ")}
    `);
    for (const { peer } of rows) cascaded.add(peer);
  }
  if (lost.some((id) => !cascaded.has(id))) {
    return memoryPersistenceFailure("memory_forget_peer_ineligible_after_fence");
  }
  return cascaded.size;
}

// Content-free count of legitimately cascaded peers, carried from the
// committed repository result to the consumer diagnostic without a wire field.
const cascadedPeerCounts = new WeakMap<object, number>();

export function rememberMemoryForgetPeerCascade(target: object, count: number): void {
  if (Number.isSafeInteger(count) && count > 0) cascadedPeerCounts.set(target, count);
}

export function memoryForgetPeerCascadeCount(target: unknown): number {
  return target !== null && typeof target === "object" ? cascadedPeerCounts.get(target) ?? 0 : 0;
}

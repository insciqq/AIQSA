import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type MemoryLexicalProjectionOperation,
  type MemorySearchItemType,
  type PrismaClient
} from "@prisma/client";
import {
  MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
  MEMORY_OPENSEARCH_BACKEND_KIND,
  MEMORY_OPENSEARCH_MAPPING_VERSION,
  MEMORY_OPENSEARCH_MAX_INTEGRITY_DOCUMENTS,
  MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
  MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
  memoryOpenSearchIntegrityFingerprintMaterial
} from "../../search/opensearch/memoryContract";
import {
  memoryRedactionHasMeaningfulRemainder,
  redactMemorySecrets
} from "../explicit/safety";
import {
  memorySha256,
  normalizeMemorySearchText
} from "../persistence/lexical";

const safeErrorCodePattern = /^[a-z0-9_]{1,64}$/u;
const safeHashPattern = /^[a-f0-9]{64}$/u;
const activeProjectionGenerationStates = [
  "ACTIVE", "BUILDING", "CATCHING_UP", "FAILED", "READY", "SUPERSEDED"
] as const;

export type MemoryLexicalProjectionClaim = Readonly<{
  attemptCount: number;
  id: string;
  indexGenerationId: string | null;
  leaseToken: string;
  memoryRevisionSnapshot: number;
  operation: MemoryLexicalProjectionOperation;
  searchEntryId: string | null;
  sequence: bigint;
  userId: string;
}>;

export type MemoryLexicalProjectionCanonicalEntry = Readonly<{
  indexGenerationId: string;
  itemType: MemorySearchItemType;
  lexicalText: string;
  safeContentHash: string;
  searchEntryId: string;
  sourceChatId: string | null;
  userId: string;
}>;

export type MemoryLexicalProjectionGenerationInventory = Readonly<{
  analysisProfile: string;
  backendKind: string;
  documentCount: number;
  enqueuedThroughSequence: bigint;
  fingerprint: string;
  mappingVersion: string;
  normalizationVersion: string;
  projectionFingerprint: string | null;
  retrievalPipelineVersion: string;
  targetMemoryRevision: number;
  visibleThroughSequence: bigint;
}>;

export type MemoryLexicalProjectionVerificationCandidate = Readonly<{
  indexGenerationId: string;
  userId: string;
}>;

export type MemoryLexicalProjectionReset = Readonly<{
  eventsReset: number;
  statesReset: number;
  syncEventsCreated: number;
}>;

export type MemoryLexicalProjectionIntegrity = Readonly<{
  blockedEvents: number;
  claimedEvents: number;
  degradedGenerations: number;
  outstandingEvents: number;
  readyGenerations: number;
  retiredGenerations: number;
  totalGenerations: number;
  version: 1;
}>;

export interface MemoryLexicalProjectionStore {
  claim(input: Readonly<{
    leaseMs: number;
    limit: number;
    maximumAttempts: number;
    now: Date;
  }>): Promise<readonly MemoryLexicalProjectionClaim[]>;
  enqueueUserPurge(input: Readonly<{
    memoryRevision: number;
    userId: string;
  }>): Promise<bigint>;
  expectedGeneration(
    input: MemoryLexicalProjectionVerificationCandidate
  ): Promise<MemoryLexicalProjectionGenerationInventory | null>;
  inspect(): Promise<MemoryLexicalProjectionIntegrity>;
  listIntegrityCandidates(input: Readonly<{
    after: MemoryLexicalProjectionVerificationCandidate | null;
    limit: number;
  }>): Promise<readonly MemoryLexicalProjectionVerificationCandidate[]>;
  listVerificationCandidates(
    limit: number
  ): Promise<readonly MemoryLexicalProjectionVerificationCandidate[]>;
  loadCanonicalEntry(
    claim: MemoryLexicalProjectionClaim
  ): Promise<MemoryLexicalProjectionCanonicalEntry | null>;
  markVerificationFailure(input: Readonly<{
    candidate: MemoryLexicalProjectionVerificationCandidate;
    errorCode: string;
    now: Date;
  }>): Promise<void>;
  purgeFenceExists(claim: MemoryLexicalProjectionClaim): Promise<boolean>;
  reset(input: Readonly<{
    mode: "REBUILD" | "RESTORE";
    now: Date;
  }>): Promise<MemoryLexicalProjectionReset>;
  retryBlocked(input: Readonly<{ limit: number; now: Date }>): Promise<number>;
  settleFailure(claim: MemoryLexicalProjectionClaim, input: Readonly<{
    errorCode: string;
    maximumAttempts: number;
    now: Date;
  }>): Promise<void>;
  settleIntegrity(input: Readonly<{
    contractFingerprint: string;
    expected: MemoryLexicalProjectionGenerationInventory;
    indexGenerationId: string;
    now: Date;
    userId: string;
    visibleDocumentCount: number;
    visibleFingerprint: string;
  }>): Promise<boolean>;
  settleSuccess(
    claim: MemoryLexicalProjectionClaim,
    now: Date
  ): Promise<void>;
}

type ClaimRow = Omit<MemoryLexicalProjectionClaim, "leaseToken">;

function validClock(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function safeErrorCode(value: string): string {
  return safeErrorCodePattern.test(value)
    ? value
    : "memory_lexical_projection_failed";
}

export async function initializeMemoryLexicalProjectionState(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    indexGenerationId: string;
    targetMemoryRevision: number;
    userId: string;
  }>
): Promise<void> {
  if (!input.indexGenerationId || !input.userId ||
    !Number.isSafeInteger(input.targetMemoryRevision) ||
    input.targetMemoryRevision < 0) {
    throw new Error("memory_lexical_projection_generation_invalid");
  }
  await tx.memoryLexicalProjectionState.create({
    data: {
      analysisProfile: MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
      backendKind: MEMORY_OPENSEARCH_BACKEND_KIND,
      indexGenerationId: input.indexGenerationId,
      mappingVersion: MEMORY_OPENSEARCH_MAPPING_VERSION,
      normalizationVersion: MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
      retrievalPipelineVersion: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
      status: "BUILDING",
      targetMemoryRevision: input.targetMemoryRevision,
      userId: input.userId
    }
  });
}

/** Advance the external projection fence for a generation whose immutable
 * document set is unchanged by a reader-visible index pointer swap. The next
 * integrity pass re-proves the exact OpenSearch contents at the new revision;
 * a previously degraded projection remains degraded. */
export async function advanceMemoryLexicalProjectionRevisionFence(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    indexGenerationId: string;
    now: Date;
    targetMemoryRevision: number;
    userId: string;
  }>
): Promise<void> {
  if (!input.indexGenerationId || !input.userId ||
    !validClock(input.now) ||
    !Number.isSafeInteger(input.targetMemoryRevision) ||
    input.targetMemoryRevision < 0) {
    throw new Error("memory_lexical_projection_generation_invalid");
  }
  const updated = await tx.$executeRaw(Prisma.sql`
    UPDATE "MemoryLexicalProjectionState" AS state
    SET
      "readyAt" = CASE
        WHEN state."targetMemoryRevision" < ${input.targetMemoryRevision}
          THEN NULL
        ELSE state."readyAt"
      END,
      "status" = CASE
        WHEN state."targetMemoryRevision" < ${input.targetMemoryRevision}
          AND state."status" = 'READY'::"MemoryLexicalProjectionStatus"
          THEN 'CATCHING_UP'::"MemoryLexicalProjectionStatus"
        ELSE state."status"
      END,
      "targetMemoryRevision" = ${input.targetMemoryRevision},
      "updatedAt" = ${input.now}
    WHERE state."userId" = ${input.userId}
      AND state."indexGenerationId" = ${input.indexGenerationId}
      AND state."status" <> 'RETIRED'::"MemoryLexicalProjectionStatus"
      AND state."targetMemoryRevision" <= ${input.targetMemoryRevision}
  `);
  if (updated !== 1) {
    throw new Error("memory_lexical_projection_state_missing");
  }
}

function exactPointerShape(
  itemType: MemorySearchItemType,
  pointers: Readonly<{
    factVersionId: string | null;
    recallChunkId: string | null;
    recallRoundId: string | null;
    recallRoundSegmentId: string | null;
    toolEventId: string | null;
  }>
): boolean {
  switch (itemType) {
    case "FACT_VERSION":
      return pointers.factVersionId !== null && pointers.recallChunkId === null &&
        pointers.recallRoundId === null &&
        pointers.recallRoundSegmentId === null && pointers.toolEventId === null;
    case "RECALL_CHUNK":
      return pointers.factVersionId === null && pointers.recallChunkId !== null &&
        pointers.recallRoundId === null &&
        pointers.recallRoundSegmentId === null && pointers.toolEventId === null;
    case "RECALL_ROUND":
      return pointers.factVersionId === null && pointers.recallChunkId === null &&
        pointers.recallRoundId !== null &&
        pointers.recallRoundSegmentId === null && pointers.toolEventId === null;
    case "RECALL_ROUND_SEGMENT":
      return pointers.factVersionId === null && pointers.recallChunkId === null &&
        pointers.recallRoundId !== null &&
        pointers.recallRoundSegmentId !== null && pointers.toolEventId === null;
    case "TOOL_EVENT":
      return pointers.factVersionId === null && pointers.recallChunkId === null &&
        pointers.recallRoundId === null &&
        pointers.recallRoundSegmentId === null && pointers.toolEventId !== null;
  }
}

async function validSourceChat(
  client: PrismaClient,
  userId: string,
  chatId: string
): Promise<boolean> {
  return (await client.chat.count({
    where: {
      id: chatId,
      memoryMode: "NORMAL",
      permanentDeletionAt: null,
      projectId: null,
      userId
    }
  })) === 1;
}

function validHistoryProjection(value: Readonly<{
  redactionState: string;
  safetyClass: string;
  state: string;
}>): boolean {
  return value.state === "ACTIVE" && value.redactionState !== "EXCLUDED" &&
    (value.safetyClass === "NORMAL" || value.safetyClass === "SENSITIVE");
}

export async function claimMemoryLexicalProjectionEvents(
  client: PrismaClient,
  input: Readonly<{
    leaseMs: number;
    limit: number;
    maximumAttempts: number;
    now: Date;
  }>
): Promise<readonly MemoryLexicalProjectionClaim[]> {
  if (!validClock(input.now) || !Number.isSafeInteger(input.limit) ||
    input.limit < 1 || input.limit > 100 ||
    !Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1_000 ||
    input.leaseMs > 10 * 60_000 ||
    !Number.isSafeInteger(input.maximumAttempts) ||
    input.maximumAttempts < 1 || input.maximumAttempts > 20) {
    throw new Error("memory_lexical_projection_claim_invalid");
  }
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
  const rows = await client.$queryRaw<ClaimRow[]>(Prisma.sql`
    WITH owner_heads AS MATERIALIZED (
      SELECT DISTINCT ON (outstanding."userId")
        outstanding."sequence"
      FROM "MemoryLexicalProjectionEvent" AS outstanding
      WHERE outstanding."state" <>
        'SUCCEEDED'::"MemoryLexicalProjectionEventState"
      ORDER BY outstanding."userId", outstanding."sequence"
    ),
    candidates AS (
      SELECT event."sequence"
      FROM "MemoryLexicalProjectionEvent" AS event
      INNER JOIN owner_heads AS head
        ON head."sequence" = event."sequence"
      WHERE (
        (
          event."state" IN (
            'PENDING'::"MemoryLexicalProjectionEventState",
            'RETRY_WAIT'::"MemoryLexicalProjectionEventState"
          )
          AND event."attemptCount" < ${input.maximumAttempts}
          AND (
            event."nextAttemptAt" IS NULL
            OR event."nextAttemptAt" <= ${input.now}
          )
        )
        OR (
          event."state" = 'CLAIMED'::"MemoryLexicalProjectionEventState"
          AND event."leaseExpiresAt" <= ${input.now}
        )
      )
      ORDER BY event."sequence"
      FOR UPDATE OF event SKIP LOCKED
      LIMIT ${input.limit}
    )
    UPDATE "MemoryLexicalProjectionEvent" AS event
    SET
      "attemptCount" = CASE
        WHEN event."state" = 'CLAIMED'::"MemoryLexicalProjectionEventState"
          THEN event."attemptCount"
        ELSE event."attemptCount" + 1
      END,
      "errorCode" = NULL,
      "leaseExpiresAt" = ${leaseExpiresAt},
      "leaseToken" = ${leaseToken},
      "nextAttemptAt" = NULL,
      "state" = 'CLAIMED'::"MemoryLexicalProjectionEventState",
      "updatedAt" = ${input.now}
    FROM candidates
    WHERE event."sequence" = candidates."sequence"
    RETURNING
      event."sequence",
      event."id"::text AS "id",
      event."userId",
      event."indexGenerationId",
      event."searchEntryId",
      event."operation",
      event."memoryRevisionSnapshot",
      event."attemptCount"
  `);
  return Object.freeze(rows.map((row) => Object.freeze({ ...row, leaseToken })));
}

export async function loadMemoryLexicalProjectionCanonicalEntry(
  client: PrismaClient,
  claim: MemoryLexicalProjectionClaim
): Promise<MemoryLexicalProjectionCanonicalEntry | null> {
  if (claim.operation !== "SYNC_ENTRY" || !claim.indexGenerationId ||
    !claim.searchEntryId) return null;
  const entry = await client.memorySearchEntry.findFirst({
    select: {
      factVersionId: true,
      id: true,
      indexGenerationId: true,
      itemType: true,
      normalizedSearchText: true,
      recallChunkId: true,
      recallRoundId: true,
      recallRoundSegmentId: true,
      safeContentHash: true,
      toolEventId: true,
      userId: true
    },
    where: {
      id: claim.searchEntryId,
      indexGenerationId: claim.indexGenerationId,
      userId: claim.userId
    }
  });
  if (!entry || !exactPointerShape(entry.itemType, entry) ||
    !safeHashPattern.test(entry.safeContentHash)) return null;
  const [generation, owner] = await Promise.all([
    client.memoryIndexGeneration.findFirst({
      select: { id: true },
      where: {
        id: entry.indexGenerationId,
        state: { in: [...activeProjectionGenerationStates] },
        userId: entry.userId
      }
    }),
    client.user.findUnique({ select: { id: true }, where: { id: entry.userId } })
  ]);
  if (!generation || !owner) return null;

  let lexicalText: string;
  let sourceChatId: string | null = null;
  switch (entry.itemType) {
    case "FACT_VERSION": {
      const version = await client.memoryFactVersion.findFirst({
        select: {
          contentPurgedAt: true,
          displayText: true,
          expiresAt: true,
          safetyClassificationState: true,
          state: true,
          structuredValue: true
        },
        where: { id: entry.factVersionId!, userId: entry.userId }
      });
      if (!version || version.contentPurgedAt || !version.displayText ||
        version.structuredValue === null ||
        version.safetyClassificationState !== "CLASSIFIED" ||
        !["ACTIVE", "SUPERSEDED"].includes(version.state) ||
        version.expiresAt && version.expiresAt <= new Date()) return null;
      const redaction = redactMemorySecrets(version.displayText);
      if (redaction.containsSecret && !memoryRedactionHasMeaningfulRemainder(
        version.displayText,
        redaction
      )) return null;
      lexicalText = normalizeMemorySearchText(redaction.redactedText);
      const safeContentHash = memorySha256({
        displayText: redaction.redactedText,
        structuredValue: version.structuredValue
      });
      if (safeContentHash !== entry.safeContentHash) return null;
      break;
    }
    case "RECALL_CHUNK": {
      const chunk = await client.memoryRecallChunk.findFirst({
        select: {
          chatId: true,
          contentHash: true,
          normalizedSafeSearchText: true,
          redactionState: true,
          safetyClass: true,
          state: true
        },
        where: { id: entry.recallChunkId!, userId: entry.userId }
      });
      if (!chunk || !validHistoryProjection(chunk) ||
        chunk.contentHash !== entry.safeContentHash ||
        !await validSourceChat(client, entry.userId, chunk.chatId)) return null;
      lexicalText = chunk.normalizedSafeSearchText;
      sourceChatId = chunk.chatId;
      break;
    }
    case "RECALL_ROUND": {
      const round = await client.memoryRecallRound.findFirst({
        select: {
          chatId: true,
          contextualSearchHash: true,
          contextualSearchText: true,
          redactionState: true,
          safetyClass: true,
          state: true
        },
        where: { id: entry.recallRoundId!, userId: entry.userId }
      });
      if (!round || !validHistoryProjection(round) ||
        round.contextualSearchHash !== entry.safeContentHash ||
        !await validSourceChat(client, entry.userId, round.chatId)) return null;
      lexicalText = normalizeMemorySearchText(round.contextualSearchText);
      sourceChatId = round.chatId;
      break;
    }
    case "RECALL_ROUND_SEGMENT": {
      const segment = await client.memoryRecallRoundSegment.findFirst({
        select: {
          chatId: true,
          contextualSearchHash: true,
          contextualSearchText: true,
          redactionState: true,
          safetyClass: true,
          state: true
        },
        where: {
          id: entry.recallRoundSegmentId!,
          roundId: entry.recallRoundId!,
          userId: entry.userId
        }
      });
      if (!segment || !validHistoryProjection(segment) ||
        segment.contextualSearchHash !== entry.safeContentHash ||
        !await validSourceChat(client, entry.userId, segment.chatId)) return null;
      lexicalText = normalizeMemorySearchText(segment.contextualSearchText);
      sourceChatId = segment.chatId;
      break;
    }
    case "TOOL_EVENT": {
      const toolEvent = await client.memoryToolEvent.findFirst({
        select: {
          chatId: true,
          contentHash: true,
          normalizedSafeSearchText: true,
          redactionState: true,
          safetyClass: true,
          state: true
        },
        where: { id: entry.toolEventId!, userId: entry.userId }
      });
      if (!toolEvent || !validHistoryProjection(toolEvent) ||
        toolEvent.contentHash !== entry.safeContentHash ||
        !await validSourceChat(client, entry.userId, toolEvent.chatId)) return null;
      lexicalText = toolEvent.normalizedSafeSearchText;
      sourceChatId = toolEvent.chatId;
      break;
    }
  }
  if (lexicalText !== entry.normalizedSearchText) return null;
  return Object.freeze({
    indexGenerationId: entry.indexGenerationId,
    itemType: entry.itemType,
    lexicalText,
    safeContentHash: entry.safeContentHash,
    searchEntryId: entry.id,
    sourceChatId,
    userId: entry.userId
  });
}

export async function memoryLexicalProjectionPurgeFenceExists(
  client: PrismaClient,
  claim: MemoryLexicalProjectionClaim
): Promise<boolean> {
  if (claim.operation === "PURGE_GENERATION" && claim.indexGenerationId) {
    const generation = await client.memoryIndexGeneration.findFirst({
      select: { state: true },
      where: { id: claim.indexGenerationId, userId: claim.userId }
    });
    return !generation || ["CANCELLED", "FAILED", "SUPERSEDED"].includes(
      generation.state
    );
  }
  if (claim.operation !== "PURGE_USER") return true;
  const [owner, entries, generations, deletion] = await Promise.all([
    client.user.findUnique({ select: { status: true }, where: { id: claim.userId } }),
    client.memorySearchEntry.count({ where: { userId: claim.userId } }),
    client.memoryIndexGeneration.count({ where: { userId: claim.userId } }),
    client.memoryDeletionOutbox.count({
      where: {
        operation: "ACCOUNT_MEMORY_DELETE",
        state: { notIn: ["CANCELLED"] },
        targetId: claim.userId,
        userId: claim.userId
      }
    })
  ]);
  return owner?.status !== "active" && entries === 0 && generations === 0 &&
    deletion === 1;
}

export async function settleMemoryLexicalProjectionSuccess(
  client: PrismaClient,
  claim: MemoryLexicalProjectionClaim,
  now: Date
): Promise<void> {
  if (!validClock(now)) throw new Error("memory_lexical_projection_clock_invalid");
  await client.$transaction(async (tx) => {
    if (claim.operation === "PURGE_USER") {
      const later = await tx.memoryLexicalProjectionEvent.count({
        where: { sequence: { gt: claim.sequence }, userId: claim.userId }
      });
      if (later !== 0) {
        throw new Error("memory_lexical_projection_user_purge_not_final");
      }
    }
    const settled = await tx.memoryLexicalProjectionEvent.updateMany({
      data: {
        completedAt: now,
        errorCode: null,
        leaseExpiresAt: null,
        leaseToken: null,
        nextAttemptAt: null,
        state: "SUCCEEDED",
        updatedAt: now
      },
      where: {
        id: claim.id,
        leaseToken: claim.leaseToken,
        sequence: claim.sequence,
        state: "CLAIMED"
      }
    });
    if (settled.count !== 1) {
      throw new Error("memory_lexical_projection_lease_lost");
    }
    if (claim.operation === "PURGE_USER") {
      await tx.memoryLexicalProjectionState.deleteMany({
        where: { userId: claim.userId }
      });
      await tx.memoryLexicalProjectionEvent.deleteMany({
        where: {
          sequence: { lt: claim.sequence },
          state: "SUCCEEDED",
          userId: claim.userId
        }
      });
      return;
    }
    if (!claim.indexGenerationId) {
      throw new Error("memory_lexical_projection_generation_missing");
    }
    const retired = claim.operation === "PURGE_GENERATION";
    const stateUpdated = retired
      ? await tx.$executeRaw(Prisma.sql`
          UPDATE "MemoryLexicalProjectionState"
          SET
            "expectedContentFingerprint" = NULL,
            "expectedDocumentCount" = NULL,
            "lastErrorCode" = NULL,
            "lastIntegrityCheckAt" = NULL,
            "lastSuccessfulRefreshAt" = NULL,
            "projectedThroughRevision" = GREATEST(
              "projectedThroughRevision",
              ${claim.memoryRevisionSnapshot}
            ),
            "projectionFingerprint" = NULL,
            "readyAt" = NULL,
            "status" = 'RETIRED'::"MemoryLexicalProjectionStatus",
            "updatedAt" = ${now},
            "visibleContentFingerprint" = NULL,
            "visibleDocumentCount" = NULL,
            "visibleThroughSequence" = GREATEST(
              "visibleThroughSequence",
              ${claim.sequence}
            )
          WHERE "userId" = ${claim.userId}
            AND "indexGenerationId" = ${claim.indexGenerationId}
            AND "enqueuedThroughSequence" >= ${claim.sequence}
        `)
      : await tx.$executeRaw(Prisma.sql`
          UPDATE "MemoryLexicalProjectionState"
          SET
            "lastErrorCode" = NULL,
            "projectedThroughRevision" = GREATEST(
              "projectedThroughRevision",
              ${claim.memoryRevisionSnapshot}
            ),
            "readyAt" = NULL,
            "status" = 'CATCHING_UP'::"MemoryLexicalProjectionStatus",
            "updatedAt" = ${now},
            "visibleThroughSequence" = GREATEST(
              "visibleThroughSequence",
              ${claim.sequence}
            )
          WHERE "userId" = ${claim.userId}
            AND "indexGenerationId" = ${claim.indexGenerationId}
            AND "enqueuedThroughSequence" >= ${claim.sequence}
        `);
    if (stateUpdated !== 1) {
      throw new Error("memory_lexical_projection_state_missing");
    }
  });
}

export async function settleMemoryLexicalProjectionFailure(
  client: PrismaClient,
  claim: MemoryLexicalProjectionClaim,
  input: Readonly<{
    errorCode: string;
    maximumAttempts: number;
    now: Date;
  }>
): Promise<void> {
  if (!validClock(input.now) || !Number.isSafeInteger(input.maximumAttempts) ||
    input.maximumAttempts < 1 || input.maximumAttempts > 20) {
    throw new Error("memory_lexical_projection_failure_invalid");
  }
  const terminal = claim.attemptCount >= input.maximumAttempts;
  const exponential = Math.min(30 * 60_000,
    1_000 * 2 ** Math.min(claim.attemptCount - 1, 10));
  const jitter = Number(claim.sequence % 997n);
  const code = safeErrorCode(input.errorCode);
  const nextAttemptAt = terminal
    ? null
    : new Date(input.now.getTime() + exponential + jitter);
  const updated = await client.memoryLexicalProjectionEvent.updateMany({
    data: {
      completedAt: null,
      errorCode: code,
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt,
      state: terminal ? "BLOCKED_REQUIRES_ADMIN" : "RETRY_WAIT",
      updatedAt: input.now
    },
    where: {
      id: claim.id,
      leaseToken: claim.leaseToken,
      sequence: claim.sequence,
      state: "CLAIMED"
    }
  });
  if (updated.count !== 1) return;
  if (claim.indexGenerationId) {
    await client.memoryLexicalProjectionState.updateMany({
      data: {
        lastErrorCode: code,
        readyAt: null,
        status: "DEGRADED",
        updatedAt: input.now
      },
      where: {
        indexGenerationId: claim.indexGenerationId,
        userId: claim.userId
      }
    });
  }
}

export async function listMemoryLexicalProjectionVerificationCandidates(
  client: PrismaClient,
  limit: number
): Promise<readonly MemoryLexicalProjectionVerificationCandidate[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("memory_lexical_projection_verification_limit_invalid");
  }
  const rows = await client.$queryRaw<MemoryLexicalProjectionVerificationCandidate[]>(
    Prisma.sql`
      SELECT state."userId", state."indexGenerationId"
      FROM "MemoryLexicalProjectionState" AS state
      WHERE state."status" IN (
        'BUILDING'::"MemoryLexicalProjectionStatus",
        'CATCHING_UP'::"MemoryLexicalProjectionStatus",
        'DEGRADED'::"MemoryLexicalProjectionStatus"
      )
        AND state."visibleThroughSequence" = state."enqueuedThroughSequence"
        AND NOT EXISTS (
          SELECT 1
          FROM "MemoryLexicalProjectionEvent" AS event
          WHERE event."userId" = state."userId"
            AND event."sequence" <= state."enqueuedThroughSequence"
            AND event."state" <>
              'SUCCEEDED'::"MemoryLexicalProjectionEventState"
        )
      ORDER BY state."updatedAt", state."userId", state."indexGenerationId"
      LIMIT ${limit}
    `
  );
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

export async function listMemoryLexicalProjectionIntegrityCandidates(
  client: PrismaClient,
  input: Readonly<{
    after: MemoryLexicalProjectionVerificationCandidate | null;
    limit: number;
  }>
): Promise<readonly MemoryLexicalProjectionVerificationCandidate[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 ||
    input.after !== null && (input.after.userId.length < 1 ||
      input.after.userId.length > 512 || input.after.indexGenerationId.length < 1 ||
      input.after.indexGenerationId.length > 512)) {
    throw new Error("memory_lexical_projection_verification_limit_invalid");
  }
  const after = input.after === null
    ? Prisma.sql`TRUE`
    : Prisma.sql`(state."userId", state."indexGenerationId") >
        (${input.after.userId}, ${input.after.indexGenerationId})`;
  const rows = await client.$queryRaw<MemoryLexicalProjectionVerificationCandidate[]>(
    Prisma.sql`
      SELECT state."userId", state."indexGenerationId"
      FROM "MemoryLexicalProjectionState" AS state
      WHERE state."status" <> 'RETIRED'::"MemoryLexicalProjectionStatus"
        AND ${after}
      ORDER BY state."userId", state."indexGenerationId"
      LIMIT ${input.limit}
    `
  );
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

export async function inspectExpectedMemoryLexicalProjectionGeneration(
  client: PrismaClient,
  input: MemoryLexicalProjectionVerificationCandidate
): Promise<MemoryLexicalProjectionGenerationInventory | null> {
  const state = await client.memoryLexicalProjectionState.findUnique({
    where: { userId_indexGenerationId: input },
    select: {
      analysisProfile: true,
      backendKind: true,
      enqueuedThroughSequence: true,
      mappingVersion: true,
      normalizationVersion: true,
      projectionFingerprint: true,
      retrievalPipelineVersion: true,
      status: true,
      targetMemoryRevision: true,
      visibleThroughSequence: true
    }
  });
  if (!state || state.status === "RETIRED") return null;
  const entries = await client.memorySearchEntry.findMany({
    orderBy: { id: "asc" },
    select: { id: true, safeContentHash: true },
    take: MEMORY_OPENSEARCH_MAX_INTEGRITY_DOCUMENTS + 1,
    where: input
  });
  if (entries.length > MEMORY_OPENSEARCH_MAX_INTEGRITY_DOCUMENTS) {
    throw new Error("memory_lexical_projection_integrity_scope_too_large");
  }
  const digest = createHash("sha256");
  for (const entry of entries) {
    digest.update(memoryOpenSearchIntegrityFingerprintMaterial({
      safeContentHash: entry.safeContentHash,
      searchEntryId: entry.id
    }), "utf8");
  }
  return Object.freeze({
    analysisProfile: state.analysisProfile,
    backendKind: state.backendKind,
    documentCount: entries.length,
    enqueuedThroughSequence: state.enqueuedThroughSequence,
    fingerprint: digest.digest("hex"),
    mappingVersion: state.mappingVersion,
    normalizationVersion: state.normalizationVersion,
    projectionFingerprint: state.projectionFingerprint,
    retrievalPipelineVersion: state.retrievalPipelineVersion,
    targetMemoryRevision: state.targetMemoryRevision,
    visibleThroughSequence: state.visibleThroughSequence
  });
}

export async function settleMemoryLexicalProjectionIntegrity(
  client: PrismaClient,
  input: Readonly<{
    contractFingerprint: string;
    expected: MemoryLexicalProjectionGenerationInventory;
    indexGenerationId: string;
    now: Date;
    userId: string;
    visibleDocumentCount: number;
    visibleFingerprint: string;
  }>
): Promise<boolean> {
  if (!validClock(input.now) ||
    !safeHashPattern.test(input.contractFingerprint) ||
    !safeHashPattern.test(input.expected.fingerprint) ||
    !safeHashPattern.test(input.visibleFingerprint) ||
    !Number.isSafeInteger(input.visibleDocumentCount) ||
    input.visibleDocumentCount < 0) {
    throw new Error("memory_lexical_projection_integrity_invalid");
  }
  const compatible = input.expected.backendKind === MEMORY_OPENSEARCH_BACKEND_KIND &&
    input.expected.mappingVersion === MEMORY_OPENSEARCH_MAPPING_VERSION &&
    input.expected.normalizationVersion === MEMORY_OPENSEARCH_NORMALIZATION_VERSION &&
    input.expected.analysisProfile === MEMORY_OPENSEARCH_ANALYSIS_PROFILE &&
    input.expected.retrievalPipelineVersion ===
      MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION;
  const healthy = compatible &&
    input.expected.enqueuedThroughSequence ===
      input.expected.visibleThroughSequence &&
    input.expected.documentCount === input.visibleDocumentCount &&
    input.expected.fingerprint === input.visibleFingerprint;
  if (!healthy) {
    await client.memoryLexicalProjectionState.updateMany({
      data: {
        expectedContentFingerprint: input.expected.fingerprint,
        expectedDocumentCount: input.expected.documentCount,
        lastErrorCode: "memory_lexical_projection_integrity_mismatch",
        lastIntegrityCheckAt: input.now,
        lastSuccessfulRefreshAt: input.now,
        projectionFingerprint: input.contractFingerprint,
        readyAt: null,
        status: "DEGRADED",
        updatedAt: input.now,
        visibleContentFingerprint: input.visibleFingerprint,
        visibleDocumentCount: input.visibleDocumentCount
      },
      where: {
        enqueuedThroughSequence: input.expected.enqueuedThroughSequence,
        indexGenerationId: input.indexGenerationId,
        targetMemoryRevision: input.expected.targetMemoryRevision,
        userId: input.userId
      }
    });
    return false;
  }
  const updated = await client.$executeRaw(Prisma.sql`
    UPDATE "MemoryLexicalProjectionState" AS state
    SET
      "expectedContentFingerprint" = ${input.expected.fingerprint},
      "expectedDocumentCount" = ${input.expected.documentCount},
      "lastErrorCode" = NULL,
      "lastIntegrityCheckAt" = ${input.now},
      "lastSuccessfulRefreshAt" = ${input.now},
      "projectedThroughRevision" = ${input.expected.targetMemoryRevision},
      "projectionFingerprint" = ${input.contractFingerprint},
      "readyAt" = ${input.now},
      "status" = 'READY'::"MemoryLexicalProjectionStatus",
      "updatedAt" = ${input.now},
      "visibleContentFingerprint" = ${input.visibleFingerprint},
      "visibleDocumentCount" = ${input.visibleDocumentCount}
    WHERE state."userId" = ${input.userId}
      AND state."indexGenerationId" = ${input.indexGenerationId}
      AND state."status" <> 'RETIRED'::"MemoryLexicalProjectionStatus"
      AND state."enqueuedThroughSequence" =
        ${input.expected.enqueuedThroughSequence}
      AND state."visibleThroughSequence" =
        ${input.expected.enqueuedThroughSequence}
      AND state."targetMemoryRevision" =
        ${input.expected.targetMemoryRevision}
      AND state."backendKind" = ${MEMORY_OPENSEARCH_BACKEND_KIND}
      AND state."mappingVersion" = ${MEMORY_OPENSEARCH_MAPPING_VERSION}
      AND state."normalizationVersion" =
        ${MEMORY_OPENSEARCH_NORMALIZATION_VERSION}
      AND state."analysisProfile" = ${MEMORY_OPENSEARCH_ANALYSIS_PROFILE}
      AND state."retrievalPipelineVersion" =
        ${MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION}
      AND NOT EXISTS (
        SELECT 1
        FROM "MemoryLexicalProjectionEvent" AS event
        WHERE event."userId" = state."userId"
          AND event."sequence" <= state."enqueuedThroughSequence"
          AND event."state" <>
            'SUCCEEDED'::"MemoryLexicalProjectionEventState"
      )
  `);
  return updated === 1;
}

export async function enqueueMemoryLexicalProjectionUserPurge(
  client: PrismaClient,
  input: Readonly<{ memoryRevision: number; userId: string }>
): Promise<bigint> {
  return client.$transaction((tx) =>
    enqueueMemoryLexicalProjectionUserPurgeInTransaction(tx, input));
}

/**
 * Appends the terminal account-level projection fence inside the canonical
 * deletion transaction. Keeping this variant transaction-bound guarantees
 * that canonical deletion cannot commit without its external purge duty.
 */
export async function enqueueMemoryLexicalProjectionUserPurgeInTransaction(
  tx: Prisma.TransactionClient,
  input: Readonly<{ memoryRevision: number; userId: string }>
): Promise<bigint> {
  if (!Number.isSafeInteger(input.memoryRevision) || input.memoryRevision < 0 ||
    input.userId.length < 1 || input.userId.length > 512) {
    throw new Error("memory_lexical_projection_user_purge_invalid");
  }
  const existing = await tx.memoryLexicalProjectionEvent.findFirst({
    select: { sequence: true },
    where: { operation: "PURGE_USER", userId: input.userId }
  });
  if (existing) return existing.sequence;
  const [created] = await tx.$queryRaw<Array<{ sequence: bigint }>>(Prisma.sql`
    SELECT aiqsa_enqueue_memory_lexical_projection_event(
      ${input.userId}::TEXT,
      NULL::TEXT,
      NULL::TEXT,
      'PURGE_USER'::"MemoryLexicalProjectionOperation",
      ${input.memoryRevision}::INTEGER
    ) AS "sequence"
  `);
  if (!created) throw new Error("memory_lexical_projection_user_purge_failed");
  return created.sequence;
}

export async function retryBlockedMemoryLexicalProjectionEvents(
  client: PrismaClient,
  input: Readonly<{ limit: number; now: Date }>
): Promise<number> {
  if (!validClock(input.now) || !Number.isSafeInteger(input.limit) ||
    input.limit < 1 || input.limit > 1_000) {
    throw new Error("memory_lexical_projection_retry_invalid");
  }
  return client.$executeRaw(Prisma.sql`
    WITH candidates AS (
      SELECT event."sequence"
      FROM "MemoryLexicalProjectionEvent" AS event
      WHERE event."state" =
        'BLOCKED_REQUIRES_ADMIN'::"MemoryLexicalProjectionEventState"
      ORDER BY event."sequence"
      LIMIT ${input.limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "MemoryLexicalProjectionEvent" AS event
    SET
      "attemptCount" = 0,
      "errorCode" = NULL,
      "nextAttemptAt" = ${input.now},
      "state" = 'RETRY_WAIT'::"MemoryLexicalProjectionEventState",
      "updatedAt" = ${input.now}
    FROM candidates
    WHERE event."sequence" = candidates."sequence"
  `);
}

export async function markMemoryLexicalProjectionVerificationFailure(
  client: PrismaClient,
  input: Readonly<{
    candidate: MemoryLexicalProjectionVerificationCandidate;
    errorCode: string;
    now: Date;
  }>
): Promise<void> {
  if (!validClock(input.now)) {
    throw new Error("memory_lexical_projection_clock_invalid");
  }
  await client.memoryLexicalProjectionState.updateMany({
    data: {
      lastErrorCode: safeErrorCode(input.errorCode),
      readyAt: null,
      status: "DEGRADED",
      updatedAt: input.now
    },
    where: input.candidate
  });
}

export async function resetMemoryLexicalProjection(
  client: PrismaClient,
  input: Readonly<{ mode: "REBUILD" | "RESTORE"; now: Date }>
): Promise<MemoryLexicalProjectionReset> {
  if (!validClock(input.now)) {
    throw new Error("memory_lexical_projection_clock_invalid");
  }
  return client.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      LOCK TABLE
        "MemoryLexicalProjectionEvent",
        "MemoryLexicalProjectionState"
      IN EXCLUSIVE MODE
    `);
    if (input.mode === "REBUILD") {
      const activeLeases = await tx.memoryLexicalProjectionEvent.count({
        where: {
          leaseExpiresAt: { gt: input.now },
          state: "CLAIMED"
        }
      });
      if (activeLeases > 0) {
        throw new Error("memory_lexical_projection_rebuild_active_leases");
      }
    }
    const removedEvents = await tx.memoryLexicalProjectionEvent.deleteMany({
      where: { operation: { not: "PURGE_USER" } }
    });
    const retainedPurges = await tx.memoryLexicalProjectionEvent.updateMany({
      data: {
        attemptCount: 0,
        completedAt: null,
        errorCode: null,
        leaseExpiresAt: null,
        leaseToken: null,
        nextAttemptAt: input.now,
        state: "PENDING",
        updatedAt: input.now
      },
      where: { operation: "PURGE_USER" }
    });
    const states = await tx.memoryLexicalProjectionState.deleteMany();
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "MemoryLexicalProjectionState" (
        "userId",
        "indexGenerationId",
        "backendKind",
        "mappingVersion",
        "normalizationVersion",
        "analysisProfile",
        "retrievalPipelineVersion",
        "status",
        "enqueuedThroughSequence",
        "visibleThroughSequence",
        "targetMemoryRevision",
        "projectedThroughRevision"
      )
      SELECT
        generation."userId",
        generation."id",
        ${MEMORY_OPENSEARCH_BACKEND_KIND},
        ${MEMORY_OPENSEARCH_MAPPING_VERSION},
        ${MEMORY_OPENSEARCH_NORMALIZATION_VERSION},
        ${MEMORY_OPENSEARCH_ANALYSIS_PROFILE},
        ${MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION},
        'BUILDING'::"MemoryLexicalProjectionStatus",
        0,
        0,
        GREATEST(generation."targetMemoryRevision", 0),
        0
      FROM "MemoryIndexGeneration" AS generation
      WHERE NOT EXISTS (
        SELECT 1
        FROM "MemoryLexicalProjectionEvent" AS purge
        WHERE purge."userId" = generation."userId"
          AND purge."operation" =
            'PURGE_USER'::"MemoryLexicalProjectionOperation"
      )
      ON CONFLICT ("userId", "indexGenerationId") DO NOTHING
    `);
    const [created] = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      WITH source_rows AS MATERIALIZED (
        SELECT
          gen_random_uuid() AS event_id,
          entry."userId" AS user_id,
          entry."indexGenerationId" AS generation_id,
          entry."id" AS search_entry_id,
          GREATEST(
            COALESCE(
              settings."memoryRevision",
              generation."targetMemoryRevision",
              0
            ),
            0
          ) AS memory_revision
        FROM "MemorySearchEntry" AS entry
        LEFT JOIN "UserMemorySettings" AS settings
          ON settings."userId" = entry."userId"
        LEFT JOIN "MemoryIndexGeneration" AS generation
          ON generation."userId" = entry."userId"
          AND generation."id" = entry."indexGenerationId"
        WHERE NOT EXISTS (
          SELECT 1
          FROM "MemoryLexicalProjectionEvent" AS purge
          WHERE purge."userId" = entry."userId"
            AND purge."operation" =
              'PURGE_USER'::"MemoryLexicalProjectionOperation"
        )
      ), inserted AS (
        INSERT INTO "MemoryLexicalProjectionEvent" (
          "id",
          "userId",
          "indexGenerationId",
          "searchEntryId",
          "operation",
          "memoryRevisionSnapshot",
          "idempotencyFingerprint",
          "nextAttemptAt"
        )
        SELECT
          event_id,
          user_id,
          generation_id,
          search_entry_id,
          'SYNC_ENTRY'::"MemoryLexicalProjectionOperation",
          memory_revision,
          event_id::text,
          ${input.now}
        FROM source_rows
        RETURNING
          "userId",
          "indexGenerationId",
          "memoryRevisionSnapshot",
          "sequence"
      ), grouped AS (
        SELECT
          "userId",
          "indexGenerationId",
          MAX("memoryRevisionSnapshot") AS memory_revision,
          MAX("sequence") AS maximum_sequence
        FROM inserted
        GROUP BY "userId", "indexGenerationId"
      ), state_updates AS (
        UPDATE "MemoryLexicalProjectionState" AS state
        SET
          "enqueuedThroughSequence" = GREATEST(
            state."enqueuedThroughSequence",
            grouped.maximum_sequence
          ),
          "status" = 'CATCHING_UP'::"MemoryLexicalProjectionStatus",
          "targetMemoryRevision" = GREATEST(
            state."targetMemoryRevision",
            grouped.memory_revision
          ),
          "updatedAt" = ${input.now}
        FROM grouped
        WHERE state."userId" = grouped."userId"
          AND state."indexGenerationId" = grouped."indexGenerationId"
        RETURNING state."id"
      )
      SELECT COUNT(*)::integer AS "count" FROM inserted
    `);
    return Object.freeze({
      eventsReset: removedEvents.count + retainedPurges.count,
      statesReset: states.count,
      syncEventsCreated: created?.count ?? 0
    });
  });
}

export async function inspectMemoryLexicalProjectionIntegrity(
  client: PrismaClient
): Promise<MemoryLexicalProjectionIntegrity> {
  const [eventGroups, stateGroups] = await Promise.all([
    client.memoryLexicalProjectionEvent.groupBy({
      _count: { _all: true },
      by: ["state"]
    }),
    client.memoryLexicalProjectionState.groupBy({
      _count: { _all: true },
      by: ["status"]
    })
  ]);
  const events = new Map(eventGroups.map((row) => [row.state, row._count._all]));
  const states = new Map(stateGroups.map((row) => [row.status, row._count._all]));
  const succeeded = events.get("SUCCEEDED") ?? 0;
  const totalEvents = eventGroups.reduce(
    (total, row) => total + row._count._all,
    0
  );
  return Object.freeze({
    blockedEvents: events.get("BLOCKED_REQUIRES_ADMIN") ?? 0,
    claimedEvents: events.get("CLAIMED") ?? 0,
    degradedGenerations: states.get("DEGRADED") ?? 0,
    outstandingEvents: totalEvents - succeeded,
    readyGenerations: states.get("READY") ?? 0,
    retiredGenerations: states.get("RETIRED") ?? 0,
    totalGenerations: stateGroups.reduce(
      (total, row) => total + row._count._all,
      0
    ),
    version: 1
  });
}

export function createPrismaMemoryLexicalProjectionStore(
  client: PrismaClient
): MemoryLexicalProjectionStore {
  const store: MemoryLexicalProjectionStore = {
    claim: (input) => claimMemoryLexicalProjectionEvents(client, input),
    enqueueUserPurge: (input) =>
      enqueueMemoryLexicalProjectionUserPurge(client, input),
    expectedGeneration: (input) =>
      inspectExpectedMemoryLexicalProjectionGeneration(client, input),
    inspect: () => inspectMemoryLexicalProjectionIntegrity(client),
    listIntegrityCandidates: (input) =>
      listMemoryLexicalProjectionIntegrityCandidates(client, input),
    listVerificationCandidates: (limit) =>
      listMemoryLexicalProjectionVerificationCandidates(client, limit),
    loadCanonicalEntry: (claim) =>
      loadMemoryLexicalProjectionCanonicalEntry(client, claim),
    markVerificationFailure: (input) =>
      markMemoryLexicalProjectionVerificationFailure(client, input),
    purgeFenceExists: (claim) =>
      memoryLexicalProjectionPurgeFenceExists(client, claim),
    reset: (input) => resetMemoryLexicalProjection(client, input),
    retryBlocked: (input) =>
      retryBlockedMemoryLexicalProjectionEvents(client, input),
    settleFailure: (claim, input) =>
      settleMemoryLexicalProjectionFailure(client, claim, input),
    settleIntegrity: (input) =>
      settleMemoryLexicalProjectionIntegrity(client, input),
    settleSuccess: (claim, now) =>
      settleMemoryLexicalProjectionSuccess(client, claim, now)
  };
  return Object.freeze(store);
}

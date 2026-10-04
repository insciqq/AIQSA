import { Prisma, type MemoryJobKind, type MemoryJobState } from "@prisma/client";
import { rememberMemoryEnqueue } from "./enqueueObservability";
import { isMemoryCoordinatorJobKind } from "../coordinator/registry";
import {
  MEMORY_EXPLICIT_RELATION_EQUAL_TEXT_SCAN,
  MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
  memoryEquivalenceTextKey,
  memoryExplicitRelationJobFingerprint
} from "../learning/relations/explicitPolicy";
import { memoryPersistenceFailure } from "./errors";
import {
  memoryAutomaticEquivalenceUnprotectedPredicate,
  memoryEquivalenceComparableVersionPredicate
} from "./explicitEquivalence";
import {
  type LockedMemorySettings,
  type MemoryTransaction
} from "./transaction";

export type MemoryJobEnqueueInput = Readonly<{
  commandSequence?: number;
  idempotencyFingerprint: string;
  kind: MemoryJobKind;
  nextAttemptAt?: Date | null;
  pipelineVersion: string;
  targetFactVersionId?: string;
  source?: Readonly<{
    activeLeafMessageId: string;
    branchGeneration: number;
    chatId: string;
    sourceHash: string;
    sourceMessageId?: string;
    sourceRevision: number;
  }>;
}>;

export type MemoryJobEnqueueResult = Readonly<{
  created: boolean;
  id: string;
  memoryGenerationSnapshot: number;
  memoryRevisionSnapshot: number;
  state: MemoryJobState;
}>;

/** Called inside the explicit write transaction, after its receipt/evidence.
 * This existence check avoids scheduling the first isolated fact: another
 * explicit save or an unprotected automatic fact must share the scope. Full
 * source and candidate authority remains the background handler's
 * responsibility. */
export async function enqueueMemoryExplicitRelation(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  targetFactVersionId: string
): Promise<void> {
  if (!settings.useMemoryFacts) return;
  const eligible = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT version."id"
    FROM "MemoryFactVersion" AS version
    JOIN "MemoryFact" AS fact ON fact."userId" = version."userId" AND fact."id" = version."factId"
    JOIN "MemoryScope" AS scope ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    WHERE version."userId" = ${settings.userId} AND version."id" = ${targetFactVersionId}
      AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
      AND ${memoryEquivalenceComparableVersionPredicate()}
      AND EXISTS (
        SELECT 1 FROM "MemoryFact" AS other
        JOIN "MemoryFactVersion" AS candidate
          ON candidate."userId" = other."userId" AND candidate."id" = other."currentVersionId"
        WHERE other."userId" = fact."userId" AND other."scopeId" = fact."scopeId" AND other."id" <> fact."id"
          AND other."state" = 'ACTIVE'::"MemoryFactState"
          AND candidate."state" = 'ACTIVE'::"MemoryFactVersionState" AND candidate."systemTo" IS NULL
          AND candidate."safetyClassificationState" = 'CLASSIFIED'::"MemorySafetyClassificationState"
          AND candidate."contentPurgedAt" IS NULL AND candidate."displayText" IS NOT NULL
          AND (candidate."expiresAt" IS NULL OR candidate."expiresAt" > CURRENT_TIMESTAMP)
          AND (candidate."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
            OR (candidate."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
              AND ${memoryAutomaticEquivalenceUnprotectedPredicate(Prisma.sql`other`)}))
      )
  `);
  if (eligible.length === 0) return;
  await enqueueMemoryJob(tx, settings, {
    idempotencyFingerprint: memoryExplicitRelationJobFingerprint(targetFactVersionId),
    kind: "RESOLVE_FACT_RELATIONS", pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
    targetFactVersionId
  });
}

type EquivalenceTextRow = Readonly<{ normalizedSearchText: string }>;

/** Called inside the transaction that made an automatic version current. Only
 * an equal normalized text (ignoring punctuation and symbols) of a current
 * explicit save in the same scope schedules the one comparison of this
 * version; that candidate match never authorizes a merge by itself. */
export async function enqueueMemoryAutomaticExplicitEquivalence(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  targetFactVersionId: string
): Promise<boolean> {
  if (!settings.useMemoryFacts) return false;
  const [source] = await tx.$queryRaw<Array<EquivalenceTextRow & Readonly<{ scopeId: string }>>>(Prisma.sql`
    SELECT version."normalizedSearchText", fact."scopeId"
    FROM "MemoryFactVersion" AS version
    JOIN "MemoryFact" AS fact ON fact."userId" = version."userId" AND fact."id" = version."factId"
    JOIN "MemoryScope" AS scope ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    WHERE version."userId" = ${settings.userId} AND version."id" = ${targetFactVersionId}
      AND version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
      AND version."normalizedSearchText" IS NOT NULL
      AND ${memoryEquivalenceComparableVersionPredicate()}
      AND ${memoryAutomaticEquivalenceUnprotectedPredicate()}
  `);
  const key = source ? memoryEquivalenceTextKey(source.normalizedSearchText) : "";
  if (!source || key.length === 0) return false;
  const explicit = await tx.$queryRaw<EquivalenceTextRow[]>(Prisma.sql`
    SELECT version."normalizedSearchText"
    FROM "MemoryFact" AS fact
    JOIN "MemoryFactVersion" AS version
      ON version."userId" = fact."userId" AND version."id" = fact."currentVersionId"
    JOIN "MemoryScope" AS scope ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    WHERE fact."userId" = ${settings.userId} AND fact."scopeId" = ${source.scopeId}
      AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
      AND version."normalizedSearchText" IS NOT NULL
      AND ${memoryEquivalenceComparableVersionPredicate()}
    ORDER BY fact."updatedAt" DESC, fact."id"
    LIMIT ${MEMORY_EXPLICIT_RELATION_EQUAL_TEXT_SCAN}
  `);
  if (!explicit.some(({ normalizedSearchText }) =>
    memoryEquivalenceTextKey(normalizedSearchText) === key)) return false;
  const job = await enqueueMemoryJob(tx, settings, {
    idempotencyFingerprint: memoryExplicitRelationJobFingerprint(targetFactVersionId),
    kind: "RESOLVE_FACT_RELATIONS", pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
    targetFactVersionId
  });
  return job.created;
}

function validToken(value: string, maxLength: number): boolean {
  return value.trim() === value && value.length > 0 && value.length <= maxLength;
}

const sha256 = /^[a-f0-9]{64}$/u;
const vNextFactExtractionPipelines = new Set([
  "memory-fact-extraction-vnext-v2",
  "memory-fact-extraction-vnext-v3",
  "memory-fact-extraction-vnext-v4",
  "memory-fact-extraction-vnext-v5",
  "memory-fact-extraction-vnext-v6",
  "memory-fact-extraction-vnext-v7",
  "memory-fact-extraction-vnext-v8"
]);
const relationPipeline = "memory-fact-relation-v2";

export function isMemoryDirectMessageExtractionPipeline(
  pipelineVersion: string
): boolean {
  return vNextFactExtractionPipelines.has(pipelineVersion);
}

function validSource(input: MemoryJobEnqueueInput["source"]): boolean {
  return input === undefined || (
    validToken(input.activeLeafMessageId, 256) &&
    validToken(input.chatId, 256) &&
    (input.sourceMessageId === undefined || validToken(input.sourceMessageId, 256)) &&
    sha256.test(input.sourceHash) &&
    Number.isSafeInteger(input.branchGeneration) &&
    input.branchGeneration >= 0 &&
    Number.isSafeInteger(input.sourceRevision) &&
    input.sourceRevision >= 0
  );
}

export async function enqueueMemoryJob(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  input: MemoryJobEnqueueInput
): Promise<MemoryJobEnqueueResult> {
  if (
    !isMemoryCoordinatorJobKind(input.kind) ||
    !validToken(input.idempotencyFingerprint, 128) ||
    !validToken(input.pipelineVersion, 64) ||
    !validSource(input.source) ||
    (input.kind === "MEMORY_COMMAND" ? (
      input.source?.sourceMessageId === undefined ||
      !Number.isSafeInteger(input.commandSequence) ||
      input.commandSequence! <= 0 || input.commandSequence! > 2_147_483_647
    ) : input.commandSequence !== undefined) ||
    (input.targetFactVersionId !== undefined &&
      !validToken(input.targetFactVersionId, 256)) ||
    (input.kind === "EXTRACT_FACTS" &&
      isMemoryDirectMessageExtractionPipeline(input.pipelineVersion) &&
      input.source?.sourceMessageId === undefined) ||
    (input.kind === "RESOLVE_FACT_RELATIONS" && (
      input.targetFactVersionId === undefined ||
      !validToken(input.targetFactVersionId, 256) ||
      (input.pipelineVersion === MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION
        ? input.source !== undefined
        : input.pipelineVersion !== relationPipeline ||
          input.source?.sourceMessageId === undefined)
    )) ||
    (input.kind !== "RESOLVE_FACT_RELATIONS" &&
      input.targetFactVersionId !== undefined)
  ) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
  const existing = await tx.memoryJob.findUnique({
    select: {
      id: true,
      activeLeafMessageId: true,
      branchGeneration: true,
      chatId: true,
      kind: true,
      memoryGenerationSnapshot: true,
      memoryRevisionSnapshot: true,
      pipelineVersion: true,
      sourceHash: true,
      sourceMessageId: true,
      sourceRevision: true,
      state: true,
      targetFactVersionId: true
    },
    where: {
      userId_idempotencyFingerprint: {
        idempotencyFingerprint: input.idempotencyFingerprint,
        userId: settings.userId
      }
    }
  });
  if (existing) {
    const sourceConflict = input.kind === "MEMORY_COMMAND"
      ? existing.chatId !== (input.source?.chatId ?? null) ||
        existing.sourceMessageId !== (input.source?.sourceMessageId ?? null) ||
        existing.sourceHash !== (input.source?.sourceHash ?? null)
      : input.kind === "EXTRACT_FACTS" &&
        isMemoryDirectMessageExtractionPipeline(input.pipelineVersion)
      ? existing.chatId !== (input.source?.chatId ?? null) ||
        existing.sourceMessageId !== (input.source?.sourceMessageId ?? null)
      : existing.chatId !== (input.source?.chatId ?? null) ||
        existing.activeLeafMessageId !== (input.source?.activeLeafMessageId ?? null) ||
        existing.branchGeneration !== (input.source?.branchGeneration ?? null) ||
        existing.sourceRevision !== (input.source?.sourceRevision ?? null) ||
        existing.sourceHash !== (input.source?.sourceHash ?? null) ||
        existing.sourceMessageId !== (input.source?.sourceMessageId ?? null);
    if (
      existing.kind !== input.kind ||
      existing.pipelineVersion !== input.pipelineVersion ||
      existing.targetFactVersionId !== (input.targetFactVersionId ?? null) ||
      sourceConflict
    ) {
      return memoryPersistenceFailure("memory_idempotency_conflict");
    }
    return {
      created: false,
      id: existing.id,
      memoryGenerationSnapshot: existing.memoryGenerationSnapshot,
      memoryRevisionSnapshot: existing.memoryRevisionSnapshot,
      state: existing.state
    };
  }

  const created = await tx.memoryJob.create({
    data: {
      idempotencyFingerprint: input.idempotencyFingerprint,
      kind: input.kind,
      memoryGenerationSnapshot: settings.memoryGeneration,
      memoryRevisionSnapshot: settings.memoryRevision,
      nextAttemptAt: input.nextAttemptAt,
      pipelineVersion: input.pipelineVersion,
      targetFactVersionId: input.targetFactVersionId,
      ...(input.kind === "MEMORY_COMMAND" ? {
        commandOperation: "UNKNOWN" as const,
        commandSequence: input.commandSequence,
        commandStatus: "PENDING" as const
      } : {}),
      ...(input.source
        ? {
            activeLeafMessageId: input.source.activeLeafMessageId,
            branchGeneration: input.source.branchGeneration,
            chatId: input.source.chatId,
            sourceHash: input.source.sourceHash,
            sourceMessageId: input.source.sourceMessageId,
            sourceRevision: input.source.sourceRevision
          }
        : {}),
      userId: settings.userId
    },
    select: {
      id: true,
      memoryGenerationSnapshot: true,
      memoryRevisionSnapshot: true,
      state: true
    }
  });
  rememberMemoryEnqueue(tx, created.id);
  return { ...created, created: true };
}

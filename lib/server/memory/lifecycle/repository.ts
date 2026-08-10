import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { MemoryDeletionStatus } from "../../../contracts/memory";
import type { MemoryBulkDeleteOperation } from "../../../contracts/memory";
import { prisma } from "../../prisma";
import type { MemoryMutationAuthorizationUse } from "../persistence/authorizations";
import { consumeMemoryMutationAuthorization } from "../persistence/authorizations";
import { enqueueMemoryDeletion } from "../persistence/deletion";
import { memoryPersistenceFailure } from "../persistence/errors";
import { memorySha256, normalizeMemorySearchText } from "../persistence/lexical";
import { createMemorySuppressionInTransaction } from "../persistence/suppressions";
import type { MemorySuppressionCreateInput } from "../persistence/suppressions";
import {
  advanceMemoryMutation,
  type LockedMemorySettings,
  type MemoryTransaction,
  withLockedMemoryTransaction
} from "../persistence/transaction";
import {
  MEMORY_DELETE_EXPLICIT_TARGET_ID,
  memoryPurgeTargetType
} from "../purge/contract";
import { auditMemoryDeletion } from "../purge/reconciliation";
import type { MemoryDeletionContributorRegistry } from "../purge/registry";
import type { MemorySuppressionKeyring } from "../suppressionKeyring";
import {
  MEMORY_HISTORY_CLEAR_TARGET_TYPE,
  auditMemoryHistoryClearDeletion
} from "../history/purge";

type ActiveFactRow = Readonly<{
  canonicalKey: string;
  category: string;
  currentSourceMode: "AUTOMATIC" | "EXPLICIT";
  currentSystemFrom: Date;
  currentVersionId: string;
  factState: "ACTIVE" | "ORPHANED";
  factId: string;
  scopeId: string;
}>;

type FactVersionRow = Readonly<{
  displayText: string | null;
  factId: string;
  id: string;
}>;

type SourceEvidenceRow = Readonly<{
  branchGeneration: number;
  chatId: string;
  messageId: string;
}>;

type LifecycleMutationCommon = Readonly<{
  authorization: MemoryMutationAuthorizationUse;
  idempotencyFingerprint: string;
  idempotencyPayloadHash: string;
  modelRunId?: string | null;
  now: Date;
  persistedToolCallId?: string | null;
  requestId: string;
}>;

export type MemoryForgetMutationInput = LifecycleMutationCommon & Readonly<{
  expectedVersionId: string;
  factId: string;
}>;

export type MemoryDeleteExplicitMutationInput = LifecycleMutationCommon & Readonly<{
  expectedMemoryRevision: number;
  expectedSettingsRevision: number;
  operation: Extract<MemoryBulkDeleteOperation, "CLEAR_HISTORY_INDEX" | "DELETE_EXPLICIT">;
}>;

export type MemoryForgetMutationResult = Readonly<{
  deletionId: string;
  eventId: string;
  factId: string;
  memoryGeneration: number;
  memoryRevision: number;
  replayed: boolean;
  settingsRevision: number;
  versionId: string;
}>;

export type MemoryDeleteExplicitMutationResult = Readonly<{
  affectedFacts: number;
  deletionId: string;
  memoryGeneration: number;
  memoryRevision: number;
  replayed: boolean;
  settingsRevision: number;
}>;

const boundedIdPattern = /^\S{1,256}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

function validateCommon(input: LifecycleMutationCommon): void {
  if (
    !boundedIdPattern.test(input.authorization.authorizationId) ||
    !boundedIdPattern.test(input.requestId) ||
    !boundedIdPattern.test(input.idempotencyFingerprint) ||
    !sha256Pattern.test(input.idempotencyPayloadHash) ||
    (input.modelRunId != null && !boundedIdPattern.test(input.modelRunId)) ||
    (input.persistedToolCallId != null && !boundedIdPattern.test(input.persistedToolCallId)) ||
    ((input.modelRunId == null) !== (input.persistedToolCallId == null)) ||
    !Number.isFinite(input.now.getTime())
  ) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
}

function lifecycleReceiptFingerprint(action: "BULK_DELETE" | "FORGET", id: string): string {
  return memorySha256({
    action,
    authorizationId: id,
    domain: "aiqsa.memory.lifecycle-operation",
    version: "v1"
  });
}

export function memoryLifecycleIdempotencyFingerprint(
  action: "BULK_DELETE" | "FORGET",
  authorizationId: string
): string {
  return lifecycleReceiptFingerprint(action, authorizationId);
}

function receiptSnapshot(
  result: MemoryDeleteExplicitMutationResult | MemoryForgetMutationResult,
  inputPayloadHash: string
): Prisma.InputJsonObject {
  return {
    ...result,
    inputPayloadHash,
    replayed: false
  };
}

function receiptObject(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return memoryPersistenceFailure("memory_idempotency_conflict");
  }
  return value as Record<string, Prisma.JsonValue>;
}

function parseForgetReceipt(
  value: Prisma.JsonValue,
  payloadHash: string
): MemoryForgetMutationResult {
  const row = receiptObject(value);
  if (
    row.inputPayloadHash !== payloadHash ||
    typeof row.deletionId !== "string" ||
    typeof row.eventId !== "string" ||
    typeof row.factId !== "string" ||
    typeof row.memoryGeneration !== "number" ||
    typeof row.memoryRevision !== "number" ||
    typeof row.settingsRevision !== "number" ||
    typeof row.versionId !== "string"
  ) {
    return memoryPersistenceFailure("memory_idempotency_conflict");
  }
  return {
    deletionId: row.deletionId,
    eventId: row.eventId,
    factId: row.factId,
    memoryGeneration: row.memoryGeneration,
    memoryRevision: row.memoryRevision,
    replayed: true,
    settingsRevision: row.settingsRevision,
    versionId: row.versionId
  };
}

function parseBulkReceipt(
  value: Prisma.JsonValue,
  payloadHash: string
): MemoryDeleteExplicitMutationResult {
  const row = receiptObject(value);
  if (
    row.inputPayloadHash !== payloadHash ||
    typeof row.affectedFacts !== "number" ||
    typeof row.deletionId !== "string" ||
    typeof row.memoryGeneration !== "number" ||
    typeof row.memoryRevision !== "number" ||
    typeof row.settingsRevision !== "number"
  ) {
    return memoryPersistenceFailure("memory_idempotency_conflict");
  }
  return {
    affectedFacts: row.affectedFacts,
    deletionId: row.deletionId,
    memoryGeneration: row.memoryGeneration,
    memoryRevision: row.memoryRevision,
    replayed: true,
    settingsRevision: row.settingsRevision
  };
}

async function replayReceipt(
  tx: MemoryTransaction,
  userId: string,
  action: "BULK_DELETE" | "FORGET",
  input: LifecycleMutationCommon
): Promise<MemoryDeleteExplicitMutationResult | MemoryForgetMutationResult | null> {
  const receipt = await tx.memoryOperationReceipt.findUnique({
    where: {
      userId_idempotencyFingerprint: {
        idempotencyFingerprint: input.idempotencyFingerprint,
        userId
      }
    }
  });
  if (!receipt) return null;
  if (
    receipt.operation !== action ||
    receipt.outcome !== "APPLIED" ||
    receipt.requestId !== input.requestId ||
    receipt.modelRunId !== (input.modelRunId ?? null) ||
    receipt.persistedToolCallId !== (input.persistedToolCallId ?? null)
  ) {
    return memoryPersistenceFailure("memory_idempotency_conflict");
  }
  return action === "FORGET"
    ? parseForgetReceipt(receipt.resultSnapshot, input.idempotencyPayloadHash)
    : parseBulkReceipt(receipt.resultSnapshot, input.idempotencyPayloadHash);
}

async function persistReceipt(
  tx: MemoryTransaction,
  userId: string,
  action: "BULK_DELETE" | "FORGET",
  input: LifecycleMutationCommon,
  result: MemoryDeleteExplicitMutationResult | MemoryForgetMutationResult,
  target?: Readonly<{ factId: string; versionId: string }>
): Promise<void> {
  await tx.memoryOperationReceipt.create({
    data: {
      idempotencyFingerprint: input.idempotencyFingerprint,
      modelRunId: input.modelRunId,
      operation: action,
      outcome: "APPLIED",
      persistedToolCallId: input.persistedToolCallId,
      requestId: input.requestId,
      resultCode: action === "FORGET"
        ? "forgotten"
        : "operation" in input && input.operation === "CLEAR_HISTORY_INDEX"
          ? "clear_history_admitted"
          : "delete_explicit_admitted",
      resultSnapshot: receiptSnapshot(result, input.idempotencyPayloadHash),
      targetFactId: target?.factId,
      targetVersionId: target?.versionId,
      userId
    }
  });
}

async function lockForgettableFact(
  tx: MemoryTransaction,
  userId: string,
  factId: string
): Promise<ActiveFactRow | null> {
  const rows = await tx.$queryRaw<ActiveFactRow[]>(Prisma.sql`
    SELECT
      fact."id" AS "factId",
      fact."scopeId",
      fact."canonicalKey",
      fact."category",
      fact."state"::text AS "factState",
      version."id" AS "currentVersionId",
      version."sourceMode"::text AS "currentSourceMode",
      version."systemFrom" AS "currentSystemFrom"
    FROM "MemoryFact" AS fact
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = fact."userId"
      AND version."factId" = fact."id"
      AND (
        (
          fact."state" = 'ACTIVE'::"MemoryFactState"
          AND version."id" = fact."currentVersionId"
          AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
        )
        OR (
          fact."state" = 'ORPHANED'::"MemoryFactState"
          AND version."state" = 'ORPHANED'::"MemoryFactVersionState"
          AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
          AND NOT EXISTS (
            SELECT 1 FROM "MemoryFactVersion" AS newer
            WHERE newer."userId" = version."userId"
              AND newer."factId" = version."factId"
              AND newer."state" = 'ORPHANED'::"MemoryFactVersionState"
              AND (newer."systemFrom", newer."id") > (version."systemFrom", version."id")
          )
        )
      )
    WHERE fact."userId" = ${userId}
      AND fact."id" = ${factId}
      AND fact."state" IN (
        'ACTIVE'::"MemoryFactState",
        'ORPHANED'::"MemoryFactState"
      )
      AND scope."state" = CASE fact."state"
        WHEN 'ACTIVE'::"MemoryFactState" THEN 'ACTIVE'::"MemoryScopeState"
        ELSE 'ORPHANED'::"MemoryScopeState"
      END
    FOR UPDATE OF fact, version
  `);
  return rows[0] ?? null;
}

async function lockExplicitFacts(
  tx: MemoryTransaction,
  userId: string
): Promise<ActiveFactRow[]> {
  return tx.$queryRaw<ActiveFactRow[]>(Prisma.sql`
    SELECT
      fact."id" AS "factId",
      fact."scopeId",
      fact."canonicalKey",
      fact."category",
      fact."state"::text AS "factState",
      version."id" AS "currentVersionId",
      version."sourceMode"::text AS "currentSourceMode",
      version."systemFrom" AS "currentSystemFrom"
    FROM "MemoryFact" AS fact
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = fact."userId"
      AND version."factId" = fact."id"
      AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
      AND (
        (
          fact."state" = 'ACTIVE'::"MemoryFactState"
          AND version."id" = fact."currentVersionId"
          AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
        )
        OR (
          fact."state" = 'ORPHANED'::"MemoryFactState"
          AND version."state" = 'ORPHANED'::"MemoryFactVersionState"
          AND NOT EXISTS (
            SELECT 1 FROM "MemoryFactVersion" AS newer
            WHERE newer."userId" = version."userId"
              AND newer."factId" = version."factId"
              AND newer."state" = 'ORPHANED'::"MemoryFactVersionState"
              AND (newer."systemFrom", newer."id") > (version."systemFrom", version."id")
          )
        )
      )
    WHERE fact."userId" = ${userId}
      AND fact."state" IN (
        'ACTIVE'::"MemoryFactState",
        'ORPHANED'::"MemoryFactState"
      )
      AND scope."state" = CASE fact."state"
        WHEN 'ACTIVE'::"MemoryFactState" THEN 'ACTIVE'::"MemoryScopeState"
        ELSE 'ORPHANED'::"MemoryScopeState"
      END
    ORDER BY fact."id"
    FOR UPDATE OF fact, version
  `);
}

async function factVersions(
  tx: MemoryTransaction,
  userId: string,
  factIds: readonly string[]
): Promise<FactVersionRow[]> {
  if (factIds.length === 0) return [];
  return tx.memoryFactVersion.findMany({
    orderBy: [{ factId: "asc" }, { systemFrom: "asc" }, { id: "asc" }],
    select: { displayText: true, factId: true, id: true },
    where: { factId: { in: [...factIds] }, userId }
  });
}

async function sourceEvidence(
  tx: MemoryTransaction,
  userId: string,
  versionIds: readonly string[]
): Promise<SourceEvidenceRow[]> {
  if (versionIds.length === 0) return [];
  const rows = await tx.memoryEvidence.findMany({
    select: { branchGeneration: true, chatId: true, messageId: true },
    where: {
      factVersionId: { in: [...versionIds] },
      sourceType: "MESSAGE",
      userId
    }
  });
  return rows.flatMap((row) =>
    row.branchGeneration !== null && row.chatId && row.messageId
      ? [{
          branchGeneration: row.branchGeneration,
          chatId: row.chatId,
          messageId: row.messageId
        }]
      : []);
}

function suppressionInputs(
  facts: readonly ActiveFactRow[],
  versions: readonly FactVersionRow[],
  sources: readonly SourceEvidenceRow[]
): MemorySuppressionCreateInput[] {
  const result: MemorySuppressionCreateInput[] = [];
  const seen = new Set<string>();
  const add = (key: string, input: MemorySuppressionCreateInput) => {
    if (seen.has(key)) return;
    seen.add(key);
    result.push(input);
  };
  for (const fact of facts) {
    add(`fact:${fact.canonicalKey}`, {
      canonicalKey: fact.canonicalKey,
      explicitOverrideAllowed: true,
      scope: "FACT",
      suppressionId: randomUUID()
    });
  }
  for (const version of versions) {
    if (!version.displayText) continue;
    const normalized = normalizeMemorySearchText(version.displayText);
    if (!normalized) continue;
    add(`value:${normalized}`, {
      explicitOverrideAllowed: true,
      normalizedValue: normalized,
      scope: "VALUE",
      suppressionId: randomUUID()
    });
  }
  for (const source of sources) {
    add(`source:${source.chatId}:${source.messageId}:${source.branchGeneration}`, {
      branchGeneration: source.branchGeneration,
      chatId: source.chatId,
      explicitOverrideAllowed: true,
      messageId: source.messageId,
      scope: "SOURCE_MESSAGE",
      suppressionId: randomUUID()
    });
  }
  return result;
}

async function applyForgetFence(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  keyring: MemorySuppressionKeyring,
  facts: readonly ActiveFactRow[],
  now: Date,
  deletionId: string
): Promise<ReadonlyMap<string, string>> {
  const versions = await factVersions(tx, settings.userId, facts.map(({ factId }) => factId));
  const sources = await sourceEvidence(tx, settings.userId, versions.map(({ id }) => id));
  for (const suppression of suppressionInputs(facts, versions, sources)) {
    await createMemorySuppressionInTransaction(
      tx,
      settings,
      keyring,
      suppression,
      { advanceMemory: false }
    );
  }

  const events = new Map<string, string>();
  for (const fact of facts) {
    const eventId = randomUUID();
    const transitionAt = new Date(Math.max(
      now.getTime(),
      fact.currentSystemFrom.getTime() + 1
    ));
    await tx.memoryEvent.create({
      data: {
        actorType: "USER",
        actorUserId: settings.userId,
        factId: fact.factId,
        factVersionId: fact.currentVersionId,
        id: eventId,
        metadata: {
          deletionId,
          schemaVersion: "memory-forget-event-v1"
        },
        operation: "FORGET",
        userId: settings.userId
      }
    });
    await tx.$executeRaw(Prisma.sql`
      UPDATE "MemoryFactVersion"
      SET
        "state" = 'FORGOTTEN'::"MemoryFactVersionState",
        "systemTo" = COALESCE("systemTo", ${transitionAt})
      WHERE "userId" = ${settings.userId} AND "factId" = ${fact.factId}
    `);
    const updated = await tx.memoryFact.updateMany({
      data: {
        currentVersionId: null,
        forgottenAt: transitionAt,
        pinned: false,
        state: "FORGOTTEN"
      },
      where: {
        currentVersionId: fact.factState === "ACTIVE" ? fact.currentVersionId : null,
        id: fact.factId,
        state: fact.factState,
        userId: settings.userId
      }
    });
    if (updated.count !== 1) {
      return memoryPersistenceFailure("memory_fact_version_stale");
    }
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "MemorySearchEntry" AS search
      USING "MemoryFactVersion" AS version
      WHERE search."userId" = ${settings.userId}
        AND version."userId" = search."userId"
        AND version."id" = search."factVersionId"
        AND version."factId" = ${fact.factId}
    `);
    events.set(fact.factId, eventId);
  }
  return events;
}

function requireBulkCas(
  settings: LockedMemorySettings,
  input: MemoryDeleteExplicitMutationInput
): void {
  if (settings.settingsRevision !== input.expectedSettingsRevision) {
    return memoryPersistenceFailure("memory_settings_conflict");
  }
  if (settings.memoryRevision !== input.expectedMemoryRevision) {
    return memoryPersistenceFailure("memory_revision_conflict");
  }
}

export async function readPrismaMemoryDeletionStatus(
  contributors: MemoryDeletionContributorRegistry,
  userId: string,
  deletionId: string,
  client: PrismaClient = prisma
): Promise<MemoryDeletionStatus | null> {
  if (!boundedIdPattern.test(deletionId)) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
  const receipts = await client.$queryRaw<Array<{
    resultSnapshot: Prisma.JsonValue;
  }>>(Prisma.sql`
    SELECT receipt."resultSnapshot"
    FROM "MemoryOperationReceipt" AS receipt
    WHERE receipt."userId" = ${userId}
      AND receipt."operation" = 'BULK_DELETE'::"MemoryMutationAction"
      AND receipt."outcome" = 'APPLIED'::"MemoryOperationOutcome"
      AND receipt."resultSnapshot" ->> 'deletionId' = ${deletionId}
    ORDER BY receipt."createdAt" DESC, receipt."id" DESC
    LIMIT 1
  `);
  const receiptValue = receipts[0]?.resultSnapshot;
  const receipt = receiptValue && !Array.isArray(receiptValue) &&
      typeof receiptValue === "object"
    ? receiptValue as Record<string, Prisma.JsonValue>
    : null;
  if (!receipt) return null;
  const memoryRevision = receipt.memoryRevision;
  const settingsRevision = receipt.settingsRevision;
  if (
    typeof memoryRevision !== "number" ||
    !Number.isSafeInteger(memoryRevision) ||
    memoryRevision < 0 ||
    typeof settingsRevision !== "number" ||
    !Number.isSafeInteger(settingsRevision) ||
    settingsRevision < 0
  ) {
    return memoryPersistenceFailure("memory_counter_contract_invalid");
  }
  const clear = await auditMemoryHistoryClearDeletion(
    deletionId,
    userId,
    client
  );
  if (clear) {
    return {
      completedUnits: clear.completedUnits,
      deletionId,
      lastAuditAt: clear.lastAuditAt?.toISOString() ?? null,
      memoryGeneration: clear.memoryGeneration,
      memoryRevision,
      operation: "CLEAR_HISTORY_INDEX",
      settingsRevision,
      state: clear.state,
      totalUnits: clear.totalUnits,
      updatedAt: clear.updatedAt.toISOString()
    };
  }
  const audited = await auditMemoryDeletion(
    contributors,
    deletionId,
    userId,
    client
  );
  if (
    !audited ||
    audited.targetId !== MEMORY_DELETE_EXPLICIT_TARGET_ID ||
    !audited.targetType.startsWith("EXPLICIT_SET@")
  ) {
    return null;
  }
  return {
    completedUnits: audited.progress.completedUnits,
    deletionId: audited.id,
    lastAuditAt: audited.lastAuditAt?.toISOString() ?? null,
    memoryGeneration: audited.memoryGeneration,
    memoryRevision,
    operation: "DELETE_EXPLICIT",
    settingsRevision,
    state: audited.state,
    totalUnits: audited.progress.totalUnits,
    updatedAt: audited.updatedAt.toISOString()
  };
}

export function createPrismaMemoryLifecycleRepository(
  keyring: MemorySuppressionKeyring,
  contributors: MemoryDeletionContributorRegistry,
  client: PrismaClient = prisma
) {
  return Object.freeze({
    async clearHistory(
      userId: string,
      input: MemoryDeleteExplicitMutationInput
    ): Promise<MemoryDeleteExplicitMutationResult> {
      validateCommon(input);
      if (
        input.operation !== "CLEAR_HISTORY_INDEX" ||
        input.authorization.action !== "BULK_DELETE" ||
        !Number.isSafeInteger(input.expectedMemoryRevision) ||
        input.expectedMemoryRevision < 0 ||
        !Number.isSafeInteger(input.expectedSettingsRevision) ||
        input.expectedSettingsRevision < 0
      ) {
        return memoryPersistenceFailure("memory_input_invalid");
      }
      return withLockedMemoryTransaction(client, userId, async (tx, settings) => {
        const replay = await replayReceipt(tx, userId, "BULK_DELETE", input);
        if (replay) return replay as MemoryDeleteExplicitMutationResult;
        requireBulkCas(settings, input);
        await consumeMemoryMutationAuthorization(tx, userId, {
          ...input.authorization,
          requestId: input.requestId
        }, input.now);
        const [chunks, episodes] = await Promise.all([
          tx.memoryRecallChunk.count({ where: { userId } }),
          tx.memoryEpisode.count({ where: { userId } })
        ]);
        await advanceMemoryMutation(tx, settings, "FORGET_OR_BULK_CLEAR");
        const barrierId = randomUUID();
        await tx.memorySourceBarrier.create({
          data: {
            explicitOverrideAllowed: false,
            id: barrierId,
            kind: "HISTORY_INDEX",
            memoryGeneration: settings.memoryGeneration,
            sourceCreatedAtCutoff: input.now,
            userId
          }
        });
        await tx.memorySearchEntry.deleteMany({
          where: {
            OR: [
              { episodeId: { not: null } },
              { recallChunkId: { not: null } }
            ],
            userId
          }
        });
        await tx.memoryEpisode.updateMany({
          data: { invalidatedAt: input.now, state: "INVALIDATED" },
          where: { state: "ACTIVE", userId }
        });
        await tx.memoryRecallChunk.updateMany({
          data: { invalidatedAt: input.now, state: "INVALIDATED" },
          where: { state: "ACTIVE", userId }
        });
        await tx.chatMemoryCheckpoint.updateMany({
          data: {
            lastDreamedMessageId: null,
            lastErrorCode: "memory_history_cleared",
            lastIndexedMessageId: null,
            lastSucceededAt: null,
            status: "STALE"
          },
          where: { userId }
        });
        await tx.memoryJob.updateMany({
          data: {
            completedAt: input.now,
            errorCode: "memory_history_cleared",
            leaseExpiresAt: null,
            leaseToken: null,
            nextAttemptAt: null,
            state: "CANCELLED",
            updatedAt: input.now
          },
          where: {
            kind: { in: ["EXTRACT_EPISODE", "INDEX_HISTORY"] },
            state: {
              in: [
                "CLAIMED",
                "QUEUED",
                "RETRYABLE_FAILED",
                "WAITING_FOR_EGRESS_CONSENT"
              ]
            },
            userId
          }
        });
        const deletion = await enqueueMemoryDeletion(tx, settings, {
          operation: "BULK_CLEAR",
          targetId: barrierId,
          targetType: MEMORY_HISTORY_CLEAR_TARGET_TYPE
        });
        const result: MemoryDeleteExplicitMutationResult = {
          affectedFacts: chunks + episodes,
          deletionId: deletion.id,
          memoryGeneration: settings.memoryGeneration,
          memoryRevision: settings.memoryRevision,
          replayed: false,
          settingsRevision: settings.settingsRevision
        };
        await persistReceipt(tx, userId, "BULK_DELETE", input, result);
        return result;
      });
    },

    async deleteExplicit(
      userId: string,
      input: MemoryDeleteExplicitMutationInput
    ): Promise<MemoryDeleteExplicitMutationResult> {
      validateCommon(input);
      if (
        input.operation !== "DELETE_EXPLICIT" ||
        input.authorization.action !== "BULK_DELETE" ||
        !Number.isSafeInteger(input.expectedMemoryRevision) ||
        input.expectedMemoryRevision < 0 ||
        !Number.isSafeInteger(input.expectedSettingsRevision) ||
        input.expectedSettingsRevision < 0
      ) {
        return memoryPersistenceFailure("memory_input_invalid");
      }
      return withLockedMemoryTransaction(client, userId, async (tx, settings) => {
        const replay = await replayReceipt(tx, userId, "BULK_DELETE", input);
        if (replay) return replay as MemoryDeleteExplicitMutationResult;
        requireBulkCas(settings, input);
        await consumeMemoryMutationAuthorization(tx, userId, {
          ...input.authorization,
          requestId: input.requestId
        }, input.now);
        const facts = await lockExplicitFacts(tx, userId);
        await advanceMemoryMutation(tx, settings, "FORGET_OR_BULK_CLEAR");
        const deletion = await enqueueMemoryDeletion(tx, settings, {
          operation: "FORGET_PURGE",
          targetId: MEMORY_DELETE_EXPLICIT_TARGET_ID,
          targetType: memoryPurgeTargetType("EXPLICIT_SET")
        });
        await applyForgetFence(tx, settings, keyring, facts, input.now, deletion.id);
        const result: MemoryDeleteExplicitMutationResult = {
          affectedFacts: facts.length,
          deletionId: deletion.id,
          memoryGeneration: settings.memoryGeneration,
          memoryRevision: settings.memoryRevision,
          replayed: false,
          settingsRevision: settings.settingsRevision
        };
        await persistReceipt(tx, userId, "BULK_DELETE", input, result);
        return result;
      });
    },

    async forget(
      userId: string,
      input: MemoryForgetMutationInput
    ): Promise<MemoryForgetMutationResult> {
      validateCommon(input);
      if (
        input.authorization.action !== "FORGET" ||
        !boundedIdPattern.test(input.factId) ||
        !boundedIdPattern.test(input.expectedVersionId)
      ) {
        return memoryPersistenceFailure("memory_input_invalid");
      }
      return withLockedMemoryTransaction(client, userId, async (tx, settings) => {
        const replay = await replayReceipt(tx, userId, "FORGET", input);
        if (replay) return replay as MemoryForgetMutationResult;
        await consumeMemoryMutationAuthorization(tx, userId, {
          ...input.authorization,
          requestId: input.requestId
        }, input.now);
        const fact = await lockForgettableFact(tx, userId, input.factId);
        if (!fact) return memoryPersistenceFailure("memory_fact_not_found");
        if (fact.currentVersionId !== input.expectedVersionId) {
          return memoryPersistenceFailure("memory_fact_version_stale");
        }
        await advanceMemoryMutation(tx, settings, "FORGET_OR_BULK_CLEAR");
        const deletion = await enqueueMemoryDeletion(tx, settings, {
          operation: "FORGET_PURGE",
          targetId: fact.factId,
          targetType: memoryPurgeTargetType("MEMORY_FACT")
        });
        const events = await applyForgetFence(
          tx,
          settings,
          keyring,
          [fact],
          input.now,
          deletion.id
        );
        const eventId = events.get(fact.factId);
        if (!eventId) return memoryPersistenceFailure("memory_counter_contract_invalid");
        const result: MemoryForgetMutationResult = {
          deletionId: deletion.id,
          eventId,
          factId: fact.factId,
          memoryGeneration: settings.memoryGeneration,
          memoryRevision: settings.memoryRevision,
          replayed: false,
          settingsRevision: settings.settingsRevision,
          versionId: fact.currentVersionId
        };
        await persistReceipt(tx, userId, "FORGET", input, result, {
          factId: fact.factId,
          versionId: fact.currentVersionId
        });
        return result;
      });
    },

    async status(userId: string, deletionId: string): Promise<MemoryDeletionStatus | null> {
      return readPrismaMemoryDeletionStatus(contributors, userId, deletionId, client);
    }
  });
}

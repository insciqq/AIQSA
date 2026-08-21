import { Prisma, type PrismaClient } from "@prisma/client";
import {
  memoryCounterEffectFor,
  type MemoryCounterMutation
} from "../../../domain/memory/counters";
import { memoryIndexGenerationBootstrapAllowed } from "../../../domain/memory/stateMachines";
import { memoryPersistenceFailure } from "./errors";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_LANGUAGE_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION
} from "./lexical";
import { wakeMemoryShadowRebuildInTransaction } from "../rebuild/wake";

const SERIALIZABLE_ATTEMPTS = 3;

export type MemoryTransaction = Prisma.TransactionClient;

export type LockedMemorySettings = {
  acceptedUtilityEgressAt: Date | null;
  acceptedUtilityEgressFingerprint: string | null;
  acceptedUtilityPolicyVersion: string | null;
  activeIndexGenerationId: string | null;
  embeddingProviderModelId: string | null;
  learnAutomatically: boolean;
  memoryConsentRevision: number;
  memoryGeneration: number;
  memoryRevision: number;
  referenceChatHistory: boolean;
  sensitiveAutomaticPolicy: "EXPLICIT_ONLY";
  settingsRevision: number;
  useMemoryFacts: boolean;
  userId: string;
};

type LockedMemorySettingsRow = LockedMemorySettings & {
  ownerStatus: "active" | "denied" | "disabled" | "pending";
};

export type MemoryCounterSnapshot = Readonly<{
  activeIndexGenerationId: string | null;
  memoryGeneration: number;
  memoryRevision: number;
}>;

export type MemoryActiveIndex = Readonly<{
  id: string;
  indexMode: "HYBRID" | "LEXICAL_ONLY";
}>;

export type MemoryTransactionOptions = Readonly<{
  clock?: () => number;
  deadlineAtMs?: number;
  requireActiveOwner?: boolean;
}>;

function remainingTransactionDeadlineMs(
  options: MemoryTransactionOptions
): number | null {
  if (options.deadlineAtMs === undefined) return null;
  if (!Number.isFinite(options.deadlineAtMs)) {
    return memoryPersistenceFailure("memory_admission_deadline_exceeded");
  }
  const remaining = Math.floor(options.deadlineAtMs - (options.clock ?? Date.now)());
  if (remaining <= 0) {
    return memoryPersistenceFailure("memory_admission_deadline_exceeded");
  }
  return remaining;
}

async function applyTransactionDeadline(
  tx: MemoryTransaction,
  remainingMs: number | null
): Promise<void> {
  if (remainingMs === null) return;
  const timeout = `${Math.max(1, remainingMs)}ms`;
  await tx.$queryRaw(Prisma.sql`
    SELECT
      set_config('lock_timeout', ${timeout}, true),
      set_config('statement_timeout', ${timeout}, true)
  `);
}

function serializationConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  return error.code === "P2010" &&
    typeof error.meta === "object" &&
    error.meta !== null &&
    "code" in error.meta &&
    error.meta.code === "40001";
}

function transactionDeadlineExceeded(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2028") return true;
  return error.code === "P2010" &&
    typeof error.meta === "object" &&
    error.meta !== null &&
    "code" in error.meta &&
    (error.meta.code === "57014" || error.meta.code === "55P03");
}

export async function lockMemorySettings(
  tx: MemoryTransaction,
  userId: string,
  requireActiveOwner: boolean
): Promise<LockedMemorySettings> {
  const rows = await tx.$queryRaw<LockedMemorySettingsRow[]>(Prisma.sql`
    SELECT
      settings."userId",
      settings."useMemoryFacts",
      settings."referenceChatHistory",
      settings."learnAutomatically",
      settings."memoryGeneration",
      settings."memoryRevision",
      settings."activeIndexGenerationId",
      settings."embeddingProviderModelId",
      settings."sensitiveAutomaticPolicy",
      settings."memoryConsentRevision",
      settings."settingsRevision",
      settings."acceptedUtilityEgressFingerprint",
      settings."acceptedUtilityPolicyVersion",
      settings."acceptedUtilityEgressAt",
      owner."status" AS "ownerStatus"
    FROM "UserMemorySettings" AS settings
    INNER JOIN "User" AS owner ON owner."id" = settings."userId"
    WHERE settings."userId" = ${userId}
    FOR UPDATE OF owner, settings
  `);
  const row = rows[0];
  if (!row || (requireActiveOwner && row.ownerStatus !== "active")) {
    return memoryPersistenceFailure("memory_owner_unavailable");
  }
  const { ownerStatus: _ownerStatus, ...settings } = row;
  return settings;
}

export async function withLockedMemoryTransaction<T>(
  client: PrismaClient,
  userId: string,
  operation: (tx: MemoryTransaction, settings: LockedMemorySettings) => Promise<T>,
  options: MemoryTransactionOptions = {}
): Promise<T> {
  for (let attempt = 0; attempt < SERIALIZABLE_ATTEMPTS; attempt += 1) {
    const remainingMs = remainingTransactionDeadlineMs(options);
    try {
      return await client.$transaction(async (tx) => {
        await applyTransactionDeadline(tx, remainingMs);
        const settings = await lockMemorySettings(
          tx,
          userId,
          options.requireActiveOwner ?? true
        );
        return operation(tx, settings);
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        ...(remainingMs === null ? {} : {
          maxWait: remainingMs,
          timeout: remainingMs
        })
      });
    } catch (error) {
      if (options.deadlineAtMs !== undefined && (
        transactionDeadlineExceeded(error) ||
        (options.clock ?? Date.now)() >= options.deadlineAtMs
      )) {
        return memoryPersistenceFailure("memory_admission_deadline_exceeded");
      }
      if (attempt < SERIALIZABLE_ATTEMPTS - 1 && serializationConflict(error)) continue;
      throw error;
    }
  }
  throw new Error("memory_serializable_retry_exhausted");
}

export async function requireActiveMemoryIndex(
  tx: MemoryTransaction,
  settings: LockedMemorySettings
): Promise<MemoryActiveIndex | null> {
  if (!settings.activeIndexGenerationId) return null;
  const generation = await tx.memoryIndexGeneration.findFirst({
    select: { id: true, indexMode: true },
    where: {
      id: settings.activeIndexGenerationId,
      state: "ACTIVE",
      userId: settings.userId
    }
  });
  if (!generation) return memoryPersistenceFailure("memory_active_generation_invalid");
  return generation;
}

export async function ensureActiveLexicalGeneration(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  targetMemoryRevision: number
): Promise<MemoryActiveIndex> {
  const active = await requireActiveMemoryIndex(tx, settings);
  if (active) return active;
  if (!memoryIndexGenerationBootstrapAllowed({
    activeGenerationExists: false,
    indexMode: "LEXICAL_ONLY",
    settingsLockHeld: true
  })) {
    return memoryPersistenceFailure("memory_counter_contract_invalid");
  }

  const aggregate = await tx.memoryIndexGeneration.aggregate({
    _max: { generation: true },
    where: { userId: settings.userId }
  });
  const now = new Date();
  const generation = await tx.memoryIndexGeneration.create({
    data: {
      activatedAt: now,
      chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION,
      generation: (aggregate._max.generation ?? -1) + 1,
      indexMode: "LEXICAL_ONLY",
      indexedThroughMemoryRevision: settings.memoryRevision,
      languageProfile: MEMORY_LEXICAL_LANGUAGE_PROFILE,
      normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
      readyAt: now,
      retrievalPipelineVersion: MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
      state: "ACTIVE",
      targetMemoryRevision,
      userId: settings.userId
    },
    select: { id: true, indexMode: true }
  });
  await tx.userMemorySettings.update({
    data: { activeIndexGenerationId: generation.id },
    where: { userId: settings.userId }
  });
  settings.activeIndexGenerationId = generation.id;
  return generation;
}

export async function advanceMemoryMutation(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  mutation: MemoryCounterMutation,
  options: Readonly<{ sourceRevisionHandled?: boolean }> = {}
): Promise<MemoryCounterSnapshot> {
  const effect = memoryCounterEffectFor(mutation);
  if (
    effect.branchGeneration !== false ||
    (effect.sourceRevision !== false && !options.sourceRevisionHandled)
  ) {
    return memoryPersistenceFailure("memory_counter_contract_invalid");
  }

  const nextMemoryGeneration = settings.memoryGeneration + (effect.memoryGeneration ? 1 : 0);
  const nextMemoryRevision = settings.memoryRevision + (effect.memoryRevision ? 1 : 0);
  let activeIndex = await requireActiveMemoryIndex(tx, settings);
  if (effect.memoryRevision && !activeIndex) {
    activeIndex = await ensureActiveLexicalGeneration(tx, settings, nextMemoryRevision);
  }

  const updated = await tx.userMemorySettings.updateMany({
    data: {
      memoryGeneration: nextMemoryGeneration,
      memoryRevision: nextMemoryRevision
    },
    where: {
      memoryGeneration: settings.memoryGeneration,
      memoryRevision: settings.memoryRevision,
      userId: settings.userId
    }
  });
  if (updated.count !== 1) return memoryPersistenceFailure("memory_counter_contract_invalid");

  settings.memoryGeneration = nextMemoryGeneration;
  settings.memoryRevision = nextMemoryRevision;
  if (effect.memoryRevision && activeIndex) {
    const settled = await tx.memoryIndexGeneration.updateMany({
      data: { indexedThroughMemoryRevision: nextMemoryRevision },
      where: { id: activeIndex.id, state: "ACTIVE", userId: settings.userId }
    });
    if (settled.count !== 1) return memoryPersistenceFailure("memory_active_generation_invalid");
  }
  if (effect.memoryRevision) {
    const shadow = await tx.memoryIndexGeneration.findFirst({
      orderBy: { generation: "desc" },
      select: { id: true },
      where: {
        state: { in: ["BUILDING", "CATCHING_UP", "READY"] },
        userId: settings.userId
      }
    });
    if (shadow) {
      await wakeMemoryShadowRebuildInTransaction(tx, settings.userId, shadow.id);
    }
  }

  return {
    activeIndexGenerationId: settings.activeIndexGenerationId,
    memoryGeneration: nextMemoryGeneration,
    memoryRevision: nextMemoryRevision
  };
}

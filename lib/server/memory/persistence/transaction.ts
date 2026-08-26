import { randomInt } from "node:crypto";
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

// Provider work can complete in a burst for one user. Every authoritative
// Memory commit deliberately takes the same settings lock, so Serializable
// waiters may each need a fresh snapshot before they can enter the short
// commit section. Keep provider work outside this loop and give the
// rollback-safe commit enough attempts to drain that burst.
const SERIALIZABLE_ATTEMPTS = 24;
const SERIALIZABLE_RETRY_BASE_DELAY_MS = 25;
const SERIALIZABLE_RETRY_MAX_DELAY_MS = 500;

export type MemoryTransaction = Prisma.TransactionClient;

export type LockedMemorySettings = {
  acceptedUtilityEgressAt: Date | null;
  acceptedUtilityEgressFingerprint: string | null;
  acceptedUtilityPolicyVersion: string | null;
  activeIndexGenerationId: string | null;
  decayEnabled: boolean;
  decayPolicyVersion: string | null;
  embeddingProviderModelId: string | null;
  learnAutomatically: boolean;
  memoryConsentRevision: number;
  memoryGeneration: number;
  memoryRevision: number;
  referenceChatHistory: boolean;
  sensitiveAutomaticPolicy: "EXPLICIT_ONLY";
  settingsRevision: number;
  synthesisEnabled: boolean;
  synthesisEnabledAt: Date | null;
  synthesisPolicyVersion: string | null;
  lastSynthesisAt: Date | null;
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
  serializationRetryDelay?: (retryOrdinal: number) => Promise<void>;
}>;

async function waitForSerializationRetry(retryOrdinal: number): Promise<void> {
  const ceiling = Math.min(
    SERIALIZABLE_RETRY_MAX_DELAY_MS,
    SERIALIZABLE_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, retryOrdinal - 1))
  );
  const milliseconds = randomInt(1, ceiling + 1);
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

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
    (error.meta.code === "40001" || error.meta.code === "40P01");
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
  // A joined `FOR UPDATE OF owner, settings` can acquire the two table locks
  // in opposite orders across concurrent transactions. Materializing the
  // owner lock first gives every Memory path one deterministic lock order,
  // then the outer query locks the settings row.
  const rows = await tx.$queryRaw<LockedMemorySettingsRow[]>(Prisma.sql`
    WITH locked_owner AS MATERIALIZED (
      SELECT owner."id", owner."status"
      FROM "User" AS owner
      WHERE owner."id" = ${userId}
      FOR UPDATE OF owner
    )
    SELECT
      settings."userId",
      settings."useMemoryFacts",
      settings."referenceChatHistory",
      settings."learnAutomatically",
      settings."memoryGeneration",
      settings."memoryRevision",
      settings."activeIndexGenerationId",
      settings."decayEnabled",
      settings."decayPolicyVersion",
      settings."embeddingProviderModelId",
      settings."sensitiveAutomaticPolicy",
      settings."memoryConsentRevision",
      settings."settingsRevision",
      settings."acceptedUtilityEgressFingerprint",
      settings."acceptedUtilityPolicyVersion",
      settings."acceptedUtilityEgressAt",
      settings."synthesisEnabled",
      settings."synthesisEnabledAt",
      settings."synthesisPolicyVersion",
      settings."lastSynthesisAt",
      locked_owner."status" AS "ownerStatus"
    FROM "UserMemorySettings" AS settings
    INNER JOIN locked_owner ON locked_owner."id" = settings."userId"
    WHERE settings."userId" = ${userId}
    FOR UPDATE OF settings
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
      if (attempt < SERIALIZABLE_ATTEMPTS - 1 && serializationConflict(error)) {
        await (options.serializationRetryDelay ?? waitForSerializationRetry)(attempt + 1);
        continue;
      }
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

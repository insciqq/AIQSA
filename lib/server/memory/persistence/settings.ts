import {
  Prisma,
  type MemoryJobKind,
  type MemoryPauseScope,
  type PrismaClient
} from "@prisma/client";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  type MemoryConsentInput,
  type MemorySettingsPatch
} from "../../../contracts/memory";
import {
  loadEmbeddingProviderRole,
  ProviderAdmissionError
} from "../../providerRuntime/admission";
import { prisma } from "../../prisma";
import {
  resolveCurrentMemoryUtilityPolicy,
  type ResolvedMemoryUtilityPolicy
} from "../execution/policy";
import { MEMORY_SYNTHESIS_POLICY_VERSION } from "../synthesis/policy";
import { MEMORY_DECAY_POLICY_VERSION } from "../../../domain/memory/retrieval";
import { memoryPersistenceFailure } from "./errors";
import {
  advanceMemoryMutation,
  type LockedMemorySettings,
  type MemoryTransaction,
  withLockedMemoryTransaction
} from "./transaction";

export type MemorySettingsPersistenceSnapshot = Readonly<{
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
  updatedAt: Date;
  useMemoryFacts: boolean;
  userId: string;
}>;

const settingsSelect = {
  acceptedUtilityEgressAt: true,
  acceptedUtilityEgressFingerprint: true,
  acceptedUtilityPolicyVersion: true,
  activeIndexGenerationId: true,
  decayEnabled: true,
  decayPolicyVersion: true,
  embeddingProviderModelId: true,
  learnAutomatically: true,
  memoryConsentRevision: true,
  memoryGeneration: true,
  memoryRevision: true,
  referenceChatHistory: true,
  sensitiveAutomaticPolicy: true,
  settingsRevision: true,
  synthesisEnabled: true,
  synthesisEnabledAt: true,
  synthesisPolicyVersion: true,
  lastSynthesisAt: true,
  updatedAt: true,
  useMemoryFacts: true,
  userId: true
} satisfies Prisma.UserMemorySettingsSelect;

type MemorySettingsRepositoryOptions = Readonly<{
  now?: () => Date;
  resolveCurrentUtilityPolicy?: (
    tx: MemoryTransaction,
    userId: string,
    settings: Pick<LockedMemorySettings, "embeddingProviderModelId">
  ) => Promise<ResolvedMemoryUtilityPolicy>;
  validateEmbeddingSelection?: (
    tx: MemoryTransaction,
    input: Readonly<{ providerModelId: string; userId: string }>
  ) => Promise<void>;
}>;

const pausableJobStates = [
  "CLAIMED",
  "QUEUED",
  "RETRYABLE_FAILED",
  "WAITING_FOR_EGRESS_CONSENT"
] as const;

async function closePauseAdmissionCutoff(
  tx: MemoryTransaction,
  userId: string,
  scope: MemoryPauseScope,
  resumedAt: Date
): Promise<void> {
  await tx.memoryPauseInterval.updateMany({
    data: { resumedAt },
    where: { resumedAt: null, scope, userId }
  });
}

async function openPauseAdmissionCutoff(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  scope: MemoryPauseScope,
  pausedAt: Date
): Promise<void> {
  await tx.memoryPauseInterval.create({
    data: {
      memoryGeneration: settings.memoryGeneration,
      pausedAt,
      scope,
      userId: settings.userId
    }
  });
}

async function cancelPausedJobs(
  tx: MemoryTransaction,
  userId: string,
  kinds: readonly MemoryJobKind[],
  errorCode: string,
  pausedAt: Date
): Promise<void> {
  await tx.memoryJob.updateMany({
    data: {
      completedAt: pausedAt,
      errorCode,
      errorMessage: null,
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: null,
      state: "CANCELLED",
      updatedAt: pausedAt
    },
    where: {
      kind: { in: [...kinds] },
      state: { in: [...pausableJobStates] },
      userId
    }
  });
}

const visibleKeys = [
  "decayEnabled",
  "embeddingDeploymentId",
  "learnAutomatically",
  "referenceChatHistory",
  "sensitiveAutomaticPolicy",
  "synthesisEnabled",
  "useMemoryFacts"
] as const;

function owns(input: object, key: PropertyKey): boolean {
  return Object.hasOwn(input, key);
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function visiblePatchChanges(
  settings: LockedMemorySettings,
  patch: MemorySettingsPatch
): boolean {
  return (
    (owns(patch, "decayEnabled") &&
      patch.decayEnabled !== settings.decayEnabled) ||
    (owns(patch, "embeddingDeploymentId") &&
      patch.embeddingDeploymentId !== settings.embeddingProviderModelId) ||
    (owns(patch, "learnAutomatically") &&
      patch.learnAutomatically !== settings.learnAutomatically) ||
    (owns(patch, "referenceChatHistory") &&
      patch.referenceChatHistory !== settings.referenceChatHistory) ||
    (owns(patch, "sensitiveAutomaticPolicy") &&
      patch.sensitiveAutomaticPolicy !== settings.sensitiveAutomaticPolicy) ||
    (owns(patch, "synthesisEnabled") &&
      patch.synthesisEnabled !== settings.synthesisEnabled) ||
    (owns(patch, "useMemoryFacts") && patch.useMemoryFacts !== settings.useMemoryFacts)
  );
}

function validatePatchShape(patch: MemorySettingsPatch): void {
  const hasVisibleKey = visibleKeys.some((key) => owns(patch, key));
  if (
    !validRevision(patch.expectedSettingsRevision) ||
    !hasVisibleKey ||
    visibleKeys.some(
      (key) => owns(patch, key) && patch[key] === undefined
    )
  ) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
  if (hasVisibleKey !== (patch.expectedMemoryRevision !== undefined)) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
  if (patch.expectedMemoryRevision !== undefined &&
    !validRevision(patch.expectedMemoryRevision)) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
}

function validateConsentInput(input: MemoryConsentInput): void {
  if (
    input.confirmationCopyVersion !== MEMORY_CONFIRMATION_COPY_VERSION ||
    !validRevision(input.expectedMemoryConsentRevision) ||
    !validRevision(input.expectedMemoryRevision) ||
    !validRevision(input.expectedSettingsRevision) ||
    input.currentUtilityEgressFingerprint.trim() !== input.currentUtilityEgressFingerprint ||
    input.currentUtilityEgressFingerprint.length === 0 ||
    input.currentUtilityEgressFingerprint.length > 128 ||
    input.currentUtilityPolicyVersion.trim() !== input.currentUtilityPolicyVersion ||
    input.currentUtilityPolicyVersion.length === 0 ||
    input.currentUtilityPolicyVersion.length > 64
  ) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
}

async function persistedSettings(
  tx: MemoryTransaction,
  userId: string
): Promise<MemorySettingsPersistenceSnapshot> {
  const row = await tx.userMemorySettings.findUnique({ select: settingsSelect, where: { userId } });
  if (!row) return memoryPersistenceFailure("memory_owner_unavailable");
  return row;
}

export function createPrismaMemorySettingsRepository(
  client: PrismaClient = prisma,
  options: MemorySettingsRepositoryOptions = {}
) {
  const now = options.now ?? (() => new Date());
  const resolveCurrentUtilityPolicy = options.resolveCurrentUtilityPolicy ??
    resolveCurrentMemoryUtilityPolicy;
  const validateEmbeddingSelection = options.validateEmbeddingSelection ??
    (async (tx, input) => {
      await loadEmbeddingProviderRole(tx, input);
    });

  return Object.freeze({
    async acceptUtilityEgress(
      userId: string,
      input: MemoryConsentInput
    ): Promise<MemorySettingsPersistenceSnapshot> {
      validateConsentInput(input);
      return withLockedMemoryTransaction(client, userId, async (tx, settings) => {
        if (settings.settingsRevision !== input.expectedSettingsRevision) {
          return memoryPersistenceFailure("memory_settings_conflict");
        }
        if (settings.memoryRevision !== input.expectedMemoryRevision) {
          return memoryPersistenceFailure("memory_revision_conflict");
        }
        if (settings.memoryConsentRevision !== input.expectedMemoryConsentRevision) {
          return memoryPersistenceFailure("memory_consent_conflict");
        }

        const currentPolicy = await resolveCurrentUtilityPolicy(tx, userId, settings);
        if (
          currentPolicy.fingerprint !== input.currentUtilityEgressFingerprint ||
          currentPolicy.policyVersion !== input.currentUtilityPolicyVersion
        ) {
          return memoryPersistenceFailure("memory_consent_policy_changed");
        }

        await advanceMemoryMutation(tx, settings, "MEMORY_VISIBLE_SETTING_CHANGE");
        const updated = await tx.userMemorySettings.updateMany({
          data: {
            acceptedUtilityEgressAt: new Date(),
            acceptedUtilityEgressFingerprint: currentPolicy.fingerprint,
            acceptedUtilityPolicyVersion: currentPolicy.policyVersion,
            memoryConsentRevision: { increment: 1 },
            settingsRevision: { increment: 1 }
          },
          where: {
            memoryConsentRevision: input.expectedMemoryConsentRevision,
            settingsRevision: input.expectedSettingsRevision,
            userId
          }
        });
        if (updated.count !== 1) return memoryPersistenceFailure("memory_settings_conflict");
        settings.memoryConsentRevision += 1;
        settings.settingsRevision += 1;
        return persistedSettings(tx, userId);
      });
    },

    async get(userId: string): Promise<MemorySettingsPersistenceSnapshot> {
      return client.$transaction(async (tx) => {
        const [owner, settings] = await Promise.all([
          tx.user.findFirst({
            select: { id: true },
            where: { id: userId, status: "active" }
          }),
          tx.userMemorySettings.findUnique({
            select: settingsSelect,
            where: { userId }
          })
        ]);
        if (!owner || !settings) {
          return memoryPersistenceFailure("memory_owner_unavailable");
        }
        return settings;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },

    async patch(
      userId: string,
      patch: MemorySettingsPatch
    ): Promise<MemorySettingsPersistenceSnapshot> {
      validatePatchShape(patch);
      return withLockedMemoryTransaction(client, userId, async (tx, settings) => {
        if (settings.settingsRevision !== patch.expectedSettingsRevision) {
          return memoryPersistenceFailure("memory_settings_conflict");
        }
        if (
          patch.expectedMemoryRevision !== undefined &&
          settings.memoryRevision !== patch.expectedMemoryRevision
        ) {
          return memoryPersistenceFailure("memory_revision_conflict");
        }
        const embeddingDeploymentId = patch.embeddingDeploymentId;
        if (owns(patch, "embeddingDeploymentId") && embeddingDeploymentId != null) {
          try {
            await validateEmbeddingSelection(tx, {
              providerModelId: embeddingDeploymentId,
              userId
            });
          } catch (error) {
            if (error instanceof ProviderAdmissionError) {
              return memoryPersistenceFailure("memory_embedding_unavailable");
            }
            throw error;
          }
        }

        const masterPause = owns(patch, "useMemoryFacts") &&
          settings.useMemoryFacts && patch.useMemoryFacts === false;
        const masterResume = owns(patch, "useMemoryFacts") &&
          !settings.useMemoryFacts && patch.useMemoryFacts === true;
        const historyPause = owns(patch, "referenceChatHistory") &&
          settings.referenceChatHistory && patch.referenceChatHistory === false;
        const historyResume = owns(patch, "referenceChatHistory") &&
          !settings.referenceChatHistory && patch.referenceChatHistory === true;
        const learningPause = owns(patch, "learnAutomatically") &&
          settings.learnAutomatically && patch.learnAutomatically === false;
        const learningResume = owns(patch, "learnAutomatically") &&
          !settings.learnAutomatically && patch.learnAutomatically === true;
        const synthesisEnable = owns(patch, "synthesisEnabled") &&
          !settings.synthesisEnabled && patch.synthesisEnabled === true;
        const synthesisDisable = owns(patch, "synthesisEnabled") &&
          settings.synthesisEnabled && patch.synthesisEnabled === false;
        if (masterPause) {
          // Unlike a subordinate preference change, pausing the master must
          // invalidate every already-admitted source/job snapshot.  Keep the
          // subordinate booleans untouched so a later explicit resume does
          // not silently rewrite the user's preferences.
          await advanceMemoryMutation(tx, settings, "MEMORY_MASTER_PAUSE");
        } else if (visiblePatchChanges(settings, patch)) {
          await advanceMemoryMutation(tx, settings, "MEMORY_VISIBLE_SETTING_CHANGE");
        }
        const cutoff = now();
        const data: Prisma.UserMemorySettingsUpdateManyMutationInput = {
          settingsRevision: { increment: 1 }
        };
        if (owns(patch, "decayEnabled")) {
          data.decayEnabled = patch.decayEnabled;
          if (patch.decayEnabled) {
            data.decayPolicyVersion = MEMORY_DECAY_POLICY_VERSION;
          }
        }
        if (owns(patch, "embeddingDeploymentId")) {
          data.embeddingProviderModelId = patch.embeddingDeploymentId;
        }
        if (owns(patch, "learnAutomatically")) data.learnAutomatically = patch.learnAutomatically;
        if (owns(patch, "referenceChatHistory")) {
          data.referenceChatHistory = patch.referenceChatHistory;
        }
        if (owns(patch, "sensitiveAutomaticPolicy")) {
          data.sensitiveAutomaticPolicy = patch.sensitiveAutomaticPolicy;
        }
        if (owns(patch, "synthesisEnabled")) {
          data.synthesisEnabled = patch.synthesisEnabled;
          if (patch.synthesisEnabled) {
            data.synthesisEnabledAt = settings.synthesisEnabledAt ?? cutoff;
            data.synthesisPolicyVersion = MEMORY_SYNTHESIS_POLICY_VERSION;
          }
        }
        if (owns(patch, "useMemoryFacts")) data.useMemoryFacts = patch.useMemoryFacts;

        const updated = await tx.userMemorySettings.updateMany({
          data,
          where: { settingsRevision: patch.expectedSettingsRevision, userId }
        });
        if (updated.count !== 1) return memoryPersistenceFailure("memory_settings_conflict");
        if (masterPause) {
          // A pause cutoff is deliberately non-destructive. It is closed at
          // resume and admission treats only its [pause, resume] interval as
          // ineligible; retained pre-pause rows remain reusable.
          await openPauseAdmissionCutoff(tx, settings, "MASTER", cutoff);
          // Cancel queued and currently leased work in the same transaction.
          // A worker that is already in provider I/O loses its lease/state;
          // its later commit is rejected by the guarded coordinator update.
          await tx.$executeRaw(Prisma.sql`
            UPDATE "MemoryJob" AS job
            SET
              "completedAt" = ${cutoff},
              "errorCode" = 'memory_master_paused',
              "errorMessage" = NULL,
              "leaseExpiresAt" = NULL,
              "leaseToken" = NULL,
              "nextAttemptAt" = NULL,
              "state" = 'CANCELLED'::"MemoryJobState",
              "updatedAt" = ${cutoff}
            WHERE job."userId" = ${userId}
              AND job."state" IN (
                'CLAIMED'::"MemoryJobState",
                'QUEUED'::"MemoryJobState",
                'RETRYABLE_FAILED'::"MemoryJobState",
                'WAITING_FOR_EGRESS_CONSENT'::"MemoryJobState"
              )
              AND (
                job."chatId" IS NULL
                OR NOT EXISTS (
                  SELECT 1
                  FROM "Chat" AS job_chat
                  WHERE job_chat."userId" = job."userId"
                    AND job_chat."id" = job."chatId"
                    AND job_chat."projectId" IS NOT NULL
                )
              )
          `);
        }
        if (masterResume) {
          await closePauseAdmissionCutoff(tx, userId, "MASTER", cutoff);
        }
        if (historyPause) {
          await openPauseAdmissionCutoff(tx, settings, "SEARCH_HISTORY", cutoff);
          await cancelPausedJobs(
            tx,
            userId,
            ["INDEX_HISTORY"],
            "memory_history_paused",
            cutoff
          );
        }
        if (historyResume) {
          await closePauseAdmissionCutoff(tx, userId, "SEARCH_HISTORY", cutoff);
        }
        if (learningPause) {
          await openPauseAdmissionCutoff(tx, settings, "AUTOMATIC_LEARNING", cutoff);
          await cancelPausedJobs(
            tx,
            userId,
            ["EXTRACT_FACTS", "CONSOLIDATE_CANDIDATE", "VERIFY_CANDIDATE"],
            "memory_automatic_learning_paused",
            cutoff
          );
        }
        if (learningResume) {
          await closePauseAdmissionCutoff(tx, userId, "AUTOMATIC_LEARNING", cutoff);
        }
        if (synthesisDisable) {
          await cancelPausedJobs(
            tx,
            userId,
            ["SYNTHESIZE_MEMORIES"],
            "memory_synthesis_disabled",
            cutoff
          );
        }
        settings.settingsRevision += 1;
        if (owns(patch, "decayEnabled")) {
          settings.decayEnabled = patch.decayEnabled!;
          if (patch.decayEnabled) {
            settings.decayPolicyVersion = MEMORY_DECAY_POLICY_VERSION;
          }
        }
        if (owns(patch, "referenceChatHistory")) {
          settings.referenceChatHistory = patch.referenceChatHistory!;
        }
        if (owns(patch, "useMemoryFacts")) {
          settings.useMemoryFacts = patch.useMemoryFacts!;
        }
        if (owns(patch, "synthesisEnabled")) {
          settings.synthesisEnabled = patch.synthesisEnabled!;
          if (synthesisEnable) {
            settings.synthesisEnabledAt ??= cutoff;
            settings.synthesisPolicyVersion = MEMORY_SYNTHESIS_POLICY_VERSION;
          }
        }
        return persistedSettings(tx, userId);
      });
    }
  });
}

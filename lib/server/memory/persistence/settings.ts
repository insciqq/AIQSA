import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  type MemoryConsentInput,
  type MemorySettingsPatch
} from "../../../contracts/memory";
import { prisma } from "../../prisma";
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
  embeddingProviderModelId: string | null;
  learnAutomatically: boolean;
  memoryConsentRevision: number;
  memoryGeneration: number;
  memoryRevision: number;
  memoryUiLocale: "EN" | "RU";
  preferredProfileLanguage: string;
  referenceChatHistory: boolean;
  sensitiveAutomaticPolicy: "EXPLICIT_ONLY";
  settingsRevision: number;
  updatedAt: Date;
  useMemoryFacts: boolean;
  userId: string;
}>;

const settingsSelect = {
  acceptedUtilityEgressAt: true,
  acceptedUtilityEgressFingerprint: true,
  acceptedUtilityPolicyVersion: true,
  activeIndexGenerationId: true,
  embeddingProviderModelId: true,
  learnAutomatically: true,
  memoryConsentRevision: true,
  memoryGeneration: true,
  memoryRevision: true,
  memoryUiLocale: true,
  preferredProfileLanguage: true,
  referenceChatHistory: true,
  sensitiveAutomaticPolicy: true,
  settingsRevision: true,
  updatedAt: true,
  useMemoryFacts: true,
  userId: true
} satisfies Prisma.UserMemorySettingsSelect;

const visibleKeys = [
  "embeddingDeploymentId",
  "learnAutomatically",
  "preferredProfileLanguage",
  "referenceChatHistory",
  "sensitiveAutomaticPolicy",
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
    (owns(patch, "embeddingDeploymentId") &&
      patch.embeddingDeploymentId !== settings.embeddingProviderModelId) ||
    (owns(patch, "learnAutomatically") &&
      patch.learnAutomatically !== settings.learnAutomatically) ||
    (owns(patch, "preferredProfileLanguage") &&
      patch.preferredProfileLanguage !== settings.preferredProfileLanguage) ||
    (owns(patch, "referenceChatHistory") &&
      patch.referenceChatHistory !== settings.referenceChatHistory) ||
    (owns(patch, "sensitiveAutomaticPolicy") &&
      patch.sensitiveAutomaticPolicy !== settings.sensitiveAutomaticPolicy) ||
    (owns(patch, "useMemoryFacts") && patch.useMemoryFacts !== settings.useMemoryFacts)
  );
}

function validatePatchShape(patch: MemorySettingsPatch): void {
  const hasVisibleKey = visibleKeys.some((key) => owns(patch, key));
  const hasLocale = owns(patch, "memoryUiLocale");
  if (
    !validRevision(patch.expectedSettingsRevision) ||
    (!hasVisibleKey && !hasLocale) ||
    [...visibleKeys, "memoryUiLocale" as const].some(
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

export function createPrismaMemorySettingsRepository(client: PrismaClient = prisma) {
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

        await advanceMemoryMutation(tx, settings, "MEMORY_VISIBLE_SETTING_CHANGE");
        const updated = await tx.userMemorySettings.updateMany({
          data: {
            acceptedUtilityEgressAt: new Date(),
            acceptedUtilityEgressFingerprint: input.currentUtilityEgressFingerprint,
            acceptedUtilityPolicyVersion: input.currentUtilityPolicyVersion,
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

        if (visiblePatchChanges(settings, patch)) {
          await advanceMemoryMutation(tx, settings, "MEMORY_VISIBLE_SETTING_CHANGE");
        }
        const data: Prisma.UserMemorySettingsUpdateManyMutationInput = {
          settingsRevision: { increment: 1 }
        };
        if (owns(patch, "embeddingDeploymentId")) {
          data.embeddingProviderModelId = patch.embeddingDeploymentId;
        }
        if (owns(patch, "learnAutomatically")) data.learnAutomatically = patch.learnAutomatically;
        if (owns(patch, "memoryUiLocale")) data.memoryUiLocale = patch.memoryUiLocale;
        if (owns(patch, "preferredProfileLanguage")) {
          data.preferredProfileLanguage = patch.preferredProfileLanguage;
        }
        if (owns(patch, "referenceChatHistory")) {
          data.referenceChatHistory = patch.referenceChatHistory;
        }
        if (owns(patch, "sensitiveAutomaticPolicy")) {
          data.sensitiveAutomaticPolicy = patch.sensitiveAutomaticPolicy;
        }
        if (owns(patch, "useMemoryFacts")) data.useMemoryFacts = patch.useMemoryFacts;

        const updated = await tx.userMemorySettings.updateMany({
          data,
          where: { settingsRevision: patch.expectedSettingsRevision, userId }
        });
        if (updated.count !== 1) return memoryPersistenceFailure("memory_settings_conflict");
        settings.settingsRevision += 1;
        return persistedSettings(tx, userId);
      });
    }
  });
}

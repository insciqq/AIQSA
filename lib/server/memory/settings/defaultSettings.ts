import { resolveRequestAuth } from "../../auth/defaultAuth";
import { prisma } from "../../prisma";
import { resolveCurrentMemoryUtilityPolicy } from "../execution/policy";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import { kickDefaultMemoryCoordinator } from "../coordinator/defaultCoordinator";
import { readMemoryHistoryIndexingProgress } from "../history/backfill";
import { memoryAutomaticLearningIsQualified } from "../learning/betaQualification";
import {
  defaultPermanentChatDeletionCapability,
  tryEnsureDefaultMemoryPhase8Composition
} from "../phase8Composition";
import { createPrismaMemorySettingsRepository } from "../persistence/settings";
import type { MemorySettingsHandlerDeps } from "./handlers";
import {
  createMemorySettingsService,
  DEFAULT_MEMORY_SETTINGS_CAPABILITIES
} from "./service";

export const defaultMemorySettingsRepository =
  createPrismaMemorySettingsRepository(prisma);

tryEnsureDefaultMemoryPhase8Composition(kickDefaultMemoryCoordinator);

export const defaultMemorySettingsService = createMemorySettingsService({
  kick: kickDefaultMemoryCoordinator,
  readHistoryIndexing: (userId, settings) =>
    readMemoryHistoryIndexingProgress(
      prisma,
      userId,
      settings.referenceChatHistory
    ),
  repository: defaultMemorySettingsRepository,
  resolveCapabilities: (settings, policy) => ({
    ...DEFAULT_MEMORY_SETTINGS_CAPABILITIES,
    automaticLearning: memoryAutomaticLearningIsQualified({
      authority: defaultMemoryExecutionAuthority.qualification,
      language: settings.memoryUiLocale,
      now: new Date(),
      policy
    }),
    permanentChatDeletion:
      defaultPermanentChatDeletionCapability.enabled
  }),
  resolveCurrentUtilityPolicy: (userId, settings) =>
    resolveCurrentMemoryUtilityPolicy(prisma, userId, settings)
});

export const defaultMemorySettingsHandlerDeps: MemorySettingsHandlerDeps = {
  resolveAuth: resolveRequestAuth,
  service: defaultMemorySettingsService
};

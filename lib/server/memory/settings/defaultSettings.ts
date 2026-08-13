import { resolveRequestAuth } from "../../auth/defaultAuth";
import { prisma } from "../../prisma";
import { resolveCurrentMemoryUtilityPolicy } from "../execution/policy";
import { kickDefaultMemoryCoordinator } from "../coordinator/defaultCoordinator";
import { readMemoryHistoryIndexingProgress } from "../history/backfill";
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
  resolveCapabilities: (_settings, _policy) => ({
    ...DEFAULT_MEMORY_SETTINGS_CAPABILITIES,
    automaticLearning: true,
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

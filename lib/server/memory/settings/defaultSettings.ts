import { resolveRequestAuth } from "../../auth/defaultAuth";
import { prisma } from "../../prisma";
import { resolveCurrentMemoryUtilityPolicy } from "../execution/policy";
import { kickDefaultMemoryCoordinator } from "../coordinator/defaultCoordinator";
import { readMemoryHistoryIndexingProgress } from "../history/backfill";
import {
  defaultPermanentChatDeletionCapability,
  tryEnsureDefaultMemoryDeletionComposition
} from "../deletionComposition";
import { createPrismaMemorySettingsRepository } from "../persistence/settings";
import type { MemorySettingsHandlerDeps } from "./handlers";
import {
  createMemorySettingsService,
  DEFAULT_MEMORY_SETTINGS_CAPABILITIES
} from "./service";
import {
  deriveMemorySettingsCapabilities,
  readMemoryCapabilityOperationalState
} from "./capabilities";

export const defaultMemorySettingsRepository =
  createPrismaMemorySettingsRepository(prisma);

tryEnsureDefaultMemoryDeletionComposition(kickDefaultMemoryCoordinator);

export const defaultMemorySettingsService = createMemorySettingsService({
  kick: kickDefaultMemoryCoordinator,
  readHistoryIndexing: (userId, settings) =>
    readMemoryHistoryIndexingProgress(
      prisma,
      userId,
      settings.referenceChatHistory,
      settings.useMemoryFacts
    ),
  repository: defaultMemorySettingsRepository,
  resolveCapabilities: async (settings, policy) =>
    deriveMemorySettingsCapabilities({
      base: {
        permanentChatDeletion: defaultPermanentChatDeletionCapability.enabled,
        temporaryChats: DEFAULT_MEMORY_SETTINGS_CAPABILITIES.temporaryChats
      },
      operations: await readMemoryCapabilityOperationalState(prisma, {
        now: new Date(),
        settings
      }),
      policy,
      settings
    }),
  resolveCurrentUtilityPolicy: (userId, settings) =>
    resolveCurrentMemoryUtilityPolicy(prisma, userId, settings)
});

export const defaultMemorySettingsHandlerDeps: MemorySettingsHandlerDeps = {
  resolveAuth: resolveRequestAuth,
  service: defaultMemorySettingsService
};

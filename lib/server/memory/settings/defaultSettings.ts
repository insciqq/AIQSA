import { resolveRequestAuth } from "../../auth/defaultAuth";
import { prisma } from "../../prisma";
import { resolveCurrentMemoryUtilityPolicy } from "../execution/policy";
import { createPrismaMemorySettingsRepository } from "../persistence/settings";
import type { MemorySettingsHandlerDeps } from "./handlers";
import { createMemorySettingsService } from "./service";

export const defaultMemorySettingsRepository =
  createPrismaMemorySettingsRepository(prisma);

export const defaultMemorySettingsService = createMemorySettingsService({
  repository: defaultMemorySettingsRepository,
  resolveCurrentUtilityPolicy: (userId, settings) =>
    resolveCurrentMemoryUtilityPolicy(prisma, userId, settings)
});

export const defaultMemorySettingsHandlerDeps: MemorySettingsHandlerDeps = {
  resolveAuth: resolveRequestAuth,
  service: defaultMemorySettingsService
};

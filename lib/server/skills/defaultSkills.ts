import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import type { SkillHandlerDeps } from "./handlers";
import { createPrismaSkillRepository } from "./prismaRepository";
import { createS3StorageAdapter } from "../uploads/storage";
import { createSkillBundleService } from "./bundleService";
import type { SkillBundleHandlerDeps } from "./bundleHandlers";
import { createSkillSharingService } from "./shareRequests";
import { createSkillSharingHandlers } from "./shareHandlers";
import { createSkillPreferenceService } from "./preferenceService";
import { createEnableAllSkillsHandler, createSetSkillPreferenceHandler } from "./handlers";
import { createPrismaSkillCatalogRelevanceService } from "./catalogRelevanceService";

export const defaultSkillRepository = createPrismaSkillRepository(prisma);
export const defaultSkillCatalogRelevance = createPrismaSkillCatalogRelevanceService(prisma);
export const defaultSkillSharingService = createSkillSharingService(prisma);
export const defaultSkillSharingHandlers = createSkillSharingHandlers({
  resolveAuth: resolveRequestAuth, service: defaultSkillSharingService, repository: defaultSkillRepository
});
export const defaultSkillPreferenceHandler = createSetSkillPreferenceHandler({
  resolveAuth: resolveRequestAuth, service: createSkillPreferenceService(prisma)
});
export const defaultEnableAllSkillsHandler = createEnableAllSkillsHandler({
  resolveAuth: resolveRequestAuth, service: createSkillPreferenceService(prisma)
});

export const defaultSkillHandlerDeps: SkillHandlerDeps = {
  repository: defaultSkillRepository,
  resolveAuth: resolveRequestAuth
};

export const defaultSkillBundleHandlerDeps: SkillBundleHandlerDeps = {
  resolveAuth: resolveRequestAuth,
  service: () => createSkillBundleService(prisma, createS3StorageAdapter())
};

import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import { createPrismaWorkspacePolicyRepository } from "../workspace/policyRepository";
import { createPrismaScheduledTaskCatalogLoader } from "./catalog";
import { createScheduledTaskHandlers } from "./handlers";
import { createPrismaScheduledTaskPinnedSkillLoader } from "./pinnedSkills";
import { kickScheduledTaskRunner } from "./runnerKick";
import { createPrismaScheduledTaskStore } from "./store";

export const defaultScheduledTaskStore = createPrismaScheduledTaskStore(prisma, {
  // Telegram loads on the first list, not with the owner API's routes.
  telegramAvailable: async (userId) => (await import("../telegram/scheduledDelivery")).isTelegramScheduledDeliveryAvailable(userId)
});
export const defaultScheduledTaskCatalogLoader = createPrismaScheduledTaskCatalogLoader(prisma);
export const defaultScheduledTaskHandlers = createScheduledTaskHandlers({
  kick: kickScheduledTaskRunner,
  loadCatalog: defaultScheduledTaskCatalogLoader,
  loadPinnedSkills: createPrismaScheduledTaskPinnedSkillLoader(prisma),
  resolveAuth: resolveRequestAuth,
  store: defaultScheduledTaskStore,
  workspacePolicy: createPrismaWorkspacePolicyRepository(prisma)
});

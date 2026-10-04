import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import { createPrismaWorkspacePolicyRepository } from "../workspace/policyRepository";
import { createPrismaScheduledTaskCatalogLoader } from "./catalog";
import { createScheduledTaskHandlers } from "./handlers";
import { kickScheduledTaskRunner } from "./runnerKick";
import { createPrismaScheduledTaskStore } from "./store";

export const defaultScheduledTaskStore = createPrismaScheduledTaskStore(prisma);
export const defaultScheduledTaskCatalogLoader = createPrismaScheduledTaskCatalogLoader(prisma);
export const defaultScheduledTaskHandlers = createScheduledTaskHandlers({
  kick: kickScheduledTaskRunner,
  loadCatalog: defaultScheduledTaskCatalogLoader,
  resolveAuth: resolveRequestAuth,
  store: defaultScheduledTaskStore,
  workspacePolicy: createPrismaWorkspacePolicyRepository(prisma)
});

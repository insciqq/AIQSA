import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import { createPrismaScheduledTaskCatalogLoader } from "./catalog";
import { createScheduledTaskHandlers } from "./handlers";
import { createPrismaScheduledTaskStore } from "./store";

export const defaultScheduledTaskStore = createPrismaScheduledTaskStore(prisma);
export const defaultScheduledTaskCatalogLoader = createPrismaScheduledTaskCatalogLoader(prisma);
export const defaultScheduledTaskHandlers = createScheduledTaskHandlers({
  loadCatalog: defaultScheduledTaskCatalogLoader,
  resolveAuth: resolveRequestAuth,
  store: defaultScheduledTaskStore
});

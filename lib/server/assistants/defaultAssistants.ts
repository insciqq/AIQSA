import { resolveRequestAuth } from "../auth/defaultAuth";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";
import { getDefaultMcpRuntimeCoordinator } from "../mcp/defaultRuntime";
import { prisma } from "../prisma";
import type { AssistantHandlerDeps } from "./handlers";
import { createPrismaAssistantRepository } from "./prismaRepository";

export const defaultAssistantRepository = createPrismaAssistantRepository(prisma, {
  isMcpGenerationLive: (generationId) =>
    getDefaultMcpRuntimeCoordinator().hasLiveGeneration(generationId)
});

export const defaultAssistantHandlerDeps: AssistantHandlerDeps = {
  loadCatalogData: createPrismaCatalogDataLoader({ prisma }),
  repository: defaultAssistantRepository,
  resolveAuth: resolveRequestAuth
};

import { resolveRequestAuth } from "../auth/defaultAuth";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";
import { mcpRepository } from "../mcp/defaultMcp";
import { getDefaultMcpRuntimeCoordinator } from "../mcp/defaultRuntime";
import { prisma } from "../prisma";
import type { AssistantHandlerDeps } from "./handlers";
import { createPrismaAssistantRepository } from "./prismaRepository";

export const defaultAssistantRepository = createPrismaAssistantRepository(prisma, {
  isMcpGenerationLive: (generationId) =>
    getDefaultMcpRuntimeCoordinator().hasLiveGeneration(generationId),
  loadUserMcpServers: (userId) => mcpRepository.listUserServers(userId)
});

export const defaultAssistantHandlerDeps: AssistantHandlerDeps = {
  loadCatalogData: createPrismaCatalogDataLoader({ prisma }),
  repository: defaultAssistantRepository,
  resolveAuth: resolveRequestAuth
};

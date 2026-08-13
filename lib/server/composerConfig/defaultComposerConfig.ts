import type {
  ComposerConfigKnowledgeBase,
  ComposerConfigMcpServer
} from "../../contracts/composerConfig";
import { defaultAssistantRepository } from "../assistants/defaultAssistants";
import {
  buildAssistantRunnerCatalogView,
  buildAssistantSummary
} from "../assistants/handlers";
import { resolveRequestAuth } from "../auth/defaultAuth";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";
import { defaultKnowledgeRepository } from "../knowledge/defaultKnowledge";
import { mcpRepository } from "../mcp/defaultMcp";
import { prisma } from "../prisma";
import type { ComposerConfigHandlerDeps } from "./handlers";

function knowledgeSummary(
  entry: Awaited<ReturnType<typeof defaultKnowledgeRepository.listForUser>>[number]
): ComposerConfigKnowledgeBase {
  return {
    archived: entry.archived,
    description: entry.description,
    id: entry.id,
    name: entry.name,
    owned: entry.owned
  };
}

function mcpSummary(
  server: Awaited<ReturnType<typeof mcpRepository.listUserServers>>[number]
): ComposerConfigMcpServer {
  return {
    description: server.description,
    enabled: server.enabled,
    id: server.id,
    knownToolCount: server.knownToolCount,
    name: server.name,
    readiness: server.readiness
  };
}

export const defaultComposerConfigHandlerDeps: ComposerConfigHandlerDeps = {
  async listAssistants(userId, catalogData) {
    const [entries, accessibleMcpServerIds, mcpRunPlan] = await Promise.all([
      defaultAssistantRepository.listForUser(userId),
      defaultAssistantRepository.loadUserAccessibleMcpServerIds(userId),
      defaultAssistantRepository.loadUserMcpRunPlanView(userId)
    ]);
    const view = buildAssistantRunnerCatalogView({
      accessibleMcpServerIds,
      catalogData,
      mcpRunPlan
    });
    return entries.map((entry) => buildAssistantSummary(entry, view));
  },
  async listKnowledgeBases(userId) {
    return (await defaultKnowledgeRepository.listForUser(userId)).map(knowledgeSummary);
  },
  async listMcpServers(userId) {
    return (await mcpRepository.listUserServers(userId)).map(mcpSummary);
  },
  loadCatalogData: createPrismaCatalogDataLoader({ prisma }),
  resolveAuth: resolveRequestAuth
};

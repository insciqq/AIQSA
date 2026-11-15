import { defaultAssistantDeletionHandlerDeps } from "../../assistants/defaultAssistantDeletion";
import { defaultAssistantHandlerDeps } from "../../assistants/defaultAssistants";
import { defaultAssistantListingService, defaultListedAssistantService } from "../../assistants/defaultListing";
import { createDeleteAssistantHandler } from "../../assistants/deletionHandlers";
import { createPublishAssistantHandler, createUpdateAssistantHandler } from "../../assistants/handlers";
import { createAssistantListingHandlers } from "../../assistants/listingHandlers";
import { prisma } from "../../prisma";
import { createProxyHandlers } from "../../proxies/handlers";
import { createProxyStore } from "../../proxies/store";
import { defaultScheduledTaskHandlerDeps } from "../../scheduledTasks/defaultScheduledTasks";
import { createScheduledTaskHandlers } from "../../scheduledTasks/handlers";
import { defaultSkillHandlerDeps } from "../../skills/defaultSkills";
import { createDeleteSkillHandler } from "../../skills/handlers";
import { createSkillSaveUndoService } from "../../skills/skillSave";
import { createSkillSaveHandlers } from "../../skills/skillSaveHandlers";
import { defaultSubagentDefinitionService } from "../../subagents/defaultSubagents";
import { createSubagentDefinitionHandlers } from "../../subagents/definitionHandlers";
import { createWorkspaceSecretHandlers } from "../../workspace/secrets/handlers";
import { createWorkspaceSecretStore } from "../../workspace/secrets/store";
import type { TelegramAccessResolver } from "../control/access";
import { telegramRequestAuth } from "../bridge/requestAuth";
import { createTelegramChangeGateway, type TelegramChangeGateway, type TelegramChangeRoutes } from "./gateway";

/**
 * The change buttons' routes in this process: each Studio route's own handler
 * factory with its production dependencies, built for one press with the
 * button user's Telegram resolver in place of the browser session's. Loaded
 * on the first press, so the bot starts without these stacks.
 */
export function createDefaultTelegramChangeGateway(deps: Readonly<{ access: Pick<TelegramAccessResolver, "resolveTelegramAccess"> }>): TelegramChangeGateway {
  const secretStore = createWorkspaceSecretStore(prisma);
  const proxyStore = createProxyStore(prisma);
  const skillSaves = () => createSkillSaveUndoService(prisma);
  return createTelegramChangeGateway((userId): TelegramChangeRoutes => {
    const resolveAuth = telegramRequestAuth(deps.access, userId);
    const subagents = createSubagentDefinitionHandlers({ resolveAuth, service: defaultSubagentDefinitionService });
    return {
      secrets: (request) => createWorkspaceSecretHandlers({ resolveAuth, store: secretStore }).POST(request),
      proxy: (request, proxyId) => createProxyHandlers({ resolveAuth, store: proxyStore })(request, "delete", "personal", proxyId),
      skill: (request, skillId) => createDeleteSkillHandler({ ...defaultSkillHandlerDeps, resolveAuth })(request, { params: { skillId } }),
      skillSaveUndo: (request, skillId, saveId) => createSkillSaveHandlers({ resolveAuth, service: skillSaves })
        .POST_UNDO(request, { params: { saveId, skillId } }),
      assistant: (request, assistantId) => request.method === "DELETE"
        ? createDeleteAssistantHandler({ ...defaultAssistantDeletionHandlerDeps, resolveAuth })(request, { params: { assistantId } })
        : createUpdateAssistantHandler({ ...defaultAssistantHandlerDeps, resolveAuth })(request, { params: { assistantId } }),
      assistantPublication: (request, assistantId) => createPublishAssistantHandler({ ...defaultAssistantHandlerDeps, resolveAuth })(
        request, { params: { assistantId } }),
      assistantListing: (request, assistantId) => createAssistantListingHandlers({
        listed: defaultListedAssistantService, requests: defaultAssistantListingService, resolveAuth
      }).request(request, { params: { assistantId } }),
      subagent: (request, definitionId) => subagents.detailDELETE(request, { params: { definitionId } }),
      subagentRestore: (request, definitionId) => subagents.restorePOST(request, { params: { definitionId } }),
      subagentDefaultUndo: (request) => subagents.defaultUndoPOST(request),
      scheduledTask: (request, taskId) => createScheduledTaskHandlers({ ...defaultScheduledTaskHandlerDeps, resolveAuth }).remove(request, taskId)
    };
  });
}

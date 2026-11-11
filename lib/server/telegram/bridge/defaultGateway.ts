import type { AssistantListResponse, AssistantSummary } from "../../../contracts/assistants";
import { defaultAssistantHandlerDeps } from "../../assistants/defaultAssistants";
import { createListAssistantsHandler } from "../../assistants/handlers";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import { buildCurrentUserCatalog } from "../../catalog/currentUserCatalog";
import { createPrismaCatalogDataLoader } from "../../catalog/prismaCatalogData";
import { connectorInternalRequest, createDefaultConnectorRunGateway } from "../../connectors/defaultRunGateway";
import { prisma } from "../../prisma";
import { parameterDialect } from "../../runs/runPreparation";
import type { TelegramAccessResolver } from "../control/access";
import { createPrismaTelegramChatListStore } from "../store/chats";
import { createPrismaTelegramTimeZoneStore } from "../store/timeZone";
import type { TelegramRunGateway } from "./gateway";
import { telegramRequestAuth } from "./requestAuth";

/**
 * The bridge's AIQSA operations in this process: the connectors' in-process
 * run operations (`createDefaultConnectorRunGateway`) as Telegram turns, and
 * the reads only Telegram's menus need, each through a synthetic request as
 * the linked user whose resolver re-reads the account and re-checks Telegram
 * access on every call (the send handler calls it again during preparation).
 * The session it presents is `telegram`, never a browser session.
 */

const MAX_ASSISTANT_CHOICES = 20;

/** Pinned, then the recently used, then the rest, each usable now; at most twenty. */
export function orderTelegramAssistants(list: Pick<AssistantListResponse, "assistants" | "recentAssistantIds">): AssistantSummary[] {
  const usable = list.assistants.filter((assistant) => !assistant.archived && assistant.availability.ok);
  const byId = new Map(usable.map((assistant) => [assistant.id, assistant]));
  const ordered = new Map<string, AssistantSummary>();
  for (const assistant of usable.filter((entry) => entry.pinned)) ordered.set(assistant.id, assistant);
  for (const id of list.recentAssistantIds) {
    const assistant = byId.get(id);
    if (assistant && !ordered.has(id)) ordered.set(id, assistant);
  }
  for (const assistant of usable) if (!ordered.has(assistant.id)) ordered.set(assistant.id, assistant);
  return [...ordered.values()].slice(0, MAX_ASSISTANT_CHOICES);
}

export function createDefaultTelegramRunGateway(deps: Readonly<{ access: Pick<TelegramAccessResolver, "resolveTelegramAccess"> }>): TelegramRunGateway {
  /** The linked user while the account is active and Telegram access holds, re-read on every call. */
  function telegramAuth(userId: string): RequestAuthResolver {
    return telegramRequestAuth(deps.access, userId);
  }
  const runs = createDefaultConnectorRunGateway({ auth: telegramAuth, connectorTurn: "telegram" });
  const loadCatalogData = createPrismaCatalogDataLoader({ checkDefaultAssistant: false, prisma });
  const chats = createPrismaTelegramChatListStore(prisma);
  const timeZones = createPrismaTelegramTimeZoneStore(prisma);

  return Object.freeze({
    activeRun: runs.activeRun,
    answer: runs.answer,
    followup: runs.followup,
    runState: runs.runState,
    send: runs.send,
    stop: runs.stop,

    async loadCatalog(userId: string) {
      const data = await loadCatalogData(userId);
      if (!data) return null;
      const catalog = buildCurrentUserCatalog(data);
      const dialects = new Map(data.models.map((entry) => [
        `${entry.provider}:${entry.modelId}`, parameterDialect(entry.adapterKind, entry.providerFamily ?? "")
      ]));
      return {
        defaults: {
          controlValues: catalog.defaults.controlValues,
          mcpMode: catalog.defaults.mcpMode ?? "auto",
          modelId: catalog.defaults.modelId,
          provider: catalog.defaults.provider,
          searchPlan: catalog.defaults.searchPlan,
          skillsMode: catalog.defaults.skillsMode ?? "auto"
        },
        models: catalog.models.map((model) => ({
          ...model, parameterDialect: dialects.get(`${model.provider}:${model.modelId}`) ?? "openai"
        })),
        searchStrategies: catalog.searchStrategies
      };
    },

    async findChat(userId: string, chatId: string) {
      const chat = await runs.chat(userId, chatId);
      if (!chat || chat.memoryMode === "TEMPORARY") return null;
      return { activeLeafMessageId: chat.activeLeafMessageId, assistantId: chat.assistantId, id: chat.id, model: chat.model, title: chat.title };
    },

    recentChats: (userId: string) => chats.recentPersonalChats(userId),

    timeZone: (userId: string) => timeZones.latestClientTimeZone(userId),

    async assistants(userId: string) {
      const response = await createListAssistantsHandler({ ...defaultAssistantHandlerDeps, resolveAuth: telegramAuth(userId) })(
        connectorInternalRequest("/api/me/assistants", "GET")
      );
      if (!response.ok) return [];
      return orderTelegramAssistants(await response.json() as AssistantListResponse)
        .map((assistant) => ({ id: assistant.id, name: assistant.name }));
    }
  } satisfies TelegramRunGateway);
}

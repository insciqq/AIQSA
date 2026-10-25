import type { AssistantListResponse, AssistantSummary } from "../../../contracts/assistants";
import type { ThreadArtifactSummary } from "../../../contracts/chats";
import { decodeRunOutcomeResponse } from "../../../contracts/runs";
import { textFromContentBlocks } from "../../../domain/modelRunEvents";
import { defaultAssistantHandlerDeps } from "../../assistants/defaultAssistants";
import { createListAssistantsHandler } from "../../assistants/handlers";
import type { RequestAuthResolver } from "../../auth/requestAuth";
import { buildCurrentUserCatalog } from "../../catalog/currentUserCatalog";
import { createPrismaCatalogDataLoader } from "../../catalog/prismaCatalogData";
import { kickDefaultMcpRuntime } from "../../mcp/defaultRuntime";
import { prisma } from "../../prisma";
import { createDefaultSendMessageDeps } from "../../runs/defaultSendMessageDeps";
import { createGetModelRunHandler, createSendMessageHandler, stopModelRun } from "../../runs/handlers";
import { createPrismaRunFollowupOperations } from "../../runs/prismaRepositoryFollowups";
import { createRunFollowupHandler } from "../../runs/runFollowupHandler";
import { parameterDialect } from "../../runs/runPreparation";
import { NATIVE_RUN_STALE_MS } from "../../engine/recovery";
import type { TelegramAccessResolver } from "../control/access";
import { createPrismaTelegramChatListStore } from "../store/chats";
import { createPrismaTelegramTimeZoneStore } from "../store/timeZone";
import type { TelegramRunGateway } from "./gateway";
import { telegramRequestAuth } from "./requestAuth";

/**
 * The bridge's AIQSA operations in this process, through the product's own
 * handlers exactly as the browser reaches them (and as scheduled tasks admit
 * their runs): a synthetic request as the linked user,
 * whose resolver re-reads the account and re-checks Telegram access on every
 * call (the handler calls it again during preparation). The session it
 * presents is `telegram`, never a browser session.
 */

const MAX_ASSISTANT_CHOICES = 20;

function internalRequest(path: string, method: "GET" | "POST", body?: unknown): Request {
  return new Request(`http://localhost${path}`, body === undefined ? { method } : {
    body: JSON.stringify(body), headers: { "content-type": "application/json" }, method
  });
}

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
  const sendDeps = createDefaultSendMessageDeps();
  const followups = createPrismaRunFollowupOperations(prisma);
  const loadCatalogData = createPrismaCatalogDataLoader({ checkDefaultAssistant: false, prisma });
  const chats = createPrismaTelegramChatListStore(prisma);
  const timeZones = createPrismaTelegramTimeZoneStore(prisma);

  /** The linked user while the account is active and Telegram access holds, re-read on every call. */
  function telegramAuth(userId: string): RequestAuthResolver {
    return telegramRequestAuth(deps.access, userId);
  }

  return Object.freeze({
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
      const chat = await sendDeps.repository.findOwnedChat(chatId, userId);
      if (!chat || chat.memoryMode === "TEMPORARY") return null;
      return {
        activeLeafMessageId: chat.activeLeafMessageId, assistantId: chat.assistantId ?? null, id: chat.id,
        model: { modelId: chat.defaultModelId, provider: chat.defaultProvider }, title: chat.title
      };
    },

    async send({ body, chatId, userId }) {
      // As a browser session does, the user's MCP runtime is woken for the run.
      kickDefaultMcpRuntime(userId);
      return createSendMessageHandler({ ...sendDeps, resolveAuth: telegramAuth(userId), telegramTurn: true })(
        internalRequest(`/api/chats/${encodeURIComponent(chatId)}/messages`, "POST", body), { params: { chatId } }
      );
    },

    async followup({ assistantMessageId, chatId, nonce, runId, text, userId }) {
      return createRunFollowupHandler({ followups, resolveAuth: telegramAuth(userId) })(
        internalRequest(`/api/model-runs/${encodeURIComponent(runId)}/followups`, "POST", { assistantMessageId, chatId, nonce, text }),
        { params: { runId } }
      );
    },

    stop: ({ runId, userId }) => stopModelRun(sendDeps, {
      payload: { code: "model_run_cancelled", message: "Model run cancelled" }, runId, userId
    }),

    async runState({ runId, userId }) {
      try {
        const response = await createGetModelRunHandler({ ...sendDeps, resolveAuth: telegramAuth(userId) })(
          internalRequest(`/api/model-runs/${encodeURIComponent(runId)}`, "GET"), { params: { runId } }
        );
        if (response.status === 401 || response.status === 404) return null;
        const outcome = response.ok ? decodeRunOutcomeResponse(await response.json()) : null;
        return { status: outcome?.status ?? "unknown" };
      } catch {
        // A run still being prepared cannot be projected yet.
        return { status: "preparing" };
      }
    },

    async answer({ runId, userId }) {
      const control = await sendDeps.repository.getRunControlForUser(runId, userId);
      if (!control?.assistantMessageId) return null;
      const update = await sendDeps.repository.getChatUpdateForRun({
        assistantMessageId: control.assistantMessageId, chatId: control.chatId, userId, userMessageId: control.assistantMessageId
      });
      const message = update?.messages.find((entry) => entry.id === control.assistantMessageId);
      if (!message) return null;
      const status = control.status === "complete" || control.status === "cancelled" || control.status === "error"
        ? control.status : "streaming";
      return {
        artifactSummary: (message.artifactSummary ?? null) as ThreadArtifactSummary | null,
        assistantMessageId: message.id,
        chatId: control.chatId,
        errorMessage: message.errorMessage ?? null,
        status,
        text: textFromContentBlocks(message.content as { blocks?: unknown[] })
      };
    },

    async activeRun({ chatId, userId }) {
      const run = await sendDeps.repository.findRecentActiveRunForChat({ chatId, since: new Date(Date.now() - NATIVE_RUN_STALE_MS), userId });
      return run ? { runId: run.id } : null;
    },

    recentChats: (userId: string) => chats.recentPersonalChats(userId),

    timeZone: (userId: string) => timeZones.latestClientTimeZone(userId),

    async assistants(userId: string) {
      const response = await createListAssistantsHandler({ ...defaultAssistantHandlerDeps, resolveAuth: telegramAuth(userId) })(
        internalRequest("/api/me/assistants", "GET")
      );
      if (!response.ok) return [];
      return orderTelegramAssistants(await response.json() as AssistantListResponse)
        .map((assistant) => ({ id: assistant.id, name: assistant.name }));
    }
  } satisfies TelegramRunGateway);
}

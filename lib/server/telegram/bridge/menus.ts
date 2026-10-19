import type { TelegramCallbackKind } from "../../../contracts/telegram";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import {
  TELEGRAM_BRIDGE_COPY, TELEGRAM_COPY, telegramAssistantSelectedText, telegramCurrentChatText, telegramModelLabel, telegramToggleLabel
} from "../copy";
import type { TelegramCallbackContext, TelegramCallbackHandler, TelegramCallbackReply, TelegramMessageContext } from "../dispatcher";
import type { TelegramKeyboard, TelegramKeyboardButton } from "../outbound";
import type { TelegramLinkPreferences, TelegramLinkRecord, TelegramLinkStore } from "../store/links";
import type { TelegramMessageRefStore } from "../store/messageRefs";
import { findTelegramModel, resolveTelegramModel, type TelegramCatalogModel, type TelegramRunCatalog } from "./body";
import type { TelegramConversation } from "./conversation";
import type { TelegramRunGateway } from "./gateway";

/**
 * The bot's chat commands (D-13) and their buttons: `/new`, `/chats` (ten
 * recent personal chats), `/assistant` (pinned, recent, the rest; at most
 * twenty), `/model` (eight catalog models per page), `/settings` (one menu
 * whose toggles edit it in place; Agent only for a model that offers it).
 * Choices that change where the next message goes run in order with the
 * messages around them; every choice is checked against the current catalog
 * and access before it is stored on the link.
 */

export const TELEGRAM_MODELS_PER_PAGE = 8;

export type TelegramBridgeMenus = Readonly<{
  newChat(context: TelegramMessageContext): void;
  chats(context: TelegramMessageContext): Promise<void>;
  assistants(context: TelegramMessageContext): Promise<void>;
  models(context: TelegramMessageContext): Promise<void>;
  settings(context: TelegramMessageContext): Promise<void>;
  callbacks: Readonly<Partial<Record<TelegramCallbackKind, TelegramCallbackHandler>>>;
}>;

type Menu = Readonly<{ text: string; keyboard?: TelegramKeyboard }>;

function marked(selected: boolean, label: string): string {
  return selected ? `✓ ${label}` : label;
}

export function telegramModelKeyboard(catalog: TelegramRunCatalog, page: number, current: TelegramCatalogModel | null): TelegramKeyboard {
  const pages = Math.max(1, Math.ceil(catalog.models.length / TELEGRAM_MODELS_PER_PAGE));
  const index = Math.min(Math.max(0, Math.trunc(page)), pages - 1);
  const rows: (readonly TelegramKeyboardButton[])[] = catalog.models
    .slice(index * TELEGRAM_MODELS_PER_PAGE, (index + 1) * TELEGRAM_MODELS_PER_PAGE)
    .map((model) => [{
      callback: { kind: "select_model", payload: { modelId: model.modelId, provider: model.provider } },
      text: marked(current?.modelId === model.modelId && current.provider === model.provider, model.displayName)
    }]);
  const pager: TelegramKeyboardButton[] = [];
  if (index > 0) pager.push({ callback: { kind: "model_page", payload: { page: index - 1 } }, text: TELEGRAM_BRIDGE_COPY.previousPage });
  if (index < pages - 1) pager.push({ callback: { kind: "model_page", payload: { page: index + 1 } }, text: TELEGRAM_BRIDGE_COPY.nextPage });
  if (pager.length > 0) rows.push(pager);
  return rows;
}

export function telegramSettingsKeyboard(link: TelegramLinkRecord, model: TelegramCatalogModel | null): TelegramKeyboard {
  return [
    [{ callback: { kind: "toggle_search" }, text: telegramToggleLabel("Search", link.searchEnabled) }],
    [{ callback: { kind: "toggle_workspace" }, text: telegramToggleLabel("Workspace", link.workspaceEnabled) }],
    ...(model?.agentAvailable ? [[{ callback: { kind: "toggle_agent" as const }, text: telegramToggleLabel("Agent", link.agentEnabled) }]] : []),
    [{
      callback: { kind: "model_page", payload: { page: 0 } },
      text: model ? telegramModelLabel(model.displayName) : TELEGRAM_BRIDGE_COPY.chooseModel
    }]
  ];
}

export function createTelegramBridgeMenus(deps: Readonly<{
  conversation: Pick<TelegramConversation, "enqueue" | "stopRun">;
  gateway: Pick<TelegramRunGateway, "assistants" | "findChat" | "loadCatalog" | "recentChats">;
  links: Pick<TelegramLinkStore, "findByUserId" | "updatePreferences">;
  messageRefs: Pick<TelegramMessageRefStore, "record">;
  now?: () => number;
}>): TelegramBridgeMenus {
  const now = deps.now ?? Date.now;

  async function send(context: TelegramMessageContext | TelegramCallbackContext, menu: Menu): Promise<void> {
    const chatId = "message" in context ? context.message.chat.id : context.chatId;
    await context.bot.outbound.sendText({ chatId, text: menu.text, ...(menu.keyboard ? { keyboard: menu.keyboard, linkId: context.link.id } : {}) });
  }

  /** Replaces the pressed menu in place; a menu that can no longer be edited is sent anew. */
  async function edit(context: TelegramCallbackContext, menu: Menu, chatOwner?: string): Promise<void> {
    const markup = menu.keyboard ? await context.bot.outbound.replyMarkup({ keyboard: menu.keyboard, linkId: context.link.id }) : undefined;
    const edited = context.messageId === null ? null : await context.bot.api.editMessageText({
      chat_id: context.chatId, message_id: context.messageId, text: menu.text, ...(markup ? { reply_markup: markup } : {})
    });
    const owner = chatOwner ? { chatId: chatOwner, linkId: context.link.id, userId: context.link.userId } : undefined;
    if (!edited?.ok) {
      await context.bot.outbound.sendText({
        chatId: context.chatId, text: menu.text, ...(menu.keyboard ? { keyboard: menu.keyboard, linkId: context.link.id } : {}),
        ...(owner ? { owner } : {})
      });
      return;
    }
    if (owner && context.messageId !== null) {
      // A reply to "Current chat: …" continues that chat too.
      await deps.messageRefs.record([{
        ...owner, botId: context.bot.botId, telegramChatId: context.chatId, telegramMessageId: context.messageId
      }], new Date(now())).catch((error: unknown) => logEvent("service_operation", {
        code: "telegram_message_ref_failed", error, outcome: "failed", prisma_code: databaseFailureCode(error), stage: "dispatch",
        subsystem: "telegram"
      }));
    }
  }

  /** The model an ordinary message would use next, for marking and the Agent toggle. */
  async function nextModel(link: TelegramLinkRecord, catalog: TelegramRunCatalog): Promise<TelegramCatalogModel | null> {
    const chat = link.currentChatId ? await deps.gateway.findChat(link.userId, link.currentChatId) : null;
    const resolved = resolveTelegramModel(catalog, {
      chatModel: chat?.model ?? null,
      selected: link.selectedModelId && link.selectedProvider ? { modelId: link.selectedModelId, provider: link.selectedProvider } : null
    });
    return resolved.ok ? resolved.model : null;
  }

  async function settingsMenu(link: TelegramLinkRecord): Promise<Menu> {
    const catalog = await deps.gateway.loadCatalog(link.userId);
    return {
      keyboard: telegramSettingsKeyboard(link, catalog ? await nextModel(link, catalog) : null),
      text: TELEGRAM_BRIDGE_COPY.settingsTitle
    };
  }

  async function modelMenu(link: TelegramLinkRecord, page: number): Promise<Menu> {
    const catalog = await deps.gateway.loadCatalog(link.userId);
    if (!catalog || catalog.models.length === 0) return { text: TELEGRAM_BRIDGE_COPY.noModels };
    return { keyboard: telegramModelKeyboard(catalog, page, await nextModel(link, catalog)), text: TELEGRAM_BRIDGE_COPY.modelsTitle };
  }

  /** Flips one setting and redraws the menu the press came from. */
  function toggle(change: (link: TelegramLinkRecord) => TelegramLinkPreferences): TelegramCallbackHandler {
    return async (context) => {
      await deps.links.updatePreferences(context.link.id, change(context.link));
      const link = await deps.links.findByUserId(context.link.userId);
      if (link?.id === context.link.id) await edit(context, await settingsMenu(link));
      return {};
    };
  }

  const callbacks: Partial<Record<TelegramCallbackKind, TelegramCallbackHandler>> = {
    select_chat: async (context): Promise<TelegramCallbackReply> => {
      const chatId = typeof context.callback.payload.chatId === "string" ? context.callback.payload.chatId : "";
      deps.conversation.enqueue(context.link, context.bot, async (link) => {
        const chat = chatId ? await deps.gateway.findChat(link.userId, chatId) : null;
        if (!chat) return edit(context, { text: TELEGRAM_BRIDGE_COPY.chatUnavailable });
        await deps.links.updatePreferences(link.id, { currentChatId: chat.id, pendingAssistantId: null });
        await edit(context, { text: telegramCurrentChatText(chat.title) }, chat.id);
      });
      return {};
    },

    select_assistant: async (context) => {
      const assistantId = typeof context.callback.payload.assistantId === "string" ? context.callback.payload.assistantId : "";
      deps.conversation.enqueue(context.link, context.bot, async (link) => {
        const chosen = (await deps.gateway.assistants(link.userId)).find((assistant) => assistant.id === assistantId);
        if (!chosen) return edit(context, { text: TELEGRAM_BRIDGE_COPY.assistantUnavailable });
        await deps.links.updatePreferences(link.id, { currentChatId: null, pendingAssistantId: chosen.id });
        await edit(context, { text: telegramAssistantSelectedText(chosen.name) });
      });
      return {};
    },

    select_model: async (context) => {
      const { modelId, provider } = context.callback.payload;
      const catalog = await deps.gateway.loadCatalog(context.link.userId);
      const model = catalog && typeof modelId === "string" && typeof provider === "string"
        ? findTelegramModel(catalog, { modelId, provider }) : null;
      if (!model) {
        await edit(context, { text: TELEGRAM_BRIDGE_COPY.modelUnavailable });
        return {};
      }
      await deps.links.updatePreferences(context.link.id, { selectedModel: { modelId: model.modelId, provider: model.provider } });
      await edit(context, { text: telegramModelLabel(model.displayName) });
      return {};
    },

    model_page: async (context) => {
      const page = typeof context.callback.payload.page === "number" ? context.callback.payload.page : 0;
      await edit(context, await modelMenu(context.link, page));
      return {};
    },

    toggle_search: toggle((link) => ({ searchEnabled: !link.searchEnabled })),
    // Agent works in a Workspace: switching Workspace off ends Agent, switching Agent on starts Workspace.
    toggle_workspace: toggle((link) => link.workspaceEnabled ? { agentEnabled: false, workspaceEnabled: false } : { workspaceEnabled: true }),
    toggle_agent: toggle((link) => link.agentEnabled ? { agentEnabled: false } : { agentEnabled: true, workspaceEnabled: true }),

    open_settings: async (context) => {
      await send(context, await settingsMenu(context.link));
      return {};
    },

    stop_run: async (context) => {
      const runId = typeof context.callback.payload.runId === "string" ? context.callback.payload.runId : "";
      const stopped = runId ? await deps.conversation.stopRun(context.link, runId) : false;
      return stopped ? {} : { text: TELEGRAM_COPY.buttonExpired };
    }
  };

  return Object.freeze({
    newChat(context: TelegramMessageContext) {
      deps.conversation.enqueue(context.link, context.bot, async (link) => {
        await deps.links.updatePreferences(link.id, { currentChatId: null, pendingAssistantId: null });
        await send(context, { text: TELEGRAM_COPY.newChat });
      });
    },

    async chats(context: TelegramMessageContext) {
      const chats = await deps.gateway.recentChats(context.link.userId);
      if (chats.length === 0) return send(context, { text: TELEGRAM_BRIDGE_COPY.noChats });
      await send(context, {
        keyboard: chats.map((chat) => [{
          callback: { kind: "select_chat", payload: { chatId: chat.id } },
          text: marked(chat.id === context.link.currentChatId, chat.title.trim() || "New Chat")
        }]),
        text: TELEGRAM_BRIDGE_COPY.chatsTitle
      });
    },

    async assistants(context: TelegramMessageContext) {
      const assistants = await deps.gateway.assistants(context.link.userId);
      if (assistants.length === 0) return send(context, { text: TELEGRAM_BRIDGE_COPY.noAssistants });
      await send(context, {
        keyboard: assistants.map((assistant) => [{
          callback: { kind: "select_assistant", payload: { assistantId: assistant.id } },
          text: marked(assistant.id === context.link.pendingAssistantId, assistant.name)
        }]),
        text: TELEGRAM_BRIDGE_COPY.assistantsTitle
      });
    },

    async models(context: TelegramMessageContext) {
      await send(context, await modelMenu(context.link, 0));
    },

    async settings(context: TelegramMessageContext) {
      await send(context, await settingsMenu(context.link));
    },

    callbacks
  });
}

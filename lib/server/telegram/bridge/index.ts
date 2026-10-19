import type { TelegramCallbackKind } from "../../../contracts/telegram";
import { logEvent } from "../../observability";
import type { TelegramAccessResolver } from "../control/access";
import type { TelegramSessionProvider } from "../control/session";
import { TELEGRAM_BRIDGE_COPY } from "../copy";
import type { TelegramHandlerRegistry, TelegramMessageContext, TelegramMessageHandler } from "../dispatcher";
import type { TelegramLinkStore } from "../store/links";
import type { TelegramMessageRefStore } from "../store/messageRefs";
import type { TelegramRunLinkStore } from "../store/runLinks";
import { createTelegramAdmission, createTelegramRunWait, type TelegramSendMessage } from "./admission";
import { createTelegramConversation, isStaleTelegramMessage, type TelegramConversation } from "./conversation";
import { deliverTelegramRun } from "./delivery";
import { publishTelegramRunEvent, type TelegramRunEvent, type TelegramRunEventContext } from "./events";
import type { TelegramRunGateway } from "./gateway";
import { createTelegramBridgeMenus } from "./menus";
import { recoverTelegramDeliveries } from "./recovery";
import { observeTelegramRun } from "./runObserver";

/**
 * Telegram messages as ordinary AIQSA chats (chat bridge): the message
 * handler (text into the merge window, the chat commands, the stale-backlog
 * cutoff), the buttons of its menus, the draft's Stop, the startup recovery
 * of interrupted deliveries, and the entry points later features use: run a
 * message (`sendTelegramMessage`, e.g. an approval's continuation) or add
 * prepared content to a chat's merge window (`conversation.queue`, media).
 */

export type TelegramChatBridge = Readonly<{
  sendTelegramMessage: TelegramSendMessage;
  conversation: TelegramConversation;
  /** Registers the bridge's handlers; returns the function that removes them. */
  register(registry: TelegramHandlerRegistry): () => void;
  /** Delivers what a restart interrupted, for runs linked before `startedAt`. */
  recover(startedAt: Date): Promise<void>;
}>;

export type TelegramChatBridgeDeps = Readonly<{
  access: Pick<TelegramAccessResolver, "resolveTelegramAccess">;
  gateway: TelegramRunGateway;
  links: Pick<TelegramLinkStore, "findByUserId" | "updatePreferences">;
  messageRefs: Pick<TelegramMessageRefStore, "find" | "record">;
  runLinks: TelegramRunLinkStore;
  sessions: TelegramSessionProvider;
  publish?: (event: TelegramRunEvent, context: TelegramRunEventContext) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  mergeWindowMs?: number;
  runWaitMs?: number;
  draftThrottleMs?: number;
  draftRefreshMs?: number;
  idleMs?: number;
}>;

/** Log codes the bridge adds to the transport and reason codes; all registered in the failure-code registry. */
export const TELEGRAM_BRIDGE_LOG_CODES = [
  "telegram_followup_failed",
  "telegram_run_admission_failed",
  "telegram_run_delivery_failed",
  "telegram_run_listener_failed",
  "telegram_run_recovery_failed",
  "telegram_run_refused",
  "telegram_run_stop_failed",
  "telegram_stale_message"
] as const;

/** One stale-backlog notice per link a minute, however many old messages arrive. */
const STALE_NOTICE_INTERVAL_MS = 60_000;
const STALE_NOTICE_MEMORY = 1_000;

export function createTelegramChatBridge(deps: TelegramChatBridgeDeps): TelegramChatBridge {
  const now = deps.now ?? Date.now;
  const publish = deps.publish ?? publishTelegramRunEvent;
  const sendTelegramMessage = createTelegramAdmission({
    gateway: deps.gateway, now, runLinks: deps.runLinks,
    ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.idleMs === undefined ? {} : { idleMs: deps.idleMs })
  });
  const delivery = { access: deps.access, gateway: deps.gateway, now, runLinks: deps.runLinks, sessions: deps.sessions };
  const conversation = createTelegramConversation({
    admit: sendTelegramMessage,
    gateway: deps.gateway,
    links: deps.links,
    messageRefs: deps.messageRefs,
    now,
    observe: (observation) => observeTelegramRun({
      ...delivery, publish,
      ...(deps.draftThrottleMs === undefined ? {} : { draftThrottleMs: deps.draftThrottleMs }),
      ...(deps.draftRefreshMs === undefined ? {} : { draftRefreshMs: deps.draftRefreshMs })
    }, observation),
    runLinks: deps.runLinks,
    ...(deps.mergeWindowMs === undefined ? {} : { mergeWindowMs: deps.mergeWindowMs }),
    ...(deps.runWaitMs === undefined ? {} : { runWaitMs: deps.runWaitMs })
  });
  const menus = createTelegramBridgeMenus({ conversation, gateway: deps.gateway, links: deps.links, messageRefs: deps.messageRefs, now });
  const staleNotices = new Map<string, number>();

  async function noticeStale(context: TelegramMessageContext): Promise<void> {
    logEvent("service_operation", { code: "telegram_stale_message", outcome: "skipped", stage: "dispatch", subsystem: "telegram" });
    const at = now();
    const last = staleNotices.get(context.link.id);
    if (last !== undefined && at - last < STALE_NOTICE_INTERVAL_MS) return;
    staleNotices.delete(context.link.id);
    staleNotices.set(context.link.id, at);
    while (staleNotices.size > STALE_NOTICE_MEMORY) staleNotices.delete(staleNotices.keys().next().value as string);
    await context.bot.outbound.sendText({
      chatId: context.message.chat.id, replyTo: context.message.message_id, text: TELEGRAM_BRIDGE_COPY.staleMessage
    });
  }

  const onMessage: TelegramMessageHandler = async (context) => {
    const { command, message } = context;
    if (command) {
      switch (command.name) {
        case "new":
          menus.newChat(context);
          return true;
        case "chats":
          await menus.chats(context);
          return true;
        case "assistant":
          await menus.assistants(context);
          return true;
        case "model":
          await menus.models(context);
          return true;
        case "settings":
          await menus.settings(context);
          return true;
        case "stop":
          await conversation.stop(context.link, context.bot);
          return true;
        default:
          await context.bot.outbound.sendText({ chatId: message.chat.id, text: TELEGRAM_BRIDGE_COPY.unknownCommand });
          return true;
      }
    }
    // Voice, audio, photos and documents belong to the media handler; other kinds to the fallback.
    if (message.text === undefined || message.has_other_content || message.voice || message.audio || message.document || message.photo) {
      return false;
    }
    // Kept by Telegram while the bot was off: running it now would cost what nobody asked for.
    if (isStaleTelegramMessage(message, now())) {
      await noticeStale(context);
      return true;
    }
    if (message.text.trim()) conversation.queue(context, [{ text: message.text, type: "text" }]);
    return true;
  };

  return Object.freeze({
    conversation,
    sendTelegramMessage,

    register(registry: TelegramHandlerRegistry) {
      const removers = [
        registry.registerMessage(onMessage),
        ...(Object.entries(menus.callbacks) as Array<[TelegramCallbackKind, NonNullable<(typeof menus.callbacks)[TelegramCallbackKind]>]>)
          .map(([kind, handler]) => registry.registerCallback(kind, handler)),
        registry.registerStop(async (context) => { conversation.stopDraft(context.link, context.draftId); })
      ];
      return () => { for (const remove of removers) remove(); };
    },

    recover(startedAt: Date) {
      return recoverTelegramDeliveries({
        deliver: (input) => deliverTelegramRun(delivery, input),
        isLive: (runId) => conversation.isLive(runId),
        now,
        publish,
        runLinks: deps.runLinks,
        sessions: deps.sessions,
        waitForRun: createTelegramRunWait(deps.gateway, { now, ...(deps.sleep ? { sleep: deps.sleep } : {}) })
      }, { startedAt });
    }
  });
}

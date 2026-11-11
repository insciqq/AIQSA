import {
  lazyConnectorLoader, lazyConnectorRunOperations, type ConnectorRunAnswer, type ConnectorRunOperations, type ConnectorRunState
} from "../../connectors/runGateway";
import type { TelegramRecentChat } from "../store/chats";
import type { TelegramModelRef, TelegramRunCatalog } from "./body";

/**
 * The AIQSA operations the chat bridge performs as the linked user: the
 * connectors' run operations (`lib/server/connectors/runGateway.ts`: the
 * product's own in-process admission, follow-up, Stop and reads) and what
 * only Telegram's menus need, behind one seam so the bridge itself stays free
 * of the run stack and testable with fakes. Every operation re-resolves the
 * user and re-checks Telegram access.
 */

/** A personal chat the user may continue from Telegram. */
export type TelegramChatRecord = Readonly<{
  id: string;
  title: string;
  activeLeafMessageId: string | null;
  assistantId: string | null;
  /** The chat's model, empty for a chat that has none yet. */
  model: TelegramModelRef;
}>;

/** A run's state as `GET /api/model-runs/[runId]` answers it. */
export type TelegramRunState = ConnectorRunState;

/** A settled run's answer as the chat shows it. */
export type TelegramRunAnswer = ConnectorRunAnswer;

export type TelegramAssistantChoice = Readonly<{ id: string; name: string }>;

export type TelegramRunGateway = ConnectorRunOperations & Readonly<{
  /** The user's current personal catalog; null when the account has none. */
  loadCatalog(userId: string): Promise<TelegramRunCatalog | null>;
  /** The chat when it is still the user's own usable personal chat (not archived or Temporary). */
  findChat(userId: string, chatId: string): Promise<TelegramChatRecord | null>;
  recentChats(userId: string): Promise<readonly TelegramRecentChat[]>;
  /** Assistants the user can start a chat with now: pinned, then recent, then the rest; at most 20. */
  assistants(userId: string): Promise<readonly TelegramAssistantChoice[]>;
  /** The IANA zone the user's browser last reported on a run; null when none is known. */
  timeZone(userId: string): Promise<string | null>;
}>;

/** A gateway whose implementation loads on first use, so the bot starts without the run stack. */
export function lazyTelegramRunGateway(load: () => Promise<TelegramRunGateway>): TelegramRunGateway {
  const gateway = lazyConnectorLoader(load);
  const lazy: TelegramRunGateway = {
    ...lazyConnectorRunOperations(gateway),
    assistants: async (userId) => (await gateway()).assistants(userId),
    findChat: async (userId, chatId) => (await gateway()).findChat(userId, chatId),
    loadCatalog: async (userId) => (await gateway()).loadCatalog(userId),
    recentChats: async (userId) => (await gateway()).recentChats(userId),
    timeZone: async (userId) => (await gateway()).timeZone(userId)
  };
  return Object.freeze(lazy);
}

import type { ThreadArtifactSummary } from "../../../contracts/chats";
import type { TelegramRecentChat } from "../store/chats";
import type { TelegramModelRef, TelegramRunCatalog } from "./body";

/**
 * The AIQSA operations the chat bridge performs as the linked user, all
 * through the product's own in-process handlers and repositories (the same
 * admission, follow-up, Stop and reads the web uses), behind one seam so the
 * bridge itself stays free of the run stack and testable with fakes. Every
 * operation re-resolves the user and re-checks Telegram access.
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
export type TelegramRunState = Readonly<{ status: string }>;

/** A settled run's answer as the chat shows it. */
export type TelegramRunAnswer = Readonly<{
  chatId: string;
  assistantMessageId: string;
  status: "complete" | "cancelled" | "error" | "streaming";
  text: string;
  errorMessage: string | null;
  artifactSummary: ThreadArtifactSummary | null;
}>;

export type TelegramAssistantChoice = Readonly<{ id: string; name: string }>;

export type TelegramRunGateway = Readonly<{
  /** The user's current personal catalog; null when the account has none. */
  loadCatalog(userId: string): Promise<TelegramRunCatalog | null>;
  /** The chat when it is still the user's own usable personal chat (not archived or Temporary). */
  findChat(userId: string, chatId: string): Promise<TelegramChatRecord | null>;
  /** `POST /api/chats/[chatId]/messages` in process, as the user. */
  send(input: Readonly<{ userId: string; chatId: string; body: Record<string, unknown> }>): Promise<Response>;
  /** `POST /api/model-runs/[runId]/followups` in process, as the user. */
  followup(input: Readonly<{
    userId: string; runId: string; chatId: string; assistantMessageId: string; nonce: string; text: string;
  }>): Promise<Response>;
  /** The ordinary Stop of an active run. */
  stop(input: Readonly<{ userId: string; runId: string }>): Promise<"stopped" | "not_cancelable" | "not_found">;
  /** Null when the run is gone or no longer the user's; a run still being prepared reads as `preparing`. */
  runState(input: Readonly<{ userId: string; runId: string }>): Promise<TelegramRunState | null>;
  /** The run's persisted answer, citations and sources; null when it can no longer be read. */
  answer(input: Readonly<{ userId: string; runId: string }>): Promise<TelegramRunAnswer | null>;
  /** The active run of a chat, whoever started it. */
  activeRun(input: Readonly<{ userId: string; chatId: string }>): Promise<Readonly<{ runId: string }> | null>;
  recentChats(userId: string): Promise<readonly TelegramRecentChat[]>;
  /** Assistants the user can start a chat with now: pinned, then recent, then the rest; at most 20. */
  assistants(userId: string): Promise<readonly TelegramAssistantChoice[]>;
  /** The IANA zone the user's browser last reported on a run; null when none is known. */
  timeZone(userId: string): Promise<string | null>;
}>;

export const TELEGRAM_TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["complete", "error", "cancelled"]);

/** A gateway whose implementation loads on first use, so the bot starts without the run stack. */
export function lazyTelegramRunGateway(load: () => Promise<TelegramRunGateway>): TelegramRunGateway {
  let loading: Promise<TelegramRunGateway> | null = null;
  const gateway = () => loading ??= load().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  const lazy: TelegramRunGateway = {
    activeRun: async (input) => (await gateway()).activeRun(input),
    answer: async (input) => (await gateway()).answer(input),
    assistants: async (userId) => (await gateway()).assistants(userId),
    findChat: async (userId, chatId) => (await gateway()).findChat(userId, chatId),
    followup: async (input) => (await gateway()).followup(input),
    loadCatalog: async (userId) => (await gateway()).loadCatalog(userId),
    recentChats: async (userId) => (await gateway()).recentChats(userId),
    runState: async (input) => (await gateway()).runState(input),
    send: async (input) => (await gateway()).send(input),
    stop: async (input) => (await gateway()).stop(input),
    timeZone: async (userId) => (await gateway()).timeZone(userId)
  };
  return Object.freeze(lazy);
}

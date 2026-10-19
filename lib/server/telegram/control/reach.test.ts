import { describe, expect, it } from "vitest";
import type { TelegramBotSession } from "../dispatcher";
import type { TelegramLinkRecord } from "../store/links";
import type { TelegramAccessDecision } from "./access";
import { reachTelegramChat, type TelegramChatBinding } from "./reach";

const BOT_ID = 7_000_001;

function link(overrides: Partial<TelegramLinkRecord> = {}): TelegramLinkRecord {
  return {
    agentEnabled: false, botId: BOT_ID, currentChatId: null, displayName: null, id: "link-1", lastSeenAt: new Date(0), linkedAt: new Date(0),
    pendingAssistantId: null, searchEnabled: false, selectedModelId: null, selectedProvider: null, telegramChatId: 501, telegramUserId: 501,
    telegramUsername: null, userId: "user-1", workspaceEnabled: false, ...overrides
  };
}

function session(botId = BOT_ID, generation = 1): TelegramBotSession {
  return { api: {} as never, botId, botUsername: "aiqsa_bot", generation, outbound: {} as never };
}

const binding: TelegramChatBinding = { botId: BOT_ID, linkId: "link-1", telegramChatId: 501, userId: "user-1" };

function reach(decision: TelegramAccessDecision, bot: TelegramBotSession | null = session()) {
  return reachTelegramChat({ access: { resolveTelegramAccess: async () => decision }, sessions: { current: async () => bot } }, binding);
}

const allowed = (value: TelegramLinkRecord = link()): TelegramAccessDecision => ({ allowed: true, control: {} as never, link: value });

describe("reaching a bound Telegram chat", () => {
  it("reaches it through the current session while the same link still names the same bot and chat", async () => {
    const current = session(BOT_ID, 2);
    expect(await reach(allowed(), current)).toEqual({ bot: current, link: link(), ok: true });
  });

  it.each([
    ["the user unlinked", { allowed: false, link: null, reasonCode: "telegram_not_linked" } as const, session(), "telegram_not_linked"],
    ["access is off", { allowed: false, link: link(), reasonCode: "telegram_access_off" } as const, session(), "telegram_access_off"],
    ["the bot is off", allowed(), null, "telegram_access_off"],
    ["another bot runs now", allowed(link({ botId: BOT_ID + 1 })), session(BOT_ID + 1), "telegram_bot_changed"],
    ["the user linked anew", allowed(link({ id: "link-2" })), session(), "telegram_not_linked"],
    ["the link moved to another chat", allowed(link({ telegramChatId: 502 })), session(), "telegram_not_linked"]
  ] as const)("refuses when %s", async (_case, decision, bot, reasonCode) => {
    expect(await reach(decision, bot)).toEqual({ ok: false, reasonCode });
  });
});

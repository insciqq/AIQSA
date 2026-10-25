import { afterEach, describe, expect, it, vi } from "vitest";
import { TELEGRAM_CALLBACK_DATA_PATTERN } from "../../../contracts/telegram";
import { createFakeTelegramBotApi } from "@/tests/support/fakeTelegramBotApi";
import { createTelegramBotApi, createTelegramPacer, type TelegramMessage } from "../botApi";
import { TELEGRAM_CORE_COPY, TELEGRAM_COPY } from "../copy";
import type { TelegramBotSession, TelegramCallbackContext } from "../dispatcher";
import { createTelegramOutbound } from "../outbound";
import type { TelegramCallbackInput, TelegramCallbackStore } from "../store/callbacks";
import type { TelegramLinkRecord } from "../store/links";
import { createTelegramLinkCommands, telegramDisplayName } from "./commands";
import type { TelegramLinkingService } from "./service";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

function setup(linking: Partial<TelegramLinkingService> = {}) {
  const fake = createFakeTelegramBotApi();
  closers.push(() => fake.close());
  const user = fake.inject.addUser({ firstName: "Alex", username: "alex_example" });
  const api = createTelegramBotApi({ pacer: createTelegramPacer({ now: () => 0 }), sleep: async () => {}, token: fake.token, transport: fake.transport });
  const buttons: Array<TelegramCallbackInput & { linkId: string }> = [];
  const callbacks: Pick<TelegramCallbackStore, "create"> = {
    create: async ({ buttons: created, linkId }) => created.map((button, index) => {
      buttons.push({ ...button, linkId });
      return `c:${"B".repeat(21)}${index}`;
    })
  };
  const outbound = createTelegramOutbound({ api, botId: fake.bot.id, callbacks, messageRefs: { record: vi.fn() } });
  const bot: TelegramBotSession = { api, botId: fake.bot.id, botUsername: fake.bot.username, generation: 1, outbound };
  const service = {
    linkFromStart: vi.fn(),
    unlinkFromBot: vi.fn(async () => true),
    ...linking
  } as unknown as TelegramLinkingService;
  const message = {
    chat: { id: user.id, type: "private" }, date: 0, from: { first_name: "Alex", id: user.id, is_bot: false, username: "alex_example" },
    has_other_content: false, message_id: 1, text: "/start"
  } as TelegramMessage;
  const link = { id: "link-1", telegramChatId: user.id, userId: "user-1" } as TelegramLinkRecord;
  return { bot, buttons, commands: createTelegramLinkCommands({ linking: service }), fake, link, message, service, user };
}

describe("Telegram account commands", () => {
  it("links from /start and confirms with the AIQSA account's name, or hands the refusal's text to the dispatcher", async () => {
    const { bot, commands, fake, message, service, user } = setup({
      linkFromStart: vi.fn()
        .mockResolvedValueOnce({ accountName: "Alex Example", kind: "linked", link: {} as TelegramLinkRecord, replaced: null })
        .mockResolvedValueOnce({ code: "telegram_link_code_invalid", kind: "refused" })
        .mockResolvedValueOnce({ code: "telegram_account_in_use", kind: "refused" })
    });
    const refuse = vi.fn(async () => undefined);
    for (let index = 0; index < 3; index += 1) await commands.start({ bot, code: "A".repeat(43), message, refuse });
    expect(service.linkFromStart).toHaveBeenCalledWith({
      code: "A".repeat(43),
      target: { botId: fake.bot.id, displayName: "Alex", telegramChatId: user.id, telegramUserId: user.id, telegramUsername: "alex_example" }
    });
    expect(fake.botMessages(user.id).map((sent) => sent.text)).toEqual([
      "Connected to AIQSA as Alex Example. Send a message to start a new chat. /help lists commands."
    ]);
    expect(refuse.mock.calls).toEqual([
      ["This link has expired. Create a new one in AIQSA → Settings → Connections."],
      ["This Telegram account is connected to another AIQSA account. Disconnect it there first."]
    ]);
  });

  it("asks before disconnecting with one single-use button bound to the link", async () => {
    const { bot, buttons, commands, fake, link, message, user } = setup();
    await commands.unlink({ bot, link, message });
    const [question] = fake.botMessages(user.id);
    expect(question?.text).toBe(TELEGRAM_COPY.unlinkQuestion);
    const keyboard = question?.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string; text: string }>> };
    expect(keyboard.inline_keyboard).toHaveLength(1);
    expect(keyboard.inline_keyboard[0]![0]!.text).toBe(TELEGRAM_COPY.unlinkConfirm);
    expect(keyboard.inline_keyboard[0]![0]!.callback_data).toMatch(TELEGRAM_CALLBACK_DATA_PATTERN);
    expect(buttons).toEqual([{ kind: "unlink_confirm", linkId: "link-1", ttlMs: 600_000 }]);
  });

  it("disconnects on the confirmation press and replaces the question with the outcome", async () => {
    const { bot, commands, fake, link, message, service, user } = setup();
    await commands.unlink({ bot, link, message });
    const question = fake.botMessages(user.id)[0]!;
    const context = { bot, chatId: user.id, link, messageId: question.message_id } as unknown as TelegramCallbackContext;
    await expect(commands.confirmUnlink(context)).resolves.toEqual({});
    expect(service.unlinkFromBot).toHaveBeenCalledWith({ linkId: "link-1", userId: "user-1" });
    expect(fake.botMessages(user.id)[0]).toMatchObject({ edits: 1, text: TELEGRAM_COPY.disconnected });
    expect(fake.botMessages(user.id)[0]?.reply_markup).toBeUndefined();

    vi.mocked(service.unlinkFromBot).mockResolvedValueOnce(false);
    await commands.confirmUnlink({ ...context, messageId: 999 } as TelegramCallbackContext);
    expect(fake.botMessages(user.id).at(-1)?.text).toBe(TELEGRAM_CORE_COPY.notConnected);
  });

  it("takes the Telegram display name from first and last name, bounded", () => {
    expect(telegramDisplayName({ first_name: " Alex ", id: 1, is_bot: false, last_name: "Example" })).toBe("Alex Example");
    expect(telegramDisplayName({ first_name: "", id: 1, is_bot: false })).toBeNull();
    expect(telegramDisplayName({ first_name: "x".repeat(300), id: 1, is_bot: false })?.length).toBe(128);
  });
});

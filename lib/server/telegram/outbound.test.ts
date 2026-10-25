import { afterEach, describe, expect, it, vi } from "vitest";
import { TELEGRAM_CALLBACK_DATA_PATTERN } from "../../contracts/telegram";
import { createFakeTelegramBotApi, telegramPhotoFixture, validateTelegramRichMessage } from "@/tests/support/fakeTelegramBotApi";
import { captureRunObservation } from "@/tests/support/runObservation";
import { createTelegramBotApi, createTelegramPacer, type TelegramInputRichMessage } from "./botApi";
import { TELEGRAM_COPY } from "./copy";
import { createTelegramOutbound, splitTelegramText } from "./outbound";
import type { TelegramCallbackStore } from "./store/callbacks";
import type { TelegramMessageRef } from "./store/messageRefs";
import type { TelegramTransport } from "./transport";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

const OWNER = { chatId: "chat-1", linkId: "link-1", messageId: "message-1", userId: "user-1" };
const SENTINEL = "private-answer-sentinel";
const DOCS = [[{ text: "Docs", url: "https://example.com/docs" }]];

function rich(text: string): TelegramInputRichMessage {
  return { blocks: [{ text, type: "paragraph" }] };
}

function setup(options: Readonly<{ transport?: (base: TelegramTransport) => TelegramTransport }> = {}) {
  const fake = createFakeTelegramBotApi();
  closers.push(() => fake.close());
  const user = fake.inject.addUser();
  const transport = options.transport ? options.transport(fake.transport) : fake.transport;
  const api = createTelegramBotApi({ pacer: createTelegramPacer({ now: () => 0 }), sleep: async () => {}, token: fake.token, transport });
  const refs: TelegramMessageRef[] = [];
  const created: unknown[] = [];
  const callbacks: Pick<TelegramCallbackStore, "create"> = {
    create: async ({ buttons, linkId }) => buttons.map((button, index) => {
      created.push({ ...button, linkId });
      return `c:${"D".repeat(21)}${index}`;
    })
  };
  const outbound = createTelegramOutbound({
    api, botId: fake.bot.id, callbacks,
    messageRefs: { record: vi.fn(async (entries: readonly TelegramMessageRef[]) => { refs.push(...entries); }) }
  });
  return { created, fake, outbound, refs, user };
}

describe("Telegram outbound content", () => {
  it("sends rendered rich messages with entity detection off, a reply on the first and the keyboard on the last, recording each", async () => {
    const { created, fake, outbound, refs, user } = setup();
    const result = await outbound.sendContent({
      chatId: user.id, keyboard: [[{ callback: { kind: "stop_run", payload: { runId: "run-1" } }, text: TELEGRAM_COPY.stop }]],
      messages: [rich("First part"), rich("Second part")], owner: OWNER, replyTo: 1
    });
    expect(result).toEqual({ fallback: false, messageIds: [1, 2], ok: true });
    const [first, second] = fake.calls("sendRichMessage");
    expect(first!.params).toMatchObject({ chat_id: user.id, reply_parameters: { allow_sending_without_reply: true, message_id: 1 } });
    expect(first!.params).not.toHaveProperty("reply_markup");
    expect((first!.params.rich_message as { skip_entity_detection: boolean }).skip_entity_detection).toBe(true);
    expect(validateTelegramRichMessage(first!.params.rich_message)).toMatchObject({ ok: true });
    expect(second!.params).not.toHaveProperty("reply_parameters");
    const keyboard = (second!.params.reply_markup as { inline_keyboard: Array<Array<Record<string, string>>> }).inline_keyboard;
    expect(keyboard).toHaveLength(1);
    expect(keyboard[0]![0]!.callback_data).toMatch(TELEGRAM_CALLBACK_DATA_PATTERN);
    expect(created).toEqual([{ kind: "stop_run", linkId: "link-1", payload: { runId: "run-1" } }]);
    expect(refs).toEqual([
      { ...OWNER, botId: fake.bot.id, telegramChatId: user.id, telegramMessageId: 1 },
      { ...OWNER, botId: fake.bot.id, telegramChatId: user.id, telegramMessageId: 2 }
    ]);
  });

  it("asks its authority before every message, the plain fallback included, and ends at the first refusal", async () => {
    const { fake, outbound, user } = setup();
    fake.failNext("sendRichMessage", { description: "Bad Request: RICH_MESSAGE_INVALID", status: 400 }, 1);
    // Allowed for the first part's rich form only: neither its plain fallback nor the next part goes.
    const authorize = vi.fn(async () => authorize.mock.calls.length <= 1);
    const result = await outbound.sendContent({ authorize, chatId: user.id, messages: [rich(SENTINEL), rich("Second part")], owner: OWNER });
    expect(result).toEqual({ failure: { kind: "unreachable", ok: false }, messageIds: [], ok: false });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(fake.calls("sendRichMessage")).toHaveLength(1);
    expect(fake.calls("sendMessage")).toHaveLength(0);
    expect(fake.botMessages(user.id)).toHaveLength(0);
  });

  it("adds no button of its own: content without a keyboard carries no reply markup", async () => {
    const { fake, outbound, user } = setup();
    await outbound.sendContent({ chatId: user.id, messages: [rich("Answer")], owner: OWNER });
    await outbound.sendText({ chatId: user.id, owner: OWNER, text: "Stopped" });
    expect(fake.lastCall("sendRichMessage")!.params).not.toHaveProperty("reply_markup");
    expect(fake.lastCall("sendMessage")!.params).not.toHaveProperty("reply_markup");
  });

  it("falls back to the refused part's own plain text without link previews, links written out", async () => {
    const capture = await captureRunObservation();
    const { fake, outbound, refs, user } = setup();
    fake.failNext("sendRichMessage", { description: `Bad Request: can't parse ${SENTINEL}`, status: 400 });
    const linked: TelegramInputRichMessage = { blocks: [
      { text: SENTINEL, type: "paragraph" },
      { text: [{ text: "Docs", type: "url", url: "https://example.com/docs" }], type: "paragraph" }
    ] };
    const result = await outbound.sendContent({
      chatId: user.id, keyboard: [[{ text: "Docs", url: "https://example.com/docs" }]], messages: [linked], owner: OWNER, replyTo: 1
    });
    expect(result).toEqual({ fallback: true, messageIds: [1], ok: true });
    const [plain] = fake.calls("sendMessage");
    expect(plain!.params).toMatchObject({
      link_preview_options: { is_disabled: true }, reply_parameters: { allow_sending_without_reply: true, message_id: 1 },
      text: `${SENTINEL}\n\nDocs (https://example.com/docs)`
    });
    expect(plain!.params.reply_markup).toEqual({ inline_keyboard: [[{ text: "Docs", url: "https://example.com/docs" }]] });
    expect(refs).toHaveLength(1);
    const records = capture.records();
    expect(records).toContainEqual(expect.objectContaining({ code: "telegram_render_fallback", subsystem: "telegram" }));
    expect(JSON.stringify(records)).not.toContain(SENTINEL);
  });

  it("replaces only a part refused mid-answer, never resending delivered parts or the whole answer", async () => {
    const parts = ["Part one", "Part two", "Part three", "Part four", "Part five"].map(rich);
    let richCalls = 0;
    const refusing = setup({
      transport: (base) => ({
        ...base,
        call: async (input) => {
          if (input.method === "sendRichMessage" && ++richCalls === 3) {
            return { description: "Bad Request: rich message refused", errorCode: 400, kind: "telegram", ok: false, status: 400 };
          }
          return base.call(input);
        }
      })
    });
    const result = await refusing.outbound.sendContent({ chatId: refusing.user.id, keyboard: DOCS, messages: parts, owner: OWNER });
    expect(result).toEqual({ fallback: true, messageIds: [1, 2, 3, 4, 5], ok: true });
    const sent = refusing.fake.botMessages(refusing.user.id);
    expect(sent.map((message) => message.kind)).toEqual(["rich", "rich", "text", "rich", "rich"]);
    expect(sent[2]!.text).toBe("Part three");
    expect(refusing.fake.calls("sendMessage")).toHaveLength(1);
    expect(sent.slice(0, 4).every((message) => message.reply_markup === undefined)).toBe(true);
    expect(sent[4]!.reply_markup).toEqual({ inline_keyboard: [[{ text: "Docs", url: "https://example.com/docs" }]] });
    expect(refusing.refs.map((ref) => ref.telegramMessageId)).toEqual([1, 2, 3, 4, 5]);
    // The last part refused: its plain text carries the keyboard.
    const lastRefused = setup({
      transport: (base) => ({
        ...base,
        call: async (input) => input.method === "sendRichMessage" && (input.params?.rich_message as { blocks: Array<{ text: string }> })
          .blocks[0]!.text === "Part five"
          ? { errorCode: 400, kind: "telegram", ok: false, status: 400 }
          : base.call(input)
      })
    });
    await lastRefused.outbound.sendContent({ chatId: lastRefused.user.id, keyboard: DOCS, messages: parts, owner: OWNER });
    expect(lastRefused.fake.botMessages(lastRefused.user.id).at(-1)).toMatchObject({
      kind: "text", reply_markup: { inline_keyboard: [[{ text: "Docs", url: "https://example.com/docs" }]] },
      text: "Part five"
    });
  });

  it("reports a refused rich answer that has no plain form, and keeps a delivered message when its reference fails", async () => {
    const refused = setup();
    refused.fake.failNext("sendRichMessage", { status: 400 });
    await expect(refused.outbound.sendContent({ chatId: refused.user.id, messages: [rich("  ")], owner: OWNER }))
      .resolves.toMatchObject({ failure: { errorCode: 400 }, messageIds: [], ok: false });
    expect(refused.fake.calls("sendMessage")).toHaveLength(0);

    const capture = await captureRunObservation();
    const fake = createFakeTelegramBotApi();
    closers.push(() => fake.close());
    const user = fake.inject.addUser();
    const api = createTelegramBotApi({ pacer: createTelegramPacer({ now: () => 0 }), sleep: async () => {}, token: fake.token, transport: fake.transport });
    const outbound = createTelegramOutbound({
      api, botId: fake.bot.id, callbacks: { create: async () => [] },
      messageRefs: { record: async () => { throw new Error("database unavailable"); } }
    });
    await expect(outbound.sendContent({ chatId: user.id, messages: [rich("A")], owner: OWNER }))
      .resolves.toEqual({ fallback: false, messageIds: [1], ok: true });
    expect(capture.records()).toContainEqual(expect.objectContaining({ code: "telegram_message_ref_failed", subsystem: "telegram" }));
  });

  it("never resends an ambiguous send, and repeats one that never reached Telegram", async () => {
    const ambiguous = setup();
    ambiguous.fake.failNext("sendRichMessage", { drop: true });
    const failed = await ambiguous.outbound.sendContent({ chatId: ambiguous.user.id, messages: [rich("A"), rich("B")], owner: OWNER });
    expect(failed).toMatchObject({ failure: { kind: "network_after_send" }, messageIds: [], ok: false });
    expect(ambiguous.fake.calls("sendRichMessage")).toHaveLength(1);
    expect(ambiguous.fake.calls("sendMessage")).toHaveLength(0);

    let refusedOnce = false;
    const retried = setup({
      transport: (base) => ({
        ...base,
        call: async (input) => {
          if (input.method === "sendRichMessage" && !refusedOnce) {
            refusedOnce = true;
            return { category: "connect", kind: "network_before_send", ok: false };
          }
          return base.call(input);
        }
      })
    });
    await expect(retried.outbound.sendContent({ chatId: retried.user.id, messages: [rich("A")], owner: OWNER }))
      .resolves.toEqual({ fallback: false, messageIds: [1], ok: true });
  });

  it("sends bot copy and plain content split at 4096 characters", async () => {
    const { fake, outbound, refs, user } = setup();
    const long = `${"word ".repeat(1_000)}\n${"x".repeat(3_000)}`;
    const result = await outbound.sendText({ chatId: user.id, owner: OWNER, text: long });
    expect(result.ok).toBe(true);
    const sent = fake.calls("sendMessage").map((call) => call.params.text as string);
    expect(sent.length).toBe(2);
    for (const chunk of sent) expect(chunk.length).toBeLessThanOrEqual(4_096);
    expect(sent.join("").replace(/\s/gu, "")).toBe(long.replace(/\s/gu, ""));
    expect(refs).toHaveLength(2);
    await outbound.sendText({ chatId: user.id, text: TELEGRAM_COPY.help });
    expect(refs).toHaveLength(2);
    await expect(outbound.sendText({ chatId: user.id, keyboard: [[{ callback: { kind: "toggle_search" }, text: "Search" }]], text: "Menu" }))
      .rejects.toThrow("telegram_keyboard_link_missing");
    await expect(outbound.sendText({ chatId: user.id, keyboard: [[{ text: "Bad", url: "tg://user?id=1" }]], text: "Menu" }))
      .rejects.toThrow("telegram_button_url_invalid");
  });

  it("sends files from buffers with a bounded caption and records them", async () => {
    const { fake, outbound, refs, user } = setup();
    const photo = await outbound.sendFile({
      caption: `Chart ${"c".repeat(2_000)}`, chatId: user.id, file: { contentType: "image/jpeg", data: telegramPhotoFixture(), filename: "chart.jpg" },
      kind: "photo", owner: OWNER
    });
    expect(photo).toEqual({ fallback: false, messageIds: [1], ok: true });
    expect((fake.lastCall("sendPhoto")!.params.caption as string).length).toBe(1_024);
    const document = await outbound.sendFile({
      chatId: user.id, file: { contentType: "application/pdf", data: Buffer.from("%PDF-1.7 synthetic"), filename: "report.pdf" },
      kind: "document", owner: OWNER
    });
    expect(document.ok).toBe(true);
    expect(fake.lastCall("sendDocument")).toMatchObject({ file: { field: "document", filename: "report.pdf" } });
    expect(refs.map((ref) => ref.telegramMessageId)).toEqual([1, 2]);
  });
});

describe("Telegram text splitting", () => {
  it("never splits inside a surrogate pair and drops only empty chunks", () => {
    const text = `${"a".repeat(4_095)}😀${"b".repeat(10)}`;
    const chunks = splitTelegramText(text);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4_096);
    expect(splitTelegramText("   ")).toEqual([]);
  });
});

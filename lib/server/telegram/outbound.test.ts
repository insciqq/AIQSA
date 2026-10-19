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

function rich(text: string): TelegramInputRichMessage {
  return { blocks: [{ text, type: "paragraph" }] };
}

function setup(options: Readonly<{ appBaseUrl?: string; transport?: (base: TelegramTransport) => TelegramTransport }> = {}) {
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
    api, appBaseUrl: options.appBaseUrl ?? "https://aiqsa.example", botId: fake.bot.id, callbacks,
    messageRefs: { record: vi.fn(async (entries: readonly TelegramMessageRef[]) => { refs.push(...entries); }) }
  });
  return { created, fake, outbound, refs, user };
}

describe("Telegram outbound content", () => {
  it("sends rendered rich messages with entity detection off, a reply on the first and the keyboard on the last, recording each", async () => {
    const { created, fake, outbound, refs, user } = setup();
    const result = await outbound.sendContent({
      chatId: user.id, keyboard: [[{ callback: { kind: "stop_run", payload: { runId: "run-1" } }, text: TELEGRAM_COPY.stop }]],
      messages: [rich("First part"), rich("Second part")], openInAiqsa: true, owner: OWNER, plainFallback: ["First part\n\nSecond part"], replyTo: 1
    });
    expect(result).toEqual({ fallback: false, messageIds: [1, 2], ok: true });
    const [first, second] = fake.calls("sendRichMessage");
    expect(first!.params).toMatchObject({ chat_id: user.id, reply_parameters: { allow_sending_without_reply: true, message_id: 1 } });
    expect(first!.params).not.toHaveProperty("reply_markup");
    expect((first!.params.rich_message as { skip_entity_detection: boolean }).skip_entity_detection).toBe(true);
    expect(validateTelegramRichMessage(first!.params.rich_message)).toMatchObject({ ok: true });
    expect(second!.params).not.toHaveProperty("reply_parameters");
    const keyboard = (second!.params.reply_markup as { inline_keyboard: Array<Array<Record<string, string>>> }).inline_keyboard;
    expect(keyboard[0]![0]!.callback_data).toMatch(TELEGRAM_CALLBACK_DATA_PATTERN);
    expect(keyboard[1]).toEqual([{ text: TELEGRAM_COPY.openInAiqsa, url: "https://aiqsa.example/c/chat-1" }]);
    expect(created).toEqual([{ kind: "stop_run", linkId: "link-1", payload: { runId: "run-1" } }]);
    expect(refs).toEqual([
      { ...OWNER, botId: fake.bot.id, telegramChatId: user.id, telegramMessageId: 1 },
      { ...OWNER, botId: fake.bot.id, telegramChatId: user.id, telegramMessageId: 2 }
    ]);
  });

  it("links to AIQSA only from an https installation", async () => {
    const { fake, outbound, user } = setup({ appBaseUrl: "http://localhost:3000" });
    expect(outbound.openInAiqsaUrl("chat-1")).toBeNull();
    await outbound.sendContent({ chatId: user.id, messages: [rich("Answer")], openInAiqsa: true, owner: OWNER, plainFallback: ["Answer"] });
    expect(fake.lastCall("sendRichMessage")!.params).not.toHaveProperty("reply_markup");
    expect(setup().outbound.openInAiqsaUrl("a b/c")).toBe("https://aiqsa.example/c/a%20b%2Fc");
  });

  it("falls back once to plain text without link previews when Telegram refuses a rich message", async () => {
    const capture = await captureRunObservation();
    const { fake, outbound, refs, user } = setup();
    fake.failNext("sendRichMessage", { description: `Bad Request: can't parse ${SENTINEL}`, status: 400 });
    const result = await outbound.sendContent({
      chatId: user.id, keyboard: [[{ text: "Docs", url: "https://example.com/docs" }]], messages: [rich(SENTINEL)], owner: OWNER,
      plainFallback: [`${SENTINEL} one`, `${SENTINEL} two`]
    });
    expect(result).toEqual({ fallback: true, messageIds: [1, 2], ok: true });
    const plain = fake.calls("sendMessage");
    expect(plain.map((call) => call.params.text)).toEqual([`${SENTINEL} one`, `${SENTINEL} two`]);
    for (const call of plain) expect(call.params.link_preview_options).toEqual({ is_disabled: true });
    expect(plain[0]!.params).not.toHaveProperty("reply_markup");
    expect(plain[1]!.params.reply_markup).toEqual({ inline_keyboard: [[{ text: "Docs", url: "https://example.com/docs" }]] });
    expect(refs).toHaveLength(2);
    const records = capture.records();
    expect(records).toContainEqual(expect.objectContaining({ code: "telegram_render_fallback", subsystem: "telegram" }));
    expect(JSON.stringify(records)).not.toContain(SENTINEL);
  });

  it("never resends an ambiguous send, and repeats one that never reached Telegram", async () => {
    const ambiguous = setup();
    ambiguous.fake.failNext("sendRichMessage", { drop: true });
    const failed = await ambiguous.outbound.sendContent({ chatId: ambiguous.user.id, messages: [rich("A"), rich("B")], owner: OWNER, plainFallback: ["A B"] });
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
    await expect(retried.outbound.sendContent({ chatId: retried.user.id, messages: [rich("A")], owner: OWNER, plainFallback: ["A"] }))
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
      kind: "document", openInAiqsa: true, owner: OWNER
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

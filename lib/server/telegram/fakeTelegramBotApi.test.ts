import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeTelegramBotApi, FAKE_TELEGRAM_TOKEN, telegramPhotoFixture, telegramVoiceFixture, validateTelegramRichMessage,
  type FakeTelegramBotApi
} from "@/tests/support/fakeTelegramBotApi";
import { createTelegramBotApi, createTelegramPacer, type TelegramBotApi } from "./botApi";
import { createTelegramTransport, type TelegramTransport } from "./transport";

/**
 * The fake Bot API's own contract (it lives in tests/support, outside the
 * hermetic include globs, so its self-test sits beside the client it serves).
 */

const TEST_ENV = { AIQSA_TEST_MODE: "1", NODE_ENV: "test" };
const cell = (text: string) => ({ text, align: "left", valign: "top" });
const paragraph = (text: unknown) => ({ type: "paragraph", text });

describe("rich message validator", () => {
  it("accepts every block AIQSA renders", () => {
    const message = {
      skip_entity_detection: true,
      blocks: [
        { type: "heading", text: "Title", size: 2 },
        paragraph(["Plain ", { type: "bold", text: { type: "italic", text: "nested" } }, { type: "code", text: "x" },
          { type: "url", text: "link", url: "https://example.com/a" }, { type: "mathematical_expression", expression: "x^2" }]),
        { type: "list", items: [{ blocks: [paragraph("one")] }, { blocks: [paragraph("two")], value: 2, type: "1" }] },
        { type: "table", is_bordered: true, cells: [[{ ...cell("A"), is_header: true }, cell("B")], [{ ...cell("wide"), colspan: 2 }]] },
        { type: "pre", text: "const x = 1;", language: "ts" },
        { type: "mathematical_expression", expression: "\\int_0^1 x" },
        { type: "blockquote", blocks: [paragraph("quoted")] },
        { type: "divider" },
        { type: "footer", text: "Sources" }
      ]
    };
    expect(validateTelegramRichMessage(message)).toMatchObject({ ok: true, blocks: 16 });
  });

  it.each([
    [{ markdown: "**x**" }, "markdown_not_allowed"],
    [{ html: "<b>x</b>" }, "html_not_allowed"],
    [{ blocks: [paragraph("x")], media: [] }, "media_not_allowed"],
    [{ blocks: [] }, "invalid_blocks"],
    [{ blocks: [{ type: "details", summary: "x", blocks: [paragraph("y")] }] }, "unsupported_block:details"],
    [{ blocks: [{ type: "buttons", buttons: [] }] }, "unsupported_block:buttons"],
    [{ blocks: [{ type: "photo", photo: {} }] }, "unsupported_block:photo"],
    [{ blocks: [paragraph({ type: "button", text: "x" })] }, "unsupported_text:button"],
    [{ blocks: [paragraph({ type: "mention", text: "@x" })] }, "unsupported_text:mention"],
    [{ blocks: [paragraph({ type: "url", text: "x", url: "tg://user?id=1" })] }, "unsafe_url"],
    [{ blocks: [paragraph({ type: "url", text: "x", url: "javascript:alert(1)" })] }, "unsafe_url"],
    [{ blocks: [paragraph("x".repeat(32_769))] }, "too_long"],
    [{ blocks: Array.from({ length: 501 }, () => ({ type: "divider" })) }, "too_many_blocks"],
    [{ blocks: [{ type: "table", cells: [Array.from({ length: 21 }, () => cell("c"))] }] }, "too_many_columns"],
    [{ blocks: [{ type: "table", cells: [[{ ...cell("c"), colspan: 21 }]] }] }, "too_many_columns"],
    [{ blocks: [{ type: "table", cells: [[{ text: "c" }]] }] }, "invalid_alignment"],
    [{ blocks: [{ type: "paragraph", text: "x", style: "y" }] }, "unknown_block_field:style"]
  ])("refuses %j (%s)", (message, reason) => {
    expect(validateTelegramRichMessage(message)).toEqual({ ok: false, reason });
  });

  it("refuses nesting deeper than 16 levels of blocks and formatting", () => {
    let text: unknown = "deep";
    for (let level = 0; level < 15; level += 1) text = { type: "bold", text };
    expect(validateTelegramRichMessage({ blocks: [paragraph(text)] })).toMatchObject({ ok: true, depth: 16 });
    expect(validateTelegramRichMessage({ blocks: [paragraph({ type: "italic", text })] })).toEqual({ ok: false, reason: "too_deep" });
  });
});

describe("fixtures", () => {
  it("ships a structurally valid Ogg Opus voice note and a JPEG", () => {
    const voice = telegramVoiceFixture();
    let offset = 0;
    const pages: Buffer[] = [];
    while (offset < voice.length) {
      expect(voice.subarray(offset, offset + 4).toString("latin1")).toBe("OggS");
      const segments = voice[offset + 26]!;
      const length = 27 + segments + [...voice.subarray(offset + 27, offset + 27 + segments)].reduce((sum, value) => sum + value, 0);
      const page = Buffer.from(voice.subarray(offset, offset + length));
      const expected = page.readUInt32LE(22);
      page.writeUInt32LE(0, 22);
      expect(oggCrc(page)).toBe(expected);
      pages.push(page);
      offset += length;
    }
    expect(pages).toHaveLength(3);
    expect(pages[0]!.includes(Buffer.from("OpusHead"))).toBe(true);
    expect(pages[1]!.includes(Buffer.from("OpusTags"))).toBe(true);
    expect(telegramPhotoFixture().subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});

function oggCrc(data: Buffer): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}

type Mode = "fetch" | "loopback";
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function connect(mode: Mode): Promise<{ api: TelegramBotApi; fake: FakeTelegramBotApi; transport: TelegramTransport }> {
  const fake = createFakeTelegramBotApi();
  closers.push(() => fake.close());
  let transport = fake.transport;
  if (mode === "loopback") {
    const server = await fake.start();
    transport = createTelegramTransport({ origin: server.origin, env: TEST_ENV });
  }
  const api = createTelegramBotApi({ token: fake.token, transport, pacer: createTelegramPacer({ now: () => 0 }), sleep: async () => {} });
  return { api, fake, transport };
}

describe.each<Mode>(["fetch", "loopback"])("fake Bot API over %s", (mode) => {
  it("refuses what Telegram refuses and what AIQSA must never send", async () => {
    const { api, fake, transport } = await connect(mode);
    const user = fake.inject.addUser();
    await expect(api.sendMessage({ chat_id: user.id, text: "x".repeat(4_097) })).resolves.toMatchObject({ ok: false, errorCode: 400 });
    await expect(api.sendMessage({ chat_id: user.id, text: "x".repeat(4_096) })).resolves.toMatchObject({ ok: true });
    await expect(api.sendMessage({ chat_id: 999, text: "x" })).resolves.toMatchObject({ ok: false, description: "Bad Request: chat not found" });
    await expect(api.sendMessage({ chat_id: user.id, text: "x", reply_markup: { inline_keyboard: [[{ text: "b", callback_data: "x".repeat(65) }]] } }))
      .resolves.toMatchObject({ ok: false, description: "Bad Request: BUTTON_DATA_INVALID" });
    await expect(transport.call({ token: fake.token, method: "sendMessage", params: { chat_id: user.id, text: "*x*", parse_mode: "MarkdownV2" } }))
      .resolves.toMatchObject({ ok: false, errorCode: 400 });
    await expect(transport.call({ token: fake.token, method: "sendRichMessage", params: { chat_id: user.id, rich_message: { markdown: "# x" } } }))
      .resolves.toMatchObject({ ok: false, errorCode: 400, description: expect.stringContaining("markdown_not_allowed") });
    const group = fake.inject.addedToGroup(user);
    const groupId = (group.my_chat_member as { chat: { id: number } }).chat.id;
    await expect(api.sendMessageDraft({ chat_id: groupId, draft_id: 1 })).resolves.toMatchObject({ ok: false, errorCode: 400 });
    await expect(api.sendMessageDraft({ chat_id: user.id, draft_id: 0 })).resolves.toMatchObject({ ok: false, errorCode: 400 });
    await expect(createTelegramBotApi({ token: "100000001:WrongTokenWrongTokenWrongToken00", transport }).getMe())
      .resolves.toMatchObject({ ok: false, errorCode: 401 });
    expect(fake.calls("sendMessage").map((call) => call.status)).toEqual([400, 200, 400, 400, 400]);
  });

  it("long-polls with offsets, wakes on an injected update and ends a superseded poll with 409", async () => {
    const { api, fake } = await connect(mode);
    const user = fake.inject.addUser();
    const waiting = api.getUpdates({ timeoutSeconds: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const update = fake.inject.text(user, "hi");
    await expect(waiting).resolves.toMatchObject({ ok: true, result: [{ update_id: update.update_id, kind: "message" }] });
    await expect(api.getUpdates({ offset: update.update_id + 1, timeoutSeconds: 0 })).resolves.toEqual({ ok: true, result: [] });
    expect(fake.pendingUpdates()).toBe(0);

    const first = api.getUpdates({ offset: update.update_id + 1, timeoutSeconds: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = api.getUpdates({ offset: update.update_id + 1, timeoutSeconds: 1 });
    await expect(first).resolves.toMatchObject({ ok: false, kind: "telegram", errorCode: 409 });
    await expect(second).resolves.toEqual({ ok: true, result: [] });
  });

  it("injects 429, 409, 401, 400, slow answers and dropped connections", async () => {
    const { api, fake, transport } = await connect(mode);
    const user = fake.inject.addUser();
    const call = (method: string, params?: Record<string, unknown>) => transport.call({ token: fake.token, method, params });
    fake.failNext("sendMessage", { status: 429, retryAfter: 5 });
    await expect(call("sendMessage", { chat_id: user.id, text: "x" })).resolves.toMatchObject({ ok: false, kind: "telegram", errorCode: 429, retryAfter: 5 });
    fake.failNext("getUpdates", { status: 409 });
    await expect(call("getUpdates")).resolves.toMatchObject({ errorCode: 409 });
    fake.failNext("getMe", { status: 401 });
    await expect(api.getMe()).resolves.toMatchObject({ errorCode: 401 });
    fake.failNext("sendRichMessage", { status: 400, description: "Bad Request: can't parse rich message" });
    await expect(api.sendRichMessage({ chat_id: user.id, rich_message: { blocks: [{ type: "divider" }] } }))
      .resolves.toMatchObject({ ok: false, errorCode: 400, description: "Bad Request: can't parse rich message" });
    fake.failNext("sendMessage", { drop: true });
    await expect(call("sendMessage", { chat_id: user.id, text: "x" })).resolves.toMatchObject({ ok: false, kind: "network_after_send" });
    fake.failNext("getMe", { delayMs: 60 });
    const started = performance.now();
    await expect(api.getMe()).resolves.toMatchObject({ ok: true });
    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
    fake.failNext("file", { status: 404 });
    const voice = fake.inject.voice(user);
    const file = await api.getFile((voice.message as { voice: { file_id: string } }).voice.file_id);
    if (!file.ok || !file.result.file_path) throw new Error("getFile failed");
    await expect(api.downloadFile(file.result.file_path)).resolves.toMatchObject({ ok: false, errorCode: 404 });
    await expect(api.downloadFile(file.result.file_path)).resolves.toEqual({ ok: true, result: telegramVoiceFixture() });
  });

  it("stores uploaded files and serves them back by file path", async () => {
    const { api, fake } = await connect(mode);
    const user = fake.inject.addUser();
    const sent = await api.sendDocument({ chat_id: user.id, caption: "report", reply_markup: { inline_keyboard: [[{ text: "Open in AIQSA", url: "https://aiqsa.example/c/1" }]] } },
      { filename: "report.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-1.7 synthetic") });
    expect(sent).toMatchObject({ ok: true });
    const [message] = fake.botMessages(user.id);
    expect(message).toMatchObject({ kind: "document", caption: "report" });
    expect(fake.file(message!.file_id!)?.bytes.toString()).toBe("%PDF-1.7 synthetic");
    expect(fake.lastCall("sendDocument")).toMatchObject({ file: { field: "document", filename: "report.pdf", contentType: "application/pdf" } });
  });
});

it("uses a valid Bot API token shape", () => {
  expect(FAKE_TELEGRAM_TOKEN).toMatch(/^\d+:[A-Za-z0-9_-]{20,}$/u);
});

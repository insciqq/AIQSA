import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFakeTelegramBotApi, telegramVoiceFixture } from "@/tests/support/fakeTelegramBotApi";
import { captureRunObservation } from "@/tests/support/runObservation";
import { createTelegramBotApi, createTelegramPacer, decodeTelegramUpdate, TELEGRAM_CHAT_SEND_INTERVAL_MS } from "./botApi";
import { TELEGRAM_BOT_COMMANDS } from "./copy";
import type { TelegramTransport } from "./transport";

function virtualClock() {
  let time = 1_700_000_000_000;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => { sleeps.push(ms); time += ms; },
    sleeps
  };
}

function setup() {
  const fake = createFakeTelegramBotApi();
  const clock = virtualClock();
  const sentAt: Array<{ method: string; at: number }> = [];
  const timed: TelegramTransport = {
    ...fake.transport,
    call: (input) => { sentAt.push({ method: input.method, at: clock.now() }); return fake.transport.call(input); }
  };
  const api = createTelegramBotApi({ token: fake.token, transport: timed, pacer: createTelegramPacer({ now: clock.now }), sleep: clock.sleep });
  const user = fake.inject.addUser({ firstName: "Alex", username: "alex_user" });
  return { api, clock, fake, sentAt, user };
}

describe("Telegram pacing", () => {
  it("spaces one chat by 1.1 s and the bot by 40 ms (at most 25 sends in any second)", () => {
    const clock = virtualClock();
    const pacer = createTelegramPacer({ now: clock.now });
    expect([pacer.reserve(1), pacer.reserve(1), pacer.reserve(1)]).toEqual([0, 1_100, 2_200]);
    const burst = Array.from({ length: 60 }, (_, index) => pacer.reserve(100 + index));
    const times = [0, 1_100, 2_200, ...burst].sort((a, b) => a - b);
    for (const start of times) expect(times.filter((time) => time >= start && time < start + 1_000).length).toBeLessThanOrEqual(25);
    expect(new Set(times).size).toBe(times.length);
  });

  it("does not hold other chats behind one chat's interval", () => {
    const clock = virtualClock();
    const pacer = createTelegramPacer({ now: clock.now });
    pacer.reserve(1);
    expect(pacer.reserve(1)).toBe(TELEGRAM_CHAT_SEND_INTERVAL_MS);
    expect(pacer.reserve(2)).toBe(40);
  });

  it("holds a burst of messages to one chat to the interval through the client", async () => {
    const { api, sentAt, user } = setup();
    for (const text of ["one", "two", "three"]) await expect(api.sendMessage({ chat_id: user.id, text })).resolves.toMatchObject({ ok: true });
    const times = sentAt.filter((entry) => entry.method === "sendMessage").map((entry) => entry.at);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(TELEGRAM_CHAT_SEND_INTERVAL_MS);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(TELEGRAM_CHAT_SEND_INTERVAL_MS);
  });
});

describe("Telegram 429 handling", () => {
  it("waits retry_after once, logs a content-free telegram record and succeeds", async () => {
    const { api, clock, fake, user } = setup();
    const observation = await captureRunObservation();
    fake.failNext("sendMessage", { status: 429, retryAfter: 3 });
    const outcome = await api.sendMessage({ chat_id: user.id, text: "hello" });
    expect(outcome).toMatchObject({ ok: true, result: { message_id: expect.any(Number) } });
    expect(clock.sleeps).toContain(3_000);
    expect(fake.calls("sendMessage")).toHaveLength(2);
    const records = observation.records().filter((record) => record.subsystem === "telegram");
    expect(records).toEqual([expect.objectContaining({
      event: "service_operation", subsystem: "telegram", code: "telegram_rate_limited", outcome: "waiting", action: "wait", delay_ms: 3_000, httpStatus: 429
    })]);
    expect(JSON.stringify(observation.records())).not.toContain(fake.token.split(":")[1]);
  });

  it("caps the wait at 60 s and returns the second 429", async () => {
    const { api, clock, fake, user } = setup();
    fake.failNext("sendMessage", { status: 429, retryAfter: 600 }, 2);
    const outcome = await api.sendMessage({ chat_id: user.id, text: "hello" });
    expect(outcome).toMatchObject({ ok: false, kind: "telegram", errorCode: 429, retryAfter: 600 });
    expect(clock.sleeps.filter((ms) => ms >= 60_000)).toEqual([60_000]);
    expect(fake.calls("sendMessage")).toHaveLength(2);
    expect(JSON.stringify(outcome)).not.toContain(fake.token);
  });

  it("never sends a streamed upload twice", async () => {
    const { api, fake, user } = setup();
    fake.failNext("sendDocument", { status: 429, retryAfter: 1 });
    const outcome = await api.sendDocument({ chat_id: user.id }, {
      filename: "a.txt", contentType: "text/plain", stream: Readable.from([Buffer.from("abc")]), size: 3
    });
    expect(outcome).toMatchObject({ ok: false, errorCode: 429 });
    expect(fake.calls("sendDocument")).toHaveLength(1);
    const buffered = await api.sendDocument({ chat_id: user.id }, { filename: "a.txt", contentType: "text/plain", data: Buffer.from("abc") });
    expect(buffered).toMatchObject({ ok: true });
  });
});

describe("Telegram send authority", () => {
  /** A client whose waits end the chat's authority (an unlink, revoked sessions, the bot switched off meanwhile). */
  function guarded(endsOn: (ms: number) => boolean) {
    const fake = createFakeTelegramBotApi();
    const user = fake.inject.addUser({ firstName: "Alex" });
    const authority = { allowed: true, asked: 0 };
    const api = createTelegramBotApi({
      pacer: createTelegramPacer({ now: () => 0 }), token: fake.token, transport: fake.transport,
      sleep: async (ms) => { if (endsOn(ms)) authority.allowed = false; }
    });
    const options = { authorize: async () => { authority.asked += 1; return authority.allowed; } };
    return { api, authority, fake, options, user };
  }

  it("asks again after a 429's wait and dispatches nothing once the chat may no longer receive it", async () => {
    const { api, authority, fake, options, user } = guarded((ms) => ms === 60_000);
    fake.failNext("sendRichMessageDraft", { retryAfter: 60, status: 429 });
    const outcome = await api.sendRichMessageDraft({
      chat_id: user.id, draft_id: 7, rich_message: { blocks: [{ text: "PRIVATE", type: "paragraph" }] }
    }, options);
    expect(outcome).toEqual({ kind: "unreachable", ok: false });
    expect(authority.asked).toBe(2);
    expect(fake.calls("sendRichMessageDraft")).toHaveLength(1);
  });

  it("asks after the chat's pacing wait, before an upload leaves", async () => {
    const { api, authority, fake, options, user } = guarded((ms) => ms > 0);
    await expect(api.sendMessage({ chat_id: user.id, text: "earlier" }, options)).resolves.toMatchObject({ ok: true });
    const outcome = await api.sendDocument({ chat_id: user.id }, { contentType: "text/plain", data: Buffer.from("PRIVATE"), filename: "a.txt" }, options);
    expect(outcome).toEqual({ kind: "unreachable", ok: false });
    expect(authority.asked).toBe(2);
    expect(fake.calls("sendDocument")).toHaveLength(0);
  });
});

describe("Telegram Bot API client against the fake", () => {
  it("covers bot setup: getMe, webhook, commands", async () => {
    const { api, fake } = setup();
    await expect(api.getMe()).resolves.toMatchObject({ ok: true, result: { is_bot: true, username: "aiqsa_test_bot" } });
    fake.setWebhook("https://hook.example/secret-path");
    await expect(api.getWebhookInfo()).resolves.toEqual({ ok: true, result: { webhookSet: true, pendingUpdateCount: 0 } });
    await expect(api.getUpdates({ timeoutSeconds: 0 })).resolves.toMatchObject({ ok: false, kind: "telegram", errorCode: 409 });
    await expect(api.deleteWebhook()).resolves.toEqual({ ok: true, result: true });
    await expect(api.setMyCommands(TELEGRAM_BOT_COMMANDS)).resolves.toEqual({ ok: true, result: true });
    expect(fake.commands()).toEqual(TELEGRAM_BOT_COMMANDS);
  });

  it("decodes every injected update kind with offsets", async () => {
    const { api, fake, user } = setup();
    const first = fake.inject.text(user, "hello");
    fake.inject.command(user, "new");
    fake.inject.voice(user, { duration: 3 });
    fake.inject.photo(user, { caption: "what is this?" });
    fake.inject.document(user, { fileName: "notes.txt", mimeType: "text/plain", bytes: Buffer.from("notes") });
    fake.inject.album(user, 2, { caption: "album" });
    fake.inject.sticker(user);
    fake.inject.stopGeneration(user, 7);
    fake.inject.addedToGroup(user);
    fake.inject.editedMessage(user, 1, "edited");
    const sent = await api.sendMessage({ chat_id: user.id, text: "pick", reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "c:AAAAAAAAAAAAAAAAAAAAAA" }]] } });
    if (!sent.ok) throw new Error("send failed");
    fake.inject.callback(user, sent.result.message_id, "c:AAAAAAAAAAAAAAAAAAAAAA");
    fake.inject.text(user, "reply", { replyTo: sent.result.message_id });
    // Not among the requested update types: Telegram (and the fake) never delivers it.
    fake.inject.raw({ poll: { id: "1" } });

    const outcome = await api.getUpdates({ offset: first.update_id, timeoutSeconds: 0 });
    if (!outcome.ok) throw new Error("getUpdates failed");
    const kinds = outcome.result.map((update) => update.kind);
    expect(kinds).toEqual([
      "message", "message", "message", "message", "message", "message", "message", "message",
      "stopped_message_generation", "my_chat_member", "edited_message", "callback_query", "message"
    ]);
    const [text, command, voice, photo, document, albumFirst, albumSecond, sticker] = outcome.result;
    expect(text).toMatchObject({ message: { text: "hello", chat: { id: user.id, type: "private" }, from: { id: user.id }, has_other_content: false } });
    expect(command).toMatchObject({ message: { text: "/new" } });
    expect(voice).toMatchObject({ message: { voice: { duration: 3, mime_type: "audio/ogg" } } });
    expect(photo).toMatchObject({ message: { caption: "what is this?", photo: expect.any(Array) } });
    expect(document).toMatchObject({ message: { document: { file_name: "notes.txt" } } });
    const group = albumFirst!.kind === "message" ? albumFirst!.message.media_group_id : undefined;
    expect(group).toBeTruthy();
    expect(albumSecond).toMatchObject({ message: { media_group_id: group } });
    expect(sticker).toMatchObject({ message: { has_other_content: true } });
    expect(outcome.result[11]).toMatchObject({ callback_query: { data: "c:AAAAAAAAAAAAAAAAAAAAAA", message: { message_id: sent.result.message_id } } });
    expect(outcome.result[12]).toMatchObject({ message: { reply_to_message: { message_id: sent.result.message_id } } });

    const last = outcome.result.at(-1)!.update_id;
    await expect(api.getUpdates({ offset: last + 1, timeoutSeconds: 0 })).resolves.toEqual({ ok: true, result: [] });
  });

  it("refuses unsafe ids and oversized fields as invalid without losing the update id", () => {
    const chat = { id: 5, type: "private" };
    expect(decodeTelegramUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 2 ** 60, type: "private" }, date: 1 } }))
      .toEqual({ update_id: 1, kind: "invalid" });
    expect(decodeTelegramUpdate({ update_id: 2, message: { message_id: 1, chat, date: 1, text: "x".repeat(8_193) } }))
      .toEqual({ update_id: 2, kind: "invalid" });
    expect(decodeTelegramUpdate({ update_id: 3, callback_query: { id: "q", from: { id: 5, is_bot: false, first_name: "A" }, chat_instance: "i", data: "é".repeat(33) } }))
      .toEqual({ update_id: 3, kind: "invalid" });
    expect(decodeTelegramUpdate({ update_id: 4, stopped_message_generation: { chat, draft_id: 0 } })).toEqual({ update_id: 4, kind: "invalid" });
    expect(decodeTelegramUpdate({ update_id: -1, message: {} })).toBeUndefined();
    expect(decodeTelegramUpdate({ update_id: 6, poll: { id: "1" } })).toEqual({ update_id: 6, kind: "other" });
    expect(decodeTelegramUpdate({ update_id: 5, message: { message_id: 1, chat, date: 1, text: "ok", extra: { nested: true } } }))
      .toMatchObject({ kind: "message", message: { text: "ok" } });
  });

  it("sends, drafts, edits, answers and leaves", async () => {
    const { api, fake, user } = setup();
    const rich = { blocks: [{ type: "paragraph" as const, text: ["Hello ", { type: "bold" as const, text: "world" }] }], skip_entity_detection: true };
    await expect(api.sendMessageDraft({ chat_id: user.id, draft_id: 11, text: "" })).resolves.toEqual({ ok: true, result: true });
    await expect(api.sendRichMessageDraft({ chat_id: user.id, draft_id: 11, rich_message: rich, can_stop: true, keep_on_stop: false }))
      .resolves.toEqual({ ok: true, result: true });
    expect(fake.drafts(user.id)).toEqual([expect.objectContaining({ draft_id: 11, can_stop: true, keep_on_stop: false, updates: 2 })]);
    const sent = await api.sendRichMessage({ chat_id: user.id, rich_message: rich });
    if (!sent.ok) throw new Error("send failed");
    await expect(api.editMessageText({ chat_id: user.id, message_id: sent.result.message_id, rich_message: { blocks: [{ type: "divider" }] } }))
      .resolves.toMatchObject({ ok: true });
    await expect(api.editMessageText({ chat_id: user.id, message_id: sent.result.message_id, text: "Plain", link_preview_options: { is_disabled: true } }))
      .resolves.toMatchObject({ ok: true });
    await expect(api.editMessageText({ chat_id: user.id, message_id: sent.result.message_id, text: "Plain", link_preview_options: { is_disabled: true } }))
      .resolves.toMatchObject({ ok: false, kind: "telegram", errorCode: 400 });
    await expect(api.editMessageReplyMarkup({ chat_id: user.id, message_id: sent.result.message_id, reply_markup: { inline_keyboard: [[{ text: "Open in AIQSA", url: "https://aiqsa.example/c/1" }]] } }))
      .resolves.toMatchObject({ ok: true });
    await expect(api.sendChatAction({ chat_id: user.id, action: "typing" })).resolves.toEqual({ ok: true, result: true });
    const press = fake.inject.callback(user, sent.result.message_id, "c:BBBBBBBBBBBBBBBBBBBBBB");
    const queryId = (press.callback_query as { id: string }).id;
    await expect(api.answerCallbackQuery({ callback_query_id: queryId, text: "This button has expired" })).resolves.toEqual({ ok: true, result: true });
    await expect(api.answerCallbackQuery({ callback_query_id: queryId })).resolves.toMatchObject({ ok: false, errorCode: 400 });
    const group = fake.inject.addedToGroup(user);
    const groupId = (group.my_chat_member as { chat: { id: number } }).chat.id;
    await expect(api.leaveChat(groupId)).resolves.toEqual({ ok: true, result: true });
    expect(fake.leftChats()).toEqual([groupId]);
  });

  it("uploads files and downloads a voice message through getFile", async () => {
    const { api, fake, user } = setup();
    await expect(api.sendPhoto({ chat_id: user.id, caption: "chart" }, { filename: "chart.jpg", contentType: "image/jpeg", data: Buffer.from("jpeg") }))
      .resolves.toMatchObject({ ok: true });
    expect(fake.lastCall("sendPhoto")).toMatchObject({ params: { chat_id: user.id, caption: "chart" }, file: { field: "photo", size: 4 } });
    const update = fake.inject.voice(user);
    const fileId = (update.message as { voice: { file_id: string } }).voice.file_id;
    const file = await api.getFile(fileId);
    if (!file.ok || !file.result.file_path) throw new Error("getFile failed");
    await expect(api.downloadFile(file.result.file_path)).resolves.toEqual({ ok: true, result: telegramVoiceFixture() });
    await expect(api.downloadFile(file.result.file_path, { maxBytes: 10 })).resolves.toMatchObject({ ok: false, kind: "too_large" });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTelegramBotApi, validateTelegramRichMessage, type FakeTelegramBotApi } from "@/tests/support/fakeTelegramBotApi";
import { createTelegramBotApi, createTelegramPacer } from "../botApi";
import { renderTelegramAnswer } from "../render";
import { createTelegramDraftStreamer, TELEGRAM_DRAFT_REFRESH_MS, TELEGRAM_DRAFT_THROTTLE_MS } from "./drafts";

let fake: FakeTelegramBotApi;

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-10-19T08:00:00.000Z") });
  fake = createFakeTelegramBotApi();
});
afterEach(async () => {
  await fake.close();
  vi.useRealTimers();
});

function streamer() {
  const user = fake.inject.addUser();
  const api = createTelegramBotApi({ pacer: createTelegramPacer({ now: () => 0 }), sleep: async () => undefined, token: fake.token, transport: fake.transport });
  const sent: Array<Readonly<{ at: number; method: string; params: Readonly<Record<string, unknown>> }>> = [];
  const recording = {
    sendMessageDraft: async (params: Parameters<typeof api.sendMessageDraft>[0]) => {
      sent.push({ at: Date.now(), method: "sendMessageDraft", params });
      return api.sendMessageDraft(params);
    },
    sendRichMessageDraft: async (params: Parameters<typeof api.sendRichMessageDraft>[0]) => {
      sent.push({ at: Date.now(), method: "sendRichMessageDraft", params });
      return api.sendRichMessageDraft(params);
    }
  };
  const drafts = createTelegramDraftStreamer({ api: recording, chatId: user.id, draftId: 4242 });
  return { drafts, sent, start: Date.now(), user };
}

describe("Telegram run drafts", () => {
  it("shows Thinking… at once, then the answer at most every 1.1 s with Telegram's Stop, newest text winning", async () => {
    const { drafts, sent, start, user } = streamer();
    drafts.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([{
      at: start, method: "sendMessageDraft", params: { can_stop: true, chat_id: user.id, draft_id: 4242, keep_on_stop: false, text: "" }
    }]);
    drafts.update("Hel");
    await vi.advanceTimersByTimeAsync(500);
    drafts.update("Hello **wor");
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ at: start + TELEGRAM_DRAFT_THROTTLE_MS, method: "sendRichMessageDraft" });
    expect(sent[1]!.params).toEqual({
      can_stop: true, chat_id: user.id, draft_id: 4242, keep_on_stop: false,
      rich_message: renderTelegramAnswer("Hello **wor", { streaming: true }).messages[0]
    });
    expect(validateTelegramRichMessage(sent[1]!.params.rich_message)).toMatchObject({ ok: true });
    for (let index = 0; index < 20; index += 1) {
      drafts.update(`Hello world ${index}`);
      await vi.advanceTimersByTimeAsync(100);
    }
    const intervals = sent.slice(1).map((entry, index, list) => index === 0 ? TELEGRAM_DRAFT_THROTTLE_MS : entry.at - list[index - 1]!.at);
    for (const interval of intervals) expect(interval).toBeGreaterThanOrEqual(TELEGRAM_DRAFT_THROTTLE_MS);
    expect(new Set(sent.map((entry) => entry.params.draft_id))).toEqual(new Set([4242]));
    await drafts.stop();
  });

  it("sends an unchanged draft again within 20 s so it never expires, and stops cleanly", async () => {
    const { drafts, sent, start } = streamer();
    drafts.start();
    drafts.update("Working on it");
    await vi.advanceTimersByTimeAsync(TELEGRAM_DRAFT_THROTTLE_MS);
    expect(sent.map((entry) => entry.at - start)).toEqual([0, TELEGRAM_DRAFT_THROTTLE_MS]);
    await vi.advanceTimersByTimeAsync(TELEGRAM_DRAFT_REFRESH_MS);
    expect(sent.map((entry) => entry.at - start)).toEqual([0, TELEGRAM_DRAFT_THROTTLE_MS, TELEGRAM_DRAFT_THROTTLE_MS + TELEGRAM_DRAFT_REFRESH_MS]);
    expect(sent[2]!.params.rich_message).toEqual(sent[1]!.params.rich_message);
    await drafts.stop();
    await vi.advanceTimersByTimeAsync(5 * TELEGRAM_DRAFT_REFRESH_MS);
    expect(sent).toHaveLength(3);
  });

  it("goes back to Thinking… when the stream resets its text", async () => {
    const { drafts, sent } = streamer();
    drafts.start();
    drafts.update("First attempt");
    await vi.advanceTimersByTimeAsync(TELEGRAM_DRAFT_THROTTLE_MS);
    drafts.reset();
    await vi.advanceTimersByTimeAsync(TELEGRAM_DRAFT_THROTTLE_MS);
    expect(sent.map((entry) => entry.method)).toEqual(["sendMessageDraft", "sendRichMessageDraft", "sendMessageDraft"]);
    expect(sent[2]!.params.text).toBe("");
    await drafts.stop();
  });

  it("switches to plain-text drafts when Telegram refuses the rich form", async () => {
    const { drafts, sent } = streamer();
    fake.failNext("sendRichMessageDraft", { description: "Bad Request: RICH_MESSAGE_INVALID", status: 400 });
    drafts.start();
    drafts.update("Answer with [a link](https://example.com)");
    await vi.advanceTimersByTimeAsync(TELEGRAM_DRAFT_THROTTLE_MS);
    expect(sent.map((entry) => entry.method)).toEqual(["sendMessageDraft", "sendRichMessageDraft", "sendMessageDraft"]);
    expect(sent[2]!.params.text).toBe("Answer with a link (https://example.com)");
    drafts.update("Answer with more");
    await vi.advanceTimersByTimeAsync(TELEGRAM_DRAFT_THROTTLE_MS);
    expect(sent.at(-1)).toMatchObject({ method: "sendMessageDraft", params: { text: "Answer with more" } });
    await drafts.stop();
  });
});

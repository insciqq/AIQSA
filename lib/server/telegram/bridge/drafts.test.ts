import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTelegramBotApi, validateTelegramRichMessage, type FakeTelegramBotApi } from "@/tests/support/fakeTelegramBotApi";
import { createTelegramBotApi, createTelegramPacer } from "../botApi";
import { renderTelegramAnswer } from "../render";
import { createTelegramDraftStreamer, TELEGRAM_DRAFT_REFRESH_MS, TELEGRAM_DRAFT_THROTTLE_MS, type TelegramDraftApi } from "./drafts";

let fake: FakeTelegramBotApi;

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-10-19T08:00:00.000Z") });
  fake = createFakeTelegramBotApi();
});
afterEach(async () => {
  await fake.close();
  vi.useRealTimers();
});

function streamer(options: Readonly<{ sleep?: (ms: number) => Promise<void> }> = {}) {
  const user = fake.inject.addUser();
  const api = createTelegramBotApi({
    pacer: createTelegramPacer({ now: () => 0 }), sleep: options.sleep ?? (async () => undefined), token: fake.token, transport: fake.transport
  });
  const sent: Array<Readonly<{ at: number; method: string; params: Readonly<Record<string, unknown>> }>> = [];
  const recording: TelegramDraftApi = {
    sendMessageDraft: async (params, sendOptions) => {
      sent.push({ at: Date.now(), method: "sendMessageDraft", params });
      return api.sendMessageDraft(params, sendOptions);
    },
    sendRichMessageDraft: async (params, sendOptions) => {
      sent.push({ at: Date.now(), method: "sendRichMessageDraft", params });
      return api.sendRichMessageDraft(params, sendOptions);
    }
  };
  /**
   * Whether the run's chat may still receive its answer; every draft asks before it is prepared
   * and again right before it leaves the Bot API.
   */
  const reach = { allowed: true, asked: 0 };
  const drafts = createTelegramDraftStreamer({
    chatId: user.id, draftId: 4242,
    reach: async () => {
      reach.asked += 1;
      return reach.allowed ? recording : null;
    }
  });
  return { drafts, reach, sent, start: Date.now(), user };
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

  it("asks before every draft whether the chat may still receive the answer, and ends for good once it may not", async () => {
    const { drafts, reach, sent } = streamer();
    drafts.start();
    drafts.update("Before the unlink");
    await vi.advanceTimersByTimeAsync(TELEGRAM_DRAFT_THROTTLE_MS);
    expect(sent.map((entry) => entry.method)).toEqual(["sendMessageDraft", "sendRichMessageDraft"]);
    expect(reach.asked).toBe(4);

    // Asked after the pacing wait, not when the text arrived: the text that came meanwhile never goes out.
    drafts.update("PRIVATE_AFTER_UNLINK");
    reach.allowed = false;
    await vi.advanceTimersByTimeAsync(TELEGRAM_DRAFT_THROTTLE_MS);
    expect(reach.asked).toBe(5);
    // Ended: no timer asks or sends again, whatever text or time comes.
    reach.allowed = true;
    drafts.update("PRIVATE_AFTER_UNLINK and more");
    drafts.reset();
    await vi.advanceTimersByTimeAsync(5 * TELEGRAM_DRAFT_REFRESH_MS);
    expect(sent).toHaveLength(2);
    expect(reach.asked).toBe(5);
    expect(JSON.stringify(sent)).not.toContain("PRIVATE_AFTER_UNLINK");
    expect(vi.getTimerCount()).toBe(0);
    await drafts.stop();
  });

  it("asks again after a 429's wait, sends nothing once the chat may no longer receive the answer, and ends for good", async () => {
    const state: { reach?: { allowed: boolean } } = {};
    // The access ends while the Bot API waits out Telegram's 60 s retry_after (not its pacing).
    const { drafts, reach, user } = streamer({ sleep: async (ms) => { if (ms === 60_000 && state.reach) state.reach.allowed = false; } });
    state.reach = reach;
    drafts.start();
    await vi.advanceTimersByTimeAsync(0);
    fake.failNext("sendRichMessageDraft", { retryAfter: 60, status: 429 });
    drafts.update("PRIVATE_DURING_RETRY");
    await vi.advanceTimersByTimeAsync(TELEGRAM_DRAFT_THROTTLE_MS);
    expect(reach.allowed).toBe(false);
    expect(fake.calls("sendRichMessageDraft")).toHaveLength(1);
    reach.allowed = true;
    drafts.update("PRIVATE_AFTER_RETRY");
    await vi.advanceTimersByTimeAsync(5 * TELEGRAM_DRAFT_REFRESH_MS);
    expect(fake.calls("sendRichMessageDraft")).toHaveLength(1);
    expect(fake.calls("sendMessageDraft")).toHaveLength(1);
    expect(fake.calls("sendMessageDraft")[0]!.params).toMatchObject({ chat_id: user.id, text: "" });
    expect(vi.getTimerCount()).toBe(0);
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

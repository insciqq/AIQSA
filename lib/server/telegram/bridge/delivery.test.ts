import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeTelegramBotApi } from "@/tests/support/fakeTelegramBotApi";
import { captureRunObservation } from "@/tests/support/runObservation";
import { memoryRunLinkStore } from "@/tests/support/telegramChatBridge";
import { createTelegramBotApi, createTelegramPacer } from "../botApi";
import type { TelegramAccessDecision } from "../control/access";
import { TELEGRAM_BRIDGE_COPY, TELEGRAM_COPY } from "../copy";
import type { TelegramBotSession } from "../dispatcher";
import { createTelegramOutbound } from "../outbound";
import { renderTelegramAnswer } from "../render";
import type { TelegramLinkRecord } from "../store/links";
import type { TelegramTransport } from "../transport";
import { deliverTelegramRun } from "./delivery";
import type { TelegramRunAnswer } from "./gateway";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

const START = Date.parse("2026-10-19T08:00:00.000Z");
const SENTINEL = "PRIVATE_AFTER_REVOCATION";

/** The final message of run-1 against the fake Bot API; `afterRich` runs after every rich message Telegram took. */
async function setup(answer: TelegramRunAnswer, afterRich: (h: Readonly<{ revoke(): void; unlink(): void }>) => void) {
  const fake = createFakeTelegramBotApi();
  closers.push(() => fake.close());
  const user = fake.inject.addUser();
  const control = {
    revoke() { decision = { allowed: false, link, reasonCode: "telegram_access_off" }; },
    unlink() { decision = { allowed: false, link: null, reasonCode: "telegram_not_linked" }; }
  };
  const transport: TelegramTransport = {
    ...fake.transport,
    call: async (input) => {
      const outcome = await fake.transport.call(input);
      if (input.method === "sendRichMessage" && outcome.ok) afterRich(control);
      return outcome;
    }
  };
  const api = createTelegramBotApi({ pacer: createTelegramPacer({ now: () => 0 }), sleep: async () => {}, token: fake.token, transport });
  const outbound = createTelegramOutbound({
    api, botId: fake.bot.id, callbacks: { create: async ({ buttons }) => buttons.map(() => "c:x") },
    messageRefs: { record: async () => undefined }
  });
  const session: TelegramBotSession = { api, botId: fake.bot.id, botUsername: fake.bot.username, generation: 1, outbound };
  const link: TelegramLinkRecord = {
    botId: fake.bot.id, currentChatId: "chat-1", displayName: null, id: "link-1", lastSeenAt: new Date(START),
    linkedAt: new Date(START), pendingAssistantId: null, searchEnabled: false, selectedModelId: null, selectedProvider: null,
    telegramChatId: user.id, telegramUserId: user.id, telegramUsername: null, userId: "user-1", workspaceEnabled: false
  };
  let decision: TelegramAccessDecision = { allowed: true, control: {} as never, link };
  const runLinks = memoryRunLinkStore();
  await runLinks.store.create({ draftId: 7, linkId: "link-1", now: new Date(START), runId: "run-1", telegramChatId: user.id, userId: "user-1" });
  const deliver = () => deliverTelegramRun({
    access: { resolveTelegramAccess: vi.fn(async () => decision) }, gateway: { answer: async () => answer }, runLinks: runLinks.store,
    sessions: { current: async () => session }
  }, { linkId: "link-1", runId: "run-1", runLinked: true, telegramChatId: user.id, userId: "user-1" });
  return { deliver, fake, runLinks, user };
}

function answer(text: string, status: TelegramRunAnswer["status"] = "complete"): TelegramRunAnswer {
  return { artifactSummary: null, assistantMessageId: "message-1", chatId: "chat-1", errorMessage: null, status, text };
}

describe("Telegram final answer delivery", () => {
  it.each([
    ["Telegram access ends", "revoke", "telegram_access_off"],
    ["the user unlinks", "unlink", "telegram_not_linked"]
  ] as const)("sends no more of a long answer once %s after its first message, settling failed with that reason", async (
    _case, change, code
  ) => {
    const LONG = `${"x".repeat(40_000)}\n\n${SENTINEL}`;
    expect(renderTelegramAnswer(LONG).messages.length).toBeGreaterThanOrEqual(2);
    let sends = 0;
    const h = await setup(answer(LONG), (control) => { if ((sends += 1) === 1) control[change](); });
    const observation = await captureRunObservation();
    const result = await h.deliver();
    expect(h.fake.calls("sendRichMessage")).toHaveLength(1);
    expect(h.fake.calls("sendMessage")).toHaveLength(0);
    expect(JSON.stringify(h.fake.calls())).not.toContain(SENTINEL);
    expect(result).toMatchObject({ messageIds: [h.fake.botMessages(h.user.id)[0]!.message_id], state: "failed" });
    expect(h.runLinks.rows.get("run-1")).toMatchObject({ deliveredAt: null, deliveryState: "failed" });
    expect(observation.records()).toContainEqual(expect.objectContaining({
      code, outcome: "failed", run_id: "run-1", stage: "settle", subsystem: "telegram"
    }));
  });

  it("sends no ending after a stopped run's text once its link stops reaching the chat", async () => {
    const h = await setup(answer("What it wrote before Stop", "cancelled"), (control) => control.unlink());
    const result = await h.deliver();
    expect(h.fake.botMessages(h.user.id)).toHaveLength(1);
    expect(JSON.stringify(h.fake.calls("sendMessage"))).not.toContain(TELEGRAM_COPY.stopped);
    expect(result).toMatchObject({ state: "failed" });
    expect(h.runLinks.rows.get("run-1")?.deliveryState).toBe("failed");
  });

  it("leaves a turn that stopped for an approval to its card, and points an empty answer to AIQSA", async () => {
    const card = { approvalId: "approval-1", canDecide: true as const, serverName: "Records", source: "model" as const,
      state: "pending" as const, toolName: "delete_record" };
    const waiting = await setup({ ...answer(""), artifactSummary: { citations: [], mcpApprovals: [card], reasoningText: [], sources: [] } },
      () => undefined);
    expect(await waiting.deliver()).toMatchObject({ state: "delivered" });
    expect(waiting.fake.calls("sendMessage")).toHaveLength(0);
    expect(waiting.runLinks.rows.get("run-1")?.deliveryState).toBe("delivered");

    const empty = await setup(answer(""), () => undefined);
    await empty.deliver();
    expect(empty.fake.calls("sendMessage").map((call) => call.params.text)).toEqual([TELEGRAM_BRIDGE_COPY.answerInAiqsa]);

    // Decided before delivery: no card is offered any more, so the pointer stays.
    const decided = await setup({ ...answer(""), artifactSummary: { citations: [], mcpApprovals: [{ ...card, state: "allowed_once" as const }],
      reasoningText: [], sources: [] } }, () => undefined);
    await decided.deliver();
    expect(decided.fake.calls("sendMessage").map((call) => call.params.text)).toEqual([TELEGRAM_BRIDGE_COPY.answerInAiqsa]);
  });

  it("delivers every message while the link still reaches the chat", async () => {
    const h = await setup(answer("What it wrote before Stop", "cancelled"), () => undefined);
    const result = await h.deliver();
    expect(h.fake.botMessages(h.user.id).map((message) => message.kind)).toEqual(["rich", "text"]);
    expect(result).toMatchObject({ state: "delivered" });
    expect(h.runLinks.rows.get("run-1")?.deliveryState).toBe("delivered");
  });
});

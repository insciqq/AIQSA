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
import type { TelegramFailure, TelegramTransport } from "../transport";
import { deliverTelegramRun } from "./delivery";
import type { TelegramRunAnswer } from "./gateway";
import { createTelegramDeliveryRetries, TELEGRAM_DELIVERY_RETRY_MIN_MS, TELEGRAM_DELIVERY_RETRY_WINDOW_MS } from "./retries";

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
    telegramChatId: user.id, telegramUserId: user.id, telegramUsername: null, userId: "user-1"
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

const BEFORE_SEND: TelegramFailure = { category: "dns", kind: "network_before_send", ok: false };

/** run-1's final message while every answer send first meets `fail(n)` (n counts sends from 1), as a host losing Telegram would. */
async function unreachable(text: string, fail: (send: number) => TelegramFailure | null) {
  const fake = createFakeTelegramBotApi();
  closers.push(() => fake.close());
  const user = fake.inject.addUser();
  const net = { fail, sends: 0 };
  const transport: TelegramTransport = {
    ...fake.transport,
    call: async (input) => {
      if (input.method !== "sendRichMessage" && input.method !== "sendMessage") return fake.transport.call(input);
      net.sends += 1;
      return net.fail(net.sends) ?? fake.transport.call(input);
    }
  };
  const api = createTelegramBotApi({ pacer: createTelegramPacer({ now: () => 0 }), sleep: async () => {}, token: fake.token, transport });
  const outbound = createTelegramOutbound({
    api, botId: fake.bot.id, callbacks: { create: async ({ buttons }) => buttons.map(() => "c:x") }, messageRefs: { record: async () => undefined }
  });
  const session: TelegramBotSession = { api, botId: fake.bot.id, botUsername: fake.bot.username, generation: 1, outbound };
  const link: TelegramLinkRecord = {
    botId: fake.bot.id, currentChatId: "chat-1", displayName: null, id: "link-1", lastSeenAt: new Date(START),
    linkedAt: new Date(START), pendingAssistantId: null, searchEnabled: false, selectedModelId: null, selectedProvider: null,
    telegramChatId: user.id, telegramUserId: user.id, telegramUsername: null, userId: "user-1"
  };
  const gate: { decision: TelegramAccessDecision } = { decision: { allowed: true, control: {} as never, link } };
  const access = { revoke: () => { gate.decision = { allowed: false, link, reasonCode: "telegram_access_off" }; } };
  const runLinks = memoryRunLinkStore();
  await runLinks.store.create({ draftId: 7, linkId: "link-1", now: new Date(START), runId: "run-1", telegramChatId: user.id, userId: "user-1" });
  const retries = createTelegramDeliveryRetries();
  const clock = { now: START };
  const deliver = (settledAt?: Date | null) => deliverTelegramRun({
    access: { resolveTelegramAccess: async () => gate.decision }, gateway: { answer: async () => answer(text) }, now: () => clock.now, retries,
    runLinks: runLinks.store, sessions: { current: async () => session }
  }, { linkId: "link-1", runId: "run-1", runLinked: true, settledAt, telegramChatId: user.id, userId: "user-1" });
  return { access, clock, deliver, fake, net, retries, row: () => runLinks.rows.get("run-1"), user };
}

describe("an answer Telegram never received", () => {
  it("hands its link back pending when the send and its one repeat never left, logs why without content, then sends it once", async () => {
    const h = await unreachable("The answer while Telegram was away", () => BEFORE_SEND);
    const observation = await captureRunObservation();
    expect(await h.deliver()).toEqual({ state: "deferred" });
    expect(h.net.sends).toBe(2);
    expect(h.row()).toMatchObject({ deliveredAt: null, deliveryState: "pending" });
    expect(h.fake.botMessages(h.user.id)).toHaveLength(0);
    // The next try waits a minute: no sweep hammers a Telegram that is down.
    expect(h.retries.due("run-1", START + TELEGRAM_DELIVERY_RETRY_MIN_MS - 1)).toBe(false);
    expect(h.retries.due("run-1", START + TELEGRAM_DELIVERY_RETRY_MIN_MS)).toBe(true);
    const records = observation.records();
    expect(records).toContainEqual(expect.objectContaining({
      category: "dns", code: "telegram_network_before_send", event: "service_operation", stage: "dispatch", subsystem: "telegram"
    }));
    expect(records).toContainEqual(expect.objectContaining({
      code: "telegram_delivery_deferred", outcome: "waiting", run_id: "run-1", stage: "settle", subsystem: "telegram"
    }));
    expect(JSON.stringify(records)).not.toContain("while Telegram was away");

    // Telegram answers again: the next try claims the link anew and sends the answer once.
    h.net.fail = () => null;
    h.clock.now += TELEGRAM_DELIVERY_RETRY_MIN_MS;
    expect(await h.deliver()).toMatchObject({ state: "delivered" });
    expect(h.fake.botMessages(h.user.id)).toHaveLength(1);
    expect(h.row()).toMatchObject({ deliveredAt: expect.any(Date), deliveryState: "delivered" });
    expect(h.retries.due("run-1", h.clock.now)).toBe(true);
  });

  it("checks access again at the later try: access ended meanwhile keeps the answer in AIQSA", async () => {
    const h = await unreachable("Private answer", () => BEFORE_SEND);
    expect(await h.deliver()).toEqual({ state: "deferred" });
    h.net.fail = () => null;
    h.access.revoke();
    expect(await h.deliver()).toMatchObject({ state: "failed" });
    expect(h.row()?.deliveryState).toBe("failed");
    expect(JSON.stringify(h.fake.calls())).not.toContain("Private answer");
  });

  it.each([
    ["within the hour after its run settled: pending again", TELEGRAM_DELIVERY_RETRY_WINDOW_MS, "pending"],
    ["past the hour after its run settled: failed for good", TELEGRAM_DELIVERY_RETRY_WINDOW_MS + 1, "failed"]
  ] as const)("settles a failed try %s", async (_case, since, settled) => {
    const h = await unreachable("Late answer", () => BEFORE_SEND);
    const observation = await captureRunObservation();
    const result = await h.deliver(new Date(START - since));
    expect(result).toMatchObject({ state: settled === "pending" ? "deferred" : "failed" });
    expect(h.row()?.deliveryState).toBe(settled);
    expect(observation.records().some((record) => record.code === "telegram_delivery_expired" && record.run_id === "run-1"))
      .toBe(settled === "failed");
  });

  it.each([
    ["a timeout", { kind: "timeout", ok: false }, "unknown", 1],
    ["a connection lost after sending", { category: "reset", kind: "network_after_send", ok: false }, "unknown", 1],
    ["Telegram's refusal", { errorCode: 403, kind: "telegram", ok: false, status: 403 }, "failed", 1]
  ] as const)("never hands back an answer whose send met %s", async (_case, failure, settled, sends) => {
    const h = await unreachable("Maybe already there", () => failure);
    expect(await h.deliver()).toMatchObject({ state: settled });
    expect(h.net.sends).toBe(sends);
    expect(h.row()?.deliveryState).toBe(settled);
  });

  it("never hands back an answer of which a part already reached Telegram", async () => {
    const LONG = `${"x".repeat(40_000)}\n\nthe last part`;
    expect(renderTelegramAnswer(LONG).messages.length).toBeGreaterThanOrEqual(2);
    const h = await unreachable(LONG, (send) => send === 1 ? null : BEFORE_SEND);
    expect(await h.deliver()).toMatchObject({ state: "failed" });
    expect(h.fake.botMessages(h.user.id)).toHaveLength(1);
    expect(h.row()?.deliveryState).toBe("failed");
  });
});

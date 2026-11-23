import { afterEach, describe, expect, it, vi } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import { createBridgeHarness, createFakeGateway, type BridgeHarness } from "@/tests/support/telegramChatBridge";
import { createTelegramBotApi, createTelegramPacer } from "../botApi";
import type { TelegramBotSession } from "../dispatcher";
import { createTelegramOutbound } from "../outbound";
import { renderTelegramAnswer } from "../render";
import type { TelegramFailure, TelegramTransport } from "../transport";
import type { TelegramRunEvent, TelegramRunEventContext } from "./events";
import { TELEGRAM_RECOVERY_FOLLOW_MS, TELEGRAM_RECOVERY_GRACE_MS, TELEGRAM_RECOVERY_MAX_AGE_MS } from "./recovery";
import { TELEGRAM_DELIVERY_RETRY_MIN_MS, TELEGRAM_DELIVERY_RETRY_WINDOW_MS } from "./retries";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

/** The state a process leaves when it dies after admitting a run, before delivering it. */
async function interruptedRun(options: Parameters<typeof createBridgeHarness>[0] = {}) {
  const gateway = createFakeGateway({ autoAnswer: null });
  const h = createBridgeHarness({ ...options, gateway });
  closers.push(h.close);
  const user = h.fake.inject.addUser();
  const link = h.link(user);
  const admission = await h.bridge.sendTelegramMessage({
    chatTarget: { assistantId: null, kind: "new" }, contentBlocks: [{ text: "a long question", type: "text" }], link, updateId: 501
  });
  expect(admission.kind).toBe("admitted");
  const run = gateway.runs[0]!;
  expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("pending");
  return { gateway, h, link, run, user };
}

const after = () => new Date(Date.now() + 1_000);

describe("Telegram delivery recovery after a restart", () => {
  it("delivers a run that settled while the process was down exactly once, however often recovery runs", async () => {
    const events: TelegramRunEvent[] = [];
    const { h, run, user } = await interruptedRun({ bridge: { publish: async (event) => { events.push(event); } } });
    run.token("The recovered answer");
    run.complete();
    const startedAt = after();
    await Promise.all([h.bridge.recover(startedAt), h.bridge.recover(startedAt)]);
    await h.bridge.recover(startedAt);
    expect(h.fake.botMessages(user.id)).toHaveLength(1);
    expect(h.fake.botMessages(user.id)[0]).toMatchObject({ rich_message: renderTelegramAnswer("The recovered answer").messages[0] });
    expect(h.fake.botMessages(user.id)[0]!.reply_markup).toBeUndefined();
    expect(h.runLinks.rows.get(run.id)).toMatchObject({ deliveredAt: expect.any(Date), deliveryState: "delivered" });
    expect(events).toEqual([{ messageIds: [h.fake.botMessages(user.id)[0]!.message_id], sent: true, status: "complete", type: "delivered" }]);
  });

  it("follows a run still going after the restart until it settles, then delivers it", async () => {
    const { h, run, user } = await interruptedRun();
    const recovering = h.bridge.recover(after());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.fake.botMessages(user.id)).toHaveLength(0);
    run.token("Finished after the restart");
    run.complete();
    await recovering;
    expect(h.fake.botMessages(user.id).map((message) => message.kind)).toEqual(["rich"]);
  });

  it("never resends a delivery whose claim a restart interrupted, and sends nothing for a run that failed access", async () => {
    const { h, link, run, user } = await interruptedRun();
    // The previous process claimed this delivery and died before settling it: Telegram may have it.
    await h.runLinks.store.claimDelivery(run.id);
    run.token("Maybe already sent");
    run.complete();
    await h.bridge.recover(after());
    expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("unknown");
    expect(h.fake.botMessages(user.id)).toHaveLength(0);

    // Access was revoked meanwhile: nothing of the chat goes out, the user learns why.
    await h.runLinks.store.create({ draftId: 7, linkId: link.id, now: new Date(), runId: "run-other", telegramChatId: user.id, userId: link.userId });
    h.aiqsa.runs.push({ ...run, id: "run-other", status: "complete", text: "Private answer" });
    h.setUser({ activeGroupIds: [], scimDeactivatedAt: null, status: "disabled" });
    await h.bridge.recover(after());
    expect(h.runLinks.rows.get("run-other")?.deliveryState).toBe("failed");
    expect(h.fake.botMessages(user.id).map((message) => message.text)).toEqual(["Telegram access is off for your account. Ask your AIQSA administrator."]);
  });

  it("leaves deliveries for the next start while the bot is off, and drops answers too old to send", async () => {
    const { h, run, user } = await interruptedRun();
    run.token("Late answer");
    run.complete();
    h.setSessionOn(false);
    await h.bridge.recover(after());
    expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("pending");
    h.setSessionOn(true);
    const row = h.runLinks.rows.get(run.id)!;
    h.runLinks.rows.set(run.id, { ...row, createdAt: new Date(Date.now() - TELEGRAM_RECOVERY_MAX_AGE_MS - 1_000) });
    await h.bridge.recover(after());
    expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("failed");
    expect(h.fake.botMessages(user.id)).toHaveLength(0);
  });

  it("delivers a run still going long after the restart through a later minute sweep, once it settles", async () => {
    const clock = { now: Date.now() };
    const { h, run, user } = await interruptedRun({ bridge: {
      now: () => clock.now, recoverySweepMs: 5,
      sleep: async (ms) => {
        clock.now += ms;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } });
    const startedAt = clock.now + 1;
    const stop = h.bridge.startRecovery(new Date(startedAt));
    closers.push(async () => stop());
    // The restart's sweep and the ones after it each follow the run a minute and leave it pending.
    await vi.waitFor(() => expect(clock.now - startedAt).toBeGreaterThan(3 * TELEGRAM_RECOVERY_FOLLOW_MS));
    expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("pending");
    expect(h.fake.botMessages(user.id)).toHaveLength(0);
    // 45 minutes in, past what one restart's recovery followed before, the run settles.
    clock.now = Math.max(clock.now, startedAt + 45 * 60_000);
    run.token("Finished after 45 minutes");
    run.complete();
    await vi.waitFor(() => expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("delivered"));
    expect(h.fake.botMessages(user.id)).toHaveLength(1);
    expect(h.fake.botMessages(user.id)[0]).toMatchObject({ rich_message: renderTelegramAnswer("Finished after 45 minutes").messages[0] });
  });
});

describe("Telegram delivery sweeps while this process runs", () => {
  /** A run of this process, started after `startedAt`, on a clock the test moves. */
  async function liveRun() {
    const clock = { now: Date.now() };
    const sources: Array<TelegramRunEventContext["source"]> = [];
    const gateway = createFakeGateway({ autoAnswer: null });
    const h = createBridgeHarness({
      bridge: { now: () => clock.now, publish: async (event, context) => { if (event.type === "delivered") sources.push(context.source); } },
      gateway
    });
    closers.push(h.close);
    const user = h.fake.inject.addUser();
    h.link(user);
    const startedAt = new Date(clock.now - 1);
    await h.deliver(h.fake.inject.text(user, "a long question"));
    h.bridge.conversation.flush();
    await vi.waitFor(() => expect(gateway.runs).toHaveLength(1));
    const run = gateway.runs[0]!;
    await vi.waitFor(() => expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("pending"));
    return { clock, h, run, sources, startedAt, user };
  }

  it("never delivers a run this process still follows: its observer delivers it, once", async () => {
    const { clock, h, run, sources, startedAt, user } = await liveRun();
    // Old enough for a sweep and already settled in AIQSA, while the live stream has not ended yet.
    clock.now += 2 * TELEGRAM_RECOVERY_GRACE_MS;
    run.token("The live answer");
    run.status = "complete";
    await h.bridge.recover(startedAt);
    expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("pending");
    expect(h.fake.botMessages(user.id)).toHaveLength(0);
    run.complete();
    await h.settle();
    expect(sources).toEqual(["live"]);
    expect(h.fake.botMessages(user.id)).toHaveLength(1);
  });

  it("delivers a run its observer had to leave while the bot was off once the bot is back, after the run's grace", async () => {
    const { clock, h, run, sources, startedAt, user } = await liveRun();
    h.setSessionOn(false);
    run.token("Answered while the bot was off");
    run.complete();
    await h.settle();
    expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("pending");
    expect(h.fake.botMessages(user.id)).toHaveLength(0);

    // The bot is switched on again: the sweep that follows leaves a run linked just now to its observer's hand-over.
    h.setSessionOn(true);
    await h.bridge.recover(startedAt);
    expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("pending");
    clock.now += TELEGRAM_RECOVERY_GRACE_MS;
    await h.bridge.recover(startedAt);
    expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("delivered");
    expect(sources).toEqual(["recovery"]);
    expect(h.fake.botMessages(user.id)).toHaveLength(1);
    expect(h.fake.botMessages(user.id)[0]).toMatchObject({ rich_message: renderTelegramAnswer("Answered while the bot was off").messages[0] });
  });
});

describe("Telegram delivery sweeps while Telegram is unreachable", () => {
  const BEFORE_SEND: TelegramFailure = { category: "connect", kind: "network_before_send", ok: false };

  /**
   * A bridge on a clock the test moves whose bot session meets `net.fail` on every answer send before it leaves, as a
   * host that lost Telegram does; the harness's own session stays as the poller's.
   */
  function unreachableBridge() {
    const clock = { now: Date.now() };
    const net: { fail: TelegramFailure | null; sends: number } = { fail: BEFORE_SEND, sends: 0 };
    const events: Array<Readonly<{ event: TelegramRunEvent; source: TelegramRunEventContext["source"] }>> = [];
    const gateway = createFakeGateway({ autoAnswer: null });
    let session: TelegramBotSession | null = null;
    const h: BridgeHarness = createBridgeHarness({
      bridge: {
        now: () => clock.now,
        publish: async (event, context) => { if (event.type === "delivered") events.push({ event, source: context.source }); },
        sessions: { current: async () => session }
      },
      gateway
    });
    closers.push(h.close);
    const transport: TelegramTransport = {
      ...h.fake.transport,
      call: async (input) => {
        if (input.method === "sendRichMessage" || input.method === "sendMessage") {
          net.sends += 1;
          if (net.fail) return net.fail;
        }
        return h.fake.transport.call(input);
      }
    };
    const api = createTelegramBotApi({ pacer: createTelegramPacer({ now: () => 0 }), sleep: async () => undefined, token: h.fake.token, transport });
    session = {
      ...h.session, api,
      outbound: createTelegramOutbound({
        api, botId: h.fake.bot.id, callbacks: { create: async ({ buttons }) => buttons.map(() => "c:x") }, messageRefs: h.messageRefs.store
      })
    };
    const user = h.fake.inject.addUser();
    const link = h.link(user);
    return { clock, events, gateway, h, link, net, user };
  }

  /** A run admitted before the process `startedAt` (a restart), settled with `text` and left for the sweeps. */
  async function settledBeforeStart(text: string) {
    const bridge = unreachableBridge();
    const { clock, gateway, h, link } = bridge;
    const admission = await h.bridge.sendTelegramMessage({
      chatTarget: { assistantId: null, kind: "new" }, contentBlocks: [{ text: "a question", type: "text" }], link, updateId: 601
    });
    expect(admission.kind).toBe("admitted");
    const run = gateway.runs[0]!;
    run.token(text);
    run.complete();
    return { ...bridge, run, startedAt: new Date(clock.now + 1) };
  }

  it("leaves an answer Telegram never took pending, backs off, and sends it exactly once at the first sweep after Telegram answers", async () => {
    const { clock, events, h, net, run, startedAt, user } = await settledBeforeStart("Answered while Telegram was away");
    await h.bridge.recover(startedAt);
    // The send and its one repeat never left: the link stays deliverable.
    expect(net.sends).toBe(2);
    expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("pending");
    // A sweep inside the wait tries nothing; the next one after it tries once more and backs off further.
    await h.bridge.recover(startedAt);
    expect(net.sends).toBe(2);
    clock.now += TELEGRAM_DELIVERY_RETRY_MIN_MS;
    await h.bridge.recover(startedAt);
    expect(net.sends).toBe(4);
    expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("pending");

    // Telegram answers again; the wait of two minutes is still running at the next minute's sweep.
    net.fail = null;
    clock.now += TELEGRAM_DELIVERY_RETRY_MIN_MS;
    await h.bridge.recover(startedAt);
    expect(net.sends).toBe(4);
    clock.now += TELEGRAM_DELIVERY_RETRY_MIN_MS;
    await h.bridge.recover(startedAt);
    expect(h.runLinks.rows.get(run.id)).toMatchObject({ deliveredAt: expect.any(Date), deliveryState: "delivered" });
    expect(h.fake.botMessages(user.id)).toHaveLength(1);
    expect(h.fake.botMessages(user.id)[0]).toMatchObject({ rich_message: renderTelegramAnswer("Answered while Telegram was away").messages[0] });

    clock.now += 10 * TELEGRAM_DELIVERY_RETRY_MIN_MS;
    await Promise.all([h.bridge.recover(startedAt), h.bridge.recover(startedAt)]);
    expect(h.fake.botMessages(user.id)).toHaveLength(1);
    expect(net.sends).toBe(5);
    expect(events).toEqual([{ event: expect.objectContaining({ sent: true, type: "delivered" }), source: "recovery" }]);
  });

  it("gives an answer up as failed, with its code, when Telegram still cannot take it over an hour after its run settled", async () => {
    const { clock, events, h, net, run, startedAt, user } = await settledBeforeStart("Answered long ago");
    const row = h.runLinks.rows.get(run.id)!;
    h.runLinks.rows.set(run.id, { ...row, runSettledAt: new Date(clock.now - TELEGRAM_DELIVERY_RETRY_WINDOW_MS - 60_000) });
    const observation = await captureRunObservation();
    await h.bridge.recover(startedAt);
    expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("failed");
    expect(observation.records()).toContainEqual(expect.objectContaining({
      code: "telegram_delivery_expired", outcome: "failed", run_id: run.id, subsystem: "telegram"
    }));
    expect(events).toEqual([{ event: expect.objectContaining({ sent: false, type: "delivered" }), source: "recovery" }]);

    net.fail = null;
    clock.now += 10 * TELEGRAM_DELIVERY_RETRY_MIN_MS;
    await h.bridge.recover(startedAt);
    expect(h.fake.botMessages(user.id)).toHaveLength(0);
    expect(net.sends).toBe(2);
  });

  it("never resends an answer whose send may have reached Telegram", async () => {
    const { clock, h, net, run, startedAt, user } = await settledBeforeStart("Maybe already there");
    net.fail = { category: "reset", kind: "network_after_send", ok: false };
    await h.bridge.recover(startedAt);
    expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("unknown");
    net.fail = null;
    for (let sweep = 0; sweep < 3; sweep += 1) {
      clock.now += 10 * TELEGRAM_DELIVERY_RETRY_MIN_MS;
      await h.bridge.recover(startedAt);
    }
    expect(net.sends).toBe(1);
    expect(h.fake.botMessages(user.id)).toHaveLength(0);
  });

  it("hands a live answer Telegram never took to the sweeps, which deliver it once Telegram answers again", async () => {
    const { clock, events, gateway, h, net, user } = unreachableBridge();
    const startedAt = new Date(clock.now - 1);
    await h.deliver(h.fake.inject.text(user, "a question"));
    h.bridge.conversation.flush();
    await vi.waitFor(() => expect(gateway.runs).toHaveLength(1));
    const run = gateway.runs[0]!;
    await vi.waitFor(() => expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("pending"));
    run.token("The live answer");
    run.complete();
    await h.settle();
    expect(net.sends).toBe(2);
    expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("pending");
    // Nothing is published for an answer still on its way: its files and cards follow it.
    expect(events).toEqual([]);

    net.fail = null;
    clock.now += Math.max(TELEGRAM_RECOVERY_GRACE_MS, TELEGRAM_DELIVERY_RETRY_MIN_MS);
    await h.bridge.recover(startedAt);
    expect(h.runLinks.rows.get(run.id)?.deliveryState).toBe("delivered");
    expect(h.fake.botMessages(user.id)).toHaveLength(1);
    expect(events).toEqual([{ event: expect.objectContaining({ sent: true, type: "delivered" }), source: "recovery" }]);
  });
});

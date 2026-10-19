import { afterEach, describe, expect, it } from "vitest";
import { TELEGRAM_COPY } from "../copy";
import { renderTelegramAnswer } from "../render";
import { createBridgeHarness, createFakeGateway } from "@/tests/support/telegramChatBridge";
import type { TelegramRunEvent } from "./events";
import { TELEGRAM_RECOVERY_MAX_AGE_MS } from "./recovery";

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
    expect(h.fake.botMessages(user.id)[0]).toMatchObject({
      reply_markup: { inline_keyboard: [[{ text: TELEGRAM_COPY.openInAiqsa, url: `https://aiqsa.example/c/${run.chatId}` }]] },
      rich_message: renderTelegramAnswer("The recovered answer").messages[0]
    });
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
});

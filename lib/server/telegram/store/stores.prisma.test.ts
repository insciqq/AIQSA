// @vitest-environment node
import { randomInt, randomUUID } from "node:crypto";
import type { TelegramBotControl } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { hashToken } from "../../auth/token";
import { prisma } from "../../prisma";
import { TELEGRAM_CONTROL_ID } from "../control/repository";
import { createPrismaTelegramCallbackStore } from "./callbacks";
import { createPrismaTelegramLinkStore } from "./links";
import { createPrismaTelegramMessageRefStore } from "./messageRefs";
import { createPrismaTelegramReceiptStore } from "./receipts";
import { deleteExpiredTelegramRecords } from "./retention";
import { createPrismaTelegramRunLinkStore } from "./runLinks";

/**
 * Telegram stores on a disposable database. Rows belong to this file's random
 * bot id and its own accounts; the control singleton is restored after each test.
 */

const NOW = new Date("2026-10-19T08:00:00.000Z");
const DAY = 24 * 3_600_000;
const users: string[] = [];
let saved: TelegramBotControl | null = null;
let botId = 0;

beforeEach(async () => {
  saved = await prisma.telegramBotControl.findUniqueOrThrow({ where: { id: TELEGRAM_CONTROL_ID } });
  botId = 7_000_000_000 + randomInt(1_000_000_000);
  await prisma.telegramBotControl.update({
    data: { botId: BigInt(botId), botUsername: "aiqsa_test_bot", tokenEnvelope: "sealed-test", tokenGeneration: Math.max(1, saved.tokenGeneration), updateOffset: null },
    where: { id: TELEGRAM_CONTROL_ID }
  });
});

afterEach(async () => {
  if (saved) {
    const { createdAt: _createdAt, id: _id, updatedAt: _updatedAt, ...row } = saved;
    await prisma.telegramBotControl.update({ data: row, where: { id: TELEGRAM_CONTROL_ID } });
  }
  await prisma.telegramUpdateReceipt.deleteMany({ where: { botId: { in: [BigInt(botId), BigInt(botId + 1)] } } });
  const ids = users.splice(0);
  await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

async function linkedAccount() {
  const user = await prisma.user.create({ data: { displayName: "Telegram store", email: `telegram-store-${randomUUID()}@example.test`, status: "active" } });
  users.push(user.id);
  const telegramUserId = 500_000_000 + randomInt(1_000_000_000);
  const link = await prisma.telegramLink.create({
    data: { botId: BigInt(botId), telegramChatId: BigInt(telegramUserId), telegramUserId: BigInt(telegramUserId), userId: user.id }
  });
  const chat = await prisma.chat.create({ data: { title: "Synthetic chat", userId: user.id } });
  const message = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("synthetic"), role: "user" } });
  return { chat, link, message, telegramUserId, userId: user.id };
}

describe("Telegram update receipts (stateful)", () => {
  it("claims each update once across two pollers and moves the offset forward only for the current bot", async () => {
    const first = createPrismaTelegramReceiptStore(prisma);
    const second = createPrismaTelegramReceiptStore(prisma);
    const batch = [10, 11, 12].map((updateId) => ({ kind: "message" as const, updateId }));
    const [a, b] = await Promise.all([
      first.claimBatch({ botId, nextOffset: 13, updates: batch }),
      second.claimBatch({ botId, nextOffset: 13, updates: batch })
    ]);
    expect([...a, ...b].sort()).toEqual([10, 11, 12]);
    await expect(first.readOffset(botId)).resolves.toBe(13);
    await first.claimBatch({ botId, nextOffset: 11, updates: [] });
    await expect(first.readOffset(botId)).resolves.toBe(13);
    await expect(first.claimBatch({ botId: botId + 1, nextOffset: 99, updates: [{ kind: "other", updateId: 98 }] }))
      .resolves.toEqual(new Set([98]));
    await expect(first.readOffset(botId)).resolves.toBe(13);
    await expect(first.readOffset(botId + 1)).resolves.toBeNull();
  });

  it("claims an injected update without moving the offset and finishes only a claimed receipt", async () => {
    const receipts = createPrismaTelegramReceiptStore(prisma);
    await expect(receipts.claim({ botId, update: { kind: "callback_query", updateId: 500 } })).resolves.toBe(true);
    await expect(receipts.claim({ botId, update: { kind: "callback_query", updateId: 500 } })).resolves.toBe(false);
    await expect(receipts.readOffset(botId)).resolves.toBeNull();
    await receipts.finish({ botId, state: "done", updateId: 500 });
    await receipts.finish({ botId, state: "failed", updateId: 500 });
    await expect(prisma.telegramUpdateReceipt.findUniqueOrThrow({ where: { botId_updateId: { botId: BigInt(botId), updateId: 500n } } }))
      .resolves.toMatchObject({ kind: "callback_query", state: "done" });
    await expect(prisma.telegramUpdateReceipt.create({ data: { botId: BigInt(botId), kind: "photo", updateId: 501n } })).rejects.toThrow();
  });
});

describe("Telegram buttons, references, run links and links (stateful)", () => {
  it("resolves a button only for its own account and consumes it once under concurrency", async () => {
    const account = await linkedAccount();
    const callbacks = createPrismaTelegramCallbackStore(prisma);
    const [data] = await callbacks.create({ buttons: [{ kind: "approval_allow_once", payload: { approvalId: "approval-1" } }], linkId: account.link.id, now: NOW });
    const press = { botId, data, now: NOW, telegramChatId: account.telegramUserId, telegramUserId: account.telegramUserId };
    const resolved = await callbacks.resolve(press);
    expect(resolved).toMatchObject({ callback: { kind: "approval_allow_once", payload: { approvalId: "approval-1" }, userId: account.userId }, ok: true });
    await expect(callbacks.resolve({ ...press, telegramUserId: account.telegramUserId + 1 })).resolves.toEqual({ ok: false, reason: "foreign" });
    const id = data!.slice(2);
    const consumed = await Promise.all([callbacks.consume({ id, now: NOW }), callbacks.consume({ id, now: NOW })]);
    expect(consumed.sort()).toEqual([false, true]);
    await expect(callbacks.resolve(press)).resolves.toEqual({ ok: false, reason: "consumed" });
    await expect(callbacks.resolve({ ...press, now: new Date(NOW.getTime() + 2 * DAY) })).resolves.toEqual({ ok: false, reason: "expired" });
  });

  it("finds a reply's chat by its bot message and forgets it with the chat or the link", async () => {
    const account = await linkedAccount();
    const refs = createPrismaTelegramMessageRefStore(prisma);
    const owner = { chatId: account.chat.id, linkId: account.link.id, messageId: account.message.id, userId: account.userId };
    const ref = { ...owner, botId, telegramChatId: account.telegramUserId, telegramMessageId: 21 };
    await refs.record([ref, ref], NOW);
    await expect(refs.find({ botId, telegramChatId: account.telegramUserId, telegramMessageId: 21 }))
      .resolves.toEqual({ chatId: account.chat.id, linkId: account.link.id, messageId: account.message.id, userId: account.userId });
    await expect(refs.find({ botId, telegramChatId: account.telegramUserId, telegramMessageId: 22 })).resolves.toBeNull();
    const other = await prisma.chat.create({ data: { title: "Other", userId: account.userId } });
    await refs.record([{ ...ref, chatId: other.id, messageId: null, telegramMessageId: 23 }], NOW);
    await prisma.chat.delete({ where: { id: other.id } });
    await expect(refs.find({ botId, telegramChatId: account.telegramUserId, telegramMessageId: 23 })).resolves.toBeNull();
    // A reference names its owner's own chat only.
    const stranger = await linkedAccount();
    await expect(refs.record([{ ...ref, chatId: stranger.chat.id, telegramMessageId: 24 }], NOW)).rejects.toThrow();
    await prisma.telegramLink.delete({ where: { id: account.link.id } });
    await expect(refs.find({ botId, telegramChatId: account.telegramUserId, telegramMessageId: 21 })).resolves.toBeNull();
  });

  it("claims a run's delivery once and settles it, keeping the runs when the link goes", async () => {
    const account = await linkedAccount();
    const run = await prisma.modelRun.create({ data: {
      chatId: account.chat.id, modelId: "fixture", normalizedRequest: {}, provider: "fake", status: "streaming", userId: account.userId,
      userMessageId: account.message.id
    } });
    const runLinks = createPrismaTelegramRunLinkStore(prisma);
    const input = { draftId: 5, linkId: account.link.id, now: NOW, runId: run.id, telegramChatId: account.telegramUserId, userId: account.userId };
    await expect(runLinks.create(input)).resolves.toBe(true);
    await expect(runLinks.create(input)).resolves.toBe(false);
    await runLinks.setStatusMessage({ runId: run.id, statusMessageId: 44 });
    await expect(runLinks.listByState({ limit: 10, state: "pending" })).resolves.toContainEqual(expect.objectContaining({ runId: run.id, statusMessageId: 44 }));
    const claims = await Promise.all([runLinks.claimDelivery(run.id), runLinks.claimDelivery(run.id)]);
    expect(claims.sort()).toEqual([false, true]);
    await runLinks.settle({ at: NOW, runId: run.id, state: "delivered" });
    await expect(runLinks.find(run.id)).resolves.toMatchObject({ deliveredAt: NOW, deliveryState: "delivered" });
    await expect(prisma.telegramRunLink.update({ data: { deliveredAt: null }, where: { runId: run.id } })).rejects.toThrow();
    await prisma.telegramLink.delete({ where: { id: account.link.id } });
    await expect(runLinks.find(run.id)).resolves.toBeNull();
    await expect(prisma.modelRun.count({ where: { id: run.id } })).resolves.toBe(1);
  });

  it("finds links by Telegram account and chat, touches them at most once a minute and changes only their run settings", async () => {
    const account = await linkedAccount();
    const links = createPrismaTelegramLinkStore(prisma);
    await expect(links.findByTelegramUser(botId, account.telegramUserId)).resolves.toMatchObject({ id: account.link.id, userId: account.userId });
    await expect(links.findByTelegramUser(botId + 1, account.telegramUserId)).resolves.toBeNull();
    await expect(links.findByChat(botId, account.telegramUserId)).resolves.toMatchObject({ id: account.link.id });
    const seen = (await prisma.telegramLink.findUniqueOrThrow({ where: { id: account.link.id } })).lastSeenAt;
    await links.touch(account.link.id, new Date(seen.getTime() + 30_000));
    await expect(links.findByUserId(account.userId)).resolves.toMatchObject({ lastSeenAt: seen });
    await links.touch(account.link.id, new Date(seen.getTime() + 61_000));
    await expect(links.findByUserId(account.userId)).resolves.toMatchObject({ lastSeenAt: new Date(seen.getTime() + 61_000) });
    await expect(links.updatePreferences(account.link.id, {
      currentChatId: account.chat.id, searchEnabled: false, selectedModel: { modelId: "fixture", provider: "fake" }
    })).resolves.toBe(true);
    await expect(links.findByUserId(account.userId)).resolves.toMatchObject({
      currentChatId: account.chat.id, searchEnabled: false, selectedModelId: "fixture", selectedProvider: "fake"
    });
    const stranger = await linkedAccount();
    await expect(links.updatePreferences(account.link.id, { currentChatId: stranger.chat.id })).rejects.toThrow();
  });
});

describe("Telegram retention (stateful)", () => {
  it("prunes only records past their retention", async () => {
    const account = await linkedAccount();
    const session = await prisma.authSession.create({
      data: { expiresAt: new Date("2099-01-01T00:00:00.000Z"), tokenHash: hashToken(randomUUID()), userId: account.userId }
    });
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const code = (createdAt: Date, expiresAt: Date, consumedAt: Date | null) => prisma.telegramLinkCode.create({
      data: { authSessionId: session.id, botId: BigInt(botId), codeHash: hashToken(randomUUID()), consumedAt, createdAt, expiresAt, userId: account.userId }
    });
    await code(ago(3), ago(2.9), null);
    await code(ago(2.1), ago(2), ago(2.05));
    const freshCode = await code(ago(0.5), new Date(now.getTime() + 60_000), ago(0.4));
    await prisma.telegramUpdateReceipt.createMany({ data: [
      { botId: BigInt(botId), kind: "message", receivedAt: ago(8), updateId: 1n },
      { botId: BigInt(botId), kind: "message", receivedAt: ago(6), updateId: 2n }
    ] });
    const callback = (createdAt: Date, expiresAt: Date) => prisma.telegramCallback.create({
      data: { createdAt, expiresAt, id: randomUUID().replace(/-/gu, "").slice(0, 22), kind: "select_chat", linkId: account.link.id, payload: {} }
    });
    await callback(ago(3), ago(2));
    const liveButton = await callback(ago(1), new Date(now.getTime() + DAY));
    await prisma.telegramMessageRef.createMany({ data: [
      { botId: BigInt(botId), chatId: account.chat.id, createdAt: ago(91), linkId: account.link.id, telegramChatId: BigInt(account.telegramUserId), telegramMessageId: 1n, userId: account.userId },
      { botId: BigInt(botId), chatId: account.chat.id, createdAt: ago(89), linkId: account.link.id, telegramChatId: BigInt(account.telegramUserId), telegramMessageId: 2n, userId: account.userId }
    ] });

    await deleteExpiredTelegramRecords(prisma, now);

    await expect(prisma.telegramLinkCode.findMany({ select: { id: true }, where: { userId: account.userId } }))
      .resolves.toEqual([{ id: freshCode.id }]);
    await expect(prisma.telegramUpdateReceipt.findMany({ select: { updateId: true }, where: { botId: BigInt(botId) } }))
      .resolves.toEqual([{ updateId: 2n }]);
    await expect(prisma.telegramCallback.findMany({ select: { id: true }, where: { linkId: account.link.id } }))
      .resolves.toEqual([{ id: liveButton.id }]);
    await expect(prisma.telegramMessageRef.findMany({ select: { telegramMessageId: true }, where: { linkId: account.link.id } }))
      .resolves.toEqual([{ telegramMessageId: 2n }]);
  });
});

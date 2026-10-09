// @vitest-environment node
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { createPrismaAuthSessionStore } from "../auth/prismaSessions";
import { createAdminUserSessionCommands } from "../auth/adminUserSessionCommands";
import { prisma } from "../prisma";
import { createPrismaSettingsRepository } from "../settings/prismaRepository";
import { scheduledTaskScheduleColumns } from "../scheduledTasks/store";
import { BROWSER_PUSH_MAX_CONSECUTIVE_FAILURES, BROWSER_PUSH_MAX_SUBSCRIPTIONS_PER_USER, createPrismaBrowserPushStore } from "./store";

const users: string[] = [];
const store = createPrismaBrowserPushStore(prisma);
const sessions = createPrismaAuthSessionStore(prisma);

async function owner(): Promise<string> {
  const id = `browser-push-test-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Synthetic push owner", email: `${id}@example.test`, id, status: "active" } });
  await prisma.userSettings.create({ data: { userId: id } });
  users.push(id);
  return id;
}

async function session(userId: string) {
  const tokenHash = randomBytes(32).toString("hex");
  const created = await prisma.authSession.create({ data: { expiresAt: new Date(Date.now() + 3_600_000), tokenHash, userId } });
  return { id: created.id, tokenHash };
}

function device(name: string = randomUUID()) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    auth: randomBytes(16).toString("base64url"), endpoint: `https://push.example/${name}`, p256dh: ecdh.getPublicKey().toString("base64url")
  };
}

async function subscribe(userId: string, sessionId: string, subscription = device()) {
  expect(await store.saveSubscription({ ...subscription, sessionId, userId }, new Date())).toBe("saved");
  return subscription;
}

async function run(userId: string, status: "cancelled" | "complete" | "error") {
  const created = await prisma.chat.create({ data: { title: "Synthetic trip plan", userId } });
  const message = await prisma.message.create({ data: { chatId: created.id, content: textMessageContent("synthetic"), role: "user" } });
  const modelRun = await prisma.modelRun.create({ data: {
    chatId: created.id, modelId: "fixture", normalizedRequest: {}, provider: "fake", status, userId, userMessageId: message.id,
    ...(status === "complete" ? { answerCompletedAt: new Date() } : {})
  } });
  return { chatId: created.id, runId: modelRun.id };
}

const targets = async (userId: string) => (await store.listTargets(userId, new Date())).map((target) => target.endpoint);

afterEach(async () => {
  const ids = users.splice(0);
  await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  // An administrator's revocation keeps a restricting reference on the revoked session.
  await prisma.authSession.deleteMany({ where: { OR: [{ userId: { in: ids } }, { revokedByUserId: { in: ids } }] } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("persisted browser push", () => {
  it("binds a device to its session and removes it when that session ends", async () => {
    const userId = await owner();
    const laptop = await session(userId);
    const phone = await session(userId);
    const laptopDevice = await subscribe(userId, laptop.id);
    const phoneDevice = await subscribe(userId, phone.id);
    expect((await targets(userId)).sort()).toEqual([laptopDevice.endpoint, phoneDevice.endpoint].sort());
    // The sender skips a device by the session that reported showing a run.
    expect(Object.fromEntries((await store.listTargets(userId, new Date())).map((target) => [target.endpoint, target.sessionId])))
      .toEqual({ [laptopDevice.endpoint]: laptop.id, [phoneDevice.endpoint]: phone.id });

    // Explicit logout revokes only this device's session.
    await sessions.revokeSessionByTokenHash({ revokedAt: new Date(), revokedReason: "logout", tokenHash: laptop.tokenHash });
    expect(await targets(userId)).toEqual([phoneDevice.endpoint]);
    expect(await prisma.browserPushSubscription.count({ where: { userId } })).toBe(1);
    expect(await store.saveSubscription({ ...device(), sessionId: laptop.id, userId }, new Date())).toBe("session_inactive");

    // Disabling the account revokes every session and with them every device.
    const admin = await owner();
    await prisma.user.update({ data: { role: "admin" }, where: { id: admin } });
    await expect(createAdminUserSessionCommands(prisma).disableUser({ revokedByUserId: admin, userId })).resolves.toBe("disabled");
    expect(await prisma.browserPushSubscription.count({ where: { userId } })).toBe(0);
  });

  it("moves a device to the account that signs in next on it", async () => {
    const first = await owner();
    const second = await owner();
    const shared = device("shared-browser");
    await subscribe(first, (await session(first)).id, shared);
    await subscribe(second, (await session(second)).id, shared);
    expect(await targets(first)).toEqual([]);
    expect(await targets(second)).toEqual([shared.endpoint]);
  });

  it("keeps consecutive failures across re-syncs and session changes until success or pruning", async () => {
    const userId = await owner();
    let current = await session(userId);
    const subscription = await subscribe(userId, current.id);
    const [target] = await store.listTargets(userId, new Date());
    const failedAt = new Date();
    await store.recordDelivery(target!, "failed", failedAt);
    current = await session(userId);
    await subscribe(userId, current.id, subscription);
    expect(await prisma.browserPushSubscription.findUniqueOrThrow({ where: { endpoint: subscription.endpoint } }))
      .toMatchObject({ failureCount: 1, lastFailureAt: failedAt, sessionId: current.id });
    const succeededAt = new Date();
    await store.recordDelivery(target!, "delivered", succeededAt);
    expect(await prisma.browserPushSubscription.findUniqueOrThrow({ where: { endpoint: subscription.endpoint } }))
      .toMatchObject({ failureCount: 0, lastFailureAt: failedAt, lastSuccessAt: succeededAt });
    for (let count = 1; count < BROWSER_PUSH_MAX_CONSECUTIVE_FAILURES; count += 1) {
      await store.recordDelivery(target!, "failed", failedAt);
      await subscribe(userId, current.id, subscription);
      expect(await prisma.browserPushSubscription.findUniqueOrThrow({ where: { endpoint: subscription.endpoint } }))
        .toMatchObject({ failureCount: count, lastFailureAt: failedAt });
    }
    await store.recordDelivery(target!, "failed", failedAt);
    expect(await targets(userId)).toEqual([]);
  });

  it.each(["auth", "p256dh", "owner"] as const)("starts failure history afresh when the subscription's %s changes", async (changed) => {
    let userId = await owner();
    let current = await session(userId);
    const subscription = await subscribe(userId, current.id);
    const [target] = await store.listTargets(userId, new Date());
    await store.recordDelivery(target!, "failed", new Date());
    if (changed === "owner") {
      userId = await owner();
      current = await session(userId);
    } else {
      subscription[changed] = device()[changed];
    }
    await subscribe(userId, current.id, subscription);
    expect(await prisma.browserPushSubscription.findUniqueOrThrow({ where: { endpoint: subscription.endpoint } }))
      .toMatchObject({ failureCount: 0, lastFailureAt: null, userId });
  });

  it("refuses registration while notifications are off and removes every device when turned off", async () => {
    const userId = await owner();
    const current = await session(userId);
    await subscribe(userId, current.id);
    await subscribe(userId, (await session(userId)).id);
    const settings = createPrismaSettingsRepository(prisma);
    await expect(settings.updateSettings(userId, { browserNotificationsEnabled: false }, [])).resolves.toMatchObject({ kind: "updated" });
    expect(await prisma.browserPushSubscription.count({ where: { userId } })).toBe(0);
    expect(await store.saveSubscription({ ...device(), sessionId: current.id, userId }, new Date())).toBe("disabled");
    expect(await store.claimRun((await run(userId, "complete")).runId, new Date())).toBeNull();
  });

  it("keeps at most the newest devices per account", async () => {
    const userId = await owner();
    const current = await session(userId);
    for (let index = 0; index <= BROWSER_PUSH_MAX_SUBSCRIPTIONS_PER_USER; index += 1) {
      await store.saveSubscription({ ...device(`device-${index}`), sessionId: current.id, userId }, new Date(Date.now() + index));
    }
    expect(await prisma.browserPushSubscription.count({ where: { userId } })).toBe(BROWSER_PUSH_MAX_SUBSCRIPTIONS_PER_USER);
    expect(await prisma.browserPushSubscription.count({ where: { endpoint: "https://push.example/device-0" } })).toBe(0);
  });

  it("claims a finished or failed ordinary chat run once, never a cancelled, scheduled or unsubscribed one", async () => {
    const userId = await owner();
    const silent = await owner();
    await subscribe(userId, (await session(userId)).id);
    const now = new Date();

    const complete = await run(userId, "complete");
    const [first, second] = await Promise.all([store.claimRun(complete.runId, now), store.claimRun(complete.runId, now)]);
    expect([first, second].filter(Boolean)).toEqual([
      { chatId: complete.chatId, kind: "run", status: "complete", title: "Synthetic trip plan", userId }
    ]);
    expect(await store.claimRun(complete.runId, now)).toBeNull();
    expect(await store.claimRun((await run(userId, "error")).runId, now)).toMatchObject({ status: "error" });

    expect(await store.claimRun((await run(userId, "cancelled")).runId, now)).toBeNull();
    expect(await store.claimRun((await run(silent, "complete")).runId, now)).toBeNull();

    // A scheduled task's run notifies through its occurrence only.
    const scheduled = await run(userId, "complete");
    const task = await prisma.scheduledTask.create({ data: {
      ...scheduledTaskScheduleColumns({ kind: "daily", time: "09:00" }), chatId: scheduled.chatId, modelId: "fixture", prompt: "Synthetic",
      provider: "fake", status: "PAUSED", timeZone: "Europe/Moscow", title: "Synthetic brief", userId
    } });
    const occurrence = await prisma.scheduledTaskOccurrence.create({ data: {
      chatId: scheduled.chatId, finishedAt: now, runId: scheduled.runId, scheduledFor: now, state: "COMPLETED", taskId: task.id,
      trigger: "manual", userId
    } });
    await prisma.modelRun.update({
      data: { scheduledOccurrenceId: occurrence.id, scheduledTaskGeneration: 1, scheduledTaskId: task.id },
      where: { id: scheduled.runId }
    });
    expect(await store.claimRun(scheduled.runId, now)).toBeNull();
    expect(await store.claimOccurrence(occurrence.id, now)).toMatchObject({
      chatId: scheduled.chatId, kind: "occurrence", state: "COMPLETED", title: "Synthetic brief", trigger: "manual", userId
    });
    expect(await store.claimOccurrence(occurrence.id, now)).toBeNull();
    expect(await prisma.browserPushDelivery.count({ where: { OR: [{ runId: complete.runId }, { occurrenceId: occurrence.id }] } })).toBe(2);
  });

  it("pushes no run of an automatic answer review and names its chat for the session's one end notice", async () => {
    const userId = await owner();
    await subscribe(userId, (await session(userId)).id);
    const chat = await prisma.chat.create({ data: { title: "Reviewed plan", userId } });
    const content = textMessageContent("synthetic");
    const question = await prisma.message.create({ data: { chatId: chat.id, content, role: "user" } });
    const answer = await prisma.message.create({ data: { chatId: chat.id, content, parentMessageId: question.id, role: "assistant",
      status: "complete" } });
    const completedRun = (assistantMessageId: string, userMessageId: string) => prisma.modelRun.create({ data: {
      answerCompletedAt: new Date(), assistantMessageId, chatId: chat.id, modelId: "fixture", normalizedRequest: {}, provider: "fake",
      status: "complete", userId, userMessageId
    } });
    const answerRun = await completedRun(answer.id, question.id);
    const reviewSession = await prisma.answerReviewSession.create({ data: {
      authorModel: { modelId: "fixture", name: "Fixture", provider: "fake" }, chatId: chat.id,
      controls: { controls: {}, reviewerSearchPlans: [{ mode: "all_selected", optionIds: [] }], version: 1 }, maxRounds: 1, mode: "auto",
      reviewers: [{ modelId: "reviewer", name: "Reviewer", provider: "fake" }], sourceAssistantMessageId: answer.id, userId
    } });
    const turn = await prisma.message.create({ data: { answerReviewRound: 1, answerReviewSessionId: reviewSession.id, answerReviewStep: 0,
      chatId: chat.id, content, parentMessageId: answer.id, role: "user", systemTurnKind: "answer_review_request" } });
    const stepAnswer = await prisma.message.create({ data: { answerReviewSessionId: reviewSession.id, chatId: chat.id, content,
      parentMessageId: turn.id, role: "assistant", status: "complete" } });
    const stepRun = await completedRun(stepAnswer.id, turn.id);

    // The answer under review and every step stay quiet; the session's end notifies once instead.
    expect(await store.claimRun(answerRun.id, new Date())).toBeNull();
    expect(await store.claimRun(stepRun.id, new Date())).toBeNull();
    expect(await store.loadAnswerReviewChat({ chatId: chat.id, userId }, new Date())).toEqual({ title: "Reviewed plan" });
    // A manual review's steps are ordinary runs and keep their own pushes.
    await prisma.answerReviewSession.update({ data: { controls: Prisma.DbNull, maxRounds: null, mode: "manual" },
      where: { id: reviewSession.id } });
    expect(await store.claimRun(stepRun.id, new Date())).toMatchObject({ chatId: chat.id, kind: "run", status: "complete" });
    // Another account's chat, and an owner with notifications off, take none.
    expect(await store.loadAnswerReviewChat({ chatId: chat.id, userId: await owner() }, new Date())).toBeNull();
    await prisma.userSettings.update({ data: { browserNotificationsEnabled: false }, where: { userId } });
    expect(await store.loadAnswerReviewChat({ chatId: chat.id, userId }, new Date())).toBeNull();
  });

  it("drops a subscription the push service reports gone or that keeps failing", async () => {
    const userId = await owner();
    const current = await session(userId);
    const kept = await subscribe(userId, current.id);
    const gone = await subscribe(userId, current.id);
    const [goneTarget] = (await store.listTargets(userId, new Date())).filter((target) => target.endpoint === gone.endpoint);
    await store.recordDelivery(goneTarget!, "gone", new Date());
    const [keptTarget] = await store.listTargets(userId, new Date());
    expect(keptTarget!.endpoint).toBe(kept.endpoint);
    await store.recordDelivery(keptTarget!, "failed", new Date());
    expect(await prisma.browserPushSubscription.findUniqueOrThrow({ where: { endpoint: kept.endpoint } }))
      .toMatchObject({ failureCount: 1, lastFailureAt: expect.any(Date) });
    await store.recordDelivery(keptTarget!, "delivered", new Date());
    expect(await prisma.browserPushSubscription.findUniqueOrThrow({ where: { endpoint: kept.endpoint } }))
      .toMatchObject({ failureCount: 0, lastSuccessAt: expect.any(Date) });
    await prisma.browserPushSubscription.update({ data: { failureCount: 19 }, where: { endpoint: kept.endpoint } });
    await store.recordDelivery(keptTarget!, "failed", new Date());
    expect(await targets(userId)).toEqual([]);
  });
});

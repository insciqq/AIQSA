// @vitest-environment node
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION, MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "../../contracts/memory";
import { createPrismaPermanentChatDeletionRepository } from "../chats/permanentDeletion/repository";
import { createPermanentChatDeletionService } from "../chats/permanentDeletion/service";
import { prisma } from "../prisma";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { createPermanentChatDeletionPass, createTemporaryChatDeletionPass } from "./chatDeletionPasses";
import { PERMANENT_CHAT_DELETION_DUTY, TEMPORARY_CHAT_DELETION_DUTY } from "./duties";
import {
  BACKGROUND_WORK_COMPLETED_RETENTION_MS,
  BACKGROUND_WORK_LEASE_MS,
  backgroundWorkRetryDelayMs,
  claimBackgroundWorkItem,
  completeBackgroundWorkItem,
  failBackgroundWorkItem,
  pruneCompletedBackgroundWorkItems,
  releaseBackgroundWorkItem
} from "./workItems";

const users: string[] = [];
const service = createPermanentChatDeletionService({
  capability: { enabled: true }, repository: createPrismaPermanentChatDeletionRepository(prisma)
});

async function owner(): Promise<string> {
  const id = `background-deletion-test-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Synthetic deletion owner", email: `${id}@example.test`, id, status: "active" } });
  users.push(id);
  return id;
}

async function chatWithFile(userId: string, storageKey: string, data: Prisma.ChatUncheckedCreateInput | null = null) {
  const chat = await prisma.chat.create({ data: { title: "Synthetic chat", userId, ...(data ?? {}) } });
  await prisma.attachment.create({ data: {
    byteSize: 18, chatId: chat.id, fileName: "synthetic.txt", kind: "file", metadata: {}, mimeType: "text/plain",
    status: "ready", storageKey, userId
  } });
  return chat;
}

function passContext(now: () => Date = () => new Date()) {
  return { now, signal: new AbortController().signal };
}

function work(duty: string, itemId: string) {
  return prisma.backgroundWorkItem.findUnique({ where: { duty_itemId: { duty, itemId } } });
}

afterEach(async () => {
  const ids = users.splice(0);
  await prisma.$executeRaw`
    UPDATE "Chat" SET "createdAt" = (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '2 days',
      "temporaryRetentionDeadline" = (clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '1 day'
    WHERE "userId" IN (${Prisma.join(ids.length ? ids : [""])}) AND "memoryMode" = 'TEMPORARY'::"MemoryChatMode"`;
  await prisma.attachment.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("background work item claims", () => {
  it("gives one item to exactly one of several concurrent claimants", async () => {
    const userId = await owner();
    const itemId = randomUUID();
    const now = new Date();
    const claims = await Promise.all(Array.from({ length: 6 }, () =>
      claimBackgroundWorkItem(prisma, { duty: "synthetic_duty", itemId, now, userId })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    await prisma.backgroundWorkItem.deleteMany({ where: { itemId } });
  });

  it("backs a failed item off, releases without counting, takes over an expired lease and completes once", async () => {
    const userId = await owner();
    const itemId = randomUUID();
    const duty = "synthetic_duty";
    const start = new Date();
    const first = await claimBackgroundWorkItem(prisma, { duty, itemId, now: start, userId });
    expect(first).toMatchObject({ attempt: 1 });
    await failBackgroundWorkItem(prisma, first!, { code: "chat_deletion_object_delete_failed", now: start });
    const retryAt = new Date(start.getTime() + backgroundWorkRetryDelayMs(1));
    await expect(claimBackgroundWorkItem(prisma, { duty, itemId, now: new Date(retryAt.getTime() - 1), userId })).resolves.toBeNull();
    const second = await claimBackgroundWorkItem(prisma, { duty, itemId, now: retryAt, userId });
    expect(second).toMatchObject({ attempt: 2 });
    // Another owner never takes the item over.
    await expect(claimBackgroundWorkItem(prisma, { duty, itemId, now: retryAt, userId: await owner() })).resolves.toBeNull();

    await releaseBackgroundWorkItem(prisma, second!, retryAt);
    await expect(work(duty, itemId)).resolves.toMatchObject({ attemptCount: 1, leaseToken: null, nextAttemptAt: null });
    const crashed = await claimBackgroundWorkItem(prisma, { duty, itemId, now: retryAt, userId });
    const takeoverAt = new Date(retryAt.getTime() + BACKGROUND_WORK_LEASE_MS);
    await expect(claimBackgroundWorkItem(prisma, { duty, itemId, now: new Date(takeoverAt.getTime() - 1), userId })).resolves.toBeNull();
    const takeover = await claimBackgroundWorkItem(prisma, { duty, itemId, now: takeoverAt, userId });
    expect(takeover).toMatchObject({ attempt: 3 });

    // The crashed holder's late completion is refused; the new holder's commits.
    await expect(completeBackgroundWorkItem(prisma, crashed!, takeoverAt)).resolves.toBe(false);
    await expect(completeBackgroundWorkItem(prisma, takeover!, takeoverAt)).resolves.toBe(true);
    await expect(claimBackgroundWorkItem(prisma, { duty, itemId, now: takeoverAt, userId })).resolves.toBeNull();
    await expect(work(duty, itemId)).resolves.toMatchObject({ completedAt: takeoverAt, lastErrorCode: null });

    await pruneCompletedBackgroundWorkItems(prisma, {
      duty, now: new Date(takeoverAt.getTime() + BACKGROUND_WORK_COMPLETED_RETENTION_MS + 1)
    });
    await expect(work(duty, itemId)).resolves.toBeNull();
  });
});

describe("chat deletion on the background worker", () => {
  it("resumes a permanent deletion interrupted between the database and object storage", async () => {
    const userId = await owner();
    const storage = createMemoryStorageAdapter();
    const exclusiveKey = `test/${randomUUID()}`;
    const sharedKey = `test/${randomUUID()}`;
    const chat = await chatWithFile(userId, exclusiveKey);
    const kept = await chatWithFile(userId, sharedKey);
    await prisma.attachment.create({ data: {
      byteSize: 18, chatId: chat.id, fileName: "shared.txt", kind: "file", metadata: {}, mimeType: "text/plain",
      status: "ready", storageKey: sharedKey, userId
    } });
    await expect(service.confirm(userId, chat.id, {
      alsoForgetOriginMemories: false, confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION, requestId: randomUUID()
    })).resolves.toEqual({ status: "IN_PROGRESS" });
    await expect(prisma.chat.findUniqueOrThrow({ where: { id: chat.id } })).resolves.toMatchObject({
      archived: true, memoryMode: "NORMAL"
    });
    await expect(prisma.memoryDeletionOutbox.count({ where: { userId } })).resolves.toBe(0);

    let failures = 1;
    const deletes: string[] = [];
    const flaky = { async deleteObject(key: string) {
      if (failures-- > 0) throw new Error("synthetic_storage_unavailable");
      deletes.push(key);
      await storage.deleteObject(key);
    } };
    const pass = createPermanentChatDeletionPass({ client: prisma, storage: flaky });
    const start = new Date();
    await pass.run(passContext(() => start));
    await expect(prisma.chat.count({ where: { id: chat.id } })).resolves.toBe(1);
    await expect(work(PERMANENT_CHAT_DELETION_DUTY, chat.id)).resolves.toMatchObject({
      attemptCount: 1, completedAt: null, lastErrorCode: "chat_deletion_object_delete_failed", leaseToken: null
    });
    await expect(service.consumerStatus(userId, chat.id)).resolves.toEqual({ status: "IN_PROGRESS" });

    const retryAt = new Date(start.getTime() + backgroundWorkRetryDelayMs(1));
    await pass.run(passContext(() => retryAt));
    await expect(prisma.chat.count({ where: { id: chat.id } })).resolves.toBe(0);
    await expect(prisma.attachment.count({ where: { chatId: chat.id } })).resolves.toBe(0);
    // The exclusive object went on the retry; the object another chat still references stays.
    expect(deletes).toEqual([exclusiveKey]);
    await expect(prisma.chat.count({ where: { id: kept.id } })).resolves.toBe(1);
    await expect(service.consumerStatus(userId, chat.id)).resolves.toEqual({ status: "COMPLETE" });
    await expect(service.consumerStatus(await owner(), chat.id)).rejects.toMatchObject({ code: "chat_not_found" });
    // A deleted chat never comes back: the fence is gone with the row, and a second admission finds nothing.
    await expect(service.confirm(userId, chat.id, {
      alsoForgetOriginMemories: false, confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION, requestId: randomUUID()
    })).rejects.toMatchObject({ code: "chat_not_found" });
  });

  it("keeps the fence immutable and refuses a Temporary chat for permanent deletion", async () => {
    const userId = await owner();
    const chat = await chatWithFile(userId, `test/${randomUUID()}`);
    await service.confirm(userId, chat.id, {
      alsoForgetOriginMemories: false, confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION, requestId: randomUUID()
    });
    await expect(prisma.chat.update({ data: { permanentDeletionAt: null, permanentDeletionOperationId: null }, where: { id: chat.id } }))
      .rejects.toBeTruthy();
    await expect(prisma.chat.update({ data: { archived: false }, where: { id: chat.id } })).rejects.toBeTruthy();
  });

  it("deletes a Temporary chat only once its deadline has passed", async () => {
    const userId = await owner();
    const storageKey = `test/${randomUUID()}`;
    const now = new Date();
    const temporary = {
      createdAt: new Date(now.getTime() - 120_000), memoryMode: "TEMPORARY" as const,
      temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION
    };
    const due = await chatWithFile(userId, storageKey, { ...temporary, temporaryRetentionDeadline: new Date(now.getTime() - 1_000), title: "Due", userId });
    const later = await chatWithFile(userId, `test/${randomUUID()}`, {
      ...temporary, temporaryRetentionDeadline: new Date(now.getTime() + 3_600_000), title: "Later", userId
    });
    // Nothing deletes a Temporary chat before its deadline, the database included.
    await expect(prisma.chat.delete({ where: { id: later.id } })).rejects.toBeTruthy();

    const deleted: string[] = [];
    await createTemporaryChatDeletionPass({ client: prisma, storage: { async deleteObject(key) { deleted.push(key); } } })
      .run(passContext(() => now));
    await expect(prisma.chat.count({ where: { id: due.id } })).resolves.toBe(0);
    await expect(prisma.chat.count({ where: { id: later.id } })).resolves.toBe(1);
    expect(deleted).toContain(storageKey);
    await expect(work(TEMPORARY_CHAT_DELETION_DUTY, due.id)).resolves.toMatchObject({ completedAt: now });
  });
});

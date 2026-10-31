// @vitest-environment node
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "@/lib/domain/content";
import { createNativeRunStore } from "../engine/runStore";
import { prisma } from "../prisma";
import { isPrismaSerializationConflict } from "../runs/prismaRepositoryShared";
import type { StorageAdapter, StoredObjectInput } from "../uploads/storage";
import { createArtifactService } from "./service";

function barrier<T = void>() {
  let release!: (value: T) => void;
  const wait = new Promise<T>(resolve => { release = resolve; });
  return { release, wait };
}

type Write = (tx: Prisma.TransactionClient) => Promise<unknown>;
function withTransactions(transaction: (write: Write) => Promise<unknown>): PrismaClient {
  return new Proxy(prisma, { get(target, key) { return key === "$transaction" ? transaction : Reflect.get(target, key); } });
}

async function waitForBlock(waiter: number, blocker: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT ${blocker}::int = ANY(pg_blocking_pids(${waiter}::int)) AS blocked`;
    if (row?.blocked) return;
    await delay(20);
  }
  throw new Error("artifact_insert_did_not_wait_for_chat");
}

describe("artifact creation deadlocks in PostgreSQL", () => {
  afterAll(() => prisma.$disconnect());

  it("retries the insert deadlocked with detached compaction and leaves exactly one ready artifact", async () => {
    const owner = await prisma.user.create({ data: { id: `artifact-deadlock-${randomUUID()}`, displayName: "Artifact deadlock", status: "active" } });
    const chatLocked = barrier<number>();
    const insertConnection = barrier<number>();
    const continueCompaction = barrier();
    const objects = new Map<string, StoredObjectInput>();
    const putObject = vi.fn(async (value: StoredObjectInput) => { objects.set(value.storageKey, value); });
    const storage: StorageAdapter = { putObject,
      async getObject(key) { const value = objects.get(key); if (!value) throw new Error("fixture_object_missing"); return { ...value, body: Buffer.from(value.body) }; },
      async deleteObject(key) { objects.delete(key); } };
    const conflicts: unknown[] = [];
    let attempts = 0;
    let creating: Promise<unknown> | undefined;
    let compacting: Promise<unknown> | undefined;
    try {
      const chat = await prisma.chat.create({ data: { userId: owner.id, title: "Deadlock", memoryMode: "EXCLUDED" } });
      const question = await prisma.message.create({ data: { chatId: chat.id, role: "user", content: textMessageContent("Artifact") } });
      const answer = await prisma.message.create({ data: { chatId: chat.id, role: "assistant", content: textMessageContent(""), status: "streaming", parentMessageId: question.id } });
      const run = await prisma.modelRun.create({ data: { chatId: chat.id, userId: owner.id, userMessageId: question.id, assistantMessageId: answer.id,
        engine: "native", provider: "fake", modelId: "fixture", status: "streaming", normalizedRequest: {} } });
      const tool = await prisma.modelRunToolCall.create({ data: { modelRunId: run.id, roundIndex: 1, ordinal: 0,
        providerCallId: "create", toolName: "create_artifact", arguments: {} } });

      // recordDetachedCompaction locks Chat, then ModelRun. Pause it with its
      // Chat lock held until the real Artifact INSERT waits on that foreign key.
      const compactionDb = withTransactions(write => prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Chat" WHERE "id" = ${chat.id} FOR UPDATE`;
        const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        chatLocked.release(connection!.pid);
        await continueCompaction.wait;
        return write(tx);
      }, { timeout: 15_000 }));
      const store = createNativeRunStore(compactionDb);
      const itemId = randomUUID();
      compacting = store.recordDetachedCompaction({ userId: owner.id, chatId: chat.id, runId: run.id, assistantMessageId: answer.id }, {
        sequence: 1, status: null, item: { id: itemId, kind: "compaction", keepFromId: question.id,
          origin: { model: "fixture", provider: "fake" }, retained: "Synthetic", summary: "Synthetic" }
      }).catch(error => ({ error }));
      const blocker = await Promise.race([chatLocked.wait, compacting.then(() => { throw new Error("compaction_ended_before_chat_lock"); })]);

      const artifactDb = withTransactions(async write => {
        attempts++;
        try {
          return await prisma.$transaction(async tx => {
            const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            insertConnection.release(connection!.pid);
            return write(tx);
          }, { timeout: 15_000 });
        } catch (error) { conflicts.push(error); throw error; }
      });
      const service = createArtifactService(artifactDb, storage);
      const input = { ownerUserId: owner.id, sourceChatId: chat.id, sourceModelRunId: run.id, sourceToolCallId: tool.id,
        operation: { intent: "create", kind: "html", title: "Deadlock", entrypoint: "index.html",
          files: [{ path: "index.html", mimeType: "text/html", text: "<p>Ready once</p>" }] } } as const;
      creating = service.createVersion(input).catch(error => ({ error }));
      const waiter = await Promise.race([insertConnection.wait, creating.then(() => { throw new Error("creation_ended_before_insert"); })]);
      await waitForBlock(waiter, blocker);
      // The insert starts waiting first, so its deadlock detector runs first.
      continueCompaction.release();
      const [version, compacted] = await Promise.all([creating, compacting]);
      expect(compacted).toBe(true);
      expect(version).toMatchObject({ status: "READY", versionNumber: 1 });
      expect(conflicts).toHaveLength(1);
      expect(isPrismaSerializationConflict(conflicts[0])).toBe(true);
      expect(attempts).toBe(3);
      expect(await prisma.artifact.count({ where: { ownerUserId: owner.id } })).toBe(1);
      expect(await prisma.artifactVersion.count({ where: { sourceToolCallId: tool.id } })).toBe(1);
      expect(await prisma.artifactChatBinding.count({ where: { chatId: chat.id } })).toBe(1);
      expect(await prisma.runTranscriptItem.count({ where: { id: itemId } })).toBe(1);
      expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: { startsWith: `artifacts/${owner.id}/` } } })).toBe(1);
      expect(putObject).toHaveBeenCalledTimes(1);
      expect(await service.createVersion(input)).toEqual(version);
      expect(attempts).toBe(3);
      expect(putObject).toHaveBeenCalledTimes(1);
    } finally {
      continueCompaction.release();
      await Promise.allSettled([creating, compacting]);
      await prisma.modelRun.deleteMany({ where: { userId: owner.id } });
      await prisma.user.deleteMany({ where: { id: owner.id } });
      await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: { startsWith: `artifacts/${owner.id}/` } } });
    }
  }, 30_000);
});

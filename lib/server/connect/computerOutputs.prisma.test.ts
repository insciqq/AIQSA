import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { createMemoryStorageAdapter } from "../../../tests/support/storage";
import { summarizeMessageRunArtifacts } from "../chats/prismaRepository";
import { createPrismaMessageBranchRepository } from "../messages/prismaRepository";
import { prisma } from "../prisma";
import { createPrismaAttachmentDownloadRepository } from "../uploads/downloadRepository";
import { workspaceInboxAttachmentWhere } from "../workspace/inboxSelection";
import { createPrismaComputerOutputStore } from "./computerOutputs";

afterAll(() => prisma.$disconnect());

type Fixture = Readonly<{
  db: PrismaClient; userId: string; chatId: string; runId: string; assistantId: string;
  storage: ReturnType<typeof createMemoryStorageAdapter>;
  toolCall(): Promise<string>;
}>;

/** One user's chat with a streaming run, all in a transaction rolled back at the end. */
async function fixture(runTest: (fixture: Fixture) => Promise<void>) {
  const rollback = new Error("computer_output_fixture_rollback");
  try { await prisma.$transaction(async (tx) => {
    const db = new Proxy(tx, { get(target, property) {
      return property === "$transaction" ? (operation: (client: Prisma.TransactionClient) => unknown) => operation(tx) : Reflect.get(target, property);
    } }) as unknown as PrismaClient;
    const user = await db.user.create({ data: { id: randomUUID(), displayName: "Computer output fixture", status: "active" } });
    const chat = await db.chat.create({ data: { userId: user.id, title: "Computer output fixture", memoryMode: "EXCLUDED" } });
    const message = await db.message.create({ data: { chatId: chat.id, role: "user", content: { blocks: [{ type: "text", text: "Send me the report" }] } } });
    const assistant = await db.message.create({ data: { chatId: chat.id, parentMessageId: message.id, role: "assistant", content: { blocks: [] },
      status: "streaming" } });
    await db.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: assistant.id } });
    const run = await db.modelRun.create({ data: { chatId: chat.id, userId: user.id, userMessageId: message.id, assistantMessageId: assistant.id,
      modelId: "chat", provider: "fake", status: "streaming", normalizedRequest: {} } });
    let ordinal = 0;
    await runTest({ assistantId: assistant.id, chatId: chat.id, db, runId: run.id, storage: createMemoryStorageAdapter(), userId: user.id,
      async toolCall() {
        const row = await db.modelRunToolCall.create({ data: { modelRunId: run.id, providerCallId: randomUUID(), roundIndex: ordinal,
          ordinal: ordinal++, toolName: "computer_attach_file", arguments: { path: "report.pdf", name: null }, state: "running", startedAt: new Date() } });
        return row.id;
      } });
    throw rollback;
  }, { timeout: 30_000 }); } catch (error) { if (error !== rollback) throw error; }
}

const signal = () => new AbortController().signal;

describe("files attached from the user's computer", () => {
  it("stores the file as the answer's attachment, once per call, and shows and serves it to its owner only", async () => fixture(async (f) => {
    const store = createPrismaComputerOutputStore(f.db, f.storage);
    const bytes = Buffer.from("%PDF-1.7 synthetic report");
    const toolCallId = await f.toolCall();
    const published = await store.publish({ bytes, fileName: "report.pdf", runId: f.runId, signal: signal(), toolCallId, userId: f.userId });
    expect(published).toMatchObject({ ok: true, reused: false, file: { byteSize: bytes.length, fileName: "report.pdf", mimeType: "application/pdf",
      relativePath: "report.pdf", source: "computer" } });
    if (!published.ok) throw new Error("not published");
    const row = await f.db.attachment.findUniqueOrThrow({ where: { id: published.file.attachmentId } });
    expect(row).toMatchObject({ chatId: f.chatId, kind: "pdf", messageId: f.assistantId, origin: "COMPUTER_OUTPUT", producerModelRunId: f.runId,
      status: "ready", userId: f.userId });
    expect(row.storageKey).toBe(`${f.userId}/computer-outputs/${f.runId}/${row.id}`);
    expect(f.storage.objects.get(row.storageKey)?.body.equals(bytes)).toBe(true);
    expect(await f.db.attachmentDeletionJob.count({ where: { storageKey: row.storageKey } })).toBe(0);

    // A retry of the call finds its file; the same bytes under the same name from another call are the same file.
    expect(await store.find({ runId: f.runId, toolCallId, userId: f.userId })).toEqual(published.file);
    expect(await store.publish({ bytes, fileName: "report.pdf", runId: f.runId, signal: signal(), toolCallId, userId: f.userId }))
      .toEqual({ file: published.file, ok: true, reused: true });
    expect(await store.publish({ bytes, fileName: "report.pdf", runId: f.runId, signal: signal(), toolCallId: await f.toolCall(), userId: f.userId }))
      .toEqual({ file: published.file, ok: true, reused: true });
    expect(await f.db.attachment.count({ where: { origin: "COMPUTER_OUTPUT", producerModelRunId: f.runId } })).toBe(1);

    const run = await f.db.modelRun.findUniqueOrThrow({ where: { id: f.runId }, select: {
      workspaceProducedAttachments: { select: { byteSize: true, checksum: true, fileName: true, id: true, metadata: true, mimeType: true,
        origin: true, workspaceCheckpointFile: { select: { relativePath: true, checkpoint: { select: { createdAt: true, description: true, id: true,
          state: true } } } }, workspaceRunOutput: { select: { relativePath: true } } } } } });
    expect(summarizeMessageRunArtifacts({ events: [], searchRuns: [], ...run })?.generatedFiles).toEqual([published.file]);
    const downloads = createPrismaAttachmentDownloadRepository(f.db);
    expect(await downloads.resolve({ attachmentId: row.id, userId: f.userId })).toMatchObject({ fileName: "report.pdf", storageKey: row.storageKey });
    expect(await downloads.resolve({ attachmentId: row.id, userId: randomUUID() })).toBeNull();
    // A later answer of the branch hands it to the Workspace as the user's file.
    expect(await f.db.attachment.count({ where: { ...workspaceInboxAttachmentWhere({ ancestorMessageIds: [f.assistantId], chatId: f.chatId,
      imageIds: [], userId: f.userId }), id: row.id } })).toBe(1);
  }));

  it("stops at the answer's cap and once the run has ended, leaving the unpublished object to retention", async () => fixture(async (f) => {
    const store = createPrismaComputerOutputStore(f.db, f.storage);
    for (let index = 0; index < 20; index += 1) {
      expect(await store.publish({ bytes: Buffer.from(`file ${index}`), fileName: `f${index}.txt`, runId: f.runId, signal: signal(),
        toolCallId: await f.toolCall(), userId: f.userId })).toMatchObject({ ok: true, reused: false });
    }
    expect(await store.publish({ bytes: Buffer.from("one more"), fileName: "more.txt", runId: f.runId, signal: signal(),
      toolCallId: await f.toolCall(), userId: f.userId })).toEqual({ code: "computer_output_limit", ok: false });
    // The refused file's object stays named by a released obligation, which retention drains.
    const released = await f.db.attachmentDeletionJob.findMany({ where: { storageKey: { startsWith: `${f.userId}/computer-outputs/${f.runId}/` } } });
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ claimToken: null, claimedAt: null });

    await f.db.modelRun.update({ where: { id: f.runId }, data: { status: "complete" } });
    expect(await store.publish({ bytes: Buffer.from("late"), fileName: "late.txt", runId: f.runId, signal: signal(), toolCallId: await f.toolCall(),
      userId: f.userId })).toEqual({ code: "computer_output_closed", ok: false });
    // Another user's run is closed to this user as well.
    expect(await store.publish({ bytes: Buffer.from("x"), fileName: "x.txt", runId: f.runId, signal: signal(), toolCallId: await f.toolCall(),
      userId: randomUUID() })).toEqual({ code: "computer_output_closed", ok: false });
  }));

  it("attaches nothing after Stop", async () => fixture(async (f) => {
    const store = createPrismaComputerOutputStore(f.db, f.storage);
    const stop = new AbortController();
    stop.abort(new DOMException("stopped", "AbortError"));
    await expect(store.publish({ bytes: Buffer.from("x"), fileName: "x.txt", runId: f.runId, signal: stop.signal, toolCallId: await f.toolCall(),
      userId: f.userId })).rejects.toThrow("stopped");
    expect(await f.db.attachment.count({ where: { producerModelRunId: f.runId } })).toBe(0);
  }));

  it("releases the file with its branch, as a Workspace output", async () => fixture(async (f) => {
    const store = createPrismaComputerOutputStore(f.db, f.storage);
    const published = await store.publish({ bytes: Buffer.from("report"), fileName: "report.txt", runId: f.runId, signal: signal(),
      toolCallId: await f.toolCall(), userId: f.userId });
    if (!published.ok) throw new Error("not published");
    await f.db.modelRun.update({ where: { id: f.runId }, data: { status: "complete" } });
    await f.db.message.update({ where: { id: f.assistantId }, data: { status: "complete" } });
    await createPrismaMessageBranchRepository(f.db).deleteMessageSubtree({ messageId: f.assistantId, userId: f.userId });
    expect(await f.db.modelRun.count({ where: { id: f.runId } })).toBe(0);
    expect(await f.db.attachment.findUnique({ where: { id: published.file.attachmentId } }))
      .toMatchObject({ chatId: f.chatId, messageId: null, origin: "COMPUTER_OUTPUT", producerModelRunId: null });
  }));
});

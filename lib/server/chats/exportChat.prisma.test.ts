import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { decodeChatArchiveManifest, decodeChatExportDocument } from "../../contracts/chatExport";
import { chatExportDocument } from "../../domain/chatExportDocument";
import { prisma } from "../prisma";
import { personalChatExportEntries } from "./exportAll";
import { loadAuthorizedChatExportSource } from "./exportChat";
import type { TarEntry } from "./tarArchive";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 12, minute));
const text = (value: string) => ({ blocks: [{ text: value, type: "text" }] });

async function users(count: number) {
  const ids = Array.from({ length: count }, () => randomUUID());
  cleanups.push(async () => { await prisma.user.deleteMany({ where: { id: { in: ids } } }); });
  await prisma.user.createMany({ data: ids.map((id) => ({ id, displayName: "Export fixture member", status: "active" })) });
  return ids;
}

/** A personal chat whose first message was edited and whose answer was regenerated with a delivered follow-up. */
async function branchedChat(ownerId: string, chat: { archived?: boolean } = {}) {
  const chatId = randomUUID();
  cleanups.push(async () => { await prisma.chat.deleteMany({ where: { id: chatId } }); });
  await prisma.chat.create({ data: { id: chatId, title: "Export fixture", createdAt: at(0), pinned: true, userId: ownerId } });
  const attachmentId = randomUUID();
  const question = await prisma.message.create({ data: { chatId, role: "user", status: "complete", createdAt: at(1),
    content: { blocks: [{ text: "Synthetic question", type: "text" }, { attachmentId, fileName: "notes.txt", type: "file" }] } } });
  await prisma.attachment.create({ data: { id: attachmentId, chatId, messageId: question.id, status: "ready", kind: "file",
    fileName: "notes.txt", mimeType: "text/plain", byteSize: 12, storageKey: `export-test/${chatId}/notes.txt`, metadata: {},
    userId: ownerId } });
  await prisma.message.create({ data: { chatId, role: "assistant", status: "complete", createdAt: at(2), parentMessageId: question.id,
    provider: "fake", modelId: "export-fixture", content: text("First answer") } });
  const regenerated = await prisma.message.create({ data: { chatId, role: "assistant", status: "complete", createdAt: at(3),
    parentMessageId: question.id, provider: "fake", modelId: "export-fixture", content: text("Regenerated answer") } });
  const run = await prisma.modelRun.create({ data: { chatId, userId: ownerId, userMessageId: question.id,
    assistantMessageId: regenerated.id, provider: "fake", modelId: "export-fixture", status: "complete", normalizedRequest: {},
    followupMode: "chat", followupRevision: 1, followupClosedAt: at(5), answerCompletedAt: at(5) } });
  await prisma.runFollowup.create({ data: { chatId, modelRunId: run.id, ordinal: 1, nonce: "export-fixture-1",
    text: "Synthetic clarification", authorName: "Export fixture member", createdAt: at(4), deliveredAt: at(4), precedingText: "Synthetic partial" } });
  const edited = await prisma.message.create({ data: { chatId, role: "user", status: "complete", createdAt: at(6),
    content: text("Edited question") } });
  await prisma.chat.update({ where: { id: chatId }, data: { activeLeafMessageId: regenerated.id, archived: chat.archived ?? false } });
  return { attachmentId, chatId, editedId: edited.id, questionId: question.id, regeneratedId: regenerated.id, runId: run.id };
}

async function tarEntries(iterable: AsyncIterable<TarEntry>): Promise<TarEntry[]> {
  const output: TarEntry[] = [];
  for await (const entry of iterable) output.push(entry);
  return output;
}

describe("chat export against PostgreSQL", () => {
  it("exports the whole tree with flattened follow-ups and attachment metadata for the owner only", async () => {
    const [ownerId, outsiderId] = await users(2) as [string, string];
    const fixture = await branchedChat(ownerId);
    const source = await loadAuthorizedChatExportSource(prisma, { chatId: fixture.chatId, userId: ownerId });
    expect(source).not.toBeNull();
    const document = chatExportDocument(source!, at(10));
    expect(decodeChatExportDocument(JSON.parse(JSON.stringify(document)))).toEqual({ ok: true, value: document });
    expect(document.chat.messages.map((message) => [message.id, message.parentId, message.role, message.text])).toEqual([
      ["m1", null, "user", "Synthetic question"],
      ["m2", "m1", "assistant", "First answer"],
      ["m3", "m1", "assistant", "Partial answer before follow-up:\n\nSynthetic partial"],
      ["m4", "m3", "user", "Follow-up 1:\n\nSynthetic clarification"],
      ["m5", "m4", "assistant", "Regenerated answer"],
      ["m6", null, "user", "Edited question"]
    ]);
    expect(document.chat).toMatchObject({ activeLeafId: "m5", archived: false, pinned: true, title: "Export fixture" });
    expect(document.chat.messages[0]?.attachments).toEqual([{ byteSize: 12, mimeType: "text/plain", name: "notes.txt" }]);
    const serialized = JSON.stringify(document);
    for (const internal of [fixture.chatId, fixture.questionId, fixture.regeneratedId, fixture.runId, fixture.attachmentId, ownerId]) {
      expect(serialized).not.toContain(internal);
    }
    expect(await loadAuthorizedChatExportSource(prisma, { chatId: fixture.chatId, userId: outsiderId })).toBeNull();
    expect(await loadAuthorizedChatExportSource(prisma, { chatId: randomUUID(), userId: ownerId })).toBeNull();
  });

  it("opens an archived personal chat for its owner only", async () => {
    const [ownerId, outsiderId] = await users(2) as [string, string];
    const archived = await branchedChat(ownerId, { archived: true });
    expect((await loadAuthorizedChatExportSource(prisma, { chatId: archived.chatId, userId: ownerId }))?.chat.archived).toBe(true);
    expect(await loadAuthorizedChatExportSource(prisma, { chatId: archived.chatId, userId: outsiderId })).toBeNull();
  });

  it("puts the identical chat object in the bulk archive beside a manifest, without other users' chats", async () => {
    const [ownerId, otherId] = await users(2) as [string, string];
    const personal = await branchedChat(ownerId);
    await branchedChat(otherId);
    const exportedAt = at(10);
    const output = await tarEntries(personalChatExportEntries(prisma, ownerId, exportedAt));
    const manifest = decodeChatArchiveManifest(JSON.parse(String(output[0]?.content)));
    if (!manifest.ok) throw new Error(manifest.code);
    expect(manifest.value.chats).toHaveLength(1);
    const path = manifest.value.chats[0]!.path;
    expect(output.map((entry) => entry.path)).toEqual(["manifest.json", manifest.value.chats[0]!.markdownPath, path]);
    const bulk = JSON.parse(String(output.find((entry) => entry.path === path)?.content));
    const single = chatExportDocument((await loadAuthorizedChatExportSource(prisma, { chatId: personal.chatId, userId: ownerId }))!, exportedAt);
    expect(bulk.chat).toEqual(JSON.parse(JSON.stringify(single.chat)));
  });
});

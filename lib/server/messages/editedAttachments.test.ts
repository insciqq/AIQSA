import type { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../domain/content";
import { createTestAuth } from "@/tests/support/auth";
import { createEditMessageBranchHandler } from "./handlers";
import { createPrismaMessageBranchRepository } from "./prismaRepository";

function fixture(projectId: string | null = null) {
  const userId = "editor";
  const original = {
    id: "original", chatId: "chat", parentMessageId: "previous-answer",
    modelId: null, provider: null, role: "user", status: "complete",
    content: { blocks: [
      { type: "text", text: "Read these files" },
      { type: "file", attachmentId: "document", fileName: "document.pdf" },
      { type: "image", attachmentId: "image", alt: "Diagram" }
    ] }
  };
  const chat = {
    id: "chat", userId: projectId ? null : userId, projectId,
    archived: false, activeLeafMessageId: original.id, folderId: null,
    memoryMode: "TEMPORARY", memoryBranchGeneration: 0, memorySourceRevision: 0,
    temporaryRetentionPolicyVersion: 1, temporaryRetentionDeadline: null
  };
  const attachments = ["document", "image"].map((id) => ({
    id, chatId: chat.id, messageId: original.id, userId: chat.userId, projectId,
    kind: id === "image" ? "image" : "pdf",
    byteSize: 100, checksum: "a".repeat(64), extractedText: null,
    fileName: `${id}.${id === "image" ? "png" : "pdf"}`,
    metadata: {}, mimeType: id === "image" ? "image/png" : "application/pdf",
    processingErrorCode: null,
    status: id === "image" ? "ready" : "processing", storageKey: `private/${id}`,
    uploaderUserId: projectId ? "uploader" : null,
    uploaderDisplayName: projectId ? "Uploader" : null
  }));
  const tx = {
    $queryRaw: vi.fn(async () => [chat]),
    message: {
      findUnique: vi.fn(async () => ({ chat: { projectId } })),
      findFirst: vi.fn(async () => original),
      create: vi.fn(async ({ data }: { data: Prisma.MessageUncheckedCreateInput }) => ({ id: "edited", ...data }))
    },
    attachment: {
      findMany: vi.fn(async ({ where }: { where: {
        chatId: string; messageId: string; id: { in: string[] }; userId: string | null; projectId: string | null;
      } }) => attachments.filter((row) =>
        where.id.in.includes(row.id) && row.chatId === where.chatId && row.messageId === where.messageId &&
        row.userId === where.userId && row.projectId === where.projectId
      )),
      create: vi.fn(async ({ data }: { data: Prisma.AttachmentUncheckedCreateInput }) => data)
    },
    modelRun: { findFirst: vi.fn(async () => null) },
    chat: { updateMany: vi.fn(async () => ({ count: 1 })), update: vi.fn(async () => ({})) },
    user: {
      findFirst: vi.fn(async () => ({ id: userId, groups: [] })),
      findUnique: vi.fn(async () => ({ displayName: "Editor" }))
    },
    project: { findUnique: vi.fn(async () => ({
      id: projectId, status: "ACTIVE", accessRevision: 1, instructionsRevision: 1,
      memoryRevision: 1, policyRevision: 1,
      grants: [{ userId, role: "CONTRIBUTOR", groupId: null, group: null }]
    })) }
  };
  const repository = createPrismaMessageBranchRepository({
    $transaction: async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx)
  } as unknown as PrismaClient);
  return { attachments, original, repository, tx, userId };
}

describe("edited message attachments", () => {
  it.each([null, "project-1"])("keeps independently linked files and images on a text edit (Project: %s)", async (projectId) => {
    const { attachments, original, repository, tx, userId } = fixture(projectId);
    const before = structuredClone({ attachments, original });
    const auth = createTestAuth({ user: { id: userId } });
    const PATCH = createEditMessageBranchHandler({ repository, resolveAuth: auth.resolveAuth });
    const response = await PATCH(new Request("http://app.local/api/messages/original", {
      body: JSON.stringify({ text: "Read these documents" }),
      headers: { cookie: auth.cookie, "content-type": "application/json" },
      method: "PATCH"
    }), { params: { messageId: original.id } });

    expect(response.status).toBe(200);
    const { message } = await response.json();
    expect(message).toMatchObject({
      id: "edited", parentMessageId: "previous-answer", status: "complete",
      content: { blocks: [
        { type: "text", text: "Read these documents" },
        { type: "file", attachmentId: expect.any(String), fileName: "document.pdf" },
        { type: "image", attachmentId: expect.any(String), alt: "Diagram" }
      ] }
    });
    expect(tx.attachment.create).toHaveBeenCalledTimes(2);
    for (const [index, source] of attachments.entries()) {
      const id = message.content.blocks[index + 1].attachmentId;
      expect(id).not.toBe(source.id);
      expect(tx.attachment.create).toHaveBeenCalledWith({ data: expect.objectContaining({
        id, chatId: "chat", messageId: "edited", storageKey: source.storageKey,
        checksum: source.checksum, status: source.status,
        ...(projectId
          ? { projectId, uploaderUserId: "uploader", uploaderDisplayName: "Uploader" }
          : { userId })
      }) });
    }
    expect(tx.attachment.create.mock.calls[0][0].data.processingJob).toEqual({
      create: { ownerUserId: userId }
    });
    expect(tx.attachment.create.mock.calls[1][0].data.processingJob).toBeUndefined();
    if (projectId) {
      expect(tx.message.create.mock.calls[0][0].data).toMatchObject({
        authorUserId: userId, authorDisplayName: "Editor", authorProjectRole: "CONTRIBUTOR"
      });
      expect(tx.attachment.create.mock.calls[0][0].data.userId).toBeUndefined();
    }
    expect({ attachments, original }).toEqual(before);
  });

  it.each(["missing", "other_message", "other_owner"])("rejects a %s attachment before creating a sibling", async (kind) => {
    const { attachments, original, repository, tx, userId } = fixture();
    if (kind === "missing") attachments.pop();
    if (kind === "other_message") attachments[0].messageId = "other-message";
    if (kind === "other_owner") attachments[0].userId = "other-user";

    expect(await repository.createEditedMessageBranch({
      content: textMessageContent("Edited"), originalMessageId: original.id, userId
    })).toBeNull();
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.attachment.create).not.toHaveBeenCalled();
    expect(tx.chat.updateMany).not.toHaveBeenCalled();
  });
});

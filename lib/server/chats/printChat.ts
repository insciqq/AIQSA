import { Prisma, type PrismaClient } from "@prisma/client";
import { decodeThreadGeneratedImage } from "../../contracts/imageGeneration";
import { chatExportActiveBranch } from "../../domain/chatExportDocument";
import {
  chatPrintDocument,
  type ChatPrintDocument,
  type ChatPrintGeneratedImage
} from "../../domain/chatPrintDocument";
import { findReadableExportChat, loadChatExportSource, routeChatId } from "./exportChat";

type GeneratedImageReadClient = Pick<Prisma.TransactionClient, "message">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Generated images of the given answers, as the thread shows them: the image
 * outputs of each answer's latest own run (a branch copy carries its images
 * as content blocks instead). One query regardless of the branch length.
 */
export async function loadChatPrintGeneratedImages(
  db: GeneratedImageReadClient,
  chatId: string,
  answerIds: readonly string[]
): Promise<Map<string, ChatPrintGeneratedImage[]>> {
  if (answerIds.length === 0) return new Map();
  const rows = await db.message.findMany({
    select: {
      assistantModelRuns: {
        orderBy: { createdAt: "desc" },
        select: {
          workspaceProducedAttachments: {
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true, metadata: true },
            where: { origin: "IMAGE_OUTPUT" }
          }
        },
        take: 1
      },
      id: true
    },
    where: { chatId, id: { in: [...answerIds] } }
  });
  return new Map(rows.map((row) => [row.id, (row.assistantModelRuns[0]?.workspaceProducedAttachments ?? []).flatMap((attachment) => {
    const image = isRecord(attachment.metadata) ? decodeThreadGeneratedImage(attachment.metadata.image) : null;
    return image && image.attachmentId === attachment.id
      ? [{ attachmentId: image.attachmentId, height: image.height, width: image.width }]
      : [];
  })]));
}

/**
 * The print projection of a chat the user may open, under exactly the read
 * rule of the chat page and the export; null for an invisible or missing
 * chat alike. One repeatable-read snapshot covers the branch and its images.
 */
export async function loadAuthorizedChatPrintDocument(
  db: PrismaClient,
  input: Readonly<{ chatId: string; userId: string }>,
  printedAt: Date = new Date()
): Promise<ChatPrintDocument | null> {
  const chatId = routeChatId(input.chatId);
  if (!chatId) return null;
  return db.$transaction(async (tx) => {
    const chat = await findReadableExportChat(tx, { chatId, userId: input.userId });
    if (!chat) return null;
    const source = await loadChatExportSource(tx, chat);
    const answerIds = chatExportActiveBranch(source)
      .filter((message) => message.role === "assistant")
      .map((message) => message.key);
    const generatedImages = await loadChatPrintGeneratedImages(tx, chat.id, answerIds);
    return chatPrintDocument(source, generatedImages, printedAt);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

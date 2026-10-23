import type { Prisma, PrismaClient } from "@prisma/client";

export type ChatAccessClient = Pick<PrismaClient, "chat"> | Prisma.TransactionClient;

/** The caller's own chat; other chats are never reachable through it. */
export type ChatAccess = Readonly<{ userId: string }>;

/**
 * Whether `userId` may open `chatId`: only its owner may, and a chat fenced
 * for permanent deletion is gone. Every other or missing chat answers null,
 * so callers reveal nothing about chats they cannot open.
 */
export async function resolveChatAccess(
  client: ChatAccessClient,
  input: Readonly<{ chatId: string; userId: string }>
): Promise<ChatAccess | null> {
  const chat = await client.chat.findUnique({
    select: { permanentDeletionAt: true, userId: true },
    where: { id: input.chatId }
  });
  return chat && !chat.permanentDeletionAt && chat.userId === input.userId
    ? { userId: input.userId }
    : null;
}

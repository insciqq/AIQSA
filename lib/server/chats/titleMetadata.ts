import { Prisma, type PrismaClient } from "@prisma/client";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { loadChatUsageTotals } from "./usageTotals";

export const chatTitleMetadataSelect = {
  title: true,
  titleRevision: true,
  titleGeneration: { select: { dispatchedAt: true, expectedTitle: true, expiresAt: true, status: true, titleRevision: true } }
} as const;

type ChatTitleMetadata = Readonly<{
  archived?: boolean;
  title: string;
  titleRevision: number;
  titleGeneration?: Readonly<{
    dispatchedAt: Date | null;
    expectedTitle: string;
    expiresAt: Date;
    status: string;
    titleRevision: number;
  }> | null;
}>;

function titleWorkPending(chat: ChatTitleMetadata): boolean {
  const generation = chat.titleGeneration;
  const deadline = generation?.status === "dispatched"
    ? (generation.dispatchedAt?.getTime() ?? 0) + 60_000 : generation?.expiresAt.getTime() ?? 0;
  return Boolean(!chat.archived && generation && ["pending", "dispatched"].includes(generation.status) && deadline > Date.now());
}

export function chatTitlePending(chat: ChatTitleMetadata): boolean {
  const generation = chat.titleGeneration;
  return Boolean(titleWorkPending(chat) && generation && generation.titleRevision === chat.titleRevision &&
    generation.expectedTitle === chat.title);
}

export function createGetChatTitleHandler(input: Readonly<{
  client: Pick<PrismaClient, "$transaction">;
  resolveAuth: RequestAuthResolver;
}>) {
  return async (request: Request, context: { params: Promise<{ chatId: string }> }): Promise<Response> => {
    const headers = { "Cache-Control": "private, no-store" };
    const auth = await input.resolveAuth(request);
    if (!auth) return Response.json({ error: "unauthorized" }, { headers, status: 401 });
    const { chatId } = await context.params;
    const result = chatId.length <= 200 ? await input.client.$transaction(async tx => {
      const chat = await tx.chat.findFirst({
        select: { ...chatTitleMetadataSelect, updatedAt: true },
        where: { archived: false, id: chatId, permanentDeletionAt: null, projectId: null, userId: auth.userId }
      });
      if (!chat) return null;
      const pending = chatTitlePending(chat);
      const includeUsage = new URL(request.url).searchParams.get("usage") === "1";
      // Presentation expiry does not settle a dispatched provider operation.
      // Keep the existing bounded browser poll until the worker records its
      // terminal accounting, including a long configured response timeout.
      const usagePending = Boolean(chat.titleGeneration &&
        ["pending", "dispatched"].includes(chat.titleGeneration.status));
      const usageStats = includeUsage && !usagePending
        ? await loadChatUsageTotals(tx, chatId) : undefined;
      return { pending, title: chat.title, updatedAt: chat.updatedAt.toISOString(),
        ...(includeUsage ? { usagePending } : {}), ...(usageStats ? { usageStats } : {}) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }) : null;
    return result
      // The title write bumps the chat revision; returning it lets the browser
      // summary follow the server instead of lagging behind it.
      ? Response.json(result, { headers })
      : Response.json({ error: "chat_not_found" }, { headers, status: 404 });
  };
}

import type { PrismaClient } from "@prisma/client";
import type { RequestAuthResolver } from "../auth/requestAuth";

export const chatTitleMetadataSelect = {
  title: true,
  titleRevision: true,
  titleGeneration: { select: { dispatchedAt: true, expectedTitle: true, expiresAt: true, status: true, titleRevision: true } }
} as const;

export function chatTitlePending(chat: Readonly<{
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
}>): boolean {
  const generation = chat.titleGeneration;
  const deadline = generation?.status === "dispatched"
    ? (generation.dispatchedAt?.getTime() ?? 0) + 60_000 : generation?.expiresAt.getTime() ?? 0;
  return Boolean(!chat.archived && generation && ["pending", "dispatched"].includes(generation.status) &&
    deadline > Date.now() && generation.titleRevision === chat.titleRevision &&
    generation.expectedTitle === chat.title);
}

export function createGetChatTitleHandler(input: Readonly<{
  client: Pick<PrismaClient, "chat">;
  resolveAuth: RequestAuthResolver;
}>) {
  return async (request: Request, context: { params: Promise<{ chatId: string }> }): Promise<Response> => {
    const headers = { "Cache-Control": "private, no-store" };
    const auth = await input.resolveAuth(request);
    if (!auth) return Response.json({ error: "unauthorized" }, { headers, status: 401 });
    const { chatId } = await context.params;
    const chat = chatId.length <= 200 ? await input.client.chat.findFirst({
      select: chatTitleMetadataSelect,
      where: { archived: false, id: chatId, permanentDeletionAt: null, projectId: null, userId: auth.userId }
    }) : null;
    return chat
      ? Response.json({ pending: chatTitlePending(chat), title: chat.title }, { headers })
      : Response.json({ error: "chat_not_found" }, { headers, status: 404 });
  };
}

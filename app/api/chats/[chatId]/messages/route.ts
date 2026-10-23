import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createGetChatMessagesPageHandler } from "@/lib/server/chats/handlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";
import { createDefaultSendMessageDeps } from "@/lib/server/runs/defaultSendMessageDeps";
import { createSendMessageHandler } from "@/lib/server/runs/handlers";

export const runtime = "nodejs";

const chatRepository = createPrismaChatRepository();

export const GET: AsyncRouteHandler<ReturnType<typeof createGetChatMessagesPageHandler>> = createGetChatMessagesPageHandler({
  repository: chatRepository,
  resolveAuth: resolveRequestAuth
});

export const POST: AsyncRouteHandler<ReturnType<typeof createSendMessageHandler>> = createSendMessageHandler({
  ...createDefaultSendMessageDeps(),
  resolveAuth: resolveRequestAuth
});

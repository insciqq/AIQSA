import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createCreateChatHandler, createListChatsHandler } from "@/lib/server/chats/handlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";

export const runtime = "nodejs";

const repository = createPrismaChatRepository();

export const GET = createListChatsHandler({
  repository,
  resolveAuth: resolveRequestAuth
});

export const POST = createCreateChatHandler({
  repository,
  resolveAuth: resolveRequestAuth
});

import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createGetChatMessagesPageHandler } from "@/lib/server/chats/handlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";
import { defaultNativeEngineHandlerDeps } from "@/lib/server/engine/defaultEngine";
import { createDefaultSendMessageDeps } from "@/lib/server/runs/defaultSendMessageDeps";
import { createSendMessageHandler } from "@/lib/server/runs/handlers";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";

const chatRepository = createPrismaChatRepository();

export const GET: AsyncRouteHandler<ReturnType<typeof createGetChatMessagesPageHandler>> = createGetChatMessagesPageHandler({
  repository: chatRepository,
  resolveAuth: resolveRequestAuth
});

// Interactive sends only: the native engine takes the pilot's runs (`AIQSA_NATIVE_ENGINE_USERS`).
export const POST: AsyncRouteHandler<ReturnType<typeof createSendMessageHandler>> = createSendMessageHandler({
  ...createDefaultSendMessageDeps(),
  nativeEngine: defaultNativeEngineHandlerDeps(createS3StorageAdapter()),
  resolveAuth: resolveRequestAuth
});

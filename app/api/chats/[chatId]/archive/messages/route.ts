import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createGetArchivedChatMessagesPageHandler } from "@/lib/server/chats/lifecycleHandlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createGetArchivedChatMessagesPageHandler>> = createGetArchivedChatMessagesPageHandler({
  repository: createPrismaChatRepository(),
  resolveAuth: resolveRequestAuth
});

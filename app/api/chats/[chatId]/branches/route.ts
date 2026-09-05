import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createGetChatBranchesHandler } from "@/lib/server/chats/handlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";

export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createGetChatBranchesHandler>> = createGetChatBranchesHandler({
  repository: createPrismaChatRepository(),
  resolveAuth: resolveRequestAuth
});

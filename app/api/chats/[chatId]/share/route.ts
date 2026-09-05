import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createListChatSharesHandler, createShareChatHandler } from "@/lib/server/shares/handlers";
import { createPrismaShareRepository } from "@/lib/server/shares/prismaRepository";

export const runtime = "nodejs";

const repository = createPrismaShareRepository();

export const GET: AsyncRouteHandler<ReturnType<typeof createListChatSharesHandler>> = createListChatSharesHandler({
  repository,
  resolveAuth: resolveRequestAuth
});

export const POST: AsyncRouteHandler<ReturnType<typeof createShareChatHandler>> = createShareChatHandler({
  repository,
  resolveAuth: resolveRequestAuth
});

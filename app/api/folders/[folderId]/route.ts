import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createDeleteFolderHandler, createUpdateFolderHandler } from "@/lib/server/chats/handlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";

export const runtime = "nodejs";

export const PATCH: AsyncRouteHandler<ReturnType<typeof createUpdateFolderHandler>> = createUpdateFolderHandler({
  repository: createPrismaChatRepository(),
  resolveAuth: resolveRequestAuth
});

export const DELETE: AsyncRouteHandler<ReturnType<typeof createDeleteFolderHandler>> = createDeleteFolderHandler({
  repository: createPrismaChatRepository(),
  resolveAuth: resolveRequestAuth
});

import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createDeleteFolderHandler, createUpdateFolderHandler } from "@/lib/server/chats/handlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";

export const runtime = "nodejs";

export const PATCH = createUpdateFolderHandler({
  repository: createPrismaChatRepository(),
  resolveAuth: resolveRequestAuth
});

export const DELETE = createDeleteFolderHandler({
  repository: createPrismaChatRepository(),
  resolveAuth: resolveRequestAuth
});

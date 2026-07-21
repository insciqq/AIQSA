import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createCreateFolderHandler } from "@/lib/server/chats/handlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";

export const runtime = "nodejs";

export const POST = createCreateFolderHandler({
  repository: createPrismaChatRepository(),
  resolveAuth: resolveRequestAuth
});

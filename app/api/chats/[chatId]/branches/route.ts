import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createGetChatBranchesHandler } from "@/lib/server/chats/handlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";

export const runtime = "nodejs";

export const GET = createGetChatBranchesHandler({
  repository: createPrismaChatRepository(),
  resolveAuth: resolveRequestAuth
});

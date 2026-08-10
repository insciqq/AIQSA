import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createPatchChatMemoryModeHandler } from "@/lib/server/chats/lifecycleHandlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const PATCH = createPatchChatMemoryModeHandler({
  repository: createPrismaChatRepository(),
  resolveAuth: resolveRequestAuth
});

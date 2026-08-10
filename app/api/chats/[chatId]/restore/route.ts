import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createRestoreChatHandler } from "@/lib/server/chats/lifecycleHandlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const POST = createRestoreChatHandler({
  repository: createPrismaChatRepository(),
  resolveAuth: resolveRequestAuth
});

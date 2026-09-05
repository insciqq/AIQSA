import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createResolveChatSourceHandler } from "@/lib/server/chats/lifecycleHandlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createResolveChatSourceHandler>> = createResolveChatSourceHandler({
  repository: createPrismaChatRepository(),
  resolveAuth: resolveRequestAuth
});

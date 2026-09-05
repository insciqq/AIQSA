import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";
import { continuationSourceHref } from "@/lib/server/chats/continuationRepository";
import { createContinuationSourceHandler } from "@/lib/server/chats/continuationHandlers";

export const runtime = "nodejs";
export const GET = createContinuationSourceHandler({
  resolveAuth: resolveRequestAuth,
  sourceHref: (chatId, userId) => continuationSourceHref(prisma, chatId, userId)
});

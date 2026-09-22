import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";
import { createPrismaRunFollowupOperations } from "@/lib/server/runs/prismaRepositoryFollowups";
import { createRunFollowupHandler } from "@/lib/server/runs/runFollowupHandler";

export const runtime = "nodejs";
export const POST: AsyncRouteHandler<ReturnType<typeof createRunFollowupHandler>> = createRunFollowupHandler({
  resolveAuth: resolveRequestAuth,
  followups: createPrismaRunFollowupOperations(prisma),
  projectIdForChat: async chatId => (await prisma.chat.findUnique({ where: { id: chatId }, select: { projectId: true } }))?.projectId ?? null
});

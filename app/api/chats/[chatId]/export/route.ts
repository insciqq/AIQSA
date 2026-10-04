import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createExportChatHandler, loadAuthorizedChatExportSource } from "@/lib/server/chats/exportChat";
import { prisma } from "@/lib/server/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createExportChatHandler>> = createExportChatHandler({
  load: (input) => loadAuthorizedChatExportSource(prisma, input),
  resolveAuth: resolveRequestAuth
});

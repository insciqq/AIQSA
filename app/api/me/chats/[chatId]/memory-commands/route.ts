import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";
import { createGetChatMemoryCommandsHandler } from "@/lib/server/memory/commands/handlers";
import { listChatMemoryCommands } from "@/lib/server/memory/commands/projection";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET: AsyncRouteHandler<ReturnType<typeof createGetChatMemoryCommandsHandler>> =
  createGetChatMemoryCommandsHandler({
    resolveAuth: resolveRequestAuth,
    list: (input) => listChatMemoryCommands(prisma, input)
  });

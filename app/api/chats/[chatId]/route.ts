import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createArchiveChatHandler, createGetChatHandler, createUpdateChatHandler } from "@/lib/server/chats/handlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";
import { defaultRunServices } from "@/lib/server/runs/defaultRunServices";
import { activeRunControllerRegistry } from "@/lib/server/runs/runExecution";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";
import { reconcileStaleRuns } from "@/lib/server/runs/runRecovery";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";

const chatRepository = createPrismaChatRepository();
const runRepository = createPrismaRunRepository();
const runServices = defaultRunServices(createS3StorageAdapter());

export const GET: AsyncRouteHandler<ReturnType<typeof createGetChatHandler>> = createGetChatHandler({
  reconcileRuns: (input) =>
    reconcileStaleRuns({
      ...runServices,
      providers: {},
      registry: activeRunControllerRegistry,
      repository: runRepository
    }, input),
  repository: chatRepository,
  resolveAuth: resolveRequestAuth
});

export const PATCH: AsyncRouteHandler<ReturnType<typeof createUpdateChatHandler>> = createUpdateChatHandler({
  repository: chatRepository,
  resolveAuth: resolveRequestAuth
});

export const DELETE: AsyncRouteHandler<ReturnType<typeof createArchiveChatHandler>> = createArchiveChatHandler({
  repository: chatRepository,
  resolveAuth: resolveRequestAuth
});

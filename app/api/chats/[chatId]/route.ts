import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createArchiveChatHandler, createGetChatHandler, createUpdateChatHandler } from "@/lib/server/chats/handlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";
import { providerRuntimeResolver } from "@/lib/server/providerRuntime/defaultRuntime";
import { activeRunControllerRegistry } from "@/lib/server/runs/runExecution";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";
import { reconcileStaleRuns } from "@/lib/server/runs/runRecovery";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";

const chatRepository = createPrismaChatRepository();
const runRepository = createPrismaRunRepository();
const storage = createS3StorageAdapter();

export const GET = createGetChatHandler({
  reconcileRuns: (input) =>
    reconcileStaleRuns({
      providerRuntime: providerRuntimeResolver,
      providers: {},
      registry: activeRunControllerRegistry,
      repository: runRepository,
      storage
    }, input),
  repository: chatRepository,
  resolveAuth: resolveRequestAuth
});

export const PATCH = createUpdateChatHandler({
  repository: chatRepository,
  resolveAuth: resolveRequestAuth
});

export const DELETE = createArchiveChatHandler({
  repository: chatRepository,
  resolveAuth: resolveRequestAuth
});

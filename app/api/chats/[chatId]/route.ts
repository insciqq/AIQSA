import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createArchiveChatHandler, createGetChatHandler, createUpdateChatHandler } from "@/lib/server/chats/handlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";
import { createProviderAdaptersFromEnv } from "@/lib/server/providers/registry";
import { activeRunControllerRegistry } from "@/lib/server/runs/runExecution";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";
import { reconcileStaleRuns } from "@/lib/server/runs/runRecovery";

export const runtime = "nodejs";

const chatRepository = createPrismaChatRepository();
const runRepository = createPrismaRunRepository();
const providers = createProviderAdaptersFromEnv();

export const GET = createGetChatHandler({
  reconcileRuns: (input) =>
    reconcileStaleRuns({
      providers,
      registry: activeRunControllerRegistry,
      repository: runRepository
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

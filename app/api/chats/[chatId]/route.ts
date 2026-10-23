import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createArchiveChatHandler, createGetChatHandler, createUpdateChatHandler } from "@/lib/server/chats/handlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";
import { defaultNativeRecoveryDeps } from "@/lib/server/engine/defaultEngine";
import { reconcileNativeRuns } from "@/lib/server/engine/recovery";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";
import { workspaceCoordinatorForStorage } from "@/lib/server/workspace/defaultServices";

export const runtime = "nodejs";

const chatRepository = createPrismaChatRepository();
// Opening a chat ends its runs that no execution owns any more (a restart cut them off), so it never stays "running".
const runRecovery = defaultNativeRecoveryDeps({
  repository: createPrismaRunRepository(),
  workspace: workspaceCoordinatorForStorage(createS3StorageAdapter())
});

export const GET: AsyncRouteHandler<ReturnType<typeof createGetChatHandler>> = createGetChatHandler({
  reconcileRuns: async (input) => {
    await reconcileNativeRuns(runRecovery, input);
  },
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

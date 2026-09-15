import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";
import { createAcceptedStructuredOutputExecutor } from "@/lib/server/providerRuntime/structuredOutputExecutor";
import { createSystemModelRoleResolver } from "@/lib/server/providerRuntime/systemModelRole";
import { createChatContinuationService } from "@/lib/server/chats/continuation";
import { createChatContinuationRepository } from "@/lib/server/chats/continuationRepository";
import { createChatContinuationHandler } from "@/lib/server/chats/continuationHandlers";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";
import { workspaceRuntime } from "@/lib/server/workspace/defaultServices";

export const runtime = "nodejs";
export const POST = createChatContinuationHandler({
  resolveAuth: resolveRequestAuth,
  continueChat: createChatContinuationService({
    repository: createChatContinuationRepository(prisma, { runtime: workspaceRuntime, storage: createS3StorageAdapter() }),
    execute: createAcceptedStructuredOutputExecutor(prisma),
    resolveSystemModel: () => createSystemModelRoleResolver(prisma).resolve()
  })
});

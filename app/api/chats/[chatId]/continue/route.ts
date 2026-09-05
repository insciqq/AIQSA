import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";
import { createAcceptedStructuredOutputExecutor } from "@/lib/server/providerRuntime/structuredOutputExecutor";
import { createSystemModelRoleResolver } from "@/lib/server/providerRuntime/systemModelRole";
import { createChatContinuationService } from "@/lib/server/chats/continuation";
import { createChatContinuationRepository } from "@/lib/server/chats/continuationRepository";
import { createChatContinuationHandler } from "@/lib/server/chats/continuationHandlers";

export const runtime = "nodejs";
export const POST = createChatContinuationHandler({
  resolveAuth: resolveRequestAuth,
  continueChat: createChatContinuationService({
    repository: createChatContinuationRepository(prisma),
    execute: createAcceptedStructuredOutputExecutor(prisma),
    resolveSystemModel: () => createSystemModelRoleResolver(prisma).resolve()
  })
});

import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createArchiveChatHandler, createGetChatHandler, createUpdateChatHandler } from "@/lib/server/chats/handlers";
import { createPrismaChatRepository } from "@/lib/server/chats/prismaRepository";
import { providerRuntimeResolver } from "@/lib/server/providerRuntime/defaultRuntime";
import { knowledgeToolExecutor } from "@/lib/server/knowledge/defaultRetrieval";
import { knowledgeProviderDispatchLifecycle } from "@/lib/server/knowledge/defaultEvidenceDispatch";
import { knowledgeRunAdmissionService } from "@/lib/server/knowledge/runAdmission";
import { defaultMemoryToolEgressReceiptService } from "@/lib/server/memory/egress/receipts";
import { defaultMcpRunPlan } from "@/lib/server/mcp/defaultRuntime";
import { activeRunControllerRegistry } from "@/lib/server/runs/runExecution";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";
import { reconcileStaleRuns } from "@/lib/server/runs/runRecovery";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";

const chatRepository = createPrismaChatRepository();
const runRepository = createPrismaRunRepository();
const storage = createS3StorageAdapter();

export const GET: AsyncRouteHandler<ReturnType<typeof createGetChatHandler>> = createGetChatHandler({
  reconcileRuns: (input) =>
    reconcileStaleRuns({
      knowledgeAdmission: knowledgeRunAdmissionService,
      knowledgeExecutor: knowledgeToolExecutor,
      knowledgeProviderDispatch: knowledgeProviderDispatchLifecycle,
      memoryEgress: defaultMemoryToolEgressReceiptService,
      mcp: defaultMcpRunPlan,
      providerRuntime: providerRuntimeResolver,
      providers: {},
      registry: activeRunControllerRegistry,
      repository: runRepository,
      storage
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

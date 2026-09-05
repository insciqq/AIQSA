import type { AsyncRouteHandler } from "@/lib/server/http/asyncRouteHandler";
import { getAuthConfig } from "@/lib/server/auth/config";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { providerRuntimeResolver } from "@/lib/server/providerRuntime/defaultRuntime";
import { knowledgeToolExecutor } from "@/lib/server/knowledge/defaultRetrieval";
import { knowledgeProviderDispatchLifecycle } from "@/lib/server/knowledge/defaultEvidenceDispatch";
import { knowledgeRunAdmissionService } from "@/lib/server/knowledge/runAdmission";
import { defaultMemoryToolEgressReceiptService } from "@/lib/server/memory/egress/receipts";
import { defaultMcpRunPlan } from "@/lib/server/mcp/defaultRuntime";
import { providerAdmissionService } from "@/lib/server/providerRuntime/defaultAdmission";
import { createGetModelRunHandler } from "@/lib/server/runs/handlers";
import { createPrismaRunRepository } from "@/lib/server/runs/prismaRepository";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";

const repository = createPrismaRunRepository();

export const GET: AsyncRouteHandler<ReturnType<typeof createGetModelRunHandler>> = createGetModelRunHandler({
  getConfig: () => getAuthConfig(),
  knowledgeAdmission: knowledgeRunAdmissionService,
  knowledgeExecutor: knowledgeToolExecutor,
  knowledgeProviderDispatch: knowledgeProviderDispatchLifecycle,
  memoryEgress: defaultMemoryToolEgressReceiptService,
  mcp: defaultMcpRunPlan,
  providerAdmission: providerAdmissionService,
  providerRuntime: providerRuntimeResolver,
  providers: {},
  repository,
  resolveAuth: resolveRequestAuth,
  storage: createS3StorageAdapter()
});

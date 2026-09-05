import { defaultMcpRunPlan } from "../mcp/defaultRuntime";
import { knowledgeRunAdmissionService } from "../knowledge/runAdmission";
import { knowledgeToolExecutor } from "../knowledge/defaultRetrieval";
import { knowledgeProviderDispatchLifecycle } from "../knowledge/defaultEvidenceDispatch";
import { defaultMemoryToolEgressReceiptService } from "../memory/egress/receipts";
import { prisma } from "../prisma";
import { providerAdmissionService } from "../providerRuntime/defaultAdmission";
import { sameProviderAdmissionPlan } from "../providerRuntime/admission";
import { providerRuntimeResolver } from "../providerRuntime/defaultRuntime";
import { createAcceptedProviderRequestExecutor } from "../providerRuntime/acceptedRequestExecutor";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { serializeRunOutcome } from "../runs/runOutcome";
import { activeRunControllerRegistry } from "../runs/runExecution";
import { workspaceCoordinatorForStorage } from "../workspace/defaultServices";
import { createPrismaChatTitleGenerator } from "../chats/titleGeneration";
import { createChatPdfRouteResolver } from "./chatPdfAdmission";
import { createChatPdfAttempts } from "./chatPdfAttempts";
import { createChatPdfCoordinator } from "./chatPdfCoordinator";
import { createChatPdfRepository } from "./chatPdfPersistence";
import { createChatPdfRunContinuation, type ChatPdfRunSnapshot } from "./chatPdfRunContinuation";
import { createS3StorageAdapter } from "./storage";

function createDefaultChatPdf() {
  const repository = createPrismaRunRepository();
  const pdfRepository = createChatPdfRepository(prisma);
  const storage = createS3StorageAdapter();
  const coordinator = createChatPdfCoordinator({
    attempts: createChatPdfAttempts(prisma), execute: createAcceptedProviderRequestExecutor(prisma),
    registry: activeRunControllerRegistry, repository: pdfRepository, storage,
    async authorize(claim) {
      const loaded = await pdfRepository.load(claim);
      const prepared = (loaded.snapshot as unknown as ChatPdfRunSnapshot).prepared;
      if (!prepared) return false;
      if (prepared.project && !await repository.isProjectRunAccessCurrent?.({ ...prepared.project, userId: claim.userId })) return false;
      if (!prepared.project) return true;
      const expected = prepared.providerAdmissionPlan;
      try {
        const current = await providerAdmissionService.load({ ...expected.selection,
          ...(prepared.project ? { executionScope: "project" as const } : {}),
          requiresClientToolCoexistence: expected.requiresClientToolCoexistence,
          searchPlan: expected.requestedSearchPlan, userId: claim.userId });
        return sameProviderAdmissionPlan(current, expected);
      } catch { return false; }
    },
    continueRun: createChatPdfRunContinuation({
      chatTitleGenerator: createPrismaChatTitleGenerator(),
      knowledgeAdmission: knowledgeRunAdmissionService, knowledgeExecutor: knowledgeToolExecutor,
      knowledgeProviderDispatch: knowledgeProviderDispatchLifecycle, memoryEgress: defaultMemoryToolEgressReceiptService,
      mcp: defaultMcpRunPlan, pdfRepository, providerAdmission: providerAdmissionService,
      providerRuntime: providerRuntimeResolver, repository, storage, workspace: workspaceCoordinatorForStorage(storage)
    }),
    async fail(claim, error) {
      const message = error.code === "pdf_local_text_unusable"
        ? "This PDF could not be read. Try a different file."
        : error.code === "pdf_preparation_context_limit" ? "This document does not fit the conversation context."
        : "Document preparation could not finish. Try again.";
      const settled = await repository.settlePreparingRunFailure({
        errorCode: error.code, message, retryable: error.retryable, runId: claim.runId, state: "FAILED", userId: claim.userId
      });
      if (settled) return;
      const run = await repository.getRunControlForRecovery?.(claim.runId);
      if (run?.status === "streaming" && run.assistantMessageId && await repository.hasPendingPdfPreparation?.(claim.runId)) {
        await repository.failRun(claim.runId, run.assistantMessageId, { code: error.code, message });
      }
    }
  });
  return {
    ...createChatPdfRouteResolver(prisma),
    kick: coordinator.kick,
    async loadRetry(input: Readonly<{ assistantMessageId: string; chatId: string; userId: string; userMessageId: string }>) {
      const job = await prisma.chatPdfRunPreparation.findFirst({ where: {
        state: { in: ["failed", "cancelled"] },
        modelRun: { assistantMessageId: input.assistantMessageId, chatId: input.chatId,
          userId: input.userId, userMessageId: input.userMessageId, status: { in: ["error", "cancelled"] } }
      } });
      if (!job || !await repository.getRunOutcomeForUser(job.modelRunId, input.userId)) return null;
      const snapshot = job.snapshot as unknown as ChatPdfRunSnapshot;
      if (snapshot?.version !== 1 || !snapshot.prepared?.chatPdfAdmissions?.length ||
        snapshot.prepared.normalizedRequest.chatId !== input.chatId) return null;
      try {
        const runtime = await providerRuntimeResolver.resolve(job.modelRunId, "answer");
        return { adapter: runtime.adapter, ...(runtime.toolBridge ? { toolBridge: runtime.toolBridge } : {}),
          prepared: { ...snapshot.prepared, sourceKind: "regenerate" as const, defaults: null, expectedActiveLeafId: null } };
      } catch { return null; }
    },
    async findAdmission(admissionKey: string, userId: string) {
      const job = await prisma.chatPdfRunPreparation.findUnique({ where: { admissionKey },
        select: { modelRun: { select: { id: true, userId: true, userMessageId: true, assistantMessageId: true } } } });
      if (!job || job.modelRun.userId !== userId || !job.modelRun.assistantMessageId) return null;
      const outcome = await repository.getRunOutcomeForUser(job.modelRun.id, userId);
      if (!outcome) return null;
      return { assistantMessageId: job.modelRun.assistantMessageId,
        userMessageId: job.modelRun.userMessageId, ...serializeRunOutcome(outcome) };
    }
  };
}

const globalForChatPdf = globalThis as unknown as { __aiqsaChatPdf?: ReturnType<typeof createDefaultChatPdf> };
export function getDefaultChatPdf() {
  return globalForChatPdf.__aiqsaChatPdf ??= createDefaultChatPdf();
}

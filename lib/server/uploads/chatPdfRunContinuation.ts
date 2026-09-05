import type { ProviderRuntimeResolver } from "../providerRuntime/runtimeResolver";
import type { ParsedDocument } from "../parsing/types";
import type { NormalizedRunRequest } from "../providers/types";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import { loadProviderAttachments } from "../runs/runAttachmentMaterialization";
import { getRunAttachmentLimits } from "../runs/attachmentLimits";
import { applyProviderRequestContextBudget } from "../runs/runContextBudget";
import { createRunExecutionResponse, type RunExecutionInput } from "../runs/runExecution";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import { applyPreparingMaterialization, createPreparingMemoryMaterializer } from "../runs/preparingRunMaterialization";
import type { CreatedRun, PreparingRunAdmissionInput, PreparingRunAdmissionResult, RunRepository } from "../runs/runRepositoryContract";
import { ChatPdfPreparationError, decodeChatPdfArtifact } from "./chatPdfCore";
import type { ChatPdfCoordinatorDependencies } from "./chatPdfCoordinator";
import type { createChatPdfRepository } from "./chatPdfPersistence";
import type { StorageAdapter } from "./storage";

export type ChatPdfRunSnapshot = Readonly<{
  prepared: MaterializedPreparedRunData;
  sourceMessageId?: string;
  version: 1;
}>;

/** Binary originals remain in attachment storage. This private checkpoint is
 * needed only to finish the accepted run or explicitly retry a failed gate. */
export function chatPdfRunSnapshot(prepared: MaterializedPreparedRunData, sourceMessageId?: string): ChatPdfRunSnapshot {
  return { prepared: { ...prepared, providerRequest: { ...prepared.providerRequest, attachments: [] } },
    ...(sourceMessageId ? { sourceMessageId } : {}), version: 1 };
}

type Dependencies = Omit<RunExecutionInput,
  "adapter" | "created" | "prepared" | "repository" | "userId" | "toolBridge" | "searchRuntimes" | "structuredOutputAdapter"> & Readonly<{
  pdfRepository: ReturnType<typeof createChatPdfRepository>;
  providerRuntime: ProviderRuntimeResolver;
  repository: RunRepository;
  storage: StorageAdapter;
}>;

export function createChatPdfRunContinuation(deps: Dependencies): ChatPdfCoordinatorDependencies["continueRun"] {
  return async ({ claim, loaded, releaseRegistry, signal }) => {
    const snapshot = loaded.snapshot as unknown as ChatPdfRunSnapshot;
    const admissionResult = loaded.admissionResult as unknown as PreparingRunAdmissionResult;
    if (snapshot?.version !== 1 || !snapshot.prepared || admissionResult?.runId !== claim.runId ||
      snapshot.prepared.normalizedRequest.chatId !== loaded.modelRun.chatId) {
      throw new ChatPdfPreparationError("pdf_preparation_invalid");
    }
    let prepared = snapshot.prepared;
    const runtime = await deps.providerRuntime.resolve(claim.runId, "answer");
    const records = await deps.repository.loadAttachments(claim.userId, prepared.normalizedRequest.attachmentIds,
      prepared.project?.projectId);
    for (const row of loaded.modelRun.chatPdfAttachments) {
      const original = records.find(({ id }) => id === row.attachmentId);
      if (!original || original.checksum?.trim() !== row.sourceChecksum.trim() || original.byteSize !== row.sourceByteSize) {
        throw new ChatPdfPreparationError("pdf_preparation_invalid");
      }
      if (row.state === "original_only" && prepared.normalizedRequest.workspace?.enabled &&
        loaded.modelRun.workspaceRunBinding && row.route !== "direct_pdf" && !row.documentArtifactId) {
        original.workspaceOriginalOnly = true;
        continue;
      }
      if (row.state !== "ready") throw new ChatPdfPreparationError("pdf_preparation_invalid");
      if (row.route === "direct_pdf") continue;
      if (!row.documentArtifactId) throw new ChatPdfPreparationError("pdf_preparation_invalid");
      const artifact = await deps.pdfRepository.readArtifact(row.documentArtifactId, row.attachmentId);
      if (artifact.kind !== "document" || artifact.preparationGeneration !== claim.runId ||
        artifact.sourceChecksum !== row.sourceChecksum || artifact.route !== row.route) {
        throw new ChatPdfPreparationError("pdf_preparation_invalid");
      }
      const object = await deps.storage.getObject(artifact.storageKey, { maxBytes: artifact.byteSize, signal });
      const document = decodeChatPdfArtifact(object.body, artifact) as ParsedDocument;
      if (typeof document?.text !== "string" || document.pageCount !== row.pageCount) {
        throw new ChatPdfPreparationError("pdf_preparation_invalid");
      }
      original.extractedText = document.text;
      original.status = "ready";
    }
    const attachments = await loadProviderAttachments({ repository: { loadAttachments: async () => records }, storage: deps.storage },
      claim.userId, prepared.normalizedRequest.attachmentIds, { capabilities: prepared.normalizedRequest.modelCapabilities,
        limits: getRunAttachmentLimits(), runId: claim.runId, signal, workspaceEnabled: prepared.normalizedRequest.workspace?.enabled });
    const budget = applyProviderRequestContextBudget({ request: { ...prepared.providerRequest, attachments },
      ...(runtime.toolBridge ? { bridge: runtime.toolBridge } : {}) });
    if (!budget.ok || !budget.request.context) throw new ChatPdfPreparationError("pdf_preparation_context_limit");
    prepared = { ...prepared, contextTruncation: budget.contextTruncation,
      normalizedRequest: { ...prepared.normalizedRequest, context: budget.request.context },
      providerRequest: budget.request, providerRequestPreview: runtime.adapter.buildRequestPreview(budget.request) };
    let created: CreatedRun = { assistantMessageId: admissionResult.assistantMessageId,
      runId: claim.runId, userMessageId: admissionResult.userMessageId };
    if (loaded.modelRun.status === "preparing") {
      if (!deps.repository.continuePdfPreparedRun) throw new ChatPdfPreparationError("pdf_preparation_unavailable");
      const common = { ...prepared, chatId: loaded.modelRun.chatId, modelId: prepared.normalizedRequest.modelId,
        provider: prepared.normalizedRequest.provider, signal, userId: claim.userId,
        memoryMaterializer: createPreparingMemoryMaterializer(prepared, runtime.adapter, runtime.toolBridge) };
      const admission: PreparingRunAdmissionInput = prepared.sourceKind === "send"
        ? { ...common, admissionKind: "NORMAL_SEND", content: prepared.normalizedRequest.content,
            expectedActiveLeafId: prepared.expectedActiveLeafId, defaults: undefined }
        : { ...common, admissionKind: "REGENERATE", preSendAssistantMessageId: snapshot.sourceMessageId ?? null,
            userMessageId: admissionResult.userMessageId, defaults: undefined };
      created = await deps.repository.continuePdfPreparedRun({ admission, claimToken: claim.claimToken, created: admissionResult });
      prepared = applyPreparingMaterialization(prepared, created);
    } else if (loaded.modelRun.status === "streaming" && loaded.state === "answer_ready" && loaded.modelRun.normalizedRequest) {
      // Phase B committed before the crash, but no answer dispatch was claimed.
      const normalizedRequest = loaded.modelRun.normalizedRequest as unknown as NormalizedRunRequest;
      const request = { ...prepared.providerRequest, ...normalizedRequest };
      const finalBudget = applyProviderRequestContextBudget({ request,
        ...(runtime.toolBridge ? { bridge: runtime.toolBridge } : {}) });
      if (!finalBudget.ok) throw new ChatPdfPreparationError("pdf_preparation_context_limit");
      prepared = { ...prepared, normalizedRequest, providerRequest: finalBudget.request,
        providerRequestPreview: runtime.adapter.buildRequestPreview(finalBudget.request) };
    } else throw new ChatPdfPreparationError("pdf_preparation_unavailable");
    signal.throwIfAborted();
    const searchRuntimes: Record<string, ProviderRuntimeBinding> = {};
    for (const option of prepared.normalizedRequest.searchPlan.options) {
      try { searchRuntimes[option.optionId] = await deps.providerRuntime.resolve(claim.runId, "search", `search:${option.optionId}`); }
      catch (error) { if (!(error instanceof Error) || error.message !== "provider_run_binding_not_found") throw error; }
    }
    if (!await deps.pdfRepository.markAnswerDispatched(claim)) throw new ChatPdfPreparationError("pdf_preparation_unavailable");
    releaseRegistry();
    const response = createRunExecutionResponse({ ...deps, adapter: runtime.adapter, created, prepared,
      searchRuntimes, structuredOutputAdapter: runtime.structuredOutputAdapter, toolBridge: runtime.toolBridge, userId: claim.userId });
    // Answer persistence and its controller have taken ownership. Do not hold
    // the single PDF worker for the duration of an ordinary streamed answer.
    void (async () => {
      const reader = response.body?.getReader();
      if (!reader) return;
      try { while (!(await reader.read()).done) { /* Drain private SSE; browser resumes from persisted state. */ } }
      finally { reader.releaseLock(); }
    })().catch(() => undefined);
  };
}

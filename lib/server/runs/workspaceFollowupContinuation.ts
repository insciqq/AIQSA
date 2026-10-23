import type { ChatTitleGenerator } from "../chats/titleGeneration";
import { nativeRunResponse, nativeRunServices, type NativeEngineHandlerDeps } from "../engine/handlerSupport";
import type { NativeRunServices } from "../engine/execution";
import type { ProviderRuntimeResolver } from "../providerRuntime/runtimeResolver";
import type { ProviderRuntimeBinding } from "../providers/runtimeFactory";
import type { StorageAdapter } from "../uploads/storage";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { logEvent } from "../observability";
import { observedFailure } from "../providers/providerObservability";
import { loadProviderAttachments } from "./runAttachmentMaterialization";
import { getRunAttachmentLimits } from "./attachmentLimits";
import { applyPreparingMaterialization, createPreparingMemoryMaterializer } from "./preparingRunMaterialization";
import type { AcceptedRunSnapshot } from "./acceptedRunSnapshot";
import type { CreatedRun, PreparingRunAdmissionInput, PreparingRunAdmissionResult, RunRepository } from "./runRepositoryContract";
import { WorkspaceFollowupError, type createWorkspaceFollowupRepository } from "./workspaceFollowupPersistence";
import type { WorkspaceFollowupCoordinatorDependencies } from "./workspaceFollowupCoordinator";

type Dependencies = Pick<NativeRunServices, "artifacts" | "images" | "mcp" | "memorySearch" | "skillTools" | "vision"> & Readonly<{
  chatTitleGenerator?: ChatTitleGenerator;
  followups: ReturnType<typeof createWorkspaceFollowupRepository>;
  kickPdf(): void;
  nativeEngine: NativeEngineHandlerDeps;
  providerRuntime: ProviderRuntimeResolver;
  repository: RunRepository;
  storage: StorageAdapter;
  workspace?: WorkspaceCoordinator;
}>;

export function createWorkspaceFollowupContinuation(deps: Dependencies): WorkspaceFollowupCoordinatorDependencies["continueRun"] {
  return async ({ claim, loaded, releaseRegistry, signal }) => {
    const snapshot = loaded.snapshot as unknown as AcceptedRunSnapshot;
    const admitted = loaded.admissionResult as unknown as PreparingRunAdmissionResult;
    if (snapshot?.version !== 1 || !snapshot.prepared || admitted?.runId !== claim.runId ||
      snapshot.prepared.sourceKind !== "send" || snapshot.prepared.normalizedRequest.chatId !== loaded.modelRun.chatId) {
      throw new WorkspaceFollowupError("workspace_followup_invalid");
    }
    let prepared = snapshot.prepared;
    // A successor the old core admitted has no engine left to run it; it ends at startup (`retiredEngineRuns.ts`).
    if (loaded.modelRun.engine !== "native") throw new WorkspaceFollowupError("workspace_followup_unavailable");
    const admission = (): PreparingRunAdmissionInput => ({
      ...prepared, admissionKind: "NORMAL_SEND", chatId: loaded.modelRun.chatId,
      content: prepared.normalizedRequest.content, expectedActiveLeafId: prepared.expectedActiveLeafId,
      modelId: prepared.normalizedRequest.modelId, provider: prepared.normalizedRequest.provider,
      defaults: undefined, signal, userId: claim.userId
    });
    if (admitted.deferredPdf && loaded.modelRun.status === "preparing") {
      if (!deps.repository.continueWorkspacePreparedRun) throw new WorkspaceFollowupError("workspace_followup_unavailable");
      const released = await deps.repository.continueWorkspacePreparedRun({
        admission: admission(), claimToken: claim.claimToken, created: admitted
      });
      if (!released.deferredPdf) throw new WorkspaceFollowupError("workspace_followup_invalid");
      releaseRegistry();
      deps.kickPdf();
      return;
    }
    const runtime = await deps.providerRuntime.resolve(claim.runId, "answer");
    const attachments = await loadProviderAttachments({ repository: deps.repository, storage: deps.storage },
      claim.userId, prepared.normalizedRequest.attachmentIds, { capabilities: prepared.normalizedRequest.modelCapabilities,
        limits: getRunAttachmentLimits(), runId: claim.runId, signal, workspaceEnabled: prepared.normalizedRequest.workspace?.enabled });
    // The engine measures and compacts its own context: the run keeps its admitted branch, with its attachments.
    prepared = { ...prepared, providerRequest: { ...prepared.providerRequest, attachments } };
    let created: CreatedRun = { assistantMessageId: admitted.assistantMessageId, runId: claim.runId, userMessageId: admitted.userMessageId };
    if (loaded.modelRun.status === "preparing") {
      if (!deps.repository.continueWorkspacePreparedRun) throw new WorkspaceFollowupError("workspace_followup_unavailable");
      created = await deps.repository.continueWorkspacePreparedRun({
        admission: { ...admission(), memoryMaterializer: createPreparingMemoryMaterializer(prepared, runtime.adapter, runtime.toolBridge) },
        claimToken: claim.claimToken, created: admitted
      });
      prepared = applyPreparingMaterialization(prepared, created);
      // The run's first execution: its wait for the answer began at admission.
      // A run resumed after a crash records no time to first output.
      created = { ...created, acceptedAt: loaded.modelRun.createdAt };
    } else {
      // A successor already past its activation was cut off; recovery ends it, and it is never started twice.
      throw new WorkspaceFollowupError("workspace_followup_invalid");
    }
    const searchRuntimes: Record<string, ProviderRuntimeBinding> = {};
    for (const option of prepared.normalizedRequest.searchPlan.options) {
      try { searchRuntimes[option.optionId] = await deps.providerRuntime.resolve(claim.runId, "search", `search:${option.optionId}`); }
      catch (error) { if (!(error instanceof Error) || error.message !== "provider_run_binding_not_found") throw error; }
    }
    signal.throwIfAborted();
    if (!await deps.followups.markAnswerDispatched(claim)) throw new WorkspaceFollowupError("workspace_followup_unavailable");
    releaseRegistry();
    const entry = snapshot.native;
    const response = nativeRunResponse(deps.nativeEngine, { adapter: runtime.adapter,
      ...(entry?.approvalId ? { approvalId: entry.approvalId } : {}),
      ...(deps.chatTitleGenerator ? { chatTitleGenerator: deps.chatTitleGenerator } : {}), created, prepared,
      repository: deps.repository, searchRuntimes, services: nativeRunServices(deps), ...(entry?.telegram ? { telegram: true } : {}),
      userId: claim.userId, ...(deps.workspace ? { workspace: deps.workspace } : {}) });
    void (async () => {
      const reader = response.body?.getReader();
      if (!reader) return;
      try { while (!(await reader.read()).done) { /* The answer executor owns persistence. */ } }
      finally { reader.releaseLock(); }
    })().catch((error: unknown) => logEvent("run_recovery", { subsystem: "workspace", run_id: claim.runId,
      stage: "drain", outcome: "failed", code: observedFailure(error).code, action: "wait" }));
  };
}

export function createWorkspaceFollowupFailure(deps: Pick<Dependencies, "repository" | "workspace">): WorkspaceFollowupCoordinatorDependencies["fail"] {
  return async (claim, error) => {
    const message = error.code === "workspace_followup_expired"
      ? "Workspace preparation timed out. Retry this message."
      : "Workspace could not finish preparing for this message. Retry when the environment is available.";
    let settled = await deps.repository.settlePreparingRunFailure({ workspaceClaimToken: claim.claimToken,
      errorCode: error.code, message, retryable: true, runId: claim.runId, state: "FAILED", userId: claim.userId });
    if (!settled) {
      const run = await deps.repository.getRunControlForRecovery?.(claim.runId);
      if (run?.status === "streaming" && run.assistantMessageId) settled = await deps.repository.failRun(
        claim.runId, run.assistantMessageId, { code: error.code, message }, { workspaceClaimToken: claim.claimToken });
    }
    // The coordinator checks the operation owner; an unclaimed successor
    // cannot stop or retire its predecessor's Workspace.
    if (settled) await deps.workspace?.settle({ outcome: "failed", runId: claim.runId, userId: claim.userId });
  };
}

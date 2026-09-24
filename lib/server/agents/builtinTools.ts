import { CHECKPOINT_OUTPUTS_TOOL_NAME, checkpointOutputsTool } from "../tools/checkpointOutputs";
import { defaultWorkspaceCheckpoints, type createWorkspaceCheckpoints } from "../workspace/checkpoints";
import { executionFailure } from "../runs/executionFailure";
import type { NormalizedRunRequest } from "../providers/types";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { ARTIFACT_TOOL_NAME, READ_ARTIFACT_TOOL_NAME, artifactTool, readArtifactTool } from "../tools/artifact";
import { defaultArtifactService } from "../artifacts/defaultArtifacts";
import type { ArtifactService } from "../artifacts/service";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import type { createAgentRunStore } from "./store";
import { IMAGE_GENERATION_TOOL_NAME, imageGenerationTool } from "../tools/imageGeneration";
import type { ImageGenerationService } from "../images/service";
import { decodeThreadGeneratedImage } from "@/lib/contracts/imageGeneration";
import { ANALYZE_IMAGE_TOOL_NAME, analyzeImageTool } from "../tools/analyzeImage";
import type { VisionAnalysisService } from "../vision/service";
import type { WorkspaceCoordinator } from "../workspace/coordinator";

export const AGENT_BUILTIN_TOOL_NAMES = [ARTIFACT_TOOL_NAME, READ_ARTIFACT_TOOL_NAME, IMAGE_GENERATION_TOOL_NAME, ANALYZE_IMAGE_TOOL_NAME, CHECKPOINT_OUTPUTS_TOOL_NAME] as const;
export const agentBuiltinTools = (request: NormalizedRunRequest) => [
  ...(request.artifactTool ? [artifactTool(request.artifactToolDescription), readArtifactTool()] : []),
  ...(request.workspace && request.workspaceCheckpoints ? [checkpointOutputsTool] : []),
  ...(request.imagePlan ? [imageGenerationTool(request.imagePlan)] : []),
  ...(request.workspace && request.visionAnalysis ? [analyzeImageTool(request.visionAnalysis)] : [])
];

const imageErrors = new Set(["image_input_invalid", "image_parameters_invalid", "image_reference_unavailable", "image_reference_invalid",
  "image_provider_revoked", "image_binding_unavailable", "image_editing_unavailable", "image_generation_unavailable", "image_tool_budget_exhausted",
  "image_response_invalid", "image_response_too_large", "image_provider_http_error", "image_provider_request_failed", "image_request_timed_out",
  "image_request_cancelled", "image_output_missing"]);

/** Shared domain tools, with one durable claim per gateway delivery. Native
 * Codex remains the only planner; no file path grants host filesystem access. */
export function createAgentBuiltinDispatcher(input: {
  request: NormalizedRunRequest; runId: string; userId: string;
  store: ReturnType<typeof createAgentRunStore>;
  artifacts?: Pick<ArtifactService, "execute">;
  images?: Pick<ImageGenerationService, "execute">;
  vision?: Pick<VisionAnalysisService, "execute">;
  checkpoints?: Pick<ReturnType<typeof createWorkspaceCheckpoints>, "execute" | "restore">;
  workspace?: Pick<WorkspaceCoordinator, "imagePath">;
}) {
  const admitted = new Set(agentBuiltinTools(input.request).map(tool => tool.name));
  const deliver = async (result: ToolExecutionResult, signal: AbortSignal): Promise<ToolExecutionResult> => {
    if (result.name !== IMAGE_GENERATION_TOOL_NAME || result.status !== "complete" || !input.request.workspace || signal.aborted) return result;
    const event = result.artifacts?.find(event => event.type === "artifact" && event.data.artifactType === "image");
    const image = event?.type === "artifact" ? decodeThreadGeneratedImage(event.data.payload) : null;
    if (!image) return result;
    let metadata: Record<string, string>;
    try {
      await input.store.assertActive();
      const workspace = input.workspace ?? (await import("../workspace/defaultServices")).workspaceCoordinatorForStorage(
        (await import("../uploads/storage")).createS3StorageAdapter());
      if (!workspace.imagePath) throw new Error("image_workspace_unavailable");
      const path = await workspace.imagePath({ runId: input.runId, userId: input.userId,
        workspace: input.request.workspace, attachmentId: image.attachmentId, signal });
      metadata = { workspace_path: path };
    } catch {
      metadata = { workspace_error: "image_workspace_unavailable", hint: "The image is saved in chat. Do not generate it again. Workspace staging can be retried on this delivery or a later turn." };
    }
    return { ...result, content: result.content.map(part => part.type === "json" && part.value && typeof part.value === "object"
      ? { ...part, value: { ...part.value, ...metadata } } : part) };
  };
  return async (call: ModelToolCall, signal: AbortSignal): Promise<ToolExecutionResult> => {
    signal.throwIfAborted();
    if (!admitted.has(call.name)) throw new Error("agent_builtin_unavailable");
    const claim = await input.store.claimBuiltinTool(call, hashCanonicalMcpValue(call.arguments));
    if (claim.result) return deliver(claim.result, signal);
    // An active or crash-ambiguous delivery cannot authorize a second write.
    if (!claim.claimed && call.name !== CHECKPOINT_OUTPUTS_TOOL_NAME) return { callId: call.id, name: call.name, status: "error", content: [{ type: "json", value: {
      error: "agent_builtin_in_progress", hint: "This delivery is still pending. Do not repeat a write with a new call ID."
    } }] };
    const context = { request: input.request, userId: input.userId, runId: input.runId, persistedToolCallId: claim.id };
    try {
      if (call.name === CHECKPOINT_OUTPUTS_TOOL_NAME) {
        const checkpoints = input.checkpoints ?? await defaultWorkspaceCheckpoints();
        return await (claim.claimed ? checkpoints.execute(call, context, signal) : checkpoints.restore(call, context, signal));
      }
      if (call.name === ANALYZE_IMAGE_TOOL_NAME) {
        const vision = input.vision ?? (await import("../vision/defaultVision")).visionAnalysisForStorage(
          (await import("../uploads/storage")).createS3StorageAdapter());
        const result = await vision.execute(call, { ...context, request: { ...context.request, attachments: [] } }, signal, {
          beforeDispatch: () => input.store.startBuiltinVision(claim.id),
          assertDispatch: input.store.assertActiveInTransaction,
          beforeSettlement: input.store.lockBuiltinSettlement,
          onResult: (tx, result) => input.store.settleBuiltinToolInTransaction(tx, claim.id, result)
        });
        // Capability and validation failures have no dispatch receipt but still settle their ordinary tool call.
        await input.store.settleBuiltinTool(claim.id, result);
        return result;
      }
      if (call.name === IMAGE_GENERATION_TOOL_NAME) {
        const images = input.images ?? (await import("../images/defaultImages")).imageGenerationForStorage(
          (await import("../uploads/storage")).createS3StorageAdapter());
        const result = await images.execute(call, context, signal, {
          beforeDispatch: () => input.store.startBuiltinImage(claim.id),
          beforeSettlement: input.store.lockBuiltinSettlement,
          onResult: (tx, result) => input.store.settleBuiltinToolInTransaction(tx, claim.id, result)
        });
        return deliver(result, signal);
      }
      const artifacts = input.artifacts ?? defaultArtifactService();
      const result = await artifacts.execute(call, context, { signal,
        assertActive: input.store.assertActiveInTransaction,
        onResult: (tx, result) => input.store.settleBuiltinToolInTransaction(tx, claim.id, result) });
      signal.throwIfAborted();
      await input.store.settleBuiltinTool(claim.id, result);
      return result;
    } catch (error) {
      // READY and its output were committed together. A lost acknowledgement
      // can only restore the exact receipt, never repeat artifact creation.
      const restored = await input.store.builtinResult(claim.id);
      if (restored) return deliver(restored, signal);
      const checkpointFailure = call.name === CHECKPOINT_OUTPUTS_TOOL_NAME ? executionFailure(error) : null;
      const code = checkpointFailure && checkpointFailure.code !== "tool_call_failed" ? checkpointFailure.code
        : call.name === IMAGE_GENERATION_TOOL_NAME && error instanceof Error && imageErrors.has(error.message) ? error.message : "agent_builtin_interrupted";
      const result: ToolExecutionResult = { callId: call.id, name: call.name, status: "error", content: [{ type: "json", value: {
        error: code, hint: checkpointFailure?.message ?? "The operation did not finish. No completed result is available for this delivery. Do not repeat an unconfirmed paid request."
      } }] };
      if (!signal.aborted && (claim.claimed || call.name !== CHECKPOINT_OUTPUTS_TOOL_NAME)) await input.store.settleBuiltinTool(claim.id, result);
      if (code !== "agent_builtin_interrupted") return result;
      throw error;
    }
  };
}

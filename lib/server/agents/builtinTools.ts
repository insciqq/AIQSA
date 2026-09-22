import type { NormalizedRunRequest } from "../providers/types";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { ARTIFACT_TOOL_NAME, READ_ARTIFACT_TOOL_NAME, artifactTool, readArtifactTool } from "../tools/artifact";
import { defaultArtifactService } from "../artifacts/defaultArtifacts";
import type { ArtifactService } from "../artifacts/service";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import type { createAgentRunStore } from "./store";

export const AGENT_BUILTIN_TOOL_NAMES = [ARTIFACT_TOOL_NAME, READ_ARTIFACT_TOOL_NAME] as const;
export const agentBuiltinTools = (request: NormalizedRunRequest) => request.artifactTool
  ? [artifactTool(request.artifactToolDescription), readArtifactTool()] : [];

/** Shared domain tools, with one durable claim per gateway delivery. Native
 * Codex remains the only planner; no file path grants host filesystem access. */
export function createAgentBuiltinDispatcher(input: {
  request: NormalizedRunRequest; runId: string; userId: string;
  store: ReturnType<typeof createAgentRunStore>;
  artifacts?: Pick<ArtifactService, "execute" | "restore">;
}) {
  const admitted = new Set(agentBuiltinTools(input.request).map(tool => tool.name));
  return async (call: ModelToolCall, signal: AbortSignal): Promise<ToolExecutionResult> => {
    signal.throwIfAborted();
    if (!admitted.has(call.name)) throw new Error("agent_builtin_unavailable");
    const claim = await input.store.claimBuiltinTool(call, hashCanonicalMcpValue(call.arguments));
    if (claim.result) return claim.result;
    // An active or crash-ambiguous delivery cannot authorize a second write.
    if (!claim.claimed) return { callId: call.id, name: call.name, status: "error", content: [{ type: "json", value: {
      error: "agent_builtin_in_progress", hint: "This delivery is still pending. Do not repeat a write with a new call ID."
    } }] };
    const artifacts = input.artifacts ?? defaultArtifactService();
    const context = { request: input.request, userId: input.userId, runId: input.runId, persistedToolCallId: claim.id };
    try {
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
      if (restored) return restored;
      const result: ToolExecutionResult = { callId: call.id, name: call.name, status: "error", content: [{ type: "json", value: {
        error: "agent_builtin_interrupted", hint: "The operation did not finish. No completed result is available for this delivery."
      } }] };
      if (!signal.aborted) await input.store.settleBuiltinTool(claim.id, result);
      throw error;
    }
  };
}

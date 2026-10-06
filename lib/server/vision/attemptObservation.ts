import { logEvent } from "../observability";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";

/**
 * One outcome record per Vision analysis attempt: the stable failure code the
 * attempt row stores (absent on success), its duration and the destination's
 * server-owned identity. Never the question, images, analysis or error text.
 * `execution` is the analyze_image tool; `grounding` the Knowledge image description.
 */
export function observeVisionAttempt(input: Readonly<{
  stage: "execution" | "grounding";
  startedAt: number;
  code: string | undefined;
  snapshot?: Pick<ProviderExecutionSnapshot, "connectionId" | "providerFamily" | "providerModelId" | "model">;
}>): void {
  const { code, snapshot } = input;
  logEvent("tool_execution", {
    tool_kind: "vision", stage: input.stage, duration_ms: Math.max(0, performance.now() - input.startedAt),
    outcome: code === undefined ? "completed" : code === "vision_analysis_cancelled" ? "cancelled" : "failed",
    code, reason: code === "vision_analysis_timeout" ? "deadline" : code === "vision_analysis_cancelled" ? "cancelled" : undefined,
    adapterKind: snapshot?.model.adapterKind, connectionId: snapshot?.connectionId,
    providerFamily: snapshot?.providerFamily, providerModelId: snapshot?.providerModelId
  });
}

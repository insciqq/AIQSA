import { logEvent } from "../observability";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";

/** Phase timings of one attempt: preparation until the dispatch claim (or the
 * failure before it), the provider wait once claimed, and the provider deadline applied. */
export type VisionAttemptPhases = Readonly<{ preparationMs?: number; providerMs?: number; timeoutMs?: number }>;

/**
 * One outcome record per Vision analysis attempt: the stable failure code the
 * attempt row stores (absent on success), its duration and the destination's
 * server-owned identity. Never the question, images, analysis or error text.
 * `execution` is the analyze_image tool; `grounding` the Knowledge image description.
 * `provider_duration_ms` is present exactly when the provider was dispatched,
 * for successful, failed and timed-out attempts alike.
 */
export function observeVisionAttempt(input: Readonly<{
  stage: "execution" | "grounding";
  startedAt: number;
  code: string | undefined;
  snapshot?: Pick<ProviderExecutionSnapshot, "connectionId" | "providerFamily" | "providerModelId" | "model">;
  phases?: VisionAttemptPhases;
}>): void {
  const { code, snapshot, phases } = input;
  logEvent("tool_execution", {
    tool_kind: "vision", stage: input.stage, duration_ms: Math.max(0, performance.now() - input.startedAt),
    outcome: code === undefined ? "completed" : code === "vision_analysis_cancelled" ? "cancelled" : "failed",
    code, reason: code === "vision_analysis_timeout" ? "deadline" : code === "vision_analysis_cancelled" ? "cancelled" : undefined,
    ...(phases?.preparationMs === undefined ? {} : { preparation_duration_ms: Math.max(0, phases.preparationMs) }),
    ...(phases?.providerMs === undefined ? {} : { provider_duration_ms: Math.max(0, phases.providerMs) }),
    ...(phases?.timeoutMs === undefined ? {} : { timeout_ms: phases.timeoutMs }),
    adapterKind: snapshot?.model.adapterKind, connectionId: snapshot?.connectionId,
    providerFamily: snapshot?.providerFamily, providerModelId: snapshot?.providerModelId
  });
}

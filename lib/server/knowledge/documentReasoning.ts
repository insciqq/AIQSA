import { supportsConfiguredReasoningEffort } from "../providers/providerModelCapabilities";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";

function fields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Freeze the Documents override in the existing execution snapshot. Default
 * leaves the deployment's exact parameters intact, including legacy profiles. */
export function freezeKnowledgeDocumentReasoning(
  snapshot: ProviderExecutionSnapshot,
  effort: string | null
): ProviderExecutionSnapshot | null {
  if (effort === null) return snapshot;
  if (!supportsConfiguredReasoningEffort(snapshot.model, snapshot.providerFamily, effort)) return null;
  const params = { ...snapshot.model.defaultParams };
  if (snapshot.providerFamily === "anthropic") {
    const outputConfig = { ...fields(params.outputConfig ?? params.output_config) };
    if (effort !== "none") outputConfig.effort = effort;
    else if (outputConfig.effort === "none") delete outputConfig.effort;
    params.outputConfig = outputConfig;
    delete params.output_config;
    params.thinking = {
      ...fields(params.thinking), budgetTokens: 0, enabled: effort !== "none", type: "adaptive"
    };
  } else if (snapshot.providerFamily === "openrouter") {
    const reasoning: Record<string, unknown> = { ...fields(params.reasoning), enabled: effort !== "none" };
    // A budget or verbosity default must not take precedence over the role's
    // explicit level (or make Off continue to request thinking).
    delete reasoning.maxTokens;
    delete reasoning.max_tokens;
    if (typeof params.verbosity === "string" && effort !== "none") {
      params.verbosity = effort;
      delete reasoning.effort;
    } else {
      delete params.verbosity;
      reasoning.effort = effort;
    }
    params.reasoning = reasoning;
  } else {
    params.reasoning = { ...fields(params.reasoning), effort };
  }
  return { ...snapshot, model: { ...snapshot.model, defaultParams: params } };
}

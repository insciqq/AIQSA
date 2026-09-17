import { maxOutputTokensFromParams } from "../../../domain/providerParams";
import { calculateContextBudgetLimits, estimateApproxTokens } from "../../../domain/contextBudget";
import { STRUCTURED_OUTPUT_LIMITS, type ProviderStructuredOutputRequest } from "../../providers/structuredOutput";
import type { MemorySecretFreeExecutionSnapshot } from "./snapshot";

// Separate execution identity: existing history projections remain usable and
// previously accepted bindings retain the former payload/floor behavior.
export const MEMORY_HISTORY_OUTPUT_PIPELINE_VERSION = "memory-history-structured-budget-v1";

export function memoryHistoryOutputRequest(
  snapshot: MemorySecretFreeExecutionSnapshot,
  request: ProviderStructuredOutputRequest
): ProviderStructuredOutputRequest {
  if (snapshot.logicalRole !== "MEMORY_HISTORY_CLASSIFY" ||
    snapshot.compatibilityRequirement.pipelineVersion !== MEMORY_HISTORY_OUTPUT_PIPELINE_VERSION) return request;
  const model = snapshot.providerExecutionSnapshot.model;
  const saved = model.defaultParams.reasoning;
  const settings = typeof saved === "object" && saved !== null && !Array.isArray(saved)
    ? saved as Record<string, unknown> : {};
  const effort = request.reasoningEffort ?? (settings.enabled === false ? "none" :
    typeof settings.effort === "string" ? settings.effort : model.capabilities.defaultReasoningEffort);
  if (effort && (effort !== "none" && !model.capabilities.reasoning ||
    model.capabilities.reasoningEfforts && !model.capabilities.reasoningEfforts.includes(effort))) {
    throw new Error("structured_output_request_invalid");
  }
  const contextWindow = model.capabilities.contextWindow;
  const contextAllowance = contextWindow === undefined ? Infinity :
    calculateContextBudgetLimits({ contextWindow }).budgetTokens - estimateApproxTokens({
      system: request.systemPrompt, user: request.userPrompt, schema: request.schema,
      reminder: request.responseReminder ?? ""
    });
  const ceiling = Math.min(
    STRUCTURED_OUTPUT_LIMITS.maxOutputTokens,
    contextAllowance,
    model.capabilities.maxOutputTokens ?? Infinity,
    maxOutputTokensFromParams(model.defaultParams) ?? model.capabilities.defaultMaxOutputTokens ??
      STRUCTURED_OUTPUT_LIMITS.maxOutputTokens
  );
  // Reasoning can be mandatory/default-on even when no effort was specified.
  // Never infer a token need from the model's name or silently reduce effort.
  const reasoning = model.capabilities.reasoning && effort !== "none";
  const maxOutputTokens = reasoning ? ceiling : Math.min(request.maxOutputTokens ?? 512, ceiling);
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < STRUCTURED_OUTPUT_LIMITS.minOutputTokens) {
    throw new Error("structured_output_request_invalid");
  }
  return { ...request, maxOutputTokens, reasoningBudgetIncluded: true,
    ...(effort ? { reasoningEffort: effort } : {}) };
}

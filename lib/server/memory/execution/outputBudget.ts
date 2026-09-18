import { maxOutputTokensFromParams } from "../../../domain/providerParams";
import { calculateContextBudgetLimits, estimateApproxTokens } from "../../../domain/contextBudget";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import { STRUCTURED_OUTPUT_LIMITS, type ProviderStructuredOutputRequest } from "../../providers/structuredOutput";
import { memoryHistoryOutputRequest } from "./historyOutputBudget";
import type { MemorySecretFreeExecutionSnapshot } from "./snapshot";
import { admittedOutputAllowance, structuredOutputInput } from "../../providers/modelOutputAllowance";

/** Schema and source validation bound the result. Payload estimates must not
 * truncate a valid result; all new Memory generation uses the admitted model
 * allowance, including its reasoning tokens and remaining context. */
export function memoryModelOutputAllowance(snapshot: ProviderExecutionSnapshot, input: unknown): number {
  const model = snapshot.model;
  const contextWindow = model.capabilities.contextWindow;
  const contextAllowance = contextWindow === undefined ? Infinity :
    calculateContextBudgetLimits({ contextWindow }).budgetTokens - estimateApproxTokens(input);
  const ceiling = Math.min(
    STRUCTURED_OUTPUT_LIMITS.maxOutputTokens,
    contextAllowance,
    model.capabilities.maxOutputTokens ?? Infinity,
    maxOutputTokensFromParams(model.defaultParams) ?? model.capabilities.defaultMaxOutputTokens ??
      STRUCTURED_OUTPUT_LIMITS.maxOutputTokens
  );
  if (!Number.isSafeInteger(ceiling) || ceiling < STRUCTURED_OUTPUT_LIMITS.minOutputTokens) {
    throw new Error("structured_output_request_invalid");
  }
  return ceiling;
}

export function memoryStructuredOutputRequest(
  snapshot: MemorySecretFreeExecutionSnapshot,
  request: ProviderStructuredOutputRequest
): ProviderStructuredOutputRequest {
  // Accepted work keeps its original output policy across upgrades/restarts.
  if (snapshot.version === 2) return memoryHistoryOutputRequest(snapshot, request);
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
  if (snapshot.version === 4 && !snapshot.generationBudget) throw new Error("structured_output_request_invalid");
  const maxOutputTokens = snapshot.version === 4
    ? admittedOutputAllowance(snapshot.generationBudget!, structuredOutputInput(request))
    : memoryModelOutputAllowance(snapshot.providerExecutionSnapshot, {
    system: request.systemPrompt, user: request.userPrompt, schema: request.schema,
    reminder: request.responseReminder ?? ""
  });
  return { ...request, maxOutputTokens, reasoningBudgetIncluded: true,
    ...(effort ? { reasoningEffort: effort } : {}) };
}

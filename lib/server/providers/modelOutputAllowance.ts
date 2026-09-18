import { calculateContextBudgetLimits, estimateApproxTokens } from "../../domain/contextBudget";
import { maxOutputTokensFromParams } from "../../domain/providerParams";
import { declaredModelOutputTokenLimit } from "./providerModelCapabilities";
import type { ProviderExecutionSnapshot } from "./runtimeFactory";
import { effectiveProviderResponseTimeoutMs } from "./providerConfiguration";

export const UNKNOWN_MODEL_OUTPUT_ALLOWANCE = 65_536;
export const MIN_UTILITY_OUTPUT_TOKENS = 16;

type ModelBinding = Pick<ProviderExecutionSnapshot, "providerFamily"> & Readonly<{
  model: Pick<ProviderExecutionSnapshot["model"], "adapterKind" | "capabilities" | "defaultParams" | "upstreamModelId">;
}>;

export type ModelGenerationBudget = Readonly<{
  version: 1;
  contextWindow: number | null;
  maxOutputTokens: number;
  timeoutMs: number;
}>;

export function isModelGenerationBudget(value: unknown): value is ModelGenerationBudget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 4 && row.version === 1 &&
    (row.contextWindow === null || Number.isSafeInteger(row.contextWindow) && Number(row.contextWindow) > 0) &&
    Number.isSafeInteger(row.maxOutputTokens) && Number(row.maxOutputTokens) >= MIN_UTILITY_OUTPUT_TOKENS &&
    Number.isSafeInteger(row.timeoutMs) && Number(row.timeoutMs) > 0 && Number(row.timeoutMs) <= 2_147_483_647;
}

export function admitModelGenerationBudget(snapshot: ProviderExecutionSnapshot, explicit?: number | null): ModelGenerationBudget {
  return Object.freeze({ version: 1, contextWindow: snapshot.model.capabilities.contextWindow ?? null,
    maxOutputTokens: modelOutputAllowance(snapshot, "", explicit),
    timeoutMs: effectiveProviderResponseTimeoutMs(snapshot.connection, snapshot.model.adapterKind === "fake" ? null : snapshot.model) });
}

export function admittedOutputAllowance(budget: ModelGenerationBudget, input: unknown): number {
  if (!isModelGenerationBudget(budget)) throw Object.assign(new Error("provider_generation_budget_invalid"), { code: "provider_generation_budget_invalid" });
  const available = budget.contextWindow === null ? Infinity :
    calculateContextBudgetLimits({ contextWindow: budget.contextWindow }).budgetTokens - estimateApproxTokens(input);
  const allowance = Math.min(budget.maxOutputTokens, available);
  if (!Number.isSafeInteger(allowance) || allowance < MIN_UTILITY_OUTPUT_TOKENS) {
    throw Object.assign(new Error("provider_context_limit_exceeded"), { code: "provider_context_limit_exceeded" });
  }
  return allowance;
}

/** An allowance for reasoning and visible output together, not a target length.
 * Only the admitted model's configuration and its actual context can lower it. */
export function modelOutputAllowance(binding: ModelBinding, input: unknown, explicit?: number | null): number {
  const ceiling = declaredModelOutputTokenLimit(binding.model, binding.providerFamily);
  const configured = explicit ?? maxOutputTokensFromParams(binding.model.defaultParams);
  const window = binding.model.capabilities.contextWindow;
  const available = window === undefined ? Infinity :
    calculateContextBudgetLimits({ contextWindow: window }).budgetTokens - estimateApproxTokens(input);
  const allowance = Math.min(configured ?? ceiling ?? UNKNOWN_MODEL_OUTPUT_ALLOWANCE, ceiling ?? Infinity, available);
  if (!Number.isSafeInteger(allowance) || allowance < MIN_UTILITY_OUTPUT_TOKENS) {
    throw Object.assign(new Error("provider_context_limit_exceeded"), { code: "provider_context_limit_exceeded" });
  }
  return allowance;
}

export function structuredOutputInput(request: Readonly<{
  systemPrompt: string; userPrompt: string; schema: unknown; responseReminder?: string;
}>): unknown {
  return { system: request.systemPrompt, user: request.userPrompt, schema: request.schema,
    reminder: request.responseReminder ?? "" };
}

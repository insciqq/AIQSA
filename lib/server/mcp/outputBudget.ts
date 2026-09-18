import { calculateContextBudgetLimits, estimateApproxTokens } from "../../domain/contextBudget";
import { modelOutputAllowance, structuredOutputInput } from "../providers/modelOutputAllowance";
import type { ProviderAdmissionRole } from "../providerRuntime/admission";
import type { ProviderStructuredOutputRequest } from "../providers/structuredOutput";

/** Auto allocates reasoning and JSON together; result size stays schema-bounded. */
export function mcpModelOutputAllowance(role: ProviderAdmissionRole, request: ProviderStructuredOutputRequest): number {
  const model = role.modelConfiguration;
  return modelOutputAllowance({ model: { ...model, upstreamModelId: role.snapshot.model.upstreamModelId },
    providerFamily: role.snapshot.providerFamily }, structuredOutputInput(request));
}

/** Retain the current request and catalog intact; only whole old messages may
 * leave the prompt when the admitted model cannot fit the conversation. */
export function admitMcpRouterRequest(role: ProviderAdmissionRole, request: ProviderStructuredOutputRequest): ProviderStructuredOutputRequest {
  const body = JSON.parse(request.userPrompt) as Record<string, unknown> & { branch_context: unknown[] };
  const history = body.branch_context;
  const withHistory = (count: number) => ({ ...request,
    userPrompt: JSON.stringify({ ...body, branch_context: count ? history.slice(-count) : [] }) });
  const base = withHistory(0);
  const maxOutputTokens = request.maxOutputTokens ?? mcpModelOutputAllowance(role, base);
  const window = role.modelConfiguration.capabilities.contextWindow;
  const available = window === undefined ? Infinity : calculateContextBudgetLimits({ contextWindow: window }).budgetTokens;
  const fits = (candidate: ProviderStructuredOutputRequest) =>
    estimateApproxTokens(structuredOutputInput(candidate)) + maxOutputTokens <= available;
  if (!fits(base)) throw new Error("mcp_router_context_limit");
  let low = 0;
  let high = history.length;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    if (fits(withHistory(count))) low = count;
    else high = count - 1;
  }
  return { ...withHistory(low), maxOutputTokens,
    ...(request.maxOutputTokens === undefined ? { reasoningBudgetIncluded: true } : {}) };
}

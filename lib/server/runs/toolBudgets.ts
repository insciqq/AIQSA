import { createSystemModelRoleResolver } from "../providerRuntime/systemModelRole";
import { effectiveProviderResponseTimeoutMs } from "../providers/providerConfiguration";
import type { NormalizedRunRequest } from "../providers/types";
import { prisma } from "../prisma";
import {
  MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS,
  isMcpDiscoveryOutputBudget,
  MCP_RUN_PLAN_LIMITS
} from "../../contracts/mcp";

export type ToolRunBudgets = Readonly<{
  mcpAutoDiscoveryTimeoutSeconds: number;
  /** Null means pre-field checkpoints derive the old cap from each routing limit. */
  mcpAutoDiscoveryMaxOutputTokens: number | "model" | null;
  maxMcpToolsPerDiscovery: number;
  maxToolCalls: number;
  maxToolRounds: number;
}>;

export const DEFAULT_TOOL_RUN_BUDGETS: ToolRunBudgets = Object.freeze({
  mcpAutoDiscoveryMaxOutputTokens: "model",
  mcpAutoDiscoveryTimeoutSeconds: MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.defaultSeconds,
  maxMcpToolsPerDiscovery: 10,
  maxToolCalls: 20,
  maxToolRounds: 8
});

const LEGACY_TOOL_RUN_BUDGETS: ToolRunBudgets = Object.freeze({
  mcpAutoDiscoveryMaxOutputTokens: null,
  mcpAutoDiscoveryTimeoutSeconds: 60,
  maxMcpToolsPerDiscovery: 5,
  maxToolCalls: 16,
  maxToolRounds: 3
});

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validToolLoopBudgets(value: unknown): value is Readonly<{
  maxToolCalls: number;
  maxToolRounds: number;
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return positiveSafeInteger(candidate.maxToolCalls) &&
    positiveSafeInteger(candidate.maxToolRounds);
}

function valid(value: unknown): value is ToolRunBudgets {
  return validToolLoopBudgets(value) &&
    isMcpDiscoveryOutputBudget((value as Record<string, unknown>).mcpAutoDiscoveryMaxOutputTokens) &&
    positiveSafeInteger((value as Record<string, unknown>).mcpAutoDiscoveryTimeoutSeconds) &&
    Number((value as Record<string, unknown>).mcpAutoDiscoveryTimeoutSeconds) <=
      MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.maxSeconds &&
    positiveSafeInteger((value as Record<string, unknown>).maxMcpToolsPerDiscovery) &&
    Number((value as Record<string, unknown>).maxMcpToolsPerDiscovery) <=
      MCP_RUN_PLAN_LIMITS.maxTools;
}

function validDiscoveryResultBudget(value: unknown): value is Readonly<{
  maxMcpToolsPerDiscovery: number;
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return positiveSafeInteger(candidate.maxMcpToolsPerDiscovery) &&
    Number(candidate.maxMcpToolsPerDiscovery) <= MCP_RUN_PLAN_LIMITS.maxTools;
}

/** Legacy accepted runs retain the limits that were in force before each field was snapshotted. */
export function toolRunBudgetsForRequest(
  request: Pick<NormalizedRunRequest, "toolBudgets"> | Readonly<{ toolBudgets?: unknown }>
): ToolRunBudgets {
  if (valid(request.toolBudgets)) return request.toolBudgets;
  if (validToolLoopBudgets(request.toolBudgets)) {
    const candidate = request.toolBudgets as Record<string, unknown>;
    if (candidate.mcpAutoDiscoveryMaxOutputTokens !== undefined &&
      !isMcpDiscoveryOutputBudget(candidate.mcpAutoDiscoveryMaxOutputTokens)) {
      throw new Error("accepted_tool_budgets_invalid");
    }
    return {
      mcpAutoDiscoveryMaxOutputTokens: (candidate.mcpAutoDiscoveryMaxOutputTokens as number | "model" | undefined) ?? null,
      mcpAutoDiscoveryTimeoutSeconds: positiveSafeInteger(candidate.mcpAutoDiscoveryTimeoutSeconds) &&
        candidate.mcpAutoDiscoveryTimeoutSeconds <= MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.maxSeconds
        ? candidate.mcpAutoDiscoveryTimeoutSeconds
        : LEGACY_TOOL_RUN_BUDGETS.mcpAutoDiscoveryTimeoutSeconds,
      maxMcpToolsPerDiscovery: validDiscoveryResultBudget(request.toolBudgets)
        ? request.toolBudgets.maxMcpToolsPerDiscovery
        : LEGACY_TOOL_RUN_BUDGETS.maxMcpToolsPerDiscovery,
      maxToolCalls: request.toolBudgets.maxToolCalls,
      maxToolRounds: request.toolBudgets.maxToolRounds
    };
  }
  return LEGACY_TOOL_RUN_BUDGETS;
}

export const installationToolBudgetPolicy = {
  async load(): Promise<ToolRunBudgets> {
    const policy = await prisma.modelPolicy.findUnique({
      select: {
        mcpAutoDiscoveryTimeoutSeconds: true,
        mcpAutoDiscoveryMaxOutputTokens: true,
        maxMcpToolsPerDiscovery: true,
        maxToolCalls: true,
        maxToolRounds: true
      },
      where: { id: "installation" }
    });
    if (!policy) throw new Error("installation_model_policy_missing");
    let discoveryTimeoutSeconds = policy.mcpAutoDiscoveryTimeoutSeconds === null ? null : Number(policy.mcpAutoDiscoveryTimeoutSeconds);
    if (discoveryTimeoutSeconds === null) {
      const resolution = await createSystemModelRoleResolver(prisma).resolve();
      discoveryTimeoutSeconds = resolution.ok ? Math.ceil(effectiveProviderResponseTimeoutMs(
        resolution.role.snapshot.connection, resolution.role.snapshot.model.adapterKind === "fake" ? null : resolution.role.snapshot.model) / 1000)
        : MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.defaultSeconds;
    }
    const budgets = {
      mcpAutoDiscoveryTimeoutSeconds: discoveryTimeoutSeconds,
      mcpAutoDiscoveryMaxOutputTokens: policy.mcpAutoDiscoveryMaxOutputTokens === null ? "model" as const : Number(policy.mcpAutoDiscoveryMaxOutputTokens),
      maxMcpToolsPerDiscovery: Number(policy.maxMcpToolsPerDiscovery),
      maxToolCalls: Number(policy.maxToolCalls),
      maxToolRounds: Number(policy.maxToolRounds)
    };
    if (!valid(budgets)) throw new Error("installation_tool_budgets_invalid");
    return budgets;
  }
};

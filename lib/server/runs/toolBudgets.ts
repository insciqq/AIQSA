import type { NormalizedRunRequest } from "../providers/types";
import { prisma } from "../prisma";
import { MCP_RUN_PLAN_LIMITS } from "../../contracts/mcp";
import {
  isToolObservationPolicy,
  type ToolObservationPolicy
} from "../../contracts/toolObservationPolicy";

export type ToolRunBudgets = Readonly<{
  maxMcpToolsPerDiscovery: number;
  maxToolCalls: number;
  maxToolRounds: number;
  /** Operator observation/compaction policy loaded with the installation row,
   * whose column default is `v1`. Absent without that loader. */
  toolObservationPolicy?: ToolObservationPolicy;
}>;

export const DEFAULT_TOOL_RUN_BUDGETS: ToolRunBudgets = Object.freeze({
  maxMcpToolsPerDiscovery: 10,
  maxToolCalls: 80,
  maxToolRounds: 32
});

const LEGACY_TOOL_RUN_BUDGETS: ToolRunBudgets = Object.freeze({
  maxMcpToolsPerDiscovery: 5,
  maxToolCalls: 16,
  maxToolRounds: 3
});

/** The installation default is `v1`; `off` is the operator's kill switch. A
 * value that is absent (no installation policy loaded) or invalid cannot prove
 * that choice, so new admission fails closed to `off`: the legacy path adds no
 * capture, reader or summary. Accepted runs keep their frozen mode either way. */
export function normalizeToolObservationPolicy(value: unknown): ToolObservationPolicy {
  return isToolObservationPolicy(value) ? value : "off";
}

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

function validDiscoveryResultBudget(value: unknown): value is Readonly<{
  maxMcpToolsPerDiscovery: number;
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return positiveSafeInteger(candidate.maxMcpToolsPerDiscovery) &&
    Number(candidate.maxMcpToolsPerDiscovery) <= MCP_RUN_PLAN_LIMITS.maxTools;
}

/** Legacy accepted runs retain the limits that were in force before each
 * field was snapshotted. Retired router allowances (`mcpAutoDiscovery*`) in
 * older accepted requests are ignored. */
export function toolRunBudgetsForRequest(
  request: Pick<NormalizedRunRequest, "toolBudgets"> | Readonly<{ toolBudgets?: unknown }>
): ToolRunBudgets {
  if (!validToolLoopBudgets(request.toolBudgets)) return LEGACY_TOOL_RUN_BUDGETS;
  return {
    maxMcpToolsPerDiscovery: validDiscoveryResultBudget(request.toolBudgets)
      ? request.toolBudgets.maxMcpToolsPerDiscovery
      : LEGACY_TOOL_RUN_BUDGETS.maxMcpToolsPerDiscovery,
    maxToolCalls: request.toolBudgets.maxToolCalls,
    maxToolRounds: request.toolBudgets.maxToolRounds
  };
}

export const installationToolBudgetPolicy = {
  async load(): Promise<ToolRunBudgets> {
    const policy = await prisma.modelPolicy.findUnique({
      select: {
        maxMcpToolsPerDiscovery: true,
        maxToolCalls: true,
        maxToolRounds: true,
        toolObservationPolicy: true
      },
      where: { id: "installation" }
    });
    if (!policy) throw new Error("installation_model_policy_missing");
    const budgets = {
      maxMcpToolsPerDiscovery: Number(policy.maxMcpToolsPerDiscovery),
      maxToolCalls: Number(policy.maxToolCalls),
      maxToolRounds: Number(policy.maxToolRounds),
      toolObservationPolicy: normalizeToolObservationPolicy(policy.toolObservationPolicy)
    };
    if (!validToolLoopBudgets(budgets) || !validDiscoveryResultBudget(budgets)) {
      throw new Error("installation_tool_budgets_invalid");
    }
    return budgets;
  }
};

import type { NormalizedRunRequest } from "../providers/types";
import { prisma } from "../prisma";
import { MCP_RUN_PLAN_LIMITS } from "../../contracts/mcp";
import {
  isToolObservationPolicy,
  type ToolObservationPolicy
} from "../../contracts/toolObservationPolicy";

export type ToolRunBudgets = Readonly<{
  maxMcpToolsPerDiscovery: number;
  /** Null: no call count ends the answer (tool limits off, the installation default). */
  maxToolCalls: number | null;
  /** Null: no round count ends the answer; its time deadline, Stop and the repeat guard still do. */
  maxToolRounds: number | null;
  /** Operator observation/compaction policy loaded with the installation row,
   * whose column default is `v1`. Absent without that loader. */
  toolObservationPolicy?: ToolObservationPolicy;
}>;

/** A new installation's: no tool limits (operator decision 2026-10-26). */
export const DEFAULT_TOOL_RUN_BUDGETS: ToolRunBudgets = Object.freeze({
  maxMcpToolsPerDiscovery: 10,
  maxToolCalls: null,
  maxToolRounds: null
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

/**
 * A Workspace answer's limit: the Workspace allowance raises an installation
 * limit, and no limit stays none.
 */
export function workspaceToolLimit(installation: number | null, workspace: number | undefined): number | null {
  return installation === null ? null : Math.max(installation, workspace ?? installation);
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function budgetRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validToolLoopBudgets(value: unknown): value is Readonly<{
  maxToolCalls: number;
  maxToolRounds: number;
}> {
  const candidate = budgetRecord(value);
  return candidate !== null && positiveSafeInteger(candidate.maxToolCalls) &&
    positiveSafeInteger(candidate.maxToolRounds);
}

/**
 * The explicit no-limit snapshot admission writes while tool limits are off:
 * both counts present as null. Anything else that is not two positive counts
 * is an older request and keeps its legacy limits.
 */
function unlimitedToolLoopBudgets(value: unknown): boolean {
  const candidate = budgetRecord(value);
  return candidate !== null && candidate.maxToolCalls === null && candidate.maxToolRounds === null;
}

function validDiscoveryResultBudget(value: unknown): value is Readonly<{
  maxMcpToolsPerDiscovery: number;
}> {
  const candidate = budgetRecord(value);
  return candidate !== null && positiveSafeInteger(candidate.maxMcpToolsPerDiscovery) &&
    Number(candidate.maxMcpToolsPerDiscovery) <= MCP_RUN_PLAN_LIMITS.maxTools;
}

/** Legacy accepted runs retain the limits that were in force before each
 * field was snapshotted. Retired router allowances (`mcpAutoDiscovery*`) in
 * older accepted requests are ignored. */
export function toolRunBudgetsForRequest(
  request: Pick<NormalizedRunRequest, "toolBudgets"> | Readonly<{ toolBudgets?: unknown }>
): ToolRunBudgets {
  const budgets: unknown = request.toolBudgets;
  const unlimited = unlimitedToolLoopBudgets(budgets);
  if (!unlimited && !validToolLoopBudgets(budgets)) return LEGACY_TOOL_RUN_BUDGETS;
  return {
    maxMcpToolsPerDiscovery: validDiscoveryResultBudget(budgets)
      ? budgets.maxMcpToolsPerDiscovery
      : LEGACY_TOOL_RUN_BUDGETS.maxMcpToolsPerDiscovery,
    maxToolCalls: validToolLoopBudgets(budgets) ? budgets.maxToolCalls : null,
    maxToolRounds: validToolLoopBudgets(budgets) ? budgets.maxToolRounds : null
  };
}

export const installationToolBudgetPolicy = {
  async load(): Promise<ToolRunBudgets> {
    const policy = await prisma.modelPolicy.findUnique({
      select: {
        maxMcpToolsPerDiscovery: true,
        maxToolCalls: true,
        maxToolRounds: true,
        toolLimitsEnabled: true,
        toolObservationPolicy: true
      },
      where: { id: "installation" }
    });
    if (!policy) throw new Error("installation_model_policy_missing");
    const budgets = {
      maxMcpToolsPerDiscovery: Number(policy.maxMcpToolsPerDiscovery),
      // Off, the saved numbers are only what turning the limits on applies.
      maxToolCalls: policy.toolLimitsEnabled ? Number(policy.maxToolCalls) : null,
      maxToolRounds: policy.toolLimitsEnabled ? Number(policy.maxToolRounds) : null,
      toolObservationPolicy: normalizeToolObservationPolicy(policy.toolObservationPolicy)
    };
    if (!validDiscoveryResultBudget(budgets) || policy.toolLimitsEnabled && !validToolLoopBudgets(budgets)) {
      throw new Error("installation_tool_budgets_invalid");
    }
    return budgets;
  }
};

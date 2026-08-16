import type { NormalizedRunRequest } from "../providers/types";
import { prisma } from "../prisma";

export type ToolRunBudgets = Readonly<{
  maxToolCalls: number;
  maxToolRounds: number;
}>;

export const DEFAULT_TOOL_RUN_BUDGETS: ToolRunBudgets = Object.freeze({
  maxToolCalls: 20,
  maxToolRounds: 8
});

const LEGACY_TOOL_RUN_BUDGETS: ToolRunBudgets = Object.freeze({
  maxToolCalls: 16,
  maxToolRounds: 3
});

function valid(value: unknown): value is ToolRunBudgets {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Number.isSafeInteger(candidate.maxToolCalls) && Number(candidate.maxToolCalls) > 0 &&
    Number.isSafeInteger(candidate.maxToolRounds) && Number(candidate.maxToolRounds) > 0;
}

/** Legacy accepted runs retain the limits that were in force before snapshots existed. */
export function toolRunBudgetsForRequest(request: NormalizedRunRequest): ToolRunBudgets {
  return valid(request.toolBudgets)
    ? request.toolBudgets
    : LEGACY_TOOL_RUN_BUDGETS;
}

export const installationToolBudgetPolicy = {
  async load(): Promise<ToolRunBudgets> {
    const policy = await prisma.modelPolicy.findUnique({
      select: { maxToolCalls: true, maxToolRounds: true },
      where: { id: "installation" }
    });
    if (!policy) throw new Error("installation_model_policy_missing");
    const budgets = {
      maxToolCalls: Number(policy.maxToolCalls),
      maxToolRounds: Number(policy.maxToolRounds)
    };
    if (!valid(budgets)) throw new Error("installation_tool_budgets_invalid");
    return budgets;
  }
};

import { describe, expect, it } from "vitest";
import type { NormalizedRunRequest } from "../providers/types";
import {
  DEFAULT_TOOL_RUN_BUDGETS,
  normalizeToolObservationPolicy,
  toolRunBudgetsForRequest
} from "./toolBudgets";

describe("accepted tool budgets", () => {
  it("uses the exact accepted snapshot", () => {
    expect(toolRunBudgetsForRequest({
      toolBudgets: { maxMcpToolsPerDiscovery: 10, maxToolCalls: 200, maxToolRounds: 17 }
    } as NormalizedRunRequest)).toEqual({ maxMcpToolsPerDiscovery: 10, maxToolCalls: 200, maxToolRounds: 17 });
  });

  it.each([
    { mcpAutoDiscoveryTimeoutSeconds: 60, mcpAutoDiscoveryMaxOutputTokens: 4096 },
    { mcpAutoDiscoveryTimeoutSeconds: 19, mcpAutoDiscoveryMaxOutputTokens: "model" },
    { mcpAutoDiscoveryMaxOutputTokens: null }
  ])("ignores retired router allowances in older accepted requests: %o", (retired) => {
    expect(toolRunBudgetsForRequest({ toolBudgets: {
      ...retired, maxMcpToolsPerDiscovery: 120, maxToolCalls: 31, maxToolRounds: 9
    } })).toEqual({ maxMcpToolsPerDiscovery: 120, maxToolCalls: 31, maxToolRounds: 9 });
  });

  it.each([
    { maxToolCalls: 20, maxToolRounds: 8 },
    { maxToolCalls: 80, maxToolRounds: 40 }
  ])("keeps pre-increase accepted budgets unchanged: %o", (accepted) => {
    const toolBudgets = { ...DEFAULT_TOOL_RUN_BUDGETS, ...accepted };
    expect(toolRunBudgetsForRequest({ toolBudgets })).toEqual(toolBudgets);
  });

  it("preserves the pre-policy limits for legacy accepted runs", () => {
    expect(toolRunBudgetsForRequest({} as NormalizedRunRequest)).toEqual({
      maxMcpToolsPerDiscovery: 5,
      maxToolCalls: 16,
      maxToolRounds: 3
    });
    expect(toolRunBudgetsForRequest({ toolBudgets: { maxToolCalls: 7, maxToolRounds: 2 } }))
      .toEqual({ maxMcpToolsPerDiscovery: 5, maxToolCalls: 7, maxToolRounds: 2 });
    expect(DEFAULT_TOOL_RUN_BUDGETS).toEqual({
      maxMcpToolsPerDiscovery: 10,
      maxToolCalls: 80,
      maxToolRounds: 32
    });
    // Without the installation policy the observation mode is unproven.
    expect(normalizeToolObservationPolicy(DEFAULT_TOOL_RUN_BUDGETS.toolObservationPolicy)).toBe("off");
  });

  it.each([undefined, null, "future"])("fails closed for an invalid rollout policy: %s", value => {
    expect(normalizeToolObservationPolicy(value)).toBe("off");
  });

  it("accepts only the two rollout modes", () => {
    expect(normalizeToolObservationPolicy("off")).toBe("off");
    expect(normalizeToolObservationPolicy("v1")).toBe("v1");
  });
});

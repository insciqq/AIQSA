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
      toolBudgets: {
        mcpAutoDiscoveryTimeoutSeconds: 60,
        mcpAutoDiscoveryMaxOutputTokens: 4096,
        maxMcpToolsPerDiscovery: 10,
        maxToolCalls: 200,
        maxToolRounds: 17
      }
    } as NormalizedRunRequest)).toEqual({
      mcpAutoDiscoveryTimeoutSeconds: 60,
      mcpAutoDiscoveryMaxOutputTokens: 4096,
      maxMcpToolsPerDiscovery: 10,
      maxToolCalls: 200,
      maxToolRounds: 17
    });
  });

  it("retains the old per-route calculation marker and the other frozen policy fields", () => {
    expect(toolRunBudgetsForRequest({ toolBudgets: {
      mcpAutoDiscoveryTimeoutSeconds: 19, maxMcpToolsPerDiscovery: 120,
      maxToolCalls: 31, maxToolRounds: 9
    } })).toEqual({ mcpAutoDiscoveryTimeoutSeconds: 19, mcpAutoDiscoveryMaxOutputTokens: null,
      maxMcpToolsPerDiscovery: 120, maxToolCalls: 31, maxToolRounds: 9 });
  });

  it.each([null, 0, 1023, 65537, 4096.5, "8192"])("rejects an invalid persisted output allowance: %s", (value) => {
    expect(() => toolRunBudgetsForRequest({ toolBudgets: {
      ...DEFAULT_TOOL_RUN_BUDGETS, mcpAutoDiscoveryMaxOutputTokens: value
    } })).toThrow("accepted_tool_budgets_invalid");
  });

  it("preserves the pre-policy limits for legacy accepted runs", () => {
    expect(toolRunBudgetsForRequest({} as NormalizedRunRequest)).toEqual({
      mcpAutoDiscoveryTimeoutSeconds: 60,
      mcpAutoDiscoveryMaxOutputTokens: null,
      maxMcpToolsPerDiscovery: 5,
      maxToolCalls: 16,
      maxToolRounds: 3
    });
    expect(DEFAULT_TOOL_RUN_BUDGETS).toEqual({
      mcpAutoDiscoveryTimeoutSeconds: 300,
      mcpAutoDiscoveryMaxOutputTokens: "model",
      maxMcpToolsPerDiscovery: 10,
      maxToolCalls: 20,
      maxToolRounds: 8
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

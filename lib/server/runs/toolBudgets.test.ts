import { describe, expect, it } from "vitest";
import type { NormalizedRunRequest } from "../providers/types";
import {
  DEFAULT_TOOL_RUN_BUDGETS,
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
      mcpAutoDiscoveryTimeoutSeconds: 60,
      mcpAutoDiscoveryMaxOutputTokens: 8192,
      maxMcpToolsPerDiscovery: 10,
      maxToolCalls: 20,
      maxToolRounds: 8
    });
  });
});

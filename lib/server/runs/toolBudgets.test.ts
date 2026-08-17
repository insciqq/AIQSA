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
        maxMcpToolsPerDiscovery: 10,
        maxToolCalls: 200,
        maxToolRounds: 17
      }
    } as NormalizedRunRequest)).toEqual({
      mcpAutoDiscoveryTimeoutSeconds: 60,
      maxMcpToolsPerDiscovery: 10,
      maxToolCalls: 200,
      maxToolRounds: 17
    });
  });

  it("preserves the pre-policy limits for legacy accepted runs", () => {
    expect(toolRunBudgetsForRequest({} as NormalizedRunRequest)).toEqual({
      mcpAutoDiscoveryTimeoutSeconds: 60,
      maxMcpToolsPerDiscovery: 5,
      maxToolCalls: 16,
      maxToolRounds: 3
    });
    expect(DEFAULT_TOOL_RUN_BUDGETS).toEqual({
      mcpAutoDiscoveryTimeoutSeconds: 60,
      maxMcpToolsPerDiscovery: 10,
      maxToolCalls: 20,
      maxToolRounds: 8
    });
  });
});

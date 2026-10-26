import { describe, expect, it, vi } from "vitest";
import type { NormalizedRunRequest } from "../providers/types";
import {
  DEFAULT_TOOL_RUN_BUDGETS,
  installationToolBudgetPolicy,
  normalizeToolObservationPolicy,
  toolRunBudgetsForRequest,
  workspaceToolLimit
} from "./toolBudgets";

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("../prisma", () => ({ prisma: { modelPolicy: { findUnique } } }));

describe("installation tool budgets for admission", () => {
  const row = (toolLimitsEnabled: boolean, maxToolCalls = 80n) => ({ maxMcpToolsPerDiscovery: 10n, maxToolCalls,
    maxToolRounds: 32n, toolLimitsEnabled, toolObservationPolicy: "v1" });

  it("admits no limits while they are off, whatever numbers are saved", async () => {
    findUnique.mockResolvedValueOnce(row(false));
    await expect(installationToolBudgetPolicy.load()).resolves.toEqual({ maxMcpToolsPerDiscovery: 10, maxToolCalls: null,
      maxToolRounds: null, toolObservationPolicy: "v1" });
  });

  it("admits the saved numbers once an administrator turned the limits on", async () => {
    findUnique.mockResolvedValueOnce(row(true));
    await expect(installationToolBudgetPolicy.load()).resolves.toEqual({ maxMcpToolsPerDiscovery: 10, maxToolCalls: 80,
      maxToolRounds: 32, toolObservationPolicy: "v1" });
  });

  it("refuses admission on a policy it cannot read as limits", async () => {
    findUnique.mockResolvedValueOnce(row(true, 0n));
    await expect(installationToolBudgetPolicy.load()).rejects.toThrow("installation_tool_budgets_invalid");
    findUnique.mockResolvedValueOnce(null);
    await expect(installationToolBudgetPolicy.load()).rejects.toThrow("installation_model_policy_missing");
  });
});

describe("accepted tool budgets", () => {
  it("uses the exact accepted snapshot", () => {
    expect(toolRunBudgetsForRequest({
      toolBudgets: { maxMcpToolsPerDiscovery: 10, maxToolCalls: 200, maxToolRounds: 17 }
    } as NormalizedRunRequest)).toEqual({ maxMcpToolsPerDiscovery: 10, maxToolCalls: 200, maxToolRounds: 17 });
  });

  it("reads the explicit no-limit snapshot as no limits, never as the legacy ones", () => {
    expect(toolRunBudgetsForRequest({ toolBudgets: { maxMcpToolsPerDiscovery: 12, maxToolCalls: null, maxToolRounds: null } }))
      .toEqual({ maxMcpToolsPerDiscovery: 12, maxToolCalls: null, maxToolRounds: null });
    // The MCP Auto tool count of such a snapshot follows the same rules as a limited one.
    expect(toolRunBudgetsForRequest({ toolBudgets: { maxToolCalls: null, maxToolRounds: null } }))
      .toEqual({ maxMcpToolsPerDiscovery: 5, maxToolCalls: null, maxToolRounds: null });
    // A new installation admits exactly that snapshot.
    expect(toolRunBudgetsForRequest({ toolBudgets: DEFAULT_TOOL_RUN_BUDGETS })).toEqual(DEFAULT_TOOL_RUN_BUDGETS);
    expect(DEFAULT_TOOL_RUN_BUDGETS).toEqual({ maxMcpToolsPerDiscovery: 10, maxToolCalls: null, maxToolRounds: null });
  });

  it.each([
    { maxMcpToolsPerDiscovery: 10, maxToolCalls: null },
    { maxMcpToolsPerDiscovery: 10, maxToolRounds: null },
    { maxMcpToolsPerDiscovery: 10, maxToolCalls: null, maxToolRounds: 8 },
    { maxMcpToolsPerDiscovery: 10, maxToolCalls: 0, maxToolRounds: null }
  ])("keeps the legacy limits for a snapshot that is not explicitly unlimited: %o", (toolBudgets) => {
    expect(toolRunBudgetsForRequest({ toolBudgets })).toEqual({ maxMcpToolsPerDiscovery: 5, maxToolCalls: 16, maxToolRounds: 3 });
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
    { maxToolCalls: 80, maxToolRounds: 32 },
    { maxToolCalls: 80, maxToolRounds: 40 }
  ])("keeps accepted limited budgets unchanged: %o", (accepted) => {
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
    // Without the installation policy the observation mode is unproven.
    expect(normalizeToolObservationPolicy(DEFAULT_TOOL_RUN_BUDGETS.toolObservationPolicy)).toBe("off");
  });

  it("lets a Workspace allowance raise a limit and never invent one", () => {
    expect(workspaceToolLimit(80, 320)).toBe(320);
    expect(workspaceToolLimit(400, 320)).toBe(400);
    expect(workspaceToolLimit(80, undefined)).toBe(80);
    expect(workspaceToolLimit(null, 320)).toBeNull();
  });

  it.each([undefined, null, "future"])("fails closed for an invalid rollout policy: %s", value => {
    expect(normalizeToolObservationPolicy(value)).toBe("off");
  });

  it("accepts only the two rollout modes", () => {
    expect(normalizeToolObservationPolicy("off")).toBe("off");
    expect(normalizeToolObservationPolicy("v1")).toBe("v1");
  });
});

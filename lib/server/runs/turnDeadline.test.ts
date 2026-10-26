import { describe, expect, it } from "vitest";
import { MCP_RUNTIME_TIMEOUT_LIMITS } from "../../contracts/mcp";
import type { McpDiscoveryState, McpRunPlanSnapshot } from "../mcp/runPlan";
import type { NormalizedRunRequest, NormalizedSearchPlanOption } from "../providers/types";
import { getWorkspaceConfig } from "../workspace/config";
import { longestToolCallMs, turnSoftDeadlineMs } from "./turnDeadline";

type Bounds = Parameters<typeof longestToolCallMs>[0];
const bare: Bounds = { searchPlan: { mode: "all_selected", options: [] } };
const timeouts = (callTimeoutMs: number) => ({ callTimeoutMs, startupTimeoutMs: 60_000 });
const loaded = (callTimeoutMs: number): McpRunPlanSnapshot => ({ servers: [{ fingerprint: "fp", revisionId: "rev", serverId: "jira",
  serverName: "Jira", runtimeTimeouts: timeouts(callTimeoutMs) }], tools: [], version: 1 });
const catalog = (callTimeoutMs: number): McpDiscoveryState => ({ catalog: { servers: [{ description: "", namespace: "wiki",
  revisionId: "rev", serverId: "wiki", serverName: "Wiki", tools: [], runtimeTimeouts: timeouts(callTimeoutMs) }], version: 1 },
  epochs: [], version: 2 });
const searchSource = (config: Record<string, unknown>) => ({ config }) as unknown as NormalizedSearchPlanOption;
const imagePlan = (responseTimeoutMs: number) => ({ snapshot: { connection: { responseTimeoutMs }, model: {} } }) as unknown as
  NonNullable<NormalizedRunRequest["imagePlan"]>;

describe("turn soft deadline", () => {
  it("lets a default turn work for 51 of its 60 minutes before it must answer, with or without a Workspace", () => {
    const config = getWorkspaceConfig({});
    const workspace = { syncToolTimeoutSeconds: config.syncToolTimeoutSeconds } as NormalizedRunRequest["workspace"];
    expect(longestToolCallMs(bare)).toBe(MCP_RUNTIME_TIMEOUT_LIMITS.defaultCallMs);
    expect(turnSoftDeadlineMs(3_600_000, longestToolCallMs(bare))).toBe(3_060_000);
    expect(turnSoftDeadlineMs(config.turnTimeoutSeconds * 1_000, longestToolCallMs({ ...bare, workspace }))).toBe(3_060_000);
  });

  it("follows the turn and keeps half of a short one for work", () => {
    // A scheduled run's 30-minute occurrence answers from 21 minutes.
    expect(turnSoftDeadlineMs(1_800_000, 300_000)).toBe(1_260_000);
    expect(turnSoftDeadlineMs(7_200_000, 300_000)).toBe(6_660_000);
    expect(turnSoftDeadlineMs(300_000, 300_000)).toBe(150_000);
    expect(turnSoftDeadlineMs(3_600_000, 2_147_483_647)).toBe(1_800_000);
  });

  it("sizes the reserve from the longest call the run's frozen bounds allow", () => {
    expect(longestToolCallMs({ ...bare, mcp: loaded(600_000) })).toBe(600_000);
    expect(longestToolCallMs({ ...bare, mcpDiscovery: catalog(1_200_000) })).toBe(1_200_000);
    expect(longestToolCallMs({ searchPlan: { mode: "all_selected", options: [searchSource({ timeoutMs: 900_000 })] } })).toBe(900_000);
    expect(longestToolCallMs({ ...bare, imagePlan: imagePlan(1_500_000) })).toBe(1_500_000);
    expect(longestToolCallMs({ mcp: loaded(600_000), mcpDiscovery: catalog(60_000), imagePlan: imagePlan(300_000),
      searchPlan: { mode: "all_selected", options: [searchSource({ timeoutMs: 700_000 }), searchSource({})] } })).toBe(700_000);
    // A turn of an hour then answers from 46 minutes: a ten-minute call and the tail fit before the deadline.
    expect(turnSoftDeadlineMs(3_600_000, longestToolCallMs({ ...bare, mcp: loaded(600_000) }))).toBe(2_760_000);
  });

  it("never sizes the reserve below MCP's default call, whatever shorter or malformed bounds the run froze", () => {
    expect(longestToolCallMs({ mcp: loaded(30_000), mcpDiscovery: catalog(Number.NaN), imagePlan: imagePlan(Number.NaN),
      searchPlan: { mode: "all_selected", options: [searchSource({ timeoutMs: 5_000 }), searchSource({ timeoutMs: -1 })] },
      workspace: { syncToolTimeoutSeconds: 30 } as NormalizedRunRequest["workspace"] })).toBe(300_000);
  });
});

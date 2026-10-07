import { describe, expect, it } from "vitest";
import { AGENT_GATEWAY_ORIGIN } from "../agents/relay";
import {
  isWorkspaceCodeInvocationId,
  parseWorkspaceRunEnvironment,
  workspaceCodeMcpEligibility,
  WORKSPACE_CODE_GATEWAY_ENV,
  WORKSPACE_CODE_TOKEN_ENV,
  WORKSPACE_CODE_UNAVAILABLE_ENV
} from "./codeMcp";

const budgets = { version: 1, maxCalls: 200, maxConcurrent: 4, maxPerSecond: 10 } as const;
const catalog = { catalog: { servers: [{ tools: [{ namespacedName: "mcp_tracker_list_0000000000" }] }] } };

describe("guest-code MCP eligibility", () => {
  it("grants code access only to personal Internet-On, gateway-capable, non-Agent runs with MCP authority", () => {
    const eligible = { workspace: { codeMcp: budgets, internetEnabled: true }, mcpDiscovery: catalog };
    expect(workspaceCodeMcpEligibility(eligible)).toEqual({ kind: "eligible", budgets });
    expect(workspaceCodeMcpEligibility({ ...eligible, project: false })).toEqual({ kind: "eligible", budgets });
    expect(workspaceCodeMcpEligibility({ workspace: eligible.workspace, mcp: { tools: [{}] } }))
      .toEqual({ kind: "eligible", budgets });
    // Agent runs keep their own bearer and gateway surface.
    expect(workspaceCodeMcpEligibility({ ...eligible, agent: { mcpMode: "auto" } })).toEqual({ kind: "agent" });
    // Members share a Project chat's Workspace: whatever else holds, its runs get no bearer.
    for (const request of [eligible, { ...eligible, workspace: { ...eligible.workspace, internetEnabled: false } }, { workspace: null }]) {
      expect(workspaceCodeMcpEligibility({ ...request, project: true }))
        .toEqual({ kind: "unavailable", reason: "project_unsupported" });
    }
    expect(workspaceCodeMcpEligibility({ ...eligible, workspace: { ...eligible.workspace, internetEnabled: false } }))
      .toEqual({ kind: "unavailable", reason: "internet_off" });
    // Runs admitted before the gateway was reachable, or with a malformed marker.
    for (const codeMcp of [undefined, { ...budgets, maxCalls: 0 }, { ...budgets, extra: 1 }, { ...budgets, version: 2 }]) {
      expect(workspaceCodeMcpEligibility({ ...eligible, workspace: { codeMcp, internetEnabled: true } }))
        .toEqual({ kind: "unavailable", reason: "gateway_unavailable" });
    }
    // MCP Off, Load all without tools, or an Auto catalog without tools.
    for (const authority of [{}, { mcp: { tools: [] } }, { mcpDiscovery: { catalog: { servers: [{ tools: [] }] } } }]) {
      expect(workspaceCodeMcpEligibility({ workspace: eligible.workspace, ...authority }))
        .toEqual({ kind: "unavailable", reason: "mcp_off" });
    }
  });

  it("accepts only exact invocation ids", () => {
    expect(isWorkspaceCodeInvocationId("a".repeat(32))).toBe(true);
    for (const value of ["A".repeat(32), "a".repeat(31), "a".repeat(33), "g".repeat(32), 1, null, undefined]) {
      expect(isWorkspaceCodeInvocationId(value)).toBe(false);
    }
  });
});

describe("run environment for guest commands", () => {
  const token = "t".repeat(43);

  it("accepts a bearer with the runner's own relay origin, or a reason, or nothing", () => {
    expect(parseWorkspaceRunEnvironment(undefined, AGENT_GATEWAY_ORIGIN)).toEqual({});
    expect(parseWorkspaceRunEnvironment({}, AGENT_GATEWAY_ORIGIN)).toEqual({});
    const bearer = { [WORKSPACE_CODE_TOKEN_ENV]: token, [WORKSPACE_CODE_GATEWAY_ENV]: AGENT_GATEWAY_ORIGIN };
    expect(parseWorkspaceRunEnvironment(bearer, AGENT_GATEWAY_ORIGIN)).toEqual(bearer);
    for (const reason of ["internet_off", "gateway_unavailable", "mcp_off", "project_unsupported"]) {
      expect(parseWorkspaceRunEnvironment({ [WORKSPACE_CODE_UNAVAILABLE_ENV]: reason }, AGENT_GATEWAY_ORIGIN))
        .toEqual({ [WORKSPACE_CODE_UNAVAILABLE_ENV]: reason });
    }
  });

  it("refuses foreign names, malformed values, another gateway and mixed shapes", () => {
    for (const value of [
      null, [], "AIQSA_RUN_TOKEN=x",
      { PATH: "/tmp" },
      { [WORKSPACE_CODE_TOKEN_ENV]: "short", [WORKSPACE_CODE_GATEWAY_ENV]: AGENT_GATEWAY_ORIGIN },
      { [WORKSPACE_CODE_TOKEN_ENV]: token },
      { [WORKSPACE_CODE_GATEWAY_ENV]: AGENT_GATEWAY_ORIGIN },
      { [WORKSPACE_CODE_TOKEN_ENV]: token, [WORKSPACE_CODE_GATEWAY_ENV]: "https://attacker.example" },
      { [WORKSPACE_CODE_TOKEN_ENV]: token, [WORKSPACE_CODE_GATEWAY_ENV]: AGENT_GATEWAY_ORIGIN, [WORKSPACE_CODE_UNAVAILABLE_ENV]: "mcp_off" },
      { [WORKSPACE_CODE_UNAVAILABLE_ENV]: "maybe" }
    ]) {
      expect(() => parseWorkspaceRunEnvironment(value, AGENT_GATEWAY_ORIGIN)).toThrow("workspace_run_environment_invalid");
    }
  });
});

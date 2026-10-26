import { describe, expect, it } from "vitest";
import { RUNNER_GATEWAY_ORIGIN } from "./runnerGatewayRelay";
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
  it("grants code access only to Internet-On, gateway-capable runs with MCP authority", () => {
    const eligible = { workspace: { codeMcp: budgets, internetEnabled: true }, mcpDiscovery: catalog };
    expect(workspaceCodeMcpEligibility(eligible)).toEqual({ kind: "eligible", budgets });
    expect(workspaceCodeMcpEligibility({ workspace: eligible.workspace, mcp: { tools: [{}] } }))
      .toEqual({ kind: "eligible", budgets });
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
    expect(parseWorkspaceRunEnvironment(undefined, RUNNER_GATEWAY_ORIGIN)).toEqual({});
    expect(parseWorkspaceRunEnvironment({}, RUNNER_GATEWAY_ORIGIN)).toEqual({});
    const bearer = { [WORKSPACE_CODE_TOKEN_ENV]: token, [WORKSPACE_CODE_GATEWAY_ENV]: RUNNER_GATEWAY_ORIGIN };
    expect(parseWorkspaceRunEnvironment(bearer, RUNNER_GATEWAY_ORIGIN)).toEqual(bearer);
    for (const reason of ["internet_off", "gateway_unavailable", "mcp_off"]) {
      expect(parseWorkspaceRunEnvironment({ [WORKSPACE_CODE_UNAVAILABLE_ENV]: reason }, RUNNER_GATEWAY_ORIGIN))
        .toEqual({ [WORKSPACE_CODE_UNAVAILABLE_ENV]: reason });
    }
  });

  it("accepts the run's browser language and time zone in their exact shapes, with either code shape", () => {
    const browser = { AIQSA_BROWSER_LOCALE: "es-ES", AIQSA_BROWSER_TIMEZONE: "America/Argentina/Buenos_Aires" };
    expect(parseWorkspaceRunEnvironment(browser, RUNNER_GATEWAY_ORIGIN)).toEqual(browser);
    const bearer = { [WORKSPACE_CODE_TOKEN_ENV]: token, [WORKSPACE_CODE_GATEWAY_ENV]: RUNNER_GATEWAY_ORIGIN };
    expect(parseWorkspaceRunEnvironment({ ...bearer, ...browser }, RUNNER_GATEWAY_ORIGIN)).toEqual({ ...bearer, ...browser });
    expect(parseWorkspaceRunEnvironment({ [WORKSPACE_CODE_UNAVAILABLE_ENV]: "mcp_off", AIQSA_BROWSER_TIMEZONE: "UTC" }, RUNNER_GATEWAY_ORIGIN))
      .toEqual({ [WORKSPACE_CODE_UNAVAILABLE_ENV]: "mcp_off", AIQSA_BROWSER_TIMEZONE: "UTC" });
    for (const zone of ["CET", "EST5EDT", "Etc/GMT+5"]) {
      expect(parseWorkspaceRunEnvironment({ AIQSA_BROWSER_TIMEZONE: zone }, RUNNER_GATEWAY_ORIGIN)).toEqual({ AIQSA_BROWSER_TIMEZONE: zone });
    }
    for (const value of [
      { AIQSA_BROWSER_LOCALE: "es_ES" }, { AIQSA_BROWSER_LOCALE: "x".repeat(40) }, { AIQSA_BROWSER_LOCALE: 1 },
      { AIQSA_BROWSER_TIMEZONE: "../../etc/passwd" }, { AIQSA_BROWSER_TIMEZONE: "Europe/Madrid\n" }, { AIQSA_BROWSER_TIMEZONE: "" },
      { AIQSA_BROWSER_TIMEZONE: "/etc/localtime" }, { AIQSA_BROWSER_TIMEZONE: "a//b" }, { AIQSA_BROWSER_TIMEZONE: "x".repeat(65) }
    ]) {
      expect(() => parseWorkspaceRunEnvironment(value, RUNNER_GATEWAY_ORIGIN)).toThrow("workspace_run_environment_invalid");
    }
  });

  it("refuses foreign names, malformed values, another gateway and mixed shapes", () => {
    for (const value of [
      null, [], "AIQSA_RUN_TOKEN=x",
      { PATH: "/tmp" },
      { [WORKSPACE_CODE_TOKEN_ENV]: "short", [WORKSPACE_CODE_GATEWAY_ENV]: RUNNER_GATEWAY_ORIGIN },
      { [WORKSPACE_CODE_TOKEN_ENV]: token },
      { [WORKSPACE_CODE_GATEWAY_ENV]: RUNNER_GATEWAY_ORIGIN },
      { [WORKSPACE_CODE_TOKEN_ENV]: token, [WORKSPACE_CODE_GATEWAY_ENV]: "https://attacker.example" },
      { [WORKSPACE_CODE_TOKEN_ENV]: token, [WORKSPACE_CODE_GATEWAY_ENV]: RUNNER_GATEWAY_ORIGIN, [WORKSPACE_CODE_UNAVAILABLE_ENV]: "mcp_off" },
      { [WORKSPACE_CODE_UNAVAILABLE_ENV]: "maybe" }
    ]) {
      expect(() => parseWorkspaceRunEnvironment(value, RUNNER_GATEWAY_ORIGIN)).toThrow("workspace_run_environment_invalid");
    }
  });
});

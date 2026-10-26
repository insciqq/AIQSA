import { describe, expect, it } from "vitest";
import {
  WORKSPACE_MCP_VERSION,
  WORKSPACE_TOOL_TRANSPORT_CEILING_BYTES,
  WORKSPACE_TURN_TIMEOUT_MAX_SECONDS,
  WorkspaceConfigError,
  getScheduledWorkspaceMaxConcurrent,
  getWorkspaceConfig,
  workspaceIdleRefreshTiming,
  workspaceRuntimeIdleTimeoutSeconds,
  workspaceToolTransportMaxBytes
} from "./config";

describe("Workspace configuration", () => {
  it("uses the product defaults without requiring a runner while unconfigured", () => {
    expect(getWorkspaceConfig({})).toMatchObject({
      cpus: 2,
      diskMiB: 10_240,
      idleTtlSeconds: 1_800,
      imageRef: "aiqsa-workspace:0.1.36",
      maxToolCalls: 320,
      maxToolRounds: 160,
      mcpVersion: WORKSPACE_MCP_VERSION,
      memoryMiB: 4_096,
      outputFileMaxBytes: 256 * 1_024 * 1_024,
      outputMaxFiles: 25,
      outputTotalMaxBytes: 512 * 1_024 * 1_024,
      retentionSeconds: 86_400,
      runtimeMode: "unconfigured",
      syncToolTimeoutSeconds: 120,
      toolOutputMaxBytes: 128 * 1_024,
      turnTimeoutSeconds: 3_600
    });
  });

  it("lets a turn take as long as one without a Workspace, keeping an explicit turn time up to two hours", () => {
    expect(getWorkspaceConfig({ AIQSA_WORKSPACE_TURN_TIMEOUT_SECONDS: "" }).turnTimeoutSeconds).toBe(3_600);
    expect(WORKSPACE_TURN_TIMEOUT_MAX_SECONDS).toBe(7_200);
    for (const seconds of ["60", "1800", "7200"]) {
      expect(getWorkspaceConfig({ AIQSA_WORKSPACE_TURN_TIMEOUT_SECONDS: seconds }).turnTimeoutSeconds).toBe(Number(seconds));
    }
    for (const seconds of ["59", "7201", "3600.5"]) {
      expect(() => getWorkspaceConfig({ AIQSA_WORKSPACE_TURN_TIMEOUT_SECONDS: seconds })).toThrow(WorkspaceConfigError);
    }
  });

  it("keeps Microsandbox's own idle stop out of a turn, never shorter than the idle time", () => {
    expect(workspaceRuntimeIdleTimeoutSeconds(getWorkspaceConfig({}))).toBe(3_900);
    expect(workspaceRuntimeIdleTimeoutSeconds(getWorkspaceConfig({ AIQSA_WORKSPACE_TURN_TIMEOUT_SECONDS: "7200" }))).toBe(7_500);
    expect(workspaceRuntimeIdleTimeoutSeconds(getWorkspaceConfig({ AIQSA_WORKSPACE_IDLE_TTL_SECONDS: "14400" }))).toBe(14_400);
  });

  it("touches a run's guest every five minutes, more often under a short idle time, for a turn and its handoff", () => {
    expect(workspaceIdleRefreshTiming(getWorkspaceConfig({}))).toEqual({ intervalMs: 300_000, lifetimeMs: 3_900_000 });
    expect(workspaceIdleRefreshTiming(getWorkspaceConfig({ AIQSA_WORKSPACE_IDLE_TTL_SECONDS: "60" })))
      .toEqual({ intervalMs: 20_000, lifetimeMs: 3_900_000 });
  });

  it("bounds the guest-code MCP budgets separately from the model's tool budgets", () => {
    expect(getWorkspaceConfig({})).toMatchObject({ codeMcpMaxCalls: 200, codeMcpMaxConcurrent: 4, codeMcpMaxPerSecond: 10 });
    expect(getWorkspaceConfig({ AIQSA_WORKSPACE_CODE_MCP_CONCURRENCY: "8", AIQSA_WORKSPACE_CODE_MCP_MAX_CALLS: "1000",
      AIQSA_WORKSPACE_CODE_MCP_RATE_PER_SECOND: "50" })).toMatchObject({ codeMcpMaxCalls: 1_000, codeMcpMaxConcurrent: 8,
      codeMcpMaxPerSecond: 50 });
    for (const [name, value] of [["AIQSA_WORKSPACE_CODE_MCP_MAX_CALLS", "0"], ["AIQSA_WORKSPACE_CODE_MCP_MAX_CALLS", "5001"],
      ["AIQSA_WORKSPACE_CODE_MCP_CONCURRENCY", "17"], ["AIQSA_WORKSPACE_CODE_MCP_RATE_PER_SECOND", "1.5"]]) {
      expect(() => getWorkspaceConfig({ [name!]: value })).toThrow(WorkspaceConfigError);
    }
  });

  it("caps scheduled Workspace runs at one by default and refuses malformed caps", () => {
    expect(getScheduledWorkspaceMaxConcurrent({})).toBe(1);
    expect(getScheduledWorkspaceMaxConcurrent({ AIQSA_SCHEDULED_WORKSPACE_MAX_CONCURRENT: "" })).toBe(1);
    expect(getScheduledWorkspaceMaxConcurrent({ AIQSA_SCHEDULED_WORKSPACE_MAX_CONCURRENT: "3" })).toBe(3);
    for (const value of ["0", "17", "1.5", "-1", "two"]) {
      expect(() => getScheduledWorkspaceMaxConcurrent({ AIQSA_SCHEDULED_WORKSPACE_MAX_CONCURRENT: value })).toThrow(WorkspaceConfigError);
    }
  });

  it("accepts an authenticated private runner configuration", () => {
    const config = getWorkspaceConfig({
      AIQSA_WORKSPACE_RUNNER_TOKEN: "t".repeat(32),
      AIQSA_WORKSPACE_RUNNER_URL: "http://workspace-runner:4310/"
    });
    expect(config.runtimeMode).toBe("remote");
    expect(config.runnerUrl?.href).toBe("http://workspace-runner:4310/");
    expect(config.runnerToken).toHaveLength(32);
  });

  it.each([
    { calls: "80", rounds: "40" },
    { calls: "500", rounds: "200" },
    { calls: "800", rounds: "400" }
  ])("preserves explicit tool budgets within the supported ceilings: %o", ({ calls, rounds }) => {
    expect(getWorkspaceConfig({
      AIQSA_WORKSPACE_MAX_TOOL_CALLS: calls,
      AIQSA_WORKSPACE_MAX_TOOL_ROUNDS: rounds
    })).toMatchObject({ maxToolCalls: Number(calls), maxToolRounds: Number(rounds) });
  });

  it.each([undefined, ""])("keeps a calls-only override valid when rounds are unset: %s", (rounds) => {
    expect(getWorkspaceConfig({
      AIQSA_WORKSPACE_MAX_TOOL_CALLS: "80",
      AIQSA_WORKSPACE_MAX_TOOL_ROUNDS: rounds
    })).toMatchObject({ maxToolCalls: 80, maxToolRounds: 80 });
  });

  it("rejects partial, unbounded, and incompatible configuration", () => {
    const invalid = [
      { AIQSA_WORKSPACE_CPUS: "0" },
      { AIQSA_WORKSPACE_RUNNER_URL: "http://workspace-runner:4310" },
      { AIQSA_WORKSPACE_RUNNER_TOKEN: "t".repeat(32) },
      { AIQSA_WORKSPACE_IDLE_TTL_SECONDS: "2000", AIQSA_WORKSPACE_RETENTION_SECONDS: "1000" },
      { AIQSA_WORKSPACE_OUTPUT_FILE_MAX_BYTES: "2000", AIQSA_WORKSPACE_OUTPUT_TOTAL_MAX_BYTES: "1000" },
      { AIQSA_WORKSPACE_MAX_TOOL_CALLS: "801" },
      { AIQSA_WORKSPACE_MAX_TOOL_ROUNDS: "401" },
      { AIQSA_WORKSPACE_MAX_TOOL_CALLS: "200", AIQSA_WORKSPACE_MAX_TOOL_ROUNDS: "201" },
      { AIQSA_WORKSPACE_MCP_VERSION: "latest" }
    ];
    for (const env of invalid) {
      expect(() => getWorkspaceConfig(env)).toThrow(WorkspaceConfigError);
    }
  });

  it("accepts only tool output bounds whose escaped worst case fits one transport message", () => {
    const largest = getWorkspaceConfig({ AIQSA_WORKSPACE_TOOL_OUTPUT_MAX_BYTES: "1048576" }).toolOutputMaxBytes;
    expect(workspaceToolTransportMaxBytes(largest)).toBeLessThanOrEqual(WORKSPACE_TOOL_TRANSPORT_CEILING_BYTES);
    expect(workspaceToolTransportMaxBytes(largest + 1)).toBeGreaterThan(WORKSPACE_TOOL_TRANSPORT_CEILING_BYTES);
    expect(() => getWorkspaceConfig({ AIQSA_WORKSPACE_TOOL_OUTPUT_MAX_BYTES: String(largest + 1) }))
      .toThrow(WorkspaceConfigError);
    // stdout and stderr at the default bound, both fully control characters, after both JSON layers.
    expect(workspaceToolTransportMaxBytes(128 * 1_024)).toBeGreaterThanOrEqual(2 * 7 * 128 * 1_024);
  });

  it("permits the deterministic runtime only in explicit non-production test mode", () => {
    expect(getWorkspaceConfig({
      AIQSA_TEST_MODE: "1",
      AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1",
      NODE_ENV: "test"
    }).runtimeMode).toBe("deterministic");
    expect(() => getWorkspaceConfig({
      AIQSA_TEST_MODE: "1",
      AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1",
      NODE_ENV: "production"
    })).toThrow("workspace_deterministic_runtime_forbidden");
  });
});

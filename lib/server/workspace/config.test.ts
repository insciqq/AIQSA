import { describe, expect, it } from "vitest";
import {
  WORKSPACE_MCP_VERSION,
  WorkspaceConfigError,
  getWorkspaceConfig
} from "./config";

describe("Workspace configuration", () => {
  it("uses the product defaults without requiring a runner while unconfigured", () => {
    expect(getWorkspaceConfig({})).toMatchObject({
      cpus: 2,
      diskMiB: 10_240,
      idleTtlSeconds: 1_800,
      maxToolCalls: 80,
      maxToolRounds: 40,
      mcpVersion: WORKSPACE_MCP_VERSION,
      memoryMiB: 4_096,
      outputFileMaxBytes: 256 * 1_024 * 1_024,
      outputMaxFiles: 25,
      outputTotalMaxBytes: 512 * 1_024 * 1_024,
      retentionSeconds: 86_400,
      runtimeMode: "unconfigured",
      syncToolTimeoutSeconds: 120,
      toolOutputMaxBytes: 128 * 1_024,
      turnTimeoutSeconds: 1_800
    });
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

  it("rejects partial, unbounded, and incompatible configuration", () => {
    const invalid = [
      { AIQSA_WORKSPACE_CPUS: "0" },
      { AIQSA_WORKSPACE_RUNNER_URL: "http://workspace-runner:4310" },
      { AIQSA_WORKSPACE_RUNNER_TOKEN: "t".repeat(32) },
      { AIQSA_WORKSPACE_IDLE_TTL_SECONDS: "2000", AIQSA_WORKSPACE_RETENTION_SECONDS: "1000" },
      { AIQSA_WORKSPACE_OUTPUT_FILE_MAX_BYTES: "2000", AIQSA_WORKSPACE_OUTPUT_TOTAL_MAX_BYTES: "1000" },
      { AIQSA_WORKSPACE_MCP_VERSION: "latest" }
    ];
    for (const env of invalid) {
      expect(() => getWorkspaceConfig(env)).toThrow(WorkspaceConfigError);
    }
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

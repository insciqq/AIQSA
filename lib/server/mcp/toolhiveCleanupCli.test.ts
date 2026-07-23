import { describe, expect, it, vi } from "vitest";
import {
  parseToolHiveCleanupArgs,
  runToolHiveCleanup
} from "./toolhiveCleanupCli";

const first = {
  group: "aiqsa-0123456789abcdef",
  name: "aiqsa-0123456789abcdef-0123456789abcdef01234567"
};
const second = {
  group: "aiqsa-0123456789abcdef",
  name: "aiqsa-0123456789abcdef-89abcdef0123456789abcdef"
};

function workload(input: typeof first) {
  return {
    ...input,
    port: 31_337,
    proxyMode: "streamable-http" as const,
    remote: false,
    status: "running" as const,
    transportType: "stdio" as const,
    url: "http://127.0.0.1:31337/mcp"
  };
}

describe("ToolHive cleanup CLI", () => {
  it("defaults to a read-only exact-owned workload listing", async () => {
    const output = vi.fn();
    const cleanupOwnedInstallation = vi.fn();
    const listOwnedWorkloads = vi.fn(async () => [workload(first)]);

    await runToolHiveCleanup({
      args: [],
      driver: {
        cleanupOwnedInstallation,
        groupName: first.group,
        listOwnedWorkloads
      },
      output
    });

    expect(cleanupOwnedInstallation).not.toHaveBeenCalled();
    expect(JSON.parse(output.mock.calls[0]?.[0] as string)).toEqual({
      group: first.group,
      mode: "dry-run",
      ownedWorkloadCount: 1,
      ownedWorkloads: [first.name]
    });
  });

  it("requires --execute, deletes through the ownership-aware driver, and verifies cleanup", async () => {
    const output = vi.fn();
    const listOwnedWorkloads = vi.fn()
      .mockResolvedValueOnce([workload(first), workload(second)])
      .mockResolvedValueOnce([]);
    const cleanupOwnedInstallation = vi.fn(async () => ({
      deletedWorkloads: [first.name, second.name],
      groupDeleted: true
    }));

    await runToolHiveCleanup({
      args: ["--execute"],
      driver: {
        cleanupOwnedInstallation,
        groupName: first.group,
        listOwnedWorkloads
      },
      output
    });

    expect(cleanupOwnedInstallation).toHaveBeenCalledOnce();
    expect(listOwnedWorkloads).toHaveBeenCalledTimes(2);
    expect(JSON.parse(output.mock.calls[0]?.[0] as string)).toMatchObject({
      deletedWorkloadCount: 2,
      groupDeleted: true,
      mode: "execute",
      ownedWorkloadCountRemaining: 0
    });
  });

  it("fails instead of reporting success when an owned workload remains", async () => {
    const listOwnedWorkloads = vi.fn(async () => [workload(first)]);

    await expect(runToolHiveCleanup({
      args: ["--execute"],
      driver: {
        cleanupOwnedInstallation: vi.fn(async () => ({
          deletedWorkloads: [],
          groupDeleted: false
        })),
        groupName: first.group,
        listOwnedWorkloads
      }
    })).rejects.toThrowError("ToolHive cleanup incomplete: 1 owned workload still present");
  });

  it("rejects unknown or contradictory mode flags", () => {
    expect(parseToolHiveCleanupArgs(["--help"])).toEqual({ execute: false, help: true });
    expect(() => parseToolHiveCleanupArgs(["--all"])).toThrowError(
      "Unknown argument: --all"
    );
    expect(() => parseToolHiveCleanupArgs(["--execute", "--dry-run"])).toThrowError(
      "Choose either --dry-run or --execute"
    );
  });
});

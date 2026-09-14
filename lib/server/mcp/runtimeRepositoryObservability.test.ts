import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { databaseFailureCode } from "../observability/databaseFailure";
import { createPrismaMcpRuntimeRepository, type remoteRuntimeCandidate } from "./runtimeRepository";

const failure = {
  errorCode: "mcp_network_failed", fingerprint: "fixture_fingerprint", generationId: "fixture_generation",
  now: new Date("2026-09-13T10:00:00.000Z")
};

describe("MCP runtime failure persistence diagnostics", () => {
  it("bounds OAuth policy failures during scans and recovers only the successfully rebuilt record", async () => {
    const record = {
      id: "policy_failure_record", userId: "fixture_user", serverId: "fixture_server", enabled: true,
      personalConfigEnvelope: null, personalConfigVersion: 0, user: { groups: [] },
      server: { enabled: true, archivedAt: null, sharedConfigEnvelope: null, sharedConfigVersion: 0,
        grants: [{ userId: "fixture_user", groupId: null, canUse: true, personalSlotKeys: [] }], oauthConnections: [],
        activeRevision: { id: "fixture_revision", configuration: {
          auth: { mode: "oauth", allowedAuthorizationServerOrigins: [], scopes: [] },
          runtime: { startupTimeoutMs: 30_000, callTimeoutMs: 30_000 }, slots: [],
          source: { kind: "remote", url: "https://mcp.example.test/rpc" }, transport: "streamable_http"
        } }
      }
    } as unknown as Parameters<typeof remoteRuntimeCandidate>[0]["record"];
    let selected = record;
    let redirect = "PRIVATE_INVALID_REDIRECT";
    const repository = createPrismaMcpRuntimeRepository({ encryptionKey: () => Buffer.alloc(32, 7),
      oauthRedirectUri: () => redirect, prisma: {
        mcpUserServer: { findMany: vi.fn(async () => [selected]), updateMany: vi.fn(async () => ({ count: 1 })) }
      } as unknown as PrismaClient });
    const lines: string[] = [];
    const writer = vi.spyOn(process.stdout, "write").mockImplementation((line) => { lines.push(String(line)); return true; });
    const scan = () => repository.synchronizeDesired({ now: failure.now, onDemand: true, serverIds: [record.serverId], userId: record.userId });
    try {
      for (let index = 0; index < 4; index += 1) await expect(scan()).resolves.toEqual([]);
      const failureRecord = expect.objectContaining({ event: "runtime_lifecycle", subsystem: "mcp", stage: "preflight", outcome: "failed" });
      expect(lines.map((line) => JSON.parse(line))).toEqual([failureRecord]);
      redirect = "https://app.example.test/oauth/callback";
      selected = { ...record, id: "other_policy_record" };
      await expect(scan()).resolves.toEqual([]);
      expect(lines.map((line) => JSON.parse(line))).toEqual([failureRecord]);
      selected = record;
      await expect(scan()).resolves.toEqual([]);
      await expect(scan()).resolves.toEqual([]);
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        failureRecord, expect.objectContaining({ event: "subsystem.recovered", stage: "preflight", repeat_count: 3 })
      ]);
      expect(lines.join("")).not.toContain("PRIVATE");
      expect(lines.join("")).not.toContain("policy_failure_record");
      expect(lines.join("")).not.toContain("example.test");
    } finally { writer.mockRestore(); }
  });

  it("observes a corrupt accepted snapshot before preserving the unavailable result", async () => {
    const repository = createPrismaMcpRuntimeRepository({ encryptionKey: () => Buffer.alloc(32, 7), prisma: {
      mcpRuntimeGeneration: { findFirst: vi.fn(async () => ({
        effectiveConfigEnvelope: null, id: "corrupt_snapshot_generation", fingerprint: "fixture_fingerprint",
        oauthConnectionId: null, userServer: { serverId: "fixture_server" },
        revision: { id: "fixture_revision", serverId: "fixture_server", configuration: {
          auth: { mode: "static" }, runtime: { startupTimeoutMs: 30_000, callTimeoutMs: 30_000 }, slots: [],
          source: { kind: "remote", url: "https://mcp.example.test" }, transport: "streamable_http"
        } }
      })) }
    } as unknown as PrismaClient });
    const lines: string[] = [];
    const writer = vi.spyOn(process.stdout, "write").mockImplementation((line) => { lines.push(String(line)); return true; });
    try {
      for (let index = 0; index < 3; index += 1) await expect(repository.loadAcceptedGeneration("corrupt_snapshot_generation", failure.now)).resolves.toBeNull();
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ event: "runtime_lifecycle", stage: "recovery", outcome: "failed", code: "mcp_values_invalid" })
      ]);
    } finally { writer.mockRestore(); }
  });

  it("observes suppressed OAuth reconciliation errors without failing the desired-runtime scan", async () => {
    const reconcile = vi.fn<() => Promise<void>>(async () => { throw Object.assign(new Error("PRIVATE_OAUTH_DETAIL"), { code: "mcp_connect_failed" }); });
    const repository = createPrismaMcpRuntimeRepository({ encryptionKey: () => Buffer.alloc(32, 7),
      reconcileOAuthConnections: reconcile, prisma: {
        $executeRaw: vi.fn(async () => 0), mcpUserServer: { findMany: vi.fn(async () => []) }
      } as unknown as PrismaClient });
    const lines: string[] = [];
    const writer = vi.spyOn(process.stdout, "write").mockImplementation((line) => { lines.push(String(line)); return true; });
    try {
      for (let index = 0; index < 3; index += 1) await expect(repository.synchronizeDesired({ now: failure.now })).resolves.toEqual([]);
      reconcile.mockImplementation(async () => undefined);
      await repository.synchronizeDesired({ now: failure.now });
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ event: "runtime_lifecycle", stage: "reconcile", code: "mcp_connect_failed" }),
        expect.objectContaining({ event: "subsystem.recovered", stage: "reconcile", repeat_count: 2 })
      ]);
      expect(lines.join("")).not.toContain("PRIVATE");
    } finally { writer.mockRestore(); }
  });

  it.each([true, false])("reports only the retry date returned by an applied write: %s", async (applied) => {
    const retryAt = new Date("2026-09-13T10:00:37.000Z");
    const query = vi.fn(async () => applied ? [{ retryAt }] : []);
    const repository = createPrismaMcpRuntimeRepository({ prisma: { $queryRaw: query } as unknown as PrismaClient });
    await expect(repository.markFailed(failure)).resolves.toEqual({ applied, retryAt: applied ? retryAt : null });
    expect(query).toHaveBeenCalledOnce();
  });

  it("retains proven Prisma classification at the actual write while preserving its rejection", async () => {
    const original = new Prisma.PrismaClientKnownRequestError("PRIVATE_DATABASE_DETAIL", { code: "P2024", clientVersion: "fixture" });
    const repository = createPrismaMcpRuntimeRepository({ prisma: {
      $queryRaw: vi.fn(async () => { throw original; })
    } as unknown as PrismaClient });
    await expect(repository.markFailed(failure)).rejects.toBe(original);
    expect(databaseFailureCode(original)).toBe("P2024");
  });
});

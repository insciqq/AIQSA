import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { McpConfigurationSlot } from "@/lib/contracts/mcp";
import { createPrismaMcpRepository } from "./prismaRepository";

const now = new Date("2026-10-02T12:00:00.000Z");
const regionSlot: McpConfigurationSlot = {
  label: "Region", policy: { allowPersonalOverride: true, kind: "shared" }, sensitive: false, slotKey: "region",
  target: { kind: "header", name: "X-Region" }, valueType: "string"
};

/** One enabled preference with a ready desired generation, as `listUserServerRecords` loads it. */
function server(input: Readonly<{ personal: boolean; slots?: McpConfigurationSlot[] }>) {
  return {
    activeRevision: {
      configuration: {
        auth: { mode: "none" },
        runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
        slots: input.slots ?? [],
        source: { kind: "remote", url: "https://mcp.example.test/mcp" },
        transport: "streamable_http"
      },
      createdAt: now,
      id: "revision-1",
      validationEvidence: { evidence: {}, testedAt: now.toISOString(), toolInventory: [{ description: "Read", name: "read" }] }
    },
    description: "Tools",
    displayName: "Tools",
    grants: input.personal ? [] : [{ canUse: true, groupId: null, personalSlotKeys: ["region"], userId: "user-1" }],
    id: "server-1",
    oauthConnections: [],
    ownerUserId: input.personal ? "user-1" : null,
    sharedConfigEnvelope: null,
    sharedConfigVersion: 0,
    userServers: [{
      desiredRuntimeGeneration: {
        errorCode: null, id: "generation-1", inventory: { exclusions: [], tools: [], version: 1 }, oauthConnectionId: null,
        revisionId: "revision-1", state: "ready", userServerId: "preference-1"
      },
      desiredRuntimeGenerationId: "generation-1",
      discoveredInventory: null,
      discoveredOAuthConnectionId: null,
      discoveredRevisionId: null,
      enabled: true,
      id: "preference-1",
      personalConfigEnvelope: null,
      personalConfigVersion: 0,
      runtimeGenerations: [],
      updatedAt: now,
      userDisabledToolNames: []
    }]
  };
}

function repository(record: ReturnType<typeof server>) {
  const upsert = vi.fn(async () => ({}));
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ id: record.id }]),
    mcpServer: { findMany: async () => [record] },
    mcpToolAccessPolicy: { findMany: async () => [] },
    mcpUserServer: { count: vi.fn(async () => 0), upsert },
    user: { findUnique: async () => ({ groups: [], status: "active" }) }
  };
  const client = { ...tx, $transaction: async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx) } as unknown as PrismaClient;
  return { storage: createPrismaMcpRepository({ encryptionKey: () => Buffer.alloc(32, 5), prisma: client }), upsert };
}

describe("desired runtime generation across preference updates", () => {
  it.each([
    ["personal", { personal: true, personalOnly: true }],
    ["installation", { personal: false, installationOnly: true }]
  ] as const)("keeps the %s runtime through an enable of an enabled connection and replaces it when switched off", async (_label, scope) => {
    const { personal, ...route } = scope;
    const { storage, upsert } = repository(server({ personal }));

    // The OAuth settle and a repeated switch-on change nothing the runtime depends on.
    await expect(storage.updateUserServer({ ...route, enabled: true, serverId: "server-1", userId: "user-1" }))
      .resolves.toMatchObject({ kind: "ok", value: { enabled: true, runtimeGenerationId: "generation-1" } });
    expect(upsert).toHaveBeenLastCalledWith(expect.objectContaining({ update: { enabled: true } }));

    await storage.updateUserServer({ ...route, enabled: false, serverId: "server-1", userId: "user-1" });
    expect(upsert).toHaveBeenLastCalledWith(expect.objectContaining({ update: { desiredRuntimeGenerationId: null, enabled: false } }));
  });

  it("replaces an installation runtime when the user's own values change", async () => {
    const { storage, upsert } = repository(server({ personal: false, slots: [regionSlot] }));

    await expect(storage.updateUserServer({
      installationOnly: true, serverId: "server-1", userId: "user-1", values: { region: "eu-west" }
    })).resolves.toMatchObject({ kind: "ok" });
    expect(upsert).toHaveBeenLastCalledWith(expect.objectContaining({ update: {
      desiredRuntimeGenerationId: null, personalConfigEnvelope: expect.any(String), personalConfigVersion: 1
    } }));

    // An empty patch changes no value and keeps the runtime.
    await storage.updateUserServer({ installationOnly: true, serverId: "server-1", userId: "user-1", values: {} });
    expect(upsert).toHaveBeenLastCalledWith(expect.objectContaining({ update: {} }));
  });
});

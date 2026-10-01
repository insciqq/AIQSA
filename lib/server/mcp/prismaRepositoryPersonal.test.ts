import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { MAX_TOOL_DESCRIPTION_LENGTH, MCP_SERVER_TOOL_LIMIT } from "@/lib/contracts/mcp";
import { createPrismaMcpRepository } from "./prismaRepository";

const now = new Date("2026-10-01T12:00:00.000Z");
const HASH = "a".repeat(64);

type Connection = { disconnectRequestedAt: Date | null; id: string; state: string; userId: string };

function runtimeInventory(names: readonly string[], description = (name: string) => `${name} live`) {
  return { exclusions: [], tools: names.map((name) => ({ definitionHash: HASH, description: description(name), inputSchema: { type: "object" }, name })), version: 1 };
}

/** One owner's personal server as `listUserServerRecords` loads it. */
function personalServer(input: {
  current?: { inventory: unknown; oauthConnectionId: string | null; state: string } | null;
  discovered?: { inventory: unknown; oauthConnectionId: string | null };
  disabled?: string[];
  oauth?: Connection[];
}) {
  const oauthMode = input.oauth !== undefined;
  return {
    activeRevision: {
      configuration: {
        auth: oauthMode ? { allowedAuthorizationServerOrigins: ["https://auth.example.test"], mode: "oauth", scopes: [] } : { mode: "none" },
        runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
        slots: [],
        source: { kind: "remote", url: "https://mcp.example.test/mcp" },
        transport: "streamable_http"
      },
      createdAt: now,
      id: "revision-1",
      validationEvidence: { evidence: {}, testedAt: now.toISOString(), toolInventory: [{ description: "Validated read", name: "read" }] }
    },
    description: "Personal tools",
    displayName: "Personal tools",
    grants: [],
    id: "server-1",
    oauthConnections: (input.oauth ?? []).map((connection) => ({ ...connection, oauthClient: { clientId: "client-1" } })),
    ownerUserId: "user-1",
    sharedConfigEnvelope: null,
    sharedConfigVersion: 0,
    userServers: [{
      desiredRuntimeGeneration: input.current ? {
        errorCode: null, id: "generation-1", revisionId: "revision-1", userServerId: "preference-1", ...input.current
      } : null,
      desiredRuntimeGenerationId: input.current ? "generation-1" : null,
      discoveredInventory: input.discovered?.inventory ?? null,
      discoveredOAuthConnectionId: input.discovered?.oauthConnectionId ?? null,
      discoveredRevisionId: input.discovered ? "revision-1" : null,
      enabled: true,
      id: "preference-1",
      personalConfigEnvelope: null,
      personalConfigVersion: 0,
      runtimeGenerations: [],
      updatedAt: now,
      userDisabledToolNames: input.disabled ?? []
    }]
  };
}

function repository(server: ReturnType<typeof personalServer>) {
  const upsert = vi.fn(async () => ({}));
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ id: server.id }]),
    mcpServer: { findMany: async () => [server] },
    mcpToolAccessPolicy: { findMany: async () => [] },
    mcpUserServer: { upsert },
    user: { findUnique: async () => ({ groups: [], status: "active" }) }
  };
  const client = { ...tx, $transaction: async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx) } as unknown as PrismaClient;
  return { storage: createPrismaMcpRepository({ encryptionKey: () => Buffer.alloc(32, 3), prisma: client }), upsert };
}

describe("personal MCP Settings projection", () => {
  it("lists the live inventory with the owner's switch-offs, bounded descriptions and agreeing counts", async () => {
    const server = personalServer({
      current: { inventory: runtimeInventory(["write", "read", "added"], (name) => name === "added" ? "x".repeat(5_000) : `${name} live`), oauthConnectionId: null, state: "ready" },
      disabled: ["gone", "write"]
    });
    const [listed] = await repository(server).storage.listUserServers("user-1");

    expect(listed).toMatchObject({
      availableTools: [
        { description: "x".repeat(MAX_TOOL_DESCRIPTION_LENGTH), name: "added" },
        { description: "read live", name: "read" },
        { description: "write live", name: "write" }
      ],
      knownToolCount: 2,
      readiness: "ready",
      sourceType: "personal",
      userDisabledToolNames: ["gone", "write"]
    });
    expect(listed?.tools.map((tool) => tool.name)).toEqual(["read", "added"]);
    expect(listed?.unavailableTools).toEqual([]);
  });

  it("applies the run plan's OAuth identity rule to the Settings fallback", async () => {
    const discovered = { inventory: { tools: [{ description: "Read mail", name: "mail.read" }], version: 1 }, oauthConnectionId: "oauth-1" };
    const restarting = personalServer({
      current: { inventory: null, oauthConnectionId: "oauth-1", state: "starting" },
      discovered,
      oauth: [{ disconnectRequestedAt: null, id: "oauth-1", state: "ready", userId: "user-1" }]
    });
    expect((await repository(restarting).storage.listUserServers("user-1"))[0]?.availableTools).toEqual([
      { description: "Read mail", name: "mail.read" }
    ]);

    const reconnected = personalServer({
      current: { inventory: null, oauthConnectionId: "oauth-2", state: "starting" },
      discovered,
      oauth: [
        { disconnectRequestedAt: null, id: "oauth-2", state: "ready", userId: "user-1" },
        { disconnectRequestedAt: now, id: "oauth-1", state: "disconnecting", userId: "user-1" }
      ]
    });
    expect((await repository(reconnected).storage.listUserServers("user-1"))[0]).toMatchObject({ availableTools: [], knownToolCount: 0 });
  });
});

describe("personal MCP tool switches", () => {
  const ready = () => personalServer({
    current: { inventory: runtimeInventory(["read", "write"]), oauthConnectionId: null, state: "ready" },
    disabled: ["gone"]
  });

  it("switches a live tool without touching the desired generation and keeps names of departed tools", async () => {
    const { storage, upsert } = repository(ready());

    await expect(storage.updateUserServer({ personalOnly: true, serverId: "server-1", tool: { enabled: false, name: "write" }, userId: "user-1" }))
      .resolves.toMatchObject({ kind: "ok" });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { userDisabledToolNames: ["gone", "write"] } }));

    await storage.updateUserServer({ enabled: false, personalOnly: true, serverId: "server-1", userId: "user-1" });
    expect(upsert).toHaveBeenLastCalledWith(expect.objectContaining({ update: { desiredRuntimeGenerationId: null, enabled: false } }));
  });

  it("requires the tool in the live inventory and prunes departed names only at the bound", async () => {
    const { storage, upsert } = repository(ready());
    await expect(storage.updateUserServer({ personalOnly: true, serverId: "server-1", tool: { enabled: true, name: "gone" }, userId: "user-1" }))
      .resolves.toEqual({ issues: [{ code: "tool_not_available", path: "tool.name" }], kind: "invalid_values" });
    expect(upsert).not.toHaveBeenCalled();

    const full = personalServer({
      current: { inventory: runtimeInventory(["read", "write"]), oauthConnectionId: null, state: "ready" },
      disabled: [...Array.from({ length: MCP_SERVER_TOOL_LIMIT - 1 }, (_, index) => `gone_${index}`), "read"]
    });
    const bounded = repository(full);
    await bounded.storage.updateUserServer({ personalOnly: true, serverId: "server-1", tool: { enabled: false, name: "write" }, userId: "user-1" });
    expect(bounded.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { userDisabledToolNames: ["read", "write"] } }));
  });
});

import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  MCP_RUN_PLAN_LIMITS,
  PERSONAL_MCP_CONNECTION_LIMIT,
  type McpDraftConfiguration
} from "@/lib/contracts/mcp";
import { createPrismaMcpRepository } from "./prismaRepository";

vi.mock("@/lib/server/prisma", () => ({ prisma: {} }));

const draft: McpDraftConfiguration = {
  auth: { mode: "none" },
  runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
  slots: [],
  source: { kind: "remote", url: "https://mcp.example.test/mcp" },
  transport: "streamable_http"
};

function lockRecorder() {
  const locks: string[] = [];
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
    locks.push(/FROM "(\w+)"/u.exec(strings.join("?"))?.[1] ?? "unknown");
    return [{ id: "locked" }];
  });
  return { $queryRaw, locks };
}

/** Each count call takes the next value: the advisory pre-check first, then the locked recheck. */
function personalCreateFixture(counts: { enabled: number[]; live: number[] }) {
  const { $queryRaw, locks } = lockRecorder();
  const tx = {
    $queryRaw,
    mcpServer: {
      count: vi.fn(async () => counts.live.shift() ?? 0),
      create: vi.fn(async () => { throw new Error("unexpected_create"); })
    },
    mcpUserServer: { count: vi.fn(async () => counts.enabled.shift() ?? 0) },
    user: {
      findFirst: vi.fn(async () => ({ id: "user-1" })),
      findFirstOrThrow: vi.fn(async () => ({ id: "user-1" }))
    }
  };
  const client = {
    ...tx,
    $transaction: vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx))
  };
  const validate = vi.fn(async () => ({
    evidence: { protocol: "fixture" },
    kind: "ok" as const,
    resolvedArtifact: null,
    toolInventory: [{ description: "Read fixture", name: "read" }]
  }));
  const repository = createPrismaMcpRepository({
    draftValidator: { validate },
    encryptionKey: () => Buffer.alloc(32, 3),
    prisma: client as unknown as PrismaClient
  });
  const create = () => repository.createPersonalServer!({
    description: "",
    draft,
    name: "Personal fixture",
    userId: "user-1",
    values: {}
  });
  return { client, create, locks, repository, tx, validate };
}

describe("personal MCP creation limits", () => {
  it.each([
    [{ enabled: [0], live: [PERSONAL_MCP_CONNECTION_LIMIT] }, "personal_mcp_limit_reached"],
    [{ enabled: [MCP_RUN_PLAN_LIMITS.maxEnabledServers], live: [3] }, "mcp_enabled_server_limit_reached"]
  ] as const)("refuses %o with %s before contacting the endpoint", async (counts, kind) => {
    const fixture = personalCreateFixture({ enabled: [...counts.enabled], live: [...counts.live] });

    await expect(fixture.create()).resolves.toEqual({ kind });
    expect(fixture.tx.mcpServer.count).toHaveBeenCalledWith({ where: { archivedAt: null, ownerUserId: "user-1" } });
    expect(fixture.tx.mcpUserServer.count).toHaveBeenCalledWith({ where: { enabled: true, userId: "user-1" } });
    expect(fixture.validate).not.toHaveBeenCalled();
    expect(fixture.client.$transaction).not.toHaveBeenCalled();
  });

  it("rechecks both limits under the owner's lock so concurrent creates cannot pass together", async () => {
    const fixture = personalCreateFixture({
      enabled: [0, 0],
      live: [PERSONAL_MCP_CONNECTION_LIMIT - 1, PERSONAL_MCP_CONNECTION_LIMIT]
    });

    await expect(fixture.create()).resolves.toEqual({ kind: "personal_mcp_limit_reached" });
    expect(fixture.validate).toHaveBeenCalledOnce();
    expect(fixture.locks).toEqual(["User"]);
    expect(fixture.tx.$queryRaw.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.tx.mcpServer.count.mock.invocationCallOrder[1]!);
    expect(fixture.tx.mcpServer.create).not.toHaveBeenCalled();
  });

  it("exposes the advisory check the create route runs before discovery", async () => {
    const fixture = personalCreateFixture({ enabled: [0, 0], live: [PERSONAL_MCP_CONNECTION_LIMIT - 1, PERSONAL_MCP_CONNECTION_LIMIT] });

    await expect(fixture.repository.personalCreationLimit!("user-1")).resolves.toBeNull();
    await expect(fixture.repository.personalCreationLimit!("user-1")).resolves.toBe("personal_mcp_limit_reached");
  });
});

function userServerFixture(input: { enabled: boolean; otherEnabled: number }) {
  const { $queryRaw, locks } = lockRecorder();
  const upsertReached = new Error("upsert_reached");
  const record = {
    activeRevision: {
      configuration: draft,
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      id: "revision-1",
      validationEvidence: { evidence: {}, testedAt: "2026-10-01T00:00:00.000Z", toolInventory: [] }
    },
    activeRevisionId: "revision-1",
    description: "",
    displayName: "Installation fixture",
    enabled: true,
    grants: [{ canUse: true, groupId: null, personalSlotKeys: [], userId: "user-1" }],
    id: "server-1",
    oauthConnections: [],
    ownerUserId: null,
    sharedConfigEnvelope: null,
    sharedConfigVersion: 0,
    userServers: [{ enabled: input.enabled, id: "preference-1", personalConfigEnvelope: null, personalConfigVersion: 0 }]
  };
  const tx = {
    $queryRaw,
    mcpServer: { findMany: vi.fn(async () => [record]) },
    mcpUserServer: {
      count: vi.fn(async () => input.otherEnabled),
      upsert: vi.fn(async () => { throw upsertReached; })
    },
    user: { findUnique: vi.fn(async () => ({ groups: [], status: "active" })) }
  };
  const client = {
    $transaction: vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx))
  };
  const repository = createPrismaMcpRepository({
    encryptionKey: () => Buffer.alloc(32, 3),
    prisma: client as unknown as PrismaClient
  });
  const enable = () => repository.updateUserServer({ enabled: true, serverId: "server-1", userId: "user-1" });
  return { enable, locks, tx, upsertReached };
}

describe("server-side enabled-server limit", () => {
  it("refuses a false-to-true transition at the limit, counting only the user's other enabled rows", async () => {
    const fixture = userServerFixture({ enabled: false, otherEnabled: MCP_RUN_PLAN_LIMITS.maxEnabledServers });

    await expect(fixture.enable()).resolves.toEqual({ kind: "mcp_enabled_server_limit_reached" });
    expect(fixture.tx.mcpUserServer.count).toHaveBeenCalledWith({
      where: { enabled: true, serverId: { not: "server-1" }, userId: "user-1" }
    });
    expect(fixture.tx.mcpUserServer.upsert).not.toHaveBeenCalled();
    // Owner before server, the order personal creation and account deletion use.
    expect(fixture.locks).toEqual(["User", "McpServer"]);
  });

  it("admits the transition below the limit", async () => {
    const fixture = userServerFixture({ enabled: false, otherEnabled: MCP_RUN_PLAN_LIMITS.maxEnabledServers - 1 });

    await expect(fixture.enable()).rejects.toBe(fixture.upsertReached);
    expect(fixture.tx.mcpUserServer.count).toHaveBeenCalledOnce();
  });

  it("passes an already-enabled row, such as the OAuth settle, without counting", async () => {
    const fixture = userServerFixture({ enabled: true, otherEnabled: MCP_RUN_PLAN_LIMITS.maxEnabledServers });

    await expect(fixture.enable()).rejects.toBe(fixture.upsertReached);
    expect(fixture.tx.mcpUserServer.count).not.toHaveBeenCalled();
  });
});

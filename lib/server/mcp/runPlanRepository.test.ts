import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { MAX_TOOL_DESCRIPTION_LENGTH } from "@/lib/contracts/mcp";
import { namespacedMcpToolName, prepareMcpRunPlan } from "./runPlan";
import {
  loadMcpCapabilityCatalog,
  loadMcpRunPlanRecords,
  loadMcpRunPlanRecordsForServers,
  loadMcpRunPlanRecordsForProjectServers
} from "./runPlanRepository";

const NOW = new Date("2026-07-22T20:00:00.000Z");
const HASH = "a".repeat(64);

type PreferenceFixture = {
  desiredRuntimeGeneration: {
    credentialSources: string[];
    errorCode: string | null;
    externalAccountLabel: string | null;
    fingerprint: string;
    id: string;
    inventory: Record<string, unknown> | null;
    inventoryUpdatedAt: Date;
    oauthConnectionId: string | null;
    revisionId: string;
    state: "failed" | "idle" | "ready" | "starting" | "stopping";
    userServerId: string;
  } | null;
  desiredRuntimeGenerationId: string | null;
  discoveredInventory: Record<string, unknown> | null;
  discoveredOAuthConnectionId: string | null;
  discoveredRevisionId: string | null;
  enabled: boolean;
  id: string;
  runtimeGenerations: {
    inventory: Record<string, unknown> | null;
    oauthConnectionId: string | null;
    revisionId: string;
    state: "failed" | "idle" | "ready" | "starting" | "stopping";
  }[];
  userDisabledToolNames: string[];
  server: {
    activeRevision: {
      configuration: Record<string, unknown>;
      validationEvidence: Record<string, unknown>;
    } | null;
    activeRevisionId: string | null;
    archivedAt: Date | null;
    description: string;
    displayName: string;
    enabled: boolean;
    grants: { canUse: boolean; groupId: string | null; userId: string | null }[];
    id: string;
    namespace: string;
    oauthConnections: {
      disconnectRequestedAt: Date | null;
      id: string;
      state: "ready" | "reauthorization_required" | "disconnecting" | "disconnected";
      userId: string;
    }[];
    ownerUserId?: string | null;
  };
  user: {
    groups: { groupId: string }[];
    status: "active" | "disabled";
  };
  userId: string;
};

function preference(overrides: Partial<PreferenceFixture> = {}): PreferenceFixture {
  const id = overrides.id ?? "preference-1";
  return {
    desiredRuntimeGeneration: {
      credentialSources: ["personal"],
      errorCode: null,
      externalAccountLabel: null,
      fingerprint: "fingerprint-1",
      id: "generation-1",
      inventory: {
        tools: [{
          definitionHash: HASH,
          description: "Echo",
          inputSchema: { type: "object" },
          name: "echo"
        }],
        version: 1
      },
      inventoryUpdatedAt: NOW,
      oauthConnectionId: null,
      revisionId: "revision-1",
      state: "ready",
      userServerId: id
    },
    desiredRuntimeGenerationId: "generation-1",
    discoveredInventory: null,
    discoveredOAuthConnectionId: null,
    discoveredRevisionId: null,
    enabled: true,
    id,
    server: {
      activeRevision: {
        configuration: {},
        validationEvidence: {
          evidence: {
            server: { instructions: "Echo only validated input." }
          },
          toolInventory: [{
            arguments: [{ description: "Text to echo", name: "text", types: ["string"] }],
            description: "Echo",
            name: "echo",
            title: "Echo input"
          }]
        }
      },
      activeRevisionId: "revision-1",
      archivedAt: null,
      description: "Example tools",
      displayName: "Example MCP",
      enabled: true,
      grants: [{ canUse: true, groupId: null, userId: "user-1" }],
      id: "server-1",
      namespace: "example",
      oauthConnections: []
    },
    user: {
      groups: [],
      status: "active"
    },
    userId: "user-1",
    runtimeGenerations: [],
    userDisabledToolNames: [],
    ...overrides
  };
}

function clientWith(records: PreferenceFixture[]) {
  const findMany = vi.fn(async () => records);
  return {
    client: { user: { findUnique: async () => ({ status: "active", groups: [] }) }, mcpToolAccessPolicy: { findMany: async () => [] }, mcpUserServer: { findMany } } as unknown as PrismaClient,
    findMany
  };
}

type ProjectServerFixture = {
  ownerUserId: string | null;
  activeRevision: { configuration: Record<string, unknown>; validationEvidence: Record<string, unknown> } | null;
  activeRevisionId: string | null;
  archivedAt: Date | null;
  description: string;
  displayName: string;
  enabled: boolean;
  id: string;
  namespace: string;
  sharedConfigEnvelope: string | null;
  sharedRuntime: { desiredRuntimeGeneration: Record<string, unknown> | null } | null;
};

/** The shared generation Project runs use: owned by the server, never a member. */
function sharedGeneration(overrides: Record<string, unknown> = {}) {
  return {
    credentialSources: ["shared"],
    errorCode: null,
    fingerprint: "project-fingerprint-1",
    id: "project-generation-1",
    inventory: {
      tools: [{
        definitionHash: HASH,
        description: "Echo",
        inputSchema: { type: "object" },
        name: "echo"
      }],
      version: 1
    },
    inventoryUpdatedAt: NOW,
    oauthConnectionId: null,
    revisionId: "project-revision-1",
    sharedServerId: "project-server-1",
    state: "ready",
    userServerId: null,
    ...overrides
  };
}

function projectServer(overrides: Partial<ProjectServerFixture> = {}): ProjectServerFixture {
  return {
    activeRevision: {
      configuration: { auth: { mode: "none" }, slots: [] },
      validationEvidence: {
        toolInventory: [{ arguments: [], description: "Echo", name: "echo" }]
      }
    },
    activeRevisionId: "project-revision-1",
    archivedAt: null,
    description: "Shared Project tools",
    displayName: "Project MCP",
    enabled: true,
    id: "project-server-1",
    namespace: "project_tools",
    ownerUserId: null,
    sharedConfigEnvelope: null,
    sharedRuntime: { desiredRuntimeGeneration: sharedGeneration() },
    ...overrides
  };
}

function projectClientWith(servers: unknown[], restrictedToolNames: readonly string[] = []) {
  const findMany = vi.fn(async () => servers);
  return {
    client: {
      mcpServer: { findMany },
      mcpToolAccessPolicy: {
        findMany: async () => restrictedToolNames.map((toolName) => ({
          groups: [], restricted: true, serverId: "project-server-1", toolName, users: []
        }))
      },
      user: { findUnique: async () => ({ status: "active", groups: [] }) }
    } as unknown as PrismaClient,
    findMany
  };
}

describe("Prisma MCP run-plan loader", () => {
  it("offers the owner's personal OAuth inventory to Auto and filters a switched-off tool from the projection only", async () => {
    const record = preference();
    record.server.ownerUserId = "user-1";
    record.server.grants = [];
    record.server.activeRevision!.validationEvidence = { toolInventory: [] };
    const client = clientWith([record]).client;
    expect((await loadMcpCapabilityCatalog("user-1", client)).servers[0]?.tools).toMatchObject([{ originalName: "echo" }]);
    record.userDisabledToolNames = ["echo"];
    const [disabled] = await loadMcpRunPlanRecords("user-1", client);
    expect(disabled?.catalogTools).toEqual([]);
    expect(disabled?.inventory).toMatchObject({ tools: [] });
    // The generation keeps its full upstream inventory and identity.
    expect(disabled).toMatchObject({ fingerprint: "fingerprint-1", generationId: "generation-1" });
    expect((record.desiredRuntimeGeneration!.inventory as { tools: unknown[] }).tools).toHaveLength(1);
    expect((await loadMcpCapabilityCatalog("user-1", client)).servers).toEqual([]);
  });

  it.each([false, true])("reuses current OAuth catalog after idle generation cleanup=%s", async (drained) => {
    const record = preference({ desiredRuntimeGeneration: null, desiredRuntimeGenerationId: null });
    record.server.ownerUserId = "user-1";
    record.server.grants = [];
    record.server.activeRevision!.configuration = { auth: { mode: "oauth" } };
    record.server.activeRevision!.validationEvidence = { toolInventory: [] };
    record.server.oauthConnections = [{
      disconnectRequestedAt: null,
      id: "oauth-current",
      state: "ready",
      userId: "user-1"
    }];
    record.runtimeGenerations = [{
      inventory: { tools: [{ description: "Read mail", name: "mail.read" }], version: 1 },
      oauthConnectionId: "oauth-current",
      revisionId: "revision-1",
      state: "ready"
    }];
    if (drained) {
      record.discoveredInventory = record.runtimeGenerations[0]!.inventory;
      record.discoveredOAuthConnectionId = "oauth-current";
      record.discoveredRevisionId = "revision-1";
      record.runtimeGenerations = [];
    }

    const [loaded] = await loadMcpRunPlanRecords("user-1", clientWith([record]).client);
    expect(loaded).toMatchObject({ generationId: null, readiness: "queued" });
    expect(loaded?.catalogTools).toEqual([{ description: "Read mail", name: "mail.read" }]);
  });

  it.each([false, true])("does not reuse old OAuth catalog after account change with drained=%s", async (drained) => {
    const record = preference({ desiredRuntimeGeneration: null, desiredRuntimeGenerationId: null });
    record.server.ownerUserId = "user-1";
    record.server.grants = [];
    record.server.activeRevision!.configuration = { auth: { mode: "oauth" } };
    record.server.activeRevision!.validationEvidence = { toolInventory: [] };
    record.server.oauthConnections = [{
      disconnectRequestedAt: null,
      id: "oauth-new",
      state: "ready",
      userId: "user-1"
    }];
    record.runtimeGenerations = [{
      inventory: { tools: [{ description: "Read mail", name: "mail.read" }], version: 1 },
      oauthConnectionId: "oauth-old",
      revisionId: "revision-1",
      state: "ready"
    }];
    if (drained) {
      record.discoveredInventory = record.runtimeGenerations[0]!.inventory;
      record.discoveredOAuthConnectionId = "oauth-old";
      record.discoveredRevisionId = "revision-1";
      record.runtimeGenerations = [];
    }

    const [loaded] = await loadMcpRunPlanRecords("user-1", clientWith([record]).client);
    expect(loaded?.catalogTools).toEqual([]);
  });

  it("rejects a personal server owned by someone else despite an accidental direct grant", async () => {
    const record = preference();
    record.server.ownerUserId = "other-user";
    const [denied] = await loadMcpRunPlanRecords("user-1", clientWith([record]).client);
    expect(denied).toMatchObject({ catalogTools: [], generationId: null, errorCode: "mcp_access_revoked" });
  });

  it("rejects a personal server from Project runs even with a shared generation", async () => {
    const [denied] = await loadMcpRunPlanRecordsForProjectServers("user-1", ["project-server-1"],
      projectClientWith([projectServer({ ownerUserId: "user-1" })]).client);
    expect(denied).toMatchObject({ catalogTools: [], enabled: false, generationId: null, errorCode: "mcp_project_credentials_unavailable" });
  });

  it("admits the server's shared Project runtime without a personal grant or a member's runtime", async () => {
    const { client, findMany } = projectClientWith([projectServer()]);

    await expect(loadMcpRunPlanRecordsForProjectServers("user-1", ["project-server-1", "project-server-1"], client))
      .resolves.toEqual([expect.objectContaining({
        credentialSources: ["shared"],
        enabled: true,
        externalAccountLabel: null,
        fingerprint: "project-fingerprint-1",
        generationId: "project-generation-1",
        readiness: "ready",
        serverId: "project-server-1"
      })]);
    // Only the server and its shared runtime are read: no member row, grant or generation scan.
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({
        sharedRuntime: expect.objectContaining({ select: expect.objectContaining({ desiredRuntimeGeneration: expect.anything() }) })
      }),
      where: { id: { in: ["project-server-1"] } }
    }));
    expect(JSON.stringify(findMany.mock.calls[0])).not.toMatch(/userServer"|desiredFor|grants/u);
  });

  it.each([
    ["personal credential source", { desiredRuntimeGeneration: sharedGeneration({ credentialSources: ["personal"] }) },
      "mcp_project_credentials_unavailable"],
    ["OAuth connection", { desiredRuntimeGeneration: sharedGeneration({ oauthConnectionId: "oauth-1" }) },
      "mcp_project_credentials_unavailable"],
    ["member-owned generation", {
      desiredRuntimeGeneration: sharedGeneration({ sharedServerId: null, userServerId: "member-preference-1" })
    }, "mcp_runtime_stale"],
    ["another server's generation", { desiredRuntimeGeneration: sharedGeneration({ sharedServerId: "project-server-2" }) },
      "mcp_runtime_stale"],
    ["historical revision", { desiredRuntimeGeneration: sharedGeneration({ revisionId: "project-revision-0" }) },
      "mcp_revision_changed"],
    ["missing shared runtime", null, "mcp_runtime_unavailable"],
    ["shared runtime without a desired generation", { desiredRuntimeGeneration: null }, "mcp_runtime_unavailable"]
  ])("fails Project MCP closed for %s", async (_label, sharedRuntime, errorCode) => {
    const [record] = await loadMcpRunPlanRecordsForProjectServers("user-1", ["project-server-1"],
      projectClientWith([projectServer({ sharedRuntime })]).client
    );

    expect(record).toMatchObject({
      credentialSources: [],
      enabled: false,
      errorCode,
      generationId: null,
      readiness: "unavailable"
    });
  });

  it.each([
    ["an OAuth identity", { auth: { mode: "oauth" }, slots: [] }, null, "mcp_project_credentials_unavailable"],
    ["a personal-only value", { auth: { mode: "static" }, slots: [{ policy: { kind: "personal", required: true } }] },
      "encrypted-shared", "mcp_project_credentials_unavailable"],
    ["static authentication without shared values", { auth: { mode: "static" }, slots: [] }, null, "mcp_runtime_unavailable"]
  ])("never starts a Project runtime for a server that needs %s", async (_label, configuration, sharedConfigEnvelope, errorCode) => {
    const [record] = await loadMcpRunPlanRecordsForProjectServers("user-1", ["project-server-1"],
      projectClientWith([projectServer({
        activeRevision: { configuration, validationEvidence: { toolInventory: [] } },
        sharedConfigEnvelope
      })]).client
    );

    expect(record).toMatchObject({ enabled: false, errorCode, generationId: null, readiness: "unavailable" });
  });

  it.each([
    ["disabled server", { archivedAt: null, enabled: false }],
    ["archived server", { archivedAt: NOW, enabled: true }],
    ["server without an active revision", { activeRevision: null, activeRevisionId: null }]
  ])("fails Project MCP closed for a %s", async (_label, serverOverride) => {
    const [record] = await loadMcpRunPlanRecordsForProjectServers("user-1", ["project-server-1"],
      projectClientWith([projectServer(serverOverride)]).client
    );

    expect(record).toMatchObject({
      credentialSources: [],
      enabled: false,
      errorCode: "mcp_server_unavailable",
      generationId: null,
      readiness: "unavailable"
    });
  });

  it("reports a failed shared runtime's own cause", async () => {
    const [record] = await loadMcpRunPlanRecordsForProjectServers("user-1", ["project-server-1"],
      projectClientWith([projectServer({
        sharedRuntime: { desiredRuntimeGeneration: sharedGeneration({ errorCode: "mcp_connect_failed", state: "failed" }) }
      })]).client
    );

    expect(record).toMatchObject({ enabled: true, errorCode: "mcp_connect_failed", readiness: "unavailable" });
  });

  it("applies the initiator's tool restrictions to the shared runtime's projection only", async () => {
    const generation = sharedGeneration({
      inventory: {
        tools: ["echo", "write"].map((name) => ({ definitionHash: HASH, description: null, inputSchema: { type: "object" }, name })),
        version: 1
      }
    });
    const server = projectServer({ sharedRuntime: { desiredRuntimeGeneration: generation } });
    server.activeRevision!.validationEvidence = {
      toolInventory: [{ arguments: [], description: "Echo", name: "echo" }, { arguments: [], description: "Write", name: "write" }]
    };

    const [restricted] = await loadMcpRunPlanRecordsForProjectServers("user-1", ["project-server-1"],
      projectClientWith([server], ["write"]).client);
    const [open] = await loadMcpRunPlanRecordsForProjectServers("user-2", ["project-server-1"],
      projectClientWith([server]).client);

    expect(restricted).toMatchObject({ catalogTools: [{ name: "echo" }], generationId: "project-generation-1" });
    expect((restricted?.inventory as { tools: { name: string }[] }).tools.map(({ name }) => name)).toEqual(["echo"]);
    expect((open?.inventory as { tools: { name: string }[] }).tools.map(({ name }) => name)).toEqual(["echo", "write"]);
    // The shared generation's own inventory is never rewritten by one member's projection.
    expect((generation.inventory as { tools: unknown[] }).tools).toHaveLength(2);
  });

  it("loads a current ready generation through a direct grant", async () => {
    const { client, findMany } = clientWith([preference()]);

    await expect(loadMcpRunPlanRecords("user-1", client)).resolves.toEqual([{
      catalogTools: [{
        arguments: [{ description: "Text to echo", name: "text", types: ["string"] }],
        description: "Echo",
        name: "echo",
        title: "Echo input"
      }],
      credentialSources: ["personal"],
      enabled: true,
      errorCode: null,
      externalAccountLabel: null,
      fingerprint: "fingerprint-1",
      generationId: "generation-1",
      inventory: expect.objectContaining({ version: 1 }),
      inventoryUpdatedAt: NOW,
      namespace: "example",
      readiness: "ready",
      revisionId: "revision-1",
      serverDescription: "Example tools",
      serverId: "server-1",
      serverInstructions: "Echo only validated input.",
      serverName: "Example MCP"
    }]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { enabled: true, userId: "user-1" }
    }));
  });

  it("keeps a disabled preference visible to exact-subset availability", async () => {
    const disabled = preference({ enabled: false });
    const { client, findMany } = clientWith([disabled]);

    await expect(loadMcpRunPlanRecordsForServers(
      "user-1",
      ["server-1"],
      client
    )).resolves.toEqual([expect.objectContaining({
      enabled: false,
      errorCode: null,
      readiness: "disabled",
      serverId: "server-1",
      serverName: "Example MCP"
    })]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { serverId: { in: ["server-1"] }, userId: "user-1" }
    }));
  });

  it("builds a schema-free catalog for accessible dormant servers only", async () => {
    const accessible = preference({
      desiredRuntimeGeneration: null,
      desiredRuntimeGenerationId: null
    });
    const revoked = preference({ id: "preference-2" });
    revoked.server = {
      ...revoked.server,
      grants: [],
      id: "server-revoked",
      namespace: "revoked"
    };

    const catalog = await loadMcpCapabilityCatalog(
      "user-1",
      clientWith([accessible, revoked]).client
    );

    expect(catalog.servers).toEqual([expect.objectContaining({
      instructions: "Echo only validated input.",
      serverId: "server-1",
      tools: [expect.objectContaining({
        arguments: [{ description: "Text to echo", name: "text", types: ["string"] }],
        originalName: "echo",
        title: "Echo input"
      })]
    })]);
    expect(JSON.stringify(catalog)).not.toContain("inputSchema");
    expect(JSON.stringify(catalog)).not.toContain("server-revoked");
  });

  it("carries validated server instructions whole past the former 8,192-character filter", async () => {
    // Over 16 KiB of UTF-8 and over 8,192 characters, with JSON-escaped quotes.
    const instructions = `${"界".repeat(6_000)} "keys" ${"use scoped reads ".repeat(200)}`.trim();
    const record = preference({ desiredRuntimeGeneration: null, desiredRuntimeGenerationId: null });
    record.server.activeRevision!.validationEvidence = {
      ...record.server.activeRevision!.validationEvidence,
      evidence: { server: { instructions: `  ${instructions}\n` } }
    };

    const [loaded] = await loadMcpRunPlanRecords("user-1", clientWith([record]).client);
    expect(loaded?.serverInstructions).toBe(instructions);
    const catalog = await loadMcpCapabilityCatalog("user-1", clientWith([record]).client);
    expect(catalog.servers[0]?.instructions).toBe(instructions);
  });

  it("accepts a matching active-group grant", async () => {
    const record = preference();
    record.server.grants = [{ canUse: true, groupId: "group-1", userId: null }];
    record.user.groups = [{ groupId: "group-1" }];

    await expect(loadMcpRunPlanRecords("user-1", clientWith([record]).client))
      .resolves.toMatchObject([{ readiness: "ready", serverId: "server-1" }]);
  });

  it("surfaces lost access instead of silently removing an enabled preference", async () => {
    const record = preference();
    record.server.grants = [{ canUse: true, groupId: "other-group", userId: null }];

    await expect(loadMcpRunPlanRecords("user-1", clientWith([record]).client)).resolves.toEqual([
      expect.objectContaining({
        enabled: true,
        errorCode: "mcp_access_revoked",
        fingerprint: null,
        generationId: null,
        readiness: "unavailable",
        serverId: "server-1"
      })
    ]);
  });

  it.each([
    {
      expected: "mcp_server_unavailable",
      label: "disabled server",
      mutate: (record: PreferenceFixture) => { record.server.enabled = false; }
    },
    {
      expected: "mcp_server_unavailable",
      label: "archived server",
      mutate: (record: PreferenceFixture) => { record.server.archivedAt = NOW; }
    },
    {
      expected: "mcp_server_unavailable",
      label: "missing revision",
      mutate: (record: PreferenceFixture) => { record.server.activeRevisionId = null; }
    },
    {
      expected: "mcp_revision_changed",
      label: "stale generation revision",
      mutate: (record: PreferenceFixture) => {
        if (record.desiredRuntimeGeneration) record.desiredRuntimeGeneration.revisionId = "revision-old";
      }
    },
    {
      expected: "mcp_runtime_stale",
      label: "stale desired generation relation",
      mutate: (record: PreferenceFixture) => { record.desiredRuntimeGenerationId = "generation-other"; }
    }
  ])("surfaces $label", async ({ expected, mutate }) => {
    const record = preference();
    mutate(record);

    await expect(loadMcpRunPlanRecords("user-1", clientWith([record]).client)).resolves.toEqual([
      expect.objectContaining({ errorCode: expected, readiness: "unavailable" })
    ]);
  });

  it("keeps an enabled preference queued when no desired generation exists yet", async () => {
    const record = preference({
      desiredRuntimeGeneration: null,
      desiredRuntimeGenerationId: null
    });

    await expect(loadMcpRunPlanRecords("user-1", clientWith([record]).client)).resolves.toEqual([
      expect.objectContaining({
        enabled: true,
        errorCode: null,
        generationId: null,
        readiness: "queued"
      })
    ]);
  });
});

describe("Prisma MCP catalogs over held-back runtime tools", () => {
  function checkedPreference(exclusions: unknown) {
    const record = preference();
    record.server.activeRevision!.validationEvidence = {
      ...record.server.activeRevision!.validationEvidence,
      toolInventory: [
        { arguments: [], description: "Echo", name: "echo" },
        { arguments: [], description: "Search", name: "search" }
      ]
    };
    record.desiredRuntimeGeneration!.inventory = {
      exclusions,
      tools: [{ definitionHash: HASH, description: "Echo", inputSchema: { type: "object" }, name: "echo" }],
      version: 1
    };
    return record;
  }

  it("offers Auto only the published tools the ready runtime does not hold back", async () => {
    const record = checkedPreference([
      { name: "delete_repo", reason: "unpublished_addition" },
      { name: "search", reason: "definition_drift" }
    ]);

    const catalog = await loadMcpCapabilityCatalog("user-1", clientWith([record]).client);

    expect(catalog.servers).toEqual([expect.objectContaining({
      serverId: "server-1",
      tools: [expect.objectContaining({ originalName: "echo" })]
    })]);
    expect(JSON.stringify(catalog)).not.toContain("delete_repo");
  });

  it("keeps the published catalog when the persisted inventory is malformed so materialization fails closed", async () => {
    const [record] = await loadMcpRunPlanRecords("user-1", clientWith([
      checkedPreference([{ name: "search", reason: "not_a_reason" }])
    ]).client);

    expect(record?.catalogTools?.map(({ name }) => name)).toEqual(["echo", "search"]);
  });

  it("subtracts the Project generation's held-back tools from its catalog", async () => {
    const server = projectServer({
      sharedRuntime: {
        desiredRuntimeGeneration: sharedGeneration({
          inventory: {
            exclusions: [{ name: "search", reason: "missing_upstream" }],
            tools: [{ definitionHash: HASH, description: "Echo", inputSchema: { type: "object" }, name: "echo" }],
            version: 1
          }
        })
      }
    });
    server.activeRevision!.validationEvidence = {
      toolInventory: [
        { arguments: [], description: "Echo", name: "echo" },
        { arguments: [], description: "Search", name: "search" }
      ]
    };

    const [record] = await loadMcpRunPlanRecordsForProjectServers(
      "user-1", ["project-server-1"], projectClientWith([server]).client
    );

    expect(record?.catalogTools?.map(({ name }) => name)).toEqual(["echo"]);
  });

  it("filters a restricted tool from the user's projection and keeps the runtime's held-back names", async () => {
    const exclusions = [{ name: "search", reason: "definition_drift" }];
    const { client } = clientWith([checkedPreference(exclusions)]);
    const restricted = {
      ...client,
      mcpToolAccessPolicy: {
        findMany: async () => [{ groups: [], restricted: true, serverId: "server-1", toolName: "echo", users: [] }]
      }
    } as unknown as PrismaClient;

    const [record] = await loadMcpRunPlanRecords("user-1", restricted);

    expect(record?.inventory).toEqual({ exclusions, tools: [], version: 1 });
    expect(record?.catalogTools).toEqual([]);
  });
});

describe("Prisma MCP personal live catalog", () => {
  function runtimeTool(name: string, description: string | null = `${name} live`) {
    return { definitionHash: HASH, description, inputSchema: { type: "object" }, name };
  }

  function personal(names: readonly string[], overrides: Partial<PreferenceFixture> = {}) {
    const record = preference(overrides);
    record.server.ownerUserId = "user-1";
    record.server.grants = [];
    record.server.activeRevision!.configuration = { auth: { mode: "none" } };
    if (record.desiredRuntimeGeneration) {
      record.desiredRuntimeGeneration.inventory = { exclusions: [], tools: names.map((name) => runtimeTool(name)), version: 1 };
    }
    return record;
  }

  async function catalogNames(client: PrismaClient) {
    return (await loadMcpCapabilityCatalog("user-1", client)).servers
      .flatMap((server) => server.tools.map((tool) => tool.originalName));
  }

  it("offers an upstream addition and drops an observed removal for a validated server", async () => {
    const record = personal(["echo", "added"]);
    const { client } = clientWith([record]);

    expect((await loadMcpCapabilityCatalog("user-1", client)).servers[0]?.tools).toEqual([
      expect.objectContaining({
        arguments: [{ description: "Text to echo", name: "text", types: ["string"] }],
        description: "echo live",
        originalName: "echo",
        title: "Echo input"
      }),
      { arguments: [], description: "added live", namespacedName: namespacedMcpToolName("example", "added"), originalName: "added" }
    ]);
    // The runtime observed the validated tool's removal: Auto stops offering it.
    record.desiredRuntimeGeneration!.inventory = { exclusions: [], tools: [runtimeTool("added")], version: 1 };
    expect(await catalogNames(client)).toEqual(["added"]);
  });

  it("removes a switched-off tool from Load all and the dispatch rebuild on the same generation", async () => {
    const record = personal(["echo", "write"]);
    const { client } = clientWith([record]);
    const write = namespacedMcpToolName("example", "write");
    const plan = (allowedToolNames?: readonly string[]) => prepareMcpRunPlan({
      allowedServerIds: ["server-1"],
      ...(allowedToolNames ? { allowedToolNames } : {}),
      isGenerationLive: () => true,
      load: () => loadMcpRunPlanRecordsForServers("user-1", ["server-1"], client),
      now: () => NOW
    });

    await expect(plan([write])).resolves.toMatchObject({ ok: true, snapshot: { tools: [{ originalName: "write" }] } });
    record.userDisabledToolNames = ["write"];
    await expect(plan([write])).resolves.toMatchObject({
      code: "mcp_not_ready", issues: [{ errorCode: "mcp_tool_not_available" }], ok: false
    });
    const loadAll = await plan();
    if (!loadAll.ok) throw new Error(loadAll.code);
    expect(loadAll.snapshot.tools.map((tool) => tool.originalName)).toEqual(["echo"]);
    expect(loadAll.bindings).toEqual([{ fingerprint: "fingerprint-1", runtimeGenerationId: "generation-1", serverId: "server-1" }]);
    expect(await catalogNames(client)).toEqual(["echo"]);
    record.userDisabledToolNames = [];
    await expect(plan([write])).resolves.toMatchObject({ ok: true });
  });

  it("lists a validated server's seeded discovery before its first runtime is ready", async () => {
    const record = personal([], {
      desiredRuntimeGeneration: null,
      desiredRuntimeGenerationId: null,
      discoveredInventory: { tools: [{ description: "Echo", name: "echo" }], version: 1 },
      discoveredRevisionId: "revision-1"
    });

    const [loaded] = await loadMcpRunPlanRecords("user-1", clientWith([record]).client);
    expect(loaded).toMatchObject({ generationId: null, readiness: "queued" });
    expect(loaded?.catalogTools).toEqual([{
      arguments: [{ description: "Text to echo", name: "text", types: ["string"] }],
      description: "Echo",
      name: "echo",
      title: "Echo input"
    }]);
  });

  it("keeps a same-connection OAuth restart in Auto and holds a re-authorized account back until it is ready", async () => {
    const record = personal([], {
      discoveredInventory: { tools: [{ description: "Read mail", name: "mail.read" }], version: 1 },
      discoveredOAuthConnectionId: "oauth-1",
      discoveredRevisionId: "revision-1"
    });
    record.server.activeRevision!.configuration = { auth: { mode: "oauth" } };
    record.server.activeRevision!.validationEvidence = { toolInventory: [] };
    record.server.oauthConnections = [{ disconnectRequestedAt: null, id: "oauth-1", state: "ready", userId: "user-1" }];
    record.desiredRuntimeGeneration = { ...record.desiredRuntimeGeneration!, inventory: null, oauthConnectionId: "oauth-1", state: "starting" };
    const { client } = clientWith([record]);

    const [restarting] = await loadMcpRunPlanRecords("user-1", client);
    expect(restarting).toMatchObject({ catalogTools: [{ description: "Read mail", name: "mail.read" }], readiness: "starting" });
    expect(await catalogNames(client)).toEqual(["mail.read"]);

    record.server.oauthConnections = [
      { disconnectRequestedAt: NOW, id: "oauth-1", state: "disconnecting", userId: "user-1" },
      { disconnectRequestedAt: null, id: "oauth-2", state: "ready", userId: "user-1" }
    ];
    record.desiredRuntimeGeneration = { ...record.desiredRuntimeGeneration!, id: "generation-2", oauthConnectionId: "oauth-2" };
    record.desiredRuntimeGenerationId = "generation-2";
    record.runtimeGenerations = [{
      inventory: { tools: [{ description: "Read mail", name: "mail.read" }], version: 1 },
      oauthConnectionId: "oauth-1",
      revisionId: "revision-1",
      state: "ready"
    }];
    expect(await catalogNames(client)).toEqual([]);

    record.desiredRuntimeGeneration = {
      ...record.desiredRuntimeGeneration!,
      inventory: { exclusions: [], tools: [runtimeTool("drive.read")], version: 1 },
      state: "ready"
    };
    expect(await catalogNames(client)).toEqual(["drive.read"]);
  });

  it("bounds live descriptions in the personal catalog", async () => {
    const record = personal([]);
    record.desiredRuntimeGeneration!.inventory = { exclusions: [], tools: [runtimeTool("echo", "d".repeat(5_000))], version: 1 };

    const [loaded] = await loadMcpRunPlanRecords("user-1", clientWith([record]).client);
    expect(loaded?.catalogTools?.[0]?.description).toHaveLength(MAX_TOOL_DESCRIPTION_LENGTH);
    // The runtime inventory used for model-facing definitions keeps the upstream text.
    expect((loaded?.inventory as { tools: { description: string }[] }).tools[0]?.description).toHaveLength(5_000);
  });
});

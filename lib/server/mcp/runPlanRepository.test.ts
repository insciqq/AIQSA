import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
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
    inventory: Record<string, unknown>;
    inventoryUpdatedAt: Date;
    revisionId: string;
    state: "failed" | "idle" | "ready" | "starting" | "stopping";
    userServerId: string;
  } | null;
  desiredRuntimeGenerationId: string | null;
  enabled: boolean;
  id: string;
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
      revisionId: "revision-1",
      state: "ready",
      userServerId: id
    },
    desiredRuntimeGenerationId: "generation-1",
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
      namespace: "example"
    },
    user: {
      groups: [],
      status: "active"
    },
    userId: "user-1",
    ...overrides
  };
}

function clientWith(records: PreferenceFixture[]) {
  const findMany = vi.fn(async () => records);
  return {
    client: { mcpUserServer: { findMany } } as unknown as PrismaClient,
    findMany
  };
}

function projectGeneration(overrides: Record<string, unknown> = {}) {
  return {
    credentialSources: ["shared"],
    errorCode: null,
    externalAccountLabel: null,
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
    revision: {
      configuration: { auth: { mode: "none" } },
      id: "project-revision-1",
      server: {
        activeRevisionId: "project-revision-1",
        archivedAt: null,
        description: "Shared Project tools",
        displayName: "Project MCP",
        enabled: true,
        id: "project-server-1",
        namespace: "project_tools",
        sharedConfigEnvelope: null
      },
      validationEvidence: {
        toolInventory: [{ arguments: [], description: "Echo", name: "echo" }]
      }
    },
    state: "ready",
    userServer: {
      desiredRuntimeGenerationId: "project-generation-1",
      enabled: true,
      personalConfigEnvelope: null,
      serverId: "project-server-1"
    },
    ...overrides
  };
}

function projectClientWith(records: unknown[]) {
  const findMany = vi.fn(async () => records);
  return {
    client: { mcpRuntimeGeneration: { findMany } } as unknown as PrismaClient,
    findMany
  };
}

describe("Prisma MCP run-plan loader", () => {
  it("admits a current shared/no-auth runtime for Project scope without a personal grant", async () => {
    const { client, findMany } = projectClientWith([projectGeneration()]);

    await expect(loadMcpRunPlanRecordsForProjectServers(["project-server-1"], client))
      .resolves.toEqual([expect.objectContaining({
        credentialSources: ["shared"],
        enabled: true,
        externalAccountLabel: null,
        generationId: "project-generation-1",
        readiness: "ready",
        serverId: "project-server-1"
      })]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        state: "ready"
      })
    }));
  });

  it.each([
    [
      "personal credential source",
      { credentialSources: ["personal"] },
      "mcp_project_credentials_unavailable"
    ],
    [
      "OAuth connection",
      { oauthConnectionId: "oauth-1" },
      "mcp_project_credentials_unavailable"
    ],
    ["personal slot envelope", {
      userServer: {
        desiredRuntimeGenerationId: "project-generation-1",
        enabled: true,
        personalConfigEnvelope: "encrypted",
        serverId: "project-server-1"
      }
    }, "mcp_project_credentials_unavailable"],
    ["historical non-current generation", {
      userServer: {
        desiredRuntimeGenerationId: "project-generation-2",
        enabled: true,
        personalConfigEnvelope: null,
        serverId: "project-server-1"
      }
    }, "mcp_runtime_unavailable"]
  ])("fails Project MCP closed for %s", async (_label, override, errorCode) => {
    const [record] = await loadMcpRunPlanRecordsForProjectServers(
      ["project-server-1"],
      projectClientWith([projectGeneration(override)]).client
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
    ["disabled server", { archivedAt: null, enabled: false }],
    ["archived server", { archivedAt: NOW, enabled: true }]
  ])("fails Project MCP closed for a %s", async (_label, serverOverride) => {
    const generation = projectGeneration();
    Object.assign(
      generation.revision.server as { archivedAt: Date | null; enabled: boolean },
      serverOverride
    );
    const [record] = await loadMcpRunPlanRecordsForProjectServers(
      ["project-server-1"],
      projectClientWith([generation]).client
    );

    expect(record).toMatchObject({
      credentialSources: [],
      enabled: false,
      errorCode: "mcp_runtime_unavailable",
      generationId: null,
      readiness: "unavailable"
    });
  });

  it("does not let a newer invalid member generation mask an older runnable generation", async () => {
    const invalid = projectGeneration({
      credentialSources: ["personal"],
      id: "project-generation-new-invalid",
      userServer: {
        desiredRuntimeGenerationId: "project-generation-new-invalid",
        enabled: true,
        personalConfigEnvelope: null,
        serverId: "project-server-1"
      }
    });
    const runnable = projectGeneration({
      id: "project-generation-older-runnable",
      userServer: {
        desiredRuntimeGenerationId: "project-generation-older-runnable",
        enabled: true,
        personalConfigEnvelope: null,
        serverId: "project-server-1"
      }
    });

    await expect(loadMcpRunPlanRecordsForProjectServers(
      ["project-server-1"],
      projectClientWith([invalid, runnable]).client
    )).resolves.toEqual([expect.objectContaining({
      enabled: true,
      generationId: "project-generation-older-runnable",
      readiness: "ready",
      serverId: "project-server-1"
    })]);
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

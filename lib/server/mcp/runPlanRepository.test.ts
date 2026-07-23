import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { loadMcpRunPlanRecords } from "./runPlanRepository";

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
    activeRevisionId: string | null;
    archivedAt: Date | null;
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
      activeRevisionId: "revision-1",
      archivedAt: null,
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

describe("Prisma MCP run-plan loader", () => {
  it("loads a current ready generation through a direct grant", async () => {
    const { client, findMany } = clientWith([preference()]);

    await expect(loadMcpRunPlanRecords("user-1", client)).resolves.toEqual([{
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
      serverId: "server-1",
      serverName: "Example MCP"
    }]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { enabled: true, userId: "user-1" }
    }));
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

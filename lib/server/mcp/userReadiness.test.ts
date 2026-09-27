import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { createPrismaMcpRepository, deriveKnownMcpToolCount, deriveMcpUserReadiness } from "./prismaRepository";

const now = new Date("2026-07-23T00:00:00.000Z");

function readiness(preferenceUpdatedAt: Date) {
  return deriveMcpUserReadiness({
    enabled: true,
    hasInvalidValues: false,
    hasMissingValues: false,
    now,
    oauthMode: false,
    oauthState: null,
    preferenceUpdatedAt,
    runtime: null
  });
}

describe("MCP user readiness", () => {
  it("keeps an enabled runtime-less server idle until an on-demand start", () => {
    expect(readiness(new Date(now.getTime() - 30_000))).toEqual({
      errorCode: null,
      readiness: "idle",
      tools: [],
      unavailableTools: []
    });
    expect(readiness(new Date(now.getTime() - 15 * 60_000))).toEqual({
      errorCode: null,
      readiness: "idle",
      tools: [],
      unavailableTools: []
    });
  });

  it("lists every tool a ready runtime holds back with its reason", () => {
    expect(deriveMcpUserReadiness({
      enabled: true,
      hasInvalidValues: false,
      hasMissingValues: false,
      now,
      oauthMode: false,
      oauthState: null,
      preferenceUpdatedAt: now,
      runtime: {
        errorCode: null,
        inventory: {
          exclusions: [
            { name: "delete_repo", reason: "unpublished_addition" },
            { name: "echo", reason: "definition_drift" }
          ],
          tools: [{ description: "Search", name: "search" }],
          version: 1
        },
        state: "ready"
      }
    })).toEqual({
      errorCode: null,
      readiness: "ready",
      tools: [{ description: "Search", name: "search" }],
      unavailableTools: [
        { name: "delete_repo", reason: "unpublished_addition" },
        { name: "echo", reason: "definition_drift" }
      ]
    });
  });

  it.each([513, 1_024])("projects the same %i-tool inventory to admin counts and the user's catalog as the runtime", (count) => {
    const tools = Array.from({ length: count }, (_, index) => ({ description: null, name: `tool_${index}` }));
    const inventory = {
      exclusions: tools.map(({ name }) => ({ name: `${name}_new`, reason: "unpublished_addition" })),
      tools: tools.map((tool) => ({ ...tool, definitionHash: "a".repeat(64), inputSchema: { type: "object" } })),
      version: 1
    };
    const user = deriveMcpUserReadiness({
      enabled: true, hasInvalidValues: false, hasMissingValues: false, now, oauthMode: false, oauthState: null,
      preferenceUpdatedAt: now, runtime: { errorCode: null, inventory, state: "ready" }
    });
    expect(user.tools).toHaveLength(count);
    expect(user.unavailableTools).toHaveLength(count);
    const revisionValidationEvidence = { evidence: {}, testedAt: now.toISOString(), toolInventory: tools };
    expect(deriveKnownMcpToolCount({ revisionCreatedAt: now, revisionValidationEvidence, runtimeInventory: null })).toBe(count);
    expect(deriveKnownMcpToolCount({ revisionCreatedAt: now, revisionValidationEvidence, runtimeInventory: inventory })).toBe(count);
  });

  it("uses active-revision inventory before startup and current runtime inventory afterward", () => {
    const revisionValidationEvidence = {
      evidence: {},
      testedAt: now.toISOString(),
      toolInventory: [
        { description: null, name: "revision_one" },
        { description: null, name: "revision_two" }
      ]
    };

    expect(deriveKnownMcpToolCount({
      disabledToolNames: ["revision_two", "REVISION_ONE"],
      revisionCreatedAt: now,
      revisionValidationEvidence,
      runtimeInventory: null
    })).toBe(1);
    expect(deriveKnownMcpToolCount({
      revisionCreatedAt: now,
      revisionValidationEvidence,
      runtimeInventory: { tools: [{ description: null, name: "runtime_one" }] }
    })).toBe(1);
    expect(deriveKnownMcpToolCount({
      revisionCreatedAt: now,
      revisionValidationEvidence,
      runtimeInventory: { tools: [] }
    })).toBe(0);
  });

  it("shows the user's own restriction instead of dropping or out-ranking it", async () => {
    const draft = {
      auth: { mode: "none" },
      runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 60_000 },
      slots: [],
      source: { kind: "remote", url: "https://mcp.example.test/mcp" },
      transport: "streamable_http"
    };
    const server = {
      activeRevision: {
        configuration: draft,
        createdAt: now,
        id: "revision-1",
        validationEvidence: {
          evidence: {},
          testedAt: now.toISOString(),
          toolInventory: ["echo", "search", "slow"].map((name) => ({ description: null, name }))
        }
      },
      description: "Synthetic tools",
      displayName: "Synthetic",
      grants: [{ canUse: true, groupId: null, personalSlotKeys: [], userId: "user-1" }],
      id: "server-1",
      oauthConnections: [],
      sharedConfigEnvelope: null,
      sharedConfigVersion: 0,
      userServers: [{
        desiredRuntimeGeneration: {
          errorCode: null,
          id: "generation-1",
          inventory: {
            exclusions: [
              { name: "delete_repo", reason: "unpublished_addition" },
              { name: "slow", reason: "missing_upstream" }
            ],
            tools: [
              { definitionHash: "a".repeat(64), description: "Echo", inputSchema: { type: "object" }, name: "echo" },
              { definitionHash: "b".repeat(64), description: "Search", inputSchema: { type: "object" }, name: "search" }
            ],
            version: 1
          },
          state: "ready"
        },
        enabled: true,
        id: "preference-1",
        personalConfigEnvelope: null,
        personalConfigVersion: 0,
        updatedAt: now
      }]
    };
    const policy = (toolName: string) => ({ groups: [], restricted: true, serverId: "server-1", toolName, users: [] });
    const client = {
      mcpServer: { findMany: async () => [server] },
      mcpToolAccessPolicy: { findMany: async () => [policy("search"), policy("slow")] },
      user: { findUnique: async () => ({ groups: [], status: "active" }) }
    } as unknown as PrismaClient;
    const repository = createPrismaMcpRepository({ encryptionKey: () => Buffer.alloc(32, 1), prisma: client });

    const [listed] = await repository.listUserServers("user-1");

    expect(listed).toMatchObject({
      knownToolCount: 1,
      readiness: "ready",
      tools: [{ description: "Echo", name: "echo" }],
      unavailableTools: [
        { name: "delete_repo", reason: "unpublished_addition" },
        { name: "search", reason: "restricted" },
        { name: "slow", reason: "restricted" }
      ]
    });
  });
});

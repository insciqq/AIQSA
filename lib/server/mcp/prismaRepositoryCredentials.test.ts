import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import type { McpDraftValidationInput, McpDraftValidationOutcome } from "./draftValidator";
import { decryptMcpEnvelope, mcpPersonalConfigEnvelopeContext } from "./encryption";
import { createPrismaMcpRepository } from "./prismaRepository";

const now = new Date("2026-10-02T12:00:00.000Z");
const key = Buffer.alloc(32, 5);
const URL = "https://mcp.example.test/mcp";

function staticDraft(headerName = "Authorization"): McpDraftConfiguration {
  return {
    auth: { mode: "static" },
    runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
    slots: [{
      label: "Authorization header",
      policy: { kind: "personal", required: true },
      sensitive: true,
      slotKey: "authorization",
      target: { kind: "header", name: headerName },
      valueType: "secret"
    }],
    source: { kind: "remote", url: URL },
    transport: "streamable_http"
  };
}

/** One owner's personal server as the repository loads it. */
function personalServer(configuration: McpDraftConfiguration, revisionId = "revision-1", version = 3) {
  return {
    activeRevision: {
      configuration,
      createdAt: now,
      id: revisionId,
      validationEvidence: { evidence: {}, testedAt: now.toISOString(), toolInventory: [{ description: "Read", name: "read" }] }
    },
    activeRevisionId: revisionId,
    description: "",
    displayName: "Static fixture",
    enabled: true,
    grants: [],
    id: "server-1",
    oauthConnections: [],
    ownerUserId: "user-1",
    sharedConfigEnvelope: null,
    sharedConfigVersion: 0,
    userServers: [{
      desiredRuntimeGeneration: null,
      desiredRuntimeGenerationId: "generation-old",
      discoveredInventory: null,
      discoveredOAuthConnectionId: null,
      discoveredRevisionId: null,
      enabled: true,
      id: "preference-1",
      personalConfigEnvelope: null,
      personalConfigVersion: version,
      runtimeGenerations: [],
      updatedAt: now,
      userDisabledToolNames: ["write"]
    }]
  };
}

function okOutcome(): McpDraftValidationOutcome {
  return { evidence: { protocol: "fixture" }, kind: "ok", resolvedArtifact: null, toolInventory: [{ description: "Read", name: "read" }] };
}

function harness(input: {
  configuration?: McpDraftConfiguration;
  lockedVersion?: number;
  outcome?: McpDraftValidationOutcome;
  written?: number;
} = {}) {
  const configuration = input.configuration ?? staticDraft();
  const server = personalServer(configuration);
  const validate = vi.fn(async (_input: McpDraftValidationInput) => input.outcome ?? okOutcome());
  const updateMany = vi.fn(async () => ({ count: input.written ?? 1 }));
  const revisionCreate = vi.fn(async () => ({ id: "revision-2" }));
  const serverUpdate = vi.fn(async () => ({}));
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ id: server.id }]),
    mcpRevision: {
      aggregate: vi.fn(async () => ({ _max: { revisionNumber: 4 } })),
      create: revisionCreate,
      findUnique: vi.fn(async () => null)
    },
    mcpServer: {
      findMany: async () => [server],
      findUnique: async () => ({ activeRevisionId: server.activeRevisionId, enabled: true, ownerUserId: "user-1" }),
      update: serverUpdate
    },
    mcpToolAccessPolicy: { findMany: async () => [] },
    mcpUserServer: {
      findUnique: async () => ({ id: "preference-1", personalConfigVersion: input.lockedVersion ?? 3 }),
      updateMany
    },
    user: {
      findFirst: async () => ({ id: "user-1" }),
      findUnique: async () => ({ groups: [], status: "active" })
    }
  };
  const transaction = vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx));
  const client = {
    ...tx,
    $transaction: transaction,
    mcpServer: { ...tx.mcpServer, findFirst: async () => server }
  } as unknown as PrismaClient;
  return {
    revisionCreate,
    serverUpdate,
    storage: createPrismaMcpRepository({ draftValidator: { validate }, encryptionKey: () => key, prisma: client }),
    transaction,
    updateMany,
    validate
  };
}

function writtenData(updateMany: ReturnType<typeof harness>["updateMany"]): Record<string, unknown> {
  const call = updateMany.mock.calls[0] as unknown as [{ data: Record<string, unknown>; where: unknown }];
  return call[0].data;
}

describe("personal MCP credential replacement", () => {
  it("validates the new secret at the stored URL and writes it under the expected version without a new revision", async () => {
    const { revisionCreate, serverUpdate, storage, updateMany, validate } = harness();
    const result = await storage.replacePersonalCredentials!({ authorization: "Bearer rotated", serverId: "server-1", userId: "user-1" });

    expect(result).toMatchObject({ kind: "ok", value: {
      authHeaderName: "Authorization", authMode: "static", id: "server-1", userDisabledToolNames: ["write"]
    } });
    expect(JSON.stringify(result)).not.toContain("rotated");
    expect(validate).toHaveBeenCalledWith({
      draft: staticDraft(), serverId: "server-1", validationUserId: "user-1", values: { authorization: "Bearer rotated" }
    });
    expect(revisionCreate).not.toHaveBeenCalled();
    expect(serverUpdate).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "preference-1", personalConfigVersion: 3 } }));
    const data = writtenData(updateMany);
    expect(data).toMatchObject({ desiredRuntimeGenerationId: null, discoveredRevisionId: "revision-1", personalConfigVersion: 4 });
    expect(decryptMcpEnvelope(data.personalConfigEnvelope as string, key, mcpPersonalConfigEnvelopeContext("preference-1", 4)))
      .toMatchObject({ values: { authorization: "Bearer rotated" } });
  });

  it("publishes the next revision for a new header name together with the new secret", async () => {
    const { revisionCreate, serverUpdate, storage, updateMany, validate } = harness();
    const result = await storage.replacePersonalCredentials!({
      authorization: "fixture-key", headerName: "X-API-Key", serverId: "server-1", userId: "user-1"
    });

    expect(result.kind).toBe("ok");
    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ draft: staticDraft("X-API-Key") }));
    expect(revisionCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      configuration: staticDraft("X-API-Key"), revisionNumber: 5, serverId: "server-1"
    }) }));
    expect(serverUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ activeRevisionId: "revision-2", draft: staticDraft("X-API-Key") }),
      where: { id: "server-1" }
    }));
    expect(writtenData(updateMany)).toMatchObject({ discoveredRevisionId: "revision-2", personalConfigVersion: 4 });
  });

  it("refuses a replacement validated against a version another replacement already superseded", async () => {
    const stale = harness({ lockedVersion: 4 });
    await expect(stale.storage.replacePersonalCredentials!({ authorization: "late", serverId: "server-1", userId: "user-1" }))
      .resolves.toEqual({ kind: "credentials_changed" });
    expect(stale.updateMany).not.toHaveBeenCalled();

    const raced = harness({ written: 0 });
    await expect(raced.storage.replacePersonalCredentials!({ authorization: "late", serverId: "server-1", userId: "user-1" }))
      .resolves.toEqual({ kind: "credentials_changed" });
  });

  it.each([
    { auth: { mode: "none" as const }, slots: [] },
    { auth: { allowedAuthorizationServerOrigins: ["https://mcp.example.test"], mode: "oauth" as const, scopes: [] }, slots: [] }
  ])("refuses a connection without a static credential before any validation", async (overrides) => {
    const { storage, transaction, validate } = harness({ configuration: { ...staticDraft(), ...overrides } });
    await expect(storage.replacePersonalCredentials!({ authorization: "key", serverId: "server-1", userId: "user-1" }))
      .resolves.toEqual({ kind: "auth_mode_invalid" });
    expect(validate).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("attributes an unsettable header to the value unless the header name changes", async () => {
    const outcome: McpDraftValidationOutcome = { issues: [{ code: "mcp_static_header_invalid", path: "slots.0.target.name" }], kind: "invalid" };
    const kept = harness({ outcome });
    await expect(kept.storage.replacePersonalCredentials!({ authorization: "key", serverId: "server-1", userId: "user-1" }))
      .resolves.toEqual({ issues: [{ code: "mcp_static_header_invalid", path: "values.authorization" }], kind: "draft_validation_failed" });
    const renamed = harness({ outcome });
    await expect(renamed.storage.replacePersonalCredentials!({ authorization: "key", headerName: "X-API-Key", serverId: "server-1", userId: "user-1" }))
      .resolves.toEqual({ issues: [{ code: "mcp_static_header_invalid", path: "slots.0.target.name" }], kind: "draft_validation_failed" });
  });

  it("keeps the stored credentials when validation fails or would move the endpoint", async () => {
    const rejected = harness({ outcome: { issues: [{ code: "mcp_authorization_required", httpStatus: 401, path: "source" }], kind: "invalid" } });
    await expect(rejected.storage.replacePersonalCredentials!({ authorization: "expired", serverId: "server-1", userId: "user-1" }))
      .resolves.toEqual({ issues: [{ code: "mcp_authorization_required", httpStatus: 401, path: "source" }], kind: "draft_validation_failed" });
    expect(rejected.transaction).not.toHaveBeenCalled();

    const corrected = harness({ outcome: { ...okOutcome(), endpointCorrection: {
      fromUrl: URL, kind: "gitlab", toUrl: "https://mcp.example.test/api/v4/mcp"
    } } as McpDraftValidationOutcome });
    await expect(corrected.storage.replacePersonalCredentials!({ authorization: "key", serverId: "server-1", userId: "user-1" }))
      .resolves.toEqual({ issues: [{ code: "validator_result_invalid", path: "validator" }], kind: "draft_validation_failed" });
    expect(corrected.transaction).not.toHaveBeenCalled();
  });
});

// @vitest-environment node

import type { AdminMcpServer, UserMcpServer } from "@/lib/contracts/mcp";
import { describe, expect, it, vi } from "vitest";
import { createMcpOAuthSettler } from "./oauthSettlement";
import type { McpRepository } from "./repositoryContract";

const DRAFT_HASH = "draft-hash-1";

function adminServer(input: Readonly<{
  activeDraftHash?: string | null;
  enabled?: boolean;
  testedDraftHash?: string | null;
}> = {}): AdminMcpServer {
  const testedDraftHash = input.testedDraftHash === undefined ? DRAFT_HASH : input.testedDraftHash;
  const activeDraftHash = input.activeDraftHash === undefined ? DRAFT_HASH : input.activeDraftHash;
  return {
    activation: {
      completedAt: null,
      errorCode: null,
      id: "activation-1",
      issues: [],
      requestedAt: "2026-07-23T00:00:00.000Z",
      stage: "queued",
      startedAt: null,
      updatedAt: "2026-07-23T00:00:00.000Z"
    },
    activePersonalSlots: [],
    activeRevision: activeDraftHash ? {
      artifactStatus: "not_applicable",
      createdAt: "2026-07-23T00:00:00.000Z",
      draftHash: activeDraftHash,
      id: "revision-1",
      identityHash: `identity-${activeDraftHash}`,
      resolvedArtifact: null,
      revisionNumber: 1,
      validationEvidence: { evidence: {}, testedAt: "2026-07-23T00:00:00.000Z", toolInventory: [] }
    } : null,
    archivedAt: null,
    description: "OAuth MCP",
    draft: {
      auth: {
        allowedAuthorizationServerOrigins: ["https://auth.example.test"],
        mode: "oauth",
        scopes: []
      },
      runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 45_000 },
      slots: [],
      source: { kind: "remote", url: "https://mcp.example.test/mcp" },
      transport: "streamable_http"
    },
    draftTest: testedDraftHash ? {
      draftHash: testedDraftHash,
      evidence: {},
      identityHash: `identity-${testedDraftHash}`,
      resolvedArtifact: null,
      testedAt: "2026-07-23T00:00:00.000Z",
      toolInventory: []
    } : null,
    draftTested: Boolean(testedDraftHash),
    enabled: input.enabled ?? true,
    grants: [],
    id: "server-1",
    name: "OAuth MCP",
    namespace: "oauth-mcp",
    revisions: [],
    sharedValues: {},
    updatedAt: "2026-07-23T00:00:00.000Z",
    validationOAuth: null
  };
}

function userServer(enabled: boolean): UserMcpServer {
  return {
    accountLabel: "Workspace",
    description: "OAuth MCP",
    enabled,
    errorCode: null,
    fields: [],
    id: "server-1",
    knownToolCount: 1,
    name: "OAuth MCP",
    oauthAvailable: true,
    oauthState: "ready",
    readiness: enabled ? "queued" : "disabled",
    tools: []
  };
}

function repository(input: Readonly<{
  activateDraft?: McpRepository["activateDraft"];
  requestActivation?: McpRepository["requestActivation"];
  testDraft?: McpRepository["testDraft"];
  updateUserServer?: McpRepository["updateUserServer"];
}> = {}): McpRepository {
  return {
    activateDraft: input.activateDraft ?? vi.fn(async () => ({ kind: "ok", value: adminServer() })),
    requestActivation: input.requestActivation ?? vi.fn(async () => ({ kind: "ok", value: adminServer() })),
    testDraft: input.testDraft ?? vi.fn(async () => ({ kind: "ok", value: adminServer() })),
    updateUserServer: input.updateUserServer ?? vi.fn(async () => ({ kind: "ok", value: userServer(true) }))
  } as McpRepository;
}

describe("MCP OAuth settlement", () => {
  it("queues only the flow-bound administrator draft and kicks background activation", async () => {
    const storage = repository();
    const onActivationRequested = vi.fn();
    const settle = createMcpOAuthSettler(storage, onActivationRequested);

    await expect(settle({
      configurationIdentity: DRAFT_HASH,
      purpose: "validation",
      serverId: "server-1",
      userId: "admin-1"
    })).resolves.toEqual({ kind: "ok" });

    expect(storage.requestActivation).toHaveBeenCalledWith({
      expectedDraftHash: DRAFT_HASH,
      serverId: "server-1",
      validationUserId: "admin-1"
    });
    expect(onActivationRequested).toHaveBeenCalledOnce();
    expect(storage.testDraft).not.toHaveBeenCalled();
    expect(storage.activateDraft).not.toHaveBeenCalled();
    expect(storage.updateUserServer).not.toHaveBeenCalled();
  });

  it("fails closed when the flow-bound draft cannot be queued", async () => {
    const rejected = repository({
      requestActivation: vi.fn(async () => ({ kind: "draft_changed" as const }))
    });
    const input = {
      configurationIdentity: DRAFT_HASH,
      purpose: "validation" as const,
      serverId: "server-1",
      userId: "admin-1"
    };

    await expect(createMcpOAuthSettler(rejected)(input)).resolves.toEqual({ kind: "failed" });
    expect(rejected.testDraft).not.toHaveBeenCalled();
    expect(rejected.activateDraft).not.toHaveBeenCalled();
  });

  it("does not claim settlement for a terminal failed activation", async () => {
    const storage = repository({
      requestActivation: vi.fn(async () => ({
        kind: "ok" as const,
        value: {
          ...adminServer(),
          activation: {
            completedAt: "2026-07-23T00:00:01.000Z",
            errorCode: "mcp_draft_test_failed",
            id: "activation-1",
            issues: [],
            requestedAt: "2026-07-23T00:00:00.000Z",
            stage: "failed" as const,
            startedAt: "2026-07-23T00:00:00.000Z",
            updatedAt: "2026-07-23T00:00:01.000Z"
          }
        }
      }))
    });

    await expect(createMcpOAuthSettler(storage)({
      configurationIdentity: DRAFT_HASH,
      purpose: "validation",
      serverId: "server-1",
      userId: "admin-1"
    })).resolves.toEqual({ kind: "failed" });
  });

  it("enables the entitled user server after authorization", async () => {
    const storage = repository();

    await expect(createMcpOAuthSettler(storage)({
      configurationIdentity: "revision-1",
      purpose: "user",
      serverId: "server-1",
      userId: "user-1"
    })).resolves.toEqual({ kind: "ok" });

    expect(storage.updateUserServer).toHaveBeenCalledWith({
      enabled: true,
      serverId: "server-1",
      userId: "user-1"
    });
    expect(storage.testDraft).not.toHaveBeenCalled();
    expect(storage.activateDraft).not.toHaveBeenCalled();
    expect(storage.requestActivation).not.toHaveBeenCalled();
  });

  it("reports user enablement failures without claiming settlement", async () => {
    const storage = repository({
      updateUserServer: vi.fn(async () => ({
        issues: [{ code: "oauth_required", path: "oauth" }],
        kind: "invalid_values" as const
      }))
    });

    await expect(createMcpOAuthSettler(storage)({
      configurationIdentity: "revision-1",
      purpose: "user",
      serverId: "server-1",
      userId: "user-1"
    })).resolves.toEqual({ kind: "failed" });
  });
});

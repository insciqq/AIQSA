import type { AdminMcpServer } from "@/lib/contracts/mcp";
import { describe, expect, it, vi } from "vitest";
import {
  adminMcpErrorMessage,
  createAdminMcpServer,
  deleteAdminMcpServer,
  requestAdminMcpCatalog,
  setAdminMcpGrant,
  testAdminMcpDraft,
  updateAdminMcpServer
} from "./adminMcpApi";

const server: AdminMcpServer = {
  activePersonalSlots: [],
  activeRevision: null,
  activation: null,
  archivedAt: null,
  description: "Team memory",
  draft: {
    auth: { mode: "none" },
    runtime: { callTimeoutMs: 60000, startupTimeoutMs: 60000 },
    slots: [],
    source: { kind: "remote", url: "https://mcp.example/mcp" },
    transport: "streamable_http"
  },
  draftTest: null,
  draftTested: false,
  enabled: false,
  grants: [],
  id: "server-1",
  name: "Memory",
  namespace: "memory",
  revisions: [],
  sharedValues: {},
  updatedAt: "2026-07-22T00:00:00.000Z",
  validationOAuth: null
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

describe("adminMcpApi", () => {
  it.each([401, 403, 404, 503])("describes HTTP %s, its stage and a safe endpoint", (httpStatus) => {
    const message = adminMcpErrorMessage({ code: "mcp_draft_test_failed", issues: [{ code: "mcp_initialize_failed", path: "source", httpStatus, operation: "initialize", endpoint: "https://user:secret@mcp.example.test/wrong?token=secret#secret" }] });
    expect(message).toContain(`HTTP ${httpStatus} during MCP initialization at https://mcp.example.test/wrong`);
    expect(message).not.toContain("secret");
    expect(message).not.toContain("mcp_initialize_failed");
    if (httpStatus === 404) expect(message).toContain("Confirm the server's MCP endpoint");
    if (httpStatus === 401 || httpStatus === 403) expect(message).toContain("account authorization");
  });

  it("distinguishes a tool-list HTTP failure after initialization", () => {
    const message = adminMcpErrorMessage({ code: "mcp_draft_test_failed", issues: [{ code: "mcp_list_tools_failed", path: "tools", operation: "list_tools", httpStatus: 404 }] });
    expect(message).toContain("HTTP 404 during tools/list");
    expect(message).toContain("server connected");
    expect(message).not.toContain("Confirm the server's MCP endpoint");
  });
  it.each([
    ["mcp_request_timeout", "did not respond in time"],
    ["mcp_initialize_failed", "Check its URL, credentials and network access"],
    ["mcp_list_tools_failed", "account's permissions"],
    ["mcp_oauth_reauthorization_required", "Reconnect under Authorization on the server page"]
  ])("gives an actionable explanation for %s", (code, expected) => {
    const message = adminMcpErrorMessage({ code: "mcp_draft_test_failed", issues: [{ code, path: "source" }] });
    expect(message).toContain(expected);
    expect(message).not.toContain(code);
  });
  it("explains how to authorize draft validation without replacing a personal connection", () => {
    const message = adminMcpErrorMessage({
      code: "mcp_draft_test_failed",
      issues: [{ code: "mcp_oauth_validation_deferred", path: "auth.mode" }]
    });
    expect(message).toContain("Connect your administrator account");
    expect(message).toContain("under Authorization on the server page");
    expect(message).toContain("used only to check settings");
    expect(message).not.toContain("mcp_oauth_validation_deferred");
  });

  it("decodes the catalog and sends typed create/update requests to narrow endpoints", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [server] }))
      .mockResolvedValueOnce(response({ server }, 202))
      .mockResolvedValueOnce(response({ server }));

    await expect(requestAdminMcpCatalog(fetcher)).resolves.toEqual({
      data: { servers: [server] },
      ok: true
    });
    await createAdminMcpServer({ activate: true, draft: server.draft, name: "Memory" }, fetcher);
    await updateAdminMcpServer(server.id, { enabled: true }, fetcher);

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/admin/mcp", { method: "GET" });
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/admin/mcp", expect.objectContaining({
      body: JSON.stringify({ activate: true, draft: server.draft, name: "Memory" }),
      method: "POST"
    }));
    expect(fetcher).toHaveBeenNthCalledWith(3, "/api/admin/mcp/server-1", expect.objectContaining({
      body: JSON.stringify({ enabled: true }),
      method: "PATCH"
    }));
  });

  it("keeps test values and whole-server grant payloads scoped to their actions", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ server }));
    await testAdminMcpDraft(server.id, { oneTimeValues: { api_key: "once" } }, fetcher);
    await setAdminMcpGrant(server.id, {
      canUse: true,
      personalSlotKeys: ["api_key"],
      userId: "user-1"
    }, fetcher);

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/admin/mcp/server-1/test", expect.objectContaining({
      body: JSON.stringify({ oneTimeValues: { api_key: "once" } }),
      method: "POST"
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/admin/mcp/server-1/grants", expect.objectContaining({
      body: JSON.stringify({ canUse: true, personalSlotKeys: ["api_key"], userId: "user-1" }),
      method: "PUT"
    }));
  });

  it("sends and decodes an exact candidate disabled-tool policy", async () => {
    const policyDraft = { ...server.draft, disabledToolNames: ["semantic_code_search"] };
    const policyServer = { ...server, draft: policyDraft };
    const fetcher = vi.fn().mockResolvedValue(response({ server: policyServer }));

    await expect(updateAdminMcpServer(server.id, { draft: policyDraft }, fetcher)).resolves.toEqual({
      data: policyServer,
      ok: true
    });
    expect(fetcher).toHaveBeenCalledWith("/api/admin/mcp/server-1", expect.objectContaining({
      body: JSON.stringify({ draft: policyDraft }),
      method: "PATCH"
    }));
  });

  it("decodes a disabled-tool policy up to the per-server tool bound", async () => {
    const names = (count: number) => Array.from({ length: count }, (_, index) => `tool_${index}`);
    const maximal = { ...server, draft: { ...server.draft, disabledToolNames: names(1_024) } };
    await expect(updateAdminMcpServer(server.id, { enabled: true }, vi.fn().mockResolvedValue(response({ server: maximal }))))
      .resolves.toEqual({ data: maximal, ok: true });
    const beyond = { ...server, draft: { ...server.draft, disabledToolNames: names(1_025) } };
    await expect(updateAdminMcpServer(server.id, { enabled: true }, vi.fn().mockResolvedValue(response({ server: beyond }))))
      .resolves.toMatchObject({ ok: false });
  });

  it("uses the narrow server endpoint for irreversible deletion", async () => {
    const tombstone = { ...server, archivedAt: "2026-07-23T01:00:00.000Z", enabled: false };
    const fetcher = vi.fn().mockResolvedValue(response({ server: tombstone }));

    await expect(deleteAdminMcpServer(server.id, fetcher)).resolves.toEqual({
      data: tombstone,
      ok: true
    });
    expect(fetcher).toHaveBeenCalledWith("/api/admin/mcp/server-1", { method: "DELETE" });
  });

  it("rejects malformed success data and preserves safe issue paths on failures", async () => {
    await expect(requestAdminMcpCatalog(vi.fn().mockResolvedValue(response({ servers: [{}] })))).resolves.toEqual({
      error: { code: "mcp_admin_response_invalid", issues: [] },
      ok: false
    });
    await expect(requestAdminMcpCatalog(vi.fn().mockResolvedValue(response({
      servers: [{ ...server, activeRevision: { id: "revision-without-identity" } }]
    })))).resolves.toEqual({
      error: { code: "mcp_admin_response_invalid", issues: [] },
      ok: false
    });
    await expect(requestAdminMcpCatalog(vi.fn().mockResolvedValue(response({
      servers: [{ ...server, draft: { ...server.draft, disabledToolNames: ["not a tool"] } }]
    })))).resolves.toEqual({
      error: { code: "mcp_admin_response_invalid", issues: [] },
      ok: false
    });
    await expect(requestAdminMcpCatalog(vi.fn().mockResolvedValue(response({
      servers: [{
        ...server,
        activation: {
          completedAt: null,
          errorCode: null,
          id: "attempt-1",
          issues: [],
          requestedAt: "2026-07-22T01:00:00.000Z",
          stage: "waiting_forever",
          startedAt: null,
          updatedAt: "2026-07-22T01:00:00.000Z"
        }
      }]
    })))).resolves.toEqual({
      error: { code: "mcp_admin_response_invalid", issues: [] },
      ok: false
    });
    const failed = await testAdminMcpDraft(server.id, {}, vi.fn().mockResolvedValue(response({
      error: "mcp_draft_test_failed",
      issues: [{ code: "remote_unavailable", path: "source.url" }]
    }, 422)));
    expect(failed).toEqual({
      error: {
        code: "mcp_draft_test_failed",
        issues: [{ code: "remote_unavailable", path: "source.url" }]
      },
      ok: false
    });
    if (failed.ok) throw new Error("Expected failure");
    expect(adminMcpErrorMessage(failed.error)).toContain("source.url: remote_unavailable");
  });

  it("decodes held-back tools and tool verification, and rejects malformed ones", async () => {
    const checked = {
      createdAt: "2026-07-22T00:00:00.000Z",
      draftHash: "hash-1",
      id: "revision-1",
      identityHash: "identity-1",
      resolvedArtifact: null,
      revisionNumber: 1,
      toolVerification: "names" as const,
      validationEvidence: { evidence: {}, testedAt: "2026-07-22T00:00:00.000Z", toolInventory: [] }
    };
    const changed: AdminMcpServer = {
      ...server,
      activeRevision: checked,
      inventoryDifferences: [
        { connections: 2, name: "delete_repo", reason: "unpublished_addition" },
        { connections: 1, name: null, reason: "unpublished_addition" }
      ],
      revisions: [checked]
    };
    await expect(requestAdminMcpCatalog(vi.fn().mockResolvedValue(response({ servers: [changed] })))).resolves.toEqual({
      data: { servers: [changed] },
      ok: true
    });
    for (const malformed of [
      { ...changed, inventoryDifferences: [{ connections: 0, name: "delete_repo", reason: "unpublished_addition" }] },
      { ...changed, inventoryDifferences: [{ connections: 1, name: "delete repo", reason: "unpublished_addition" }] },
      { ...changed, inventoryDifferences: [{ connections: 1, name: "search", reason: "disabled_by_policy" }] },
      { ...changed, inventoryDifferences: {} },
      { ...changed, activeRevision: { ...checked, toolVerification: "trusted" } }
    ]) {
      await expect(requestAdminMcpCatalog(vi.fn().mockResolvedValue(response({ servers: [malformed] })))).resolves.toEqual({
        error: { code: "mcp_admin_response_invalid", issues: [] },
        ok: false
      });
    }
  });

  it("decodes a durable activation receipt from an accepted create response", async () => {
    const activating: AdminMcpServer = {
      ...server,
      activation: {
        completedAt: null,
        errorCode: null,
        id: "attempt-1",
        issues: [],
        requestedAt: "2026-07-22T01:00:00.000Z",
        stage: "connecting",
        startedAt: "2026-07-22T01:00:01.000Z",
        updatedAt: "2026-07-22T01:00:02.000Z"
      }
    };
    const fetcher = vi.fn().mockResolvedValue(response({ server: activating }, 202));

    await expect(createAdminMcpServer({ activate: true, draft: server.draft, name: "Memory" }, fetcher))
      .resolves.toEqual({ data: activating, ok: true });

    // A job written by an earlier release may still sit in a stage this release no longer emits.
    const leftover: AdminMcpServer = { ...activating, activation: { ...activating.activation!, stage: "resolving" } };
    await expect(requestAdminMcpCatalog(vi.fn().mockResolvedValue(response({ servers: [leftover] }))))
      .resolves.toEqual({ data: { servers: [leftover] }, ok: true });
  });
});

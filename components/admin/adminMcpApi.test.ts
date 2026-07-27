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

  it("decodes a durable activation receipt from an accepted create response", async () => {
    const activating: AdminMcpServer = {
      ...server,
      activation: {
        completedAt: null,
        errorCode: null,
        id: "attempt-1",
        issues: [],
        requestedAt: "2026-07-22T01:00:00.000Z",
        stage: "preparing_runtime",
        startedAt: "2026-07-22T01:00:01.000Z",
        updatedAt: "2026-07-22T01:00:02.000Z"
      }
    };
    const fetcher = vi.fn().mockResolvedValue(response({ server: activating }, 202));

    await expect(createAdminMcpServer({ activate: true, draft: server.draft, name: "Memory" }, fetcher))
      .resolves.toEqual({ data: activating, ok: true });
  });

  it("turns classified local startup issues into setup guidance without exposing process output", () => {
    const message = adminMcpErrorMessage({
      code: "mcp_draft_test_failed",
      issues: [{ code: "mcp_local_environment_missing", path: "slots.CANVAS_BASE_URL" }]
    });

    expect(message).toContain("requires CANVAS_BASE_URL");
    expect(message).toContain("Configuration fields");
    expect(message).not.toContain("mcp_local_environment_missing");
  });
});

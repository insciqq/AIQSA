import { act, renderHook, waitFor } from "@testing-library/react";
import type { AdminMcpServer } from "@/lib/contracts/mcp";
import { describe, expect, it, vi } from "vitest";
import { useAdminMcpController } from "./useAdminMcpController";

function mcpServer(overrides: Partial<AdminMcpServer> = {}): AdminMcpServer {
  return {
    activePersonalSlots: [],
    activeRevision: null,
    archivedAt: null,
    description: "Team tools",
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
    name: "Tools",
    namespace: "tools",
    revisions: [],
    sharedValues: {},
    updatedAt: "2026-07-22T00:00:00.000Z",
    validationOAuth: null,
    ...overrides
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

describe("useAdminMcpController", () => {
  it("loads lazily only when an MCP-owning admin section becomes active", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ servers: [mcpServer()] }));
    const { rerender, result } = renderHook(
      ({ active }) => useAdminMcpController({ active, fetcher }),
      { initialProps: { active: false } }
    );
    expect(fetcher).not.toHaveBeenCalled();

    rerender({ active: true });
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.state.selectedServer?.name).toBe("Tools");
  });

  it("reconciles mutation responses without exposing stale success", async () => {
    const original = mcpServer();
    const enabled = mcpServer({ enabled: true, updatedAt: "2026-07-22T01:00:00.000Z" });
    const onMutationCommitted = vi.fn(() => Promise.reject(new Error("dashboard refresh failed")));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [original] }))
      .mockResolvedValueOnce(response({ server: enabled }));
    const { result } = renderHook(() => useAdminMcpController({
      active: true,
      fetcher,
      onMutationCommitted
    }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    await act(async () => {
      expect(await result.current.actions.update(original.id, { enabled: true })).toBe(true);
    });
    expect(result.current.state.selectedServer?.enabled).toBe(true);
    expect(result.current.state.notice).toBe("MCP server draft saved.");
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenLastCalledWith("/api/admin/mcp/server-1", expect.objectContaining({
      body: JSON.stringify({ enabled: true }),
      method: "PATCH"
    }));
  });

  it("removes a successfully deleted server from local catalog state", async () => {
    const original = mcpServer();
    const tombstone = mcpServer({
      archivedAt: "2026-07-23T01:00:00.000Z",
      enabled: false
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [original] }))
      .mockResolvedValueOnce(response({ server: tombstone }));
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    await act(async () => {
      expect(await result.current.actions.delete(original.id)).toBe(true);
    });

    expect(result.current.state.servers).toEqual([]);
    expect(result.current.state.selectedServer).toBeNull();
    expect(result.current.state.notice).toBe("MCP server deleted.");
    expect(fetcher).toHaveBeenLastCalledWith("/api/admin/mcp/server-1", { method: "DELETE" });
  });

  it("automatically checks a newly created non-OAuth server", async () => {
    const draft = mcpServer();
    const checked = mcpServer({
      draftTested: true,
      draftTest: {
        draftHash: "a".repeat(64),
        evidence: {},
        identityHash: "b".repeat(64),
        resolvedArtifact: null,
        testedAt: "2026-07-22T01:00:00.000Z",
        toolInventory: []
      }
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [] }))
      .mockResolvedValueOnce(response({ server: draft }, 201))
      .mockResolvedValueOnce(response({ server: checked }));
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    await act(async () => {
      expect(await result.current.actions.create({
        description: draft.description,
        draft: draft.draft,
        name: draft.name
      })).toEqual(checked);
    });

    expect(fetcher).toHaveBeenNthCalledWith(3, "/api/admin/mcp/server-1/check-update", expect.objectContaining({
      body: "{}",
      method: "POST"
    }));
    expect(result.current.state.selectedServer?.draftTested).toBe(true);
    expect(result.current.state.notice).toMatch(/created and checked/i);
  });

  it("waits for validation OAuth before automatically checking an OAuth draft", async () => {
    const oauth = mcpServer({
      draft: {
        ...mcpServer().draft,
        auth: {
          allowedAuthorizationServerOrigins: ["https://auth.example"],
          mode: "oauth",
          scopes: []
        }
      }
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [] }))
      .mockResolvedValueOnce(response({ server: oauth }, 201));
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    await act(async () => {
      expect(await result.current.actions.create({
        description: oauth.description,
        draft: oauth.draft,
        name: oauth.name
      })).toEqual(oauth);
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.state.notice).toMatch(/connect OAuth/i);
  });

  it("refreshes the MCP catalog after validation OAuth disconnect", async () => {
    const connected = mcpServer({
      validationOAuth: {
        accountLabel: "Admin validation",
        connectedAt: "2026-07-22T01:00:00.000Z",
        state: "ready"
      }
    });
    const disconnected = mcpServer({ validationOAuth: null });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [connected] }))
      .mockResolvedValueOnce(response({ status: "disconnecting" }))
      .mockResolvedValueOnce(response({ servers: [disconnected] }));
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    await act(async () => {
      expect(await result.current.actions.disconnectValidationOAuth(connected.id)).toBe(true);
    });

    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/admin/mcp/server-1/oauth/validation/disconnect",
      expect.objectContaining({ body: "{}", method: "POST" })
    );
    expect(fetcher).toHaveBeenNthCalledWith(3, "/api/admin/mcp", { method: "GET" });
    expect(result.current.state.selectedServer?.validationOAuth).toBeNull();
    expect(result.current.state.notice).toBe("Validation OAuth connection disconnected.");
  });
});

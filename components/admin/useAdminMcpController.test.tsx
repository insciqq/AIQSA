import { act, renderHook, waitFor } from "@testing-library/react";
import type { AdminMcpServer } from "@/lib/contracts/mcp";
import { describe, expect, it, vi } from "vitest";
import { useAdminMcpController } from "./useAdminMcpController";

function mcpServer(overrides: Partial<AdminMcpServer> = {}): AdminMcpServer {
  return {
    activePersonalSlots: [],
    activeRevision: null,
    activation: null,
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
  it("refreshes connection problems when returning to the MCP section", async () => {
    const original = mcpServer();
    const failed = mcpServer({ runtimeProblem: "unavailable" });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [original] }))
      .mockResolvedValueOnce(response({ servers: [failed] }));
    const { result, rerender } = renderHook(({ active }) => useAdminMcpController({ active, fetcher }), { initialProps: { active: true } });
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    rerender({ active: false });
    rerender({ active: true });
    await waitFor(() => expect(result.current.state.servers[0].runtimeProblem).toBe("unavailable"));
  });

  it("does not replace a committed mutation with an older catalog response", async () => {
    const original = mcpServer();
    const enabled = mcpServer({ enabled: true });
    let finishRefresh!: (value: Response) => void;
    const staleCatalog = new Promise<Response>((resolve) => { finishRefresh = resolve; });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [original] }))
      .mockReturnValueOnce(staleCatalog)
      .mockResolvedValueOnce(response({ server: enabled }));
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    let refresh!: Promise<void>;
    act(() => { refresh = result.current.actions.refresh(); });
    await act(async () => { await result.current.actions.update(original.id, { enabled: true }); });
    await act(async () => { finishRefresh(response({ servers: [original] })); await refresh; });
    expect(result.current.state.servers[0].enabled).toBe(true);
  });
  it("tests and publishes the exact candidate with secrets only in the validation request", async () => {
    const original = mcpServer();
    const candidate = mcpServer({ name: "Changed", updatedAt: "2026-07-22T01:00:00.000Z" });
    const applied = { ...candidate, enabled: true, updatedAt: "2026-07-22T02:00:00.000Z" };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [original] }))
      .mockResolvedValueOnce(response({ server: candidate }))
      .mockResolvedValueOnce(response({ server: applied }));
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    await act(async () => {
      expect(await result.current.actions.save(original.id, {
        draft: candidate.draft, name: candidate.name, sharedValues: { key: "fixture-secret" }
      })).toEqual({ applied: true, updatedAt: applied.updatedAt });
    });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      draft: candidate.draft, name: "Changed", expectedUpdatedAt: original.updatedAt
    });
    expect(fetcher.mock.calls[2][0]).toBe("/api/admin/mcp/server-1/test");
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({
      expectedUpdatedAt: candidate.updatedAt, publish: true, sharedValues: { key: "fixture-secret" }
    });
    expect(result.current.state.servers[0]).toEqual(applied);
    expect(result.current.state.notice).toBe("MCP settings checked and applied.");
  });

  it("retains a failed candidate for retry and never reports it as applied", async () => {
    const original = mcpServer();
    const candidate = mcpServer({ name: "Changed", updatedAt: "2026-07-22T01:00:00.000Z" });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [original] }))
      .mockResolvedValueOnce(response({ server: candidate }))
      .mockResolvedValueOnce(response({ error: "mcp_draft_test_failed", issues: [{ code: "mcp_oauth_validation_deferred", path: "auth.mode" }] }, 400));
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    await act(async () => {
      expect(await result.current.actions.save(original.id, { name: candidate.name })).toEqual({
        applied: false, updatedAt: candidate.updatedAt
      });
    });
    expect(result.current.state.notice).toBeNull();
    expect(result.current.state.error).toContain("Connect your administrator account");
    expect(result.current.state.servers[0].activeRevision).toEqual(original.activeRevision);
  });
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
    expect(result.current.state.selectedServer).toBeNull();

    act(() => result.current.actions.select("server-1"));
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
    act(() => result.current.actions.select(original.id));

    await act(async () => {
      expect(await result.current.actions.update(original.id, { enabled: true })).toBe(true);
    });
    expect(result.current.state.selectedServer?.enabled).toBe(true);
    expect(result.current.state.notice).toBe("MCP settings updated.");
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
    act(() => result.current.actions.select(original.id));

    await act(async () => {
      expect(await result.current.actions.delete(original.id)).toBe(true);
    });

    expect(result.current.state.servers).toEqual([]);
    expect(result.current.state.selectedServer).toBeNull();
    expect(result.current.state.notice).toBe("MCP server deleted.");
    expect(fetcher).toHaveBeenLastCalledWith("/api/admin/mcp/server-1", { method: "DELETE" });
  });

  it("returns an accepted activation immediately without a second check request", async () => {
    const activating = mcpServer({
      activation: {
        completedAt: null,
        errorCode: null,
        id: "attempt-1",
        issues: [],
        requestedAt: "2026-07-22T01:00:00.000Z",
        stage: "queued",
        startedAt: null,
        updatedAt: "2026-07-22T01:00:00.000Z"
      }
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [] }))
      .mockResolvedValueOnce(response({ server: activating }, 202));
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    await act(async () => {
      expect(await result.current.actions.create({
        activate: true,
        description: activating.description,
        draft: activating.draft,
        name: activating.name
      })).toEqual(activating);
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/admin/mcp", expect.objectContaining({
      body: JSON.stringify({
        activate: true,
        description: activating.description,
        draft: activating.draft,
        name: activating.name
      }),
      method: "POST"
    }));
    expect(result.current.state.selectedServer?.activation?.stage).toBe("queued");
    expect(result.current.state.notice).toMatch(/activation started/i);
  });

  it("polls a transient activation receipt until it reaches a terminal stage", async () => {
    const queued = mcpServer({
      activation: {
        completedAt: null,
        errorCode: null,
        id: "attempt-1",
        issues: [],
        requestedAt: "2026-07-22T01:00:00.000Z",
        stage: "discovering_tools",
        startedAt: "2026-07-22T01:00:01.000Z",
        updatedAt: "2026-07-22T01:00:02.000Z"
      }
    });
    const ready = mcpServer({
      activation: {
        ...queued.activation!,
        completedAt: "2026-07-22T01:00:04.000Z",
        stage: "ready",
        updatedAt: "2026-07-22T01:00:04.000Z"
      }
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [queued] }))
      .mockResolvedValueOnce(response({ servers: [ready] }));
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    act(() => result.current.actions.select(queued.id));
    await waitFor(() => expect(result.current.state.selectedServer?.activation?.stage).toBe("ready"), {
      timeout: 2_500
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.state.loading).toBe(false);
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
    act(() => result.current.actions.select(connected.id));

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

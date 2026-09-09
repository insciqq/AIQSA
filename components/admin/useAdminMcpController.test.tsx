import { act, renderHook, waitFor } from "@testing-library/react";
import type { AdminGroup } from "@/lib/contracts/admin";
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

function feedback() {
  return { onError: vi.fn(), onNotice: vi.fn() };
}

const group: AdminGroup = { accessGrants: [], archivedAt: null, id: "group-bulk", name: "Research", systemRole: null, userCount: 2 };

function withGroupGrant(server: AdminMcpServer, canUse = true): AdminMcpServer {
  return { ...server, grants: [
    ...server.grants.filter((grant) => grant.groupId !== group.id),
    ...(canUse ? [{ canUse, groupId: group.id, groupName: group.name, id: `grant-${server.id}`, personalSlotKeys: [], userId: null, userName: null }] : [])
  ] };
}

describe("useAdminMcpController", () => {
  it("grants the complete current group catalog one server at a time, skipping duplicates and existing or archived grants", async () => {
    const personalGrant = { canUse: false, groupId: null, groupName: null, id: "personal-grant", personalSlotKeys: ["api_key"], userId: "user-1", userName: "Alice" };
    let saved = Array.from({ length: 10 }, (_, index) => mcpServer({
      grants: [personalGrant], id: `server-${index}`, name: `Server ${index}`
    }));
    saved[0] = withGroupGrant(saved[0]);
    const archivedServer = mcpServer({ archivedAt: "2026-09-01T00:00:00Z", id: "archived" });
    let finishFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { finishFirst = resolve; });
    const changed: string[] = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") return response({ servers: [...saved, saved[1], archivedServer] });
      const id = String(url).split("/").at(-2)!;
      changed.push(id);
      if (changed.length === 1) await firstPending;
      expect(init?.method).toBe("PUT");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ canUse: true, groupId: group.id });
      saved = saved.map((server) => server.id === id ? withGroupGrant(server) : server);
      return response({ server: saved.find((server) => server.id === id) });
    });
    const onMutationCommitted = vi.fn();
    const notices = feedback();
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher, onMutationCommitted, ...notices }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.actions.bulkGrantGroup(group, true); });
    expect(changed).toEqual(["server-1"]);
    expect(result.current.state.bulkGrantProgress).toEqual({ completed: 0, groupId: group.id, total: 9 });
    await expect(result.current.actions.bulkGrantGroup(group, true)).resolves.toBe(false);
    await expect(result.current.actions.grant("server-9", { canUse: true, groupId: group.id })).resolves.toBe(false);
    await act(async () => { finishFirst(); await expect(pending).resolves.toBe(true); });
    expect(changed).toEqual(Array.from({ length: 9 }, (_, index) => `server-${index + 1}`));
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(2);
    expect(onMutationCommitted).toHaveBeenCalledOnce();
    expect(notices.onNotice).toHaveBeenCalledWith("Research: All current MCP servers granted.");
    expect(notices.onError).not.toHaveBeenCalled();
    expect(result.current.state.busy).toBe(false);
    for (const server of result.current.state.servers.filter((server) => !server.archivedAt)) {
      expect(server.grants.filter((grant) => grant.groupId === group.id)).toHaveLength(1);
      expect(server.grants.find((grant) => grant.userId === "user-1")).toEqual(personalGrant);
    }
    saved.push(mcpServer({ id: "server-later", name: "Added later" }));
    await act(async () => { await result.current.actions.refresh(); });
    expect(result.current.state.servers.find((server) => server.id === "server-later")!.grants).toEqual([]);
  });

  it("stops a partial MCP failure, reloads the catalog and never claims all servers are granted", async () => {
    const servers = Array.from({ length: 3 }, (_, index) => mcpServer({ id: `server-${index}` }));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers }))
      .mockResolvedValueOnce(response({ server: withGroupGrant(servers[0]) }))
      .mockResolvedValueOnce(response({ error: "mcp_not_found" }, 404))
      .mockResolvedValueOnce(response({ servers: [withGroupGrant(servers[0]), servers[2]] }));
    const notices = feedback();
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher, ...notices }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    await act(async () => { await expect(result.current.actions.bulkGrantGroup(group, true)).resolves.toBe(false); });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(2);
    expect(notices.onNotice).not.toHaveBeenCalled();
    expect(notices.onError).toHaveBeenCalledWith(expect.stringContaining("1 of 3 MCP access changes confirmed"));
    expect(notices.onError).toHaveBeenCalledWith(expect.stringContaining("This MCP server no longer exists"));
    expect(result.current.state.servers).toEqual([withGroupGrant(servers[0]), servers[2]]);
    expect(result.current.state.busy).toBe(false);
  });

  it("clears only group server-use grants and preserves personal permissions, unrelated groups and archived servers", async () => {
    const personal = { canUse: true, groupId: null, groupName: null, id: "personal", personalSlotKeys: ["api_key"], userId: "user-1", userName: "Alice" };
    const otherGroup = { canUse: true, groupId: "other-group", groupName: "Other", id: "other", personalSlotKeys: [], userId: null, userName: null };
    const original = withGroupGrant(mcpServer({ grants: [personal, otherGroup] }));
    const archivedServer = withGroupGrant(mcpServer({ archivedAt: "2026-09-01T00:00:00Z", id: "archived" }));
    const cleared = withGroupGrant(original, false);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [original, archivedServer, mcpServer({ id: "ungranted" })] }))
      .mockResolvedValueOnce(response({ server: cleared }))
      .mockResolvedValueOnce(response({ servers: [cleared, archivedServer, mcpServer({ id: "ungranted" })] }));
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    await act(async () => { await expect(result.current.actions.bulkGrantGroup(group, false)).resolves.toBe(true); });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ canUse: false, groupId: group.id });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.current.state.servers.find((server) => server.id === original.id)!.grants).toEqual([personal, otherGroup]);
    expect(result.current.state.servers.find((server) => server.id === "archived")).toEqual(archivedServer);
  });

  it("keeps confirmed mutation replies visible but reports a failed final refresh without a success notice", async () => {
    const original = mcpServer();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [original] }))
      .mockResolvedValueOnce(response({ server: withGroupGrant(original) }))
      .mockRejectedValueOnce(new Error("offline"));
    const notices = feedback();
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher, ...notices }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    await act(async () => { await expect(result.current.actions.bulkGrantGroup(group, true)).resolves.toBe(false); });
    expect(result.current.state.servers).toEqual([withGroupGrant(original)]);
    expect(notices.onNotice).not.toHaveBeenCalled();
    expect(notices.onError).toHaveBeenCalledWith(expect.stringContaining("1 of 1 MCP access changes saved, but current grants could not be reloaded"));
    expect(result.current.state.error).not.toBeNull();
    await expect(result.current.actions.bulkGrantGroup(group, false)).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects Full access, archived groups and unloaded or empty catalogs before dispatch", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ servers: [] }));
    const { result } = renderHook(() => useAdminMcpController({ active: false, fetcher }));
    await expect(result.current.actions.bulkGrantGroup(group, true)).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => { await result.current.actions.refresh(); });
    await expect(result.current.actions.bulkGrantGroup(group, true)).resolves.toBe(false);
    await expect(result.current.actions.bulkGrantGroup({ ...group, systemRole: "full_access" }, true)).resolves.toBe(false);
    await expect(result.current.actions.bulkGrantGroup({ ...group, archivedAt: "2026-09-01T00:00:00Z" }, false)).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("finishes an initial failed load and lets the user retry", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ error: "mcp_storage_unavailable" }, 503))
      .mockResolvedValueOnce(response({ servers: [mcpServer()] }));
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    expect(result.current.state.loading).toBe(false);
    expect(result.current.state.error).toContain("temporarily unavailable");
    await act(async () => { await result.current.actions.refresh(); });
    expect(result.current.state.servers).toHaveLength(1);
    expect(result.current.state.error).toBeNull();
  });

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
      .mockResolvedValueOnce(response({ server: applied }));
    const { onError, onNotice } = feedback();
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher, onError, onNotice }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    await act(async () => {
      expect(await result.current.actions.save(original.id, {
        draft: candidate.draft, name: candidate.name, sharedValues: { key: "fixture-secret" }
      })).toEqual({ applied: true, updatedAt: applied.updatedAt });
    });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      draft: candidate.draft, name: "Changed", expectedUpdatedAt: original.updatedAt,
      publish: true, sharedValues: { key: "fixture-secret" }
    });
    expect(fetcher.mock.calls[1][0]).toBe("/api/admin/mcp/server-1/test");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.state.servers[0]).toEqual(applied);
    expect(onNotice).toHaveBeenCalledWith("Settings checked and applied.");
    expect(onError).not.toHaveBeenCalled();
  });

  it("returns a failed check to the form and preserves the entire previous catalog", async () => {
    const original = mcpServer();
    const candidate = mcpServer({ name: "Changed", updatedAt: "2026-07-22T01:00:00.000Z" });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [original] }))
      .mockResolvedValueOnce(response({ error: "mcp_draft_test_failed", issues: [{ code: "mcp_oauth_validation_deferred", path: "auth.mode" }] }, 400));
    const { onError, onNotice } = feedback();
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher, onError, onNotice }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    await act(async () => {
      const saved = await result.current.actions.save(original.id, { name: candidate.name });
      expect(saved).toMatchObject({ applied: false });
      expect(saved.updatedAt).toBeUndefined();
      expect(saved.message).toContain("Connect your administrator account");
    });
    expect(onNotice).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.state.servers[0].activeRevision).toEqual(original.activeRevision);
    expect(result.current.state.servers[0]).toEqual(original);
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
    expect(result.current.state.servers[0]?.name).toBe("Tools");
  });

  it("reconciles mutation responses, toasts the outcome and keeps a failed dashboard refresh private", async () => {
    const original = mcpServer();
    const enabled = mcpServer({ enabled: true, updatedAt: "2026-07-22T01:00:00.000Z" });
    const onMutationCommitted = vi.fn(() => Promise.reject(new Error("dashboard refresh failed")));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [original] }))
      .mockResolvedValueOnce(response({ server: enabled }))
      .mockResolvedValueOnce(response({ error: "mcp_storage_unavailable" }, 503));
    const { onError, onNotice } = feedback();
    const { result } = renderHook(() => useAdminMcpController({
      active: true,
      fetcher,
      onError,
      onMutationCommitted,
      onNotice
    }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    await act(async () => {
      expect(await result.current.actions.update(original.id, { enabled: true })).toBe(true);
    });
    expect(result.current.state.servers[0].enabled).toBe(true);
    expect(onNotice).toHaveBeenCalledWith("MCP server enabled.");
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenLastCalledWith("/api/admin/mcp/server-1", expect.objectContaining({
      body: JSON.stringify({ enabled: true }),
      method: "PATCH"
    }));

    await act(async () => {
      expect(await result.current.actions.update(original.id, { enabled: false })).toBe(false);
    });
    expect(onError).toHaveBeenCalledWith("MCP storage is temporarily unavailable.");
    expect(result.current.state.servers[0].enabled).toBe(true);
  });

  it("stages a tool selection silently: the page state line says what is left to apply", async () => {
    const original = mcpServer({ updatedAt: "2026-07-22T00:00:00.000Z" });
    const staged = mcpServer({ draft: { ...original.draft, disabledToolNames: ["forget"] }, updatedAt: "2026-07-22T01:00:00.000Z" });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [original] }))
      .mockResolvedValueOnce(response({ server: staged }));
    const { onNotice } = feedback();
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher, onNotice }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    await act(async () => {
      expect(await result.current.actions.update(original.id, { draft: staged.draft })).toBe(true);
    });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      draft: staged.draft, expectedUpdatedAt: original.updatedAt
    });
    expect(onNotice).not.toHaveBeenCalled();
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
    const { onNotice } = feedback();
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher, onNotice }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    await act(async () => {
      expect(await result.current.actions.delete(original.id)).toBe(true);
    });

    expect(result.current.state.servers).toEqual([]);
    expect(onNotice).toHaveBeenCalledWith("MCP server deleted.");
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
    const { onNotice } = feedback();
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher, onNotice }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    await act(async () => {
      expect(await result.current.actions.create({
        activate: true,
        description: activating.description,
        draft: activating.draft,
        name: activating.name
      })).toEqual({ ok: true, server: activating });
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
    expect(result.current.state.servers[0]?.activation?.stage).toBe("queued");
    expect(onNotice).toHaveBeenCalledWith("Settings saved. Setup continues in the background.");
  });

  it("returns a rejected creation to the form without a toast", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ servers: [] }))
      .mockResolvedValueOnce(response({ error: "invalid_draft" }, 400));
    const { onError, onNotice } = feedback();
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher, onError, onNotice }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    await act(async () => {
      expect(await result.current.actions.create({
        activate: true,
        draft: mcpServer().draft,
        name: "Broken"
      })).toEqual({ message: "Review the MCP configuration fields and try again.", ok: false });
    });
    expect(onError).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
    expect(result.current.state.servers).toEqual([]);
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
    await waitFor(() => expect(result.current.state.servers[0]?.activation?.stage).toBe("ready"), {
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
    const { onNotice } = feedback();
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher, onNotice }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));

    await act(async () => {
      expect(await result.current.actions.create({
        description: oauth.description,
        draft: oauth.draft,
        name: oauth.name
      })).toEqual({ ok: true, server: oauth });
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/connect your account/i));
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
    const { onNotice } = feedback();
    const { result } = renderHook(() => useAdminMcpController({ active: true, fetcher, onNotice }));
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
    expect(result.current.state.servers[0]?.validationOAuth).toBeNull();
    expect(onNotice).toHaveBeenCalledWith("Your authorization was disconnected.");
  });
});

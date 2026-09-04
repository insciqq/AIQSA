import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposerControlStore } from "./composerControlStore";
import { isMcpOAuthAuthorizing, markMcpOAuthAuthorizing, consumeMcpOAuthReturn, observeMcpSettings, refreshMcpSettings, useMcpSettingsStore } from "./mcpSettingsStore";
import {
  resetComposerControlStoreForTest,
  resetMcpSettingsStoreForTest
} from "@/tests/support/appShellStores";

const server = {
  accountLabel: null,
  description: "Team tasks",
  enabled: true,
  operationalStatus: "active" as const,
  fields: [],
  id: "server-1",
  knownToolCount: 1,
  name: "Todoist",
  oauthAvailable: true,
  oauthState: "ready" as const,
  readiness: "ready" as const,
  tools: [{ description: null, name: "create_task" }]
};

describe("MCP settings store", () => {
  afterEach(() => {
    resetComposerControlStoreForTest();
    resetMcpSettingsStoreForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("loads the user catalog once and supports an explicit status refresh", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ servers: [server] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([refreshMcpSettings(), refreshMcpSettings()]);
    await refreshMcpSettings();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useMcpSettingsStore.getState()).toMatchObject({ loadState: "ready", servers: [server] });

    await refreshMcpSettings(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a stable configured-empty state visible during background refresh", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    useMcpSettingsStore.setState({ loadState: "ready", servers: [] });
    const observedLoadStates: string[] = [];
    const unsubscribe = useMcpSettingsStore.subscribe((state) => {
      observedLoadStates.push(state.loadState);
    });

    const refresh = refreshMcpSettings(true, { background: true });

    expect(useMcpSettingsStore.getState()).toMatchObject({ loadState: "ready", servers: [] });
    expect(observedLoadStates).not.toContain("loading");

    resolveResponse(new Response(JSON.stringify({ servers: [server] }), { status: 200 }));
    await refresh;

    expect(useMcpSettingsStore.getState()).toMatchObject({ loadState: "ready", servers: [server] });
    expect(observedLoadStates).not.toContain("loading");
    unsubscribe();
  });

  it("polls an activating server with backoff until readiness becomes terminal", async () => {
    vi.useFakeTimers();
    const queued = { ...server, operationalStatus: "checking" as const, readiness: "queued" as const, tools: [] };
    const starting = { ...queued, readiness: "starting" as const };
    const responses = [queued, starting, server];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      servers: [responses.shift() ?? server]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    useMcpSettingsStore.setState({
      loadState: "ready",
      servers: [{ ...server, enabled: false, readiness: "disabled", tools: [] }]
    });
    const observedLoadStates: string[] = [];
    const unsubscribe = useMcpSettingsStore.subscribe((state) => {
      observedLoadStates.push(state.loadState);
    });

    const stop = observeMcpSettings();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(749);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useMcpSettingsStore.getState().servers[0]?.readiness).toBe("starting");

    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useMcpSettingsStore.getState().servers[0]?.readiness).toBe("ready");
    expect(observedLoadStates).not.toContain("loading");

    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unsubscribe();
    stop();
  });

  it("renews visible health every 30 seconds, pauses hidden polling and refreshes on return", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ servers: [server] })));
    vi.stubGlobal("fetch", fetchMock);
    const stop = observeMcpSettings();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("preserves the list but removes stale active claims while renewal hangs or fails", async () => {
    useMcpSettingsStore.setState({ loadState: "ready", servers: [server] });
    let fail!: (error: Error) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((_resolve, reject) => { fail = reject; }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = refreshMcpSettings(true, { background: true }).catch(() => undefined);
    const duplicate = refreshMcpSettings(true, { background: true }).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(useMcpSettingsStore.getState()).toMatchObject({
      loadState: "ready", servers: [{ id: server.id, operationalStatus: "checking" }]
    });
    fail(new Error("offline"));
    await Promise.all([pending, duplicate]);
    expect(useMcpSettingsStore.getState()).toMatchObject({
      loadState: "ready", servers: [{ id: server.id, operationalStatus: "checking" }]
    });
  });

  it("ignores a pre-mutation catalog response after the user disables the server", async () => {
    useMcpSettingsStore.setState({ loadState: "ready", servers: [server] });
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const pending = refreshMcpSettings(true);
    useMcpSettingsStore.getState().replaceServer({
      ...server, enabled: false, operationalStatus: "inactive", readiness: "disabled"
    });
    finish(new Response(JSON.stringify({ servers: [server] })));
    await pending;
    expect(useMcpSettingsStore.getState().loadState).toBe("ready");
    expect(useMcpSettingsStore.getState().servers[0]).toMatchObject({ enabled: false, operationalStatus: "inactive" });
  });

  it("never changes the composer mode when the last server disables or readiness changes", () => {
    useComposerControlStore.getState().setMcpSelection({ mode: "load_all" });
    useMcpSettingsStore.setState({ loadState: "ready", servers: [server] });

    useMcpSettingsStore.getState().replaceServer({
      ...server,
      enabled: false,
      readiness: "disabled",
      tools: []
    });
    expect(useComposerControlStore.getState().mcpSelection).toEqual({ mode: "load_all" });

    useMcpSettingsStore.getState().replaceServer({
      ...server,
      readiness: "queued",
      tools: []
    });
    expect(useComposerControlStore.getState().mcpSelection).toEqual({ mode: "load_all" });
  });

  it("records and scrubs an OAuth callback outcome", () => {
    markMcpOAuthAuthorizing("server-1");
    expect(isMcpOAuthAuthorizing("server-1")).toBe(true);
    window.history.replaceState(null, "", "/?settings=mcp&oauth=connected&server=server-1&keep=yes");
    const outcome = consumeMcpOAuthReturn(new URL(window.location.href));

    expect(outcome).toEqual({ kind: "connected", serverId: "server-1" });
    expect(useMcpSettingsStore.getState().oauthOutcome).toEqual(outcome);
    expect(isMcpOAuthAuthorizing("server-1")).toBe(false);
    expect(window.location.search).toBe("?keep=yes");
  });
});

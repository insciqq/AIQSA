import { afterEach, describe, expect, it, vi } from "vitest";
import { isMcpOAuthAuthorizing, markMcpOAuthAuthorizing, consumeMcpOAuthReturn, refreshMcpSettings, useMcpSettingsStore } from "./mcpSettingsStore";
import { resetMcpSettingsStoreForTest } from "@/tests/support/appShellStores";

const server = {
  accountLabel: null,
  description: "Team tasks",
  enabled: true,
  errorCode: null,
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
    resetMcpSettingsStoreForTest();
    vi.useRealTimers();
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
    const queued = { ...server, readiness: "queued" as const, tools: [] };
    const starting = { ...queued, readiness: "starting" as const };
    const responses = [starting, server];
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

    useMcpSettingsStore.getState().replaceServer(queued);
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

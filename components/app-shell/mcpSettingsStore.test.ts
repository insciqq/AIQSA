import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMcpOAuthAuthorizing,
  markMcpOAuthAuthorizing,
  consumeMcpOAuthReturn,
  refreshMcpSettings,
  resetMcpSettingsStoreForTest,
  useMcpSettingsStore
} from "./mcpSettingsStore";

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

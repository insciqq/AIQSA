import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeMcpSettings } from "@/components/app-shell/mcpSettingsStore";
import type { UserMcpServer } from "@/lib/contracts/mcp";
import { resetMcpSettingsStoreForTest } from "@/tests/support/appShellStores";
import { useStudioMcpAttentionV2 } from "./WorkspaceWelcomeV2";

afterEach(() => {
  vi.useRealTimers();
});

describe("Settings MCP attention", () => {
  afterEach(() => {
    resetMcpSettingsStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("flags the tab from the shared observation and releases only the Settings observer", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const ready: UserMcpServer = {
      accountLabel: null,
      description: "Team tasks",
      enabled: true,
      fields: [],
      id: "server-1",
      knownToolCount: 1,
      name: "Todoist",
      oauthAvailable: true,
      oauthState: "ready",
      readiness: "ready",
      tools: []
    };
    let current: UserMcpServer = { ...ready, oauthState: "reauthorization_required",
      readiness: "reauthorization_required" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ servers: [current] })));
    vi.stubGlobal("fetch", fetchMock);
    const releaseChatShell = observeMcpSettings();
    const studio = renderHook(() => useStudioMcpAttentionV2("account-1"));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(studio.result.current).toBe(true);

    current = ready;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(studio.result.current).toBe(false);

    studio.unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    releaseChatShell();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Settings alone keeps the catalog fresh while open and stops when left.
    const alone = renderHook(() => useStudioMcpAttentionV2("account-1"));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    alone.unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

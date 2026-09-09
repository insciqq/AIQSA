import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deactivateMcpSettings, useMcpSettingsStore } from "@/components/app-shell/mcpSettingsStore";
import { useMcpOAuthReturn } from "./useMcpOAuthReturn";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ servers: [] })));
});

afterEach(() => {
  cleanup();
  deactivateMcpSettings();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

function useShellReturn(accountId: string, open: () => void) {
  useEffect(() => () => deactivateMcpSettings(), [accountId]);
  useMcpOAuthReturn(accountId, open);
}

describe("MCP OAuth return lifecycle", () => {
  it.each(["connected", "cancelled", "failed"] as const)("preserves the %s result through shell effect replay", async (kind) => {
    window.history.replaceState(null, "", `/?settings=mcp&oauth=${kind}&server=server-1&keep=yes#anchor`);
    const open = vi.fn();
    const { rerender } = renderHook(({ accountId }) => useShellReturn(accountId, open), {
      initialProps: { accountId: "account-1" }, wrapper: StrictMode
    });
    await waitFor(() => expect(useMcpSettingsStore.getState().oauthOutcome).toEqual({ kind, serverId: "server-1" }));
    expect(open).toHaveBeenCalledOnce();
    expect(window.location.search).toBe("?keep=yes");
    expect(window.location.hash).toBe("#anchor");

    rerender({ accountId: "account-2" });
    await waitFor(() => expect(useMcpSettingsStore.getState().oauthOutcome).toBeNull());
    expect(open).toHaveBeenCalledOnce();
  });

  it("leaves a return untouched when its shell unmounts before handling it", async () => {
    window.history.replaceState(null, "", "/?settings=mcp&oauth=connected&server=server-1");
    const open = vi.fn();
    const { unmount } = renderHook(() => useShellReturn("account-1", open));
    unmount();
    await Promise.resolve();

    expect(open).not.toHaveBeenCalled();
    expect(window.location.search).toContain("oauth=connected");
    expect(useMcpSettingsStore.getState().oauthOutcome).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

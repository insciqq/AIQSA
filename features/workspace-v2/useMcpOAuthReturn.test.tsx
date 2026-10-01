import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deactivateMcpSettings, useMcpSettingsStore } from "@/components/app-shell/mcpSettingsStore";
import { deactivatePersonalMcp, usePersonalMcpStore } from "@/components/app-shell/personalMcpStore";
import { useMcpOAuthReturn } from "./useMcpOAuthReturn";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ servers: [] })));
});

afterEach(() => {
  cleanup();
  deactivateMcpSettings();
  deactivatePersonalMcp();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

function useShellReturn(accountId: string, open: () => void) {
  useEffect(() => () => deactivateMcpSettings(), [accountId]);
  useMcpOAuthReturn(accountId, open);
}

function useConnectionsReturn(accountId: string, open: () => void) {
  useEffect(() => () => deactivateMcpSettings(), [accountId]);
  useMcpOAuthReturn(accountId, vi.fn(), open);
}

describe("MCP OAuth return lifecycle", () => {
  it.each(["settings", "library"].flatMap(destination => ["connected", "cancelled", "failed"].map(kind => ({ destination, kind }))))("preserves $destination $kind through shell effect replay", async ({ destination, kind }) => {
    window.history.replaceState(null, "", `/?${destination}=mcp&oauth=${kind}&server=server-1&keep=yes#anchor`);
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

  it.each(["/c/chat-1", "/p/project-1/c/chat-1"])("opens the MCP tab over the chat %s the authorization returned to", async (pathname) => {
    window.history.replaceState(null, "", `${pathname}?library=mcp&oauth=cancelled&server=server-1&message=m1`);
    const open = vi.fn();
    renderHook(() => useShellReturn("account-1", open), { wrapper: StrictMode });
    await waitFor(() => expect(useMcpSettingsStore.getState().oauthOutcome).toEqual({ kind: "cancelled", serverId: "server-1" }));
    expect(open).toHaveBeenCalledOnce();
    expect(`${window.location.pathname}${window.location.search}`).toBe(`${pathname}?message=m1`);
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

  it("opens Connections over the origin chat and routes the outcome only to the personal store", async () => {
    window.history.replaceState(null, "", "/c/chat-1?settings=connections&oauth=failed&server=personal-1");
    const open = vi.fn();
    renderHook(() => useConnectionsReturn("account-1", open), { wrapper: StrictMode });
    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(`${window.location.pathname}${window.location.search}`).toBe("/c/chat-1");
    expect(usePersonalMcpStore.getState().oauthOutcome).toEqual({ kind: "failed", serverId: "personal-1" });
    expect(useMcpSettingsStore.getState().oauthOutcome).toBeNull();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).toEqual(["/api/me/mcp-connections"]);
  });
});

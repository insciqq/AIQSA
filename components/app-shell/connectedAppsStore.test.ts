import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateConnectedApps,
  deactivateConnectedApps,
  refreshConnectedApps,
  revokeConnectedAppAccess,
  useConnectedAppsStore
} from "./connectedAppsStore";

const activeApp = {
  clientName: "Codex CLI",
  clientOrigin: "http://127.0.0.1:43119",
  connectedAt: "2026-09-03T01:00:00.000Z",
  connectionId: "grant-1",
  lastUsedAt: null,
  revokedAt: null,
  state: "ACTIVE" as const
};

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("Connected Apps store", () => {
  afterEach(() => {
    deactivateConnectedApps();
    vi.unstubAllGlobals();
  });

  it("never applies a stale list after the active account changes", async () => {
    const responses: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      responses.push(resolve);
    })));

    activateConnectedApps("account-a");
    const accountA = refreshConnectedApps();
    activateConnectedApps("account-b");
    const accountB = refreshConnectedApps();

    responses[1]!(jsonResponse({ apps: [] }));
    await accountB;
    responses[0]!(jsonResponse({ apps: [activeApp] }));
    await accountA;

    expect(useConnectedAppsStore.getState()).toMatchObject({
      accountId: "account-b",
      apps: [],
      loadState: "ready"
    });
  });

  it("lets the terminal revoke response win over an in-flight list", async () => {
    let resolveList!: (response: Response) => void;
    let resolveRevoke!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveList = resolve;
      }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveRevoke = resolve;
      }));
    vi.stubGlobal("fetch", fetchMock);
    activateConnectedApps("account-a");
    useConnectedAppsStore.setState({ apps: [activeApp], loadState: "ready" });

    const staleList = refreshConnectedApps(true);
    const revoke = revokeConnectedAppAccess(activeApp.connectionId);
    expect(useConnectedAppsStore.getState().busyConnectionId).toBe("grant-1");

    const revoked = {
      ...activeApp,
      revokedAt: "2026-09-03T02:00:00.000Z",
      state: "REVOKED" as const
    };
    resolveRevoke(jsonResponse({ app: revoked }));
    await revoke;
    resolveList(jsonResponse({ apps: [activeApp] }));
    await staleList;

    expect(useConnectedAppsStore.getState()).toMatchObject({
      apps: [revoked],
      busyConnectionId: null,
      error: null,
      lastRevokedConnectionId: "grant-1"
    });
  });

  it("keeps the visible app unchanged when revocation fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ error: "connected_apps_unavailable" }, 503)
    ));
    activateConnectedApps("account-a");
    useConnectedAppsStore.setState({ apps: [activeApp], loadState: "ready" });

    await expect(revokeConnectedAppAccess("grant-1")).rejects.toMatchObject({
      code: "connected_apps_unavailable"
    });
    expect(useConnectedAppsStore.getState()).toMatchObject({
      apps: [activeApp],
      busyConnectionId: null,
      error: "connected_apps_unavailable"
    });
  });
});

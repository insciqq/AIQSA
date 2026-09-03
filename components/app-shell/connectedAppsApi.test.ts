import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectedAppsApiError,
  loadConnectedApps,
  revokeConnectedApp
} from "./connectedAppsApi";

const activeApp = {
  clientName: "Codex CLI",
  clientOrigin: "http://127.0.0.1:43119",
  connectedAt: "2026-09-03T01:00:00.000Z",
  connectionId: "grant/one",
  lastUsedAt: null,
  revokedAt: null,
  state: "ACTIVE" as const
};

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("Connected Apps API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads a strict client-safe list and URL-encodes the revoked connection", async () => {
    const revoked = {
      ...activeApp,
      revokedAt: "2026-09-03T02:00:00.000Z",
      state: "REVOKED" as const
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ apps: [activeApp] }))
      .mockResolvedValueOnce(jsonResponse({ app: revoked }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadConnectedApps()).resolves.toEqual([activeApp]);
    await expect(revokeConnectedApp(activeApp.connectionId)).resolves.toEqual(revoked);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/me/connected-apps");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/me/connected-apps/grant%2Fone"
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("rejects malformed success bodies and preserves coded server failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ apps: [{ ...activeApp, secret: "no" }] }))
      .mockResolvedValueOnce(jsonResponse({ error: "connected_app_not_found" }, 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadConnectedApps()).rejects.toEqual(
      new ConnectedAppsApiError("connected_apps_response_invalid", 502)
    );
    await expect(revokeConnectedApp("grant-1")).rejects.toMatchObject({
      code: "connected_app_not_found",
      status: 404
    });
  });
});

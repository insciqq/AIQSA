import { describe, expect, it, vi } from "vitest";
import { createWorkspaceAvailabilityHandler } from "./availabilityHandlers";

function activeSession() {
  return { user: { role: "user", status: "active" }, userId: "user-1" };
}

describe("blank-composer Workspace availability handler", () => {
  it("returns a private bounded projection for an active user", async () => {
    const snapshot = { health: { state: "ready" }, policy: { enabled: true } };
    const projected = {
      available: true,
      enabled: false,
      internetEnabled: false,
      sessionState: "not_started"
    };
    const availability = {
      project: vi.fn().mockReturnValue(projected),
      snapshot: vi.fn().mockResolvedValue(snapshot)
    };
    const handler = createWorkspaceAvailabilityHandler({
      availability: availability as never,
      resolveAuth: vi.fn().mockResolvedValue(activeSession()) as never
    });

    const response = await handler(new Request("http://local.test/api/workspace"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(availability.project).toHaveBeenCalledWith(snapshot, {
      enabled: false,
      modelSupportsTools: true,
      session: null
    });
    await expect(response.json()).resolves.toEqual({ workspace: projected });
  });

  it("rejects inactive sessions before reading installation health", async () => {
    const availability = { project: vi.fn(), snapshot: vi.fn() };
    const handler = createWorkspaceAvailabilityHandler({
      availability: availability as never,
      resolveAuth: vi.fn().mockResolvedValue({
        user: { role: "user", status: "disabled" },
        userId: "user-1"
      }) as never
    });

    const response = await handler(new Request("http://local.test/api/workspace"));
    expect(response.status).toBe(401);
    expect(availability.snapshot).not.toHaveBeenCalled();
  });
});

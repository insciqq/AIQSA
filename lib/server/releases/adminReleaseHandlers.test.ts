import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { createAdminReleaseStatusHandler } from "./adminReleaseHandlers";

const releaseStatus = {
  checkedAt: "2026-07-31T13:00:00.000Z",
  currentVersion: "0.1.12",
  latestVersion: "0.2.0",
  publishedAt: "2026-07-31T12:00:00.000Z",
  releaseUrl: "https://github.com/insciqq/AIQSA/releases/tag/v0.2.0",
  state: "update_available" as const
};

function session(): AuthenticatedSession {
  return {
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    id: "session-1",
    user: {
      displayName: "Admin",
      email: "admin@example.test",
      id: "admin-1",
      role: "admin",
      status: "active"
    },
    userId: "admin-1"
  };
}

describe("admin release-status handler", () => {
  it("returns no release data to anonymous, ordinary, or inactive users", async () => {
    const readStatus = vi.fn(async () => releaseStatus);
    const request = new Request("http://localhost/api/admin/release");
    const anonymous = createAdminReleaseStatusHandler({
      readStatus,
      repository: { findAdminUser: vi.fn(async () => null) },
      resolveAuth: async () => null
    });
    const ordinary = createAdminReleaseStatusHandler({
      readStatus,
      repository: {
        findAdminUser: vi.fn(async () => ({
          id: "admin-1",
          role: "user" as const,
          status: "active" as const
        }))
      },
      resolveAuth: async () => session()
    });
    const inactive = createAdminReleaseStatusHandler({
      readStatus,
      repository: {
        findAdminUser: vi.fn(async () => ({
          id: "admin-1",
          role: "admin" as const,
          status: "disabled" as const
        }))
      },
      resolveAuth: async () => session()
    });

    const anonymousResponse = await anonymous(request);
    const ordinaryResponse = await ordinary(request);
    const inactiveResponse = await inactive(request);

    expect(anonymousResponse.status).toBe(401);
    await expect(anonymousResponse.json()).resolves.toEqual({ error: "unauthorized" });
    expect(ordinaryResponse.status).toBe(403);
    await expect(ordinaryResponse.json()).resolves.toEqual({ error: "forbidden" });
    expect(inactiveResponse.status).toBe(403);
    await expect(inactiveResponse.json()).resolves.toEqual({ error: "forbidden" });
    expect(readStatus).not.toHaveBeenCalled();
  });

  it("returns the bounded status only to an active administrator", async () => {
    const readStatus = vi.fn(async () => releaseStatus);
    const findAdminUser = vi.fn(async () => ({
      id: "admin-1",
      role: "admin" as const,
      status: "active" as const
    }));
    const handler = createAdminReleaseStatusHandler({
      readStatus,
      repository: { findAdminUser },
      resolveAuth: async () => session()
    });

    const response = await handler(new Request("http://localhost/api/admin/release"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(releaseStatus);
    expect(findAdminUser).toHaveBeenCalledWith("admin-1");
    expect(readStatus).toHaveBeenCalledOnce();
  });
});

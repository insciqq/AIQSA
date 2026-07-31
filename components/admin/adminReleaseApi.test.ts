import { describe, expect, it, vi } from "vitest";
import { requestAdminReleaseStatus } from "./adminReleaseApi";

const validStatus = {
  checkedAt: "2026-07-31T13:00:00.000Z",
  currentVersion: "0.1.12",
  latestVersion: "0.2.0",
  publishedAt: "2026-07-31T12:00:00.000Z",
  releaseUrl: "https://github.com/insciqq/AIQSA/releases/tag/v0.2.0",
  state: "update_available"
};

describe("admin release API client", () => {
  it("accepts only a valid successful release-status response", async () => {
    const fetcher = vi.fn(async () => Response.json(validStatus));

    await expect(requestAdminReleaseStatus(fetcher)).resolves.toEqual({
      ok: true,
      status: validStatus
    });
    expect(fetcher).toHaveBeenCalledWith("/api/admin/release", { method: "GET" });
  });

  it.each([
    Response.json({ error: "forbidden" }, { status: 403 }),
    Response.json({ ...validStatus, releaseUrl: "https://attacker.example/release" }),
    Response.json({ ...validStatus, latestVersion: null }),
    new Response("not json", { status: 200 })
  ])("fails quietly for unsuccessful or malformed response %#", async (response) => {
    await expect(requestAdminReleaseStatus(async () => response)).resolves.toEqual({ ok: false });
  });

  it("fails quietly when the request rejects", async () => {
    await expect(requestAdminReleaseStatus(async () => {
      throw new Error("network unavailable");
    })).resolves.toEqual({ ok: false });
  });
});

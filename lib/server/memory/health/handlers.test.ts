import { afterEach, describe, expect, it, vi } from "vitest";
import { createGetMemoryHealthHandler } from "./handlers";

const health = {
  action: "NONE",
  deletion: {
    activeCount: 0,
    countTruncated: false,
    retrievalFenced: false,
    state: "CLEAR"
  },
  egressReview: "NONE",
  indexing: {
    completedChats: 0,
    countTruncated: false,
    state: "READY",
    totalChats: 0
  },
  learning: { reason: "NONE", resumeAt: null, state: "READY" },
  observedAt: "2026-08-12T10:00:00.000Z",
  rebuild: { state: "IDLE" },
  state: "UP_TO_DATE",
  temporary: { countTruncated: false, overdueCount: 0, state: "CLEAR" }
};

afterEach(() => vi.restoreAllMocks());

describe("owner Memory health handler", () => {
  it("authenticates, scopes by owner, and returns private no-store state", async () => {
    const user = vi.fn().mockResolvedValue(health);
    const handler = createGetMemoryHealthHandler({
      resolveAuth: vi.fn().mockResolvedValue({ userId: "owner-1" }) as never,
      service: { admin: vi.fn(), user } as never
    });
    const response = await handler(new Request("http://local.test/api/me/memory/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(user).toHaveBeenCalledWith("owner-1");
    await expect(response.json()).resolves.toEqual({ health });
  });

  it("does not log or return private failure details", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createGetMemoryHealthHandler({
      resolveAuth: vi.fn().mockResolvedValue({ userId: "owner-1" }) as never,
      service: {
        admin: vi.fn(),
        user: vi.fn().mockRejectedValue(new Error("private source text"))
      } as never
    });
    const response = await handler(new Request("http://local.test/api/me/memory/health"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "memory_health_unavailable" });
    expect(error).toHaveBeenCalledWith("memory_health_read_failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain("private source text");
  });
});

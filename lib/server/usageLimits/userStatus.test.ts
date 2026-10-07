import { describe, expect, it, vi } from "vitest";
import { decodeUserUsageLimitStatusResponse } from "@/lib/contracts/usageLimits";
import type { UsageLimitStatus } from "./repository";
import { createUserUsageLimitStatusHandler } from "./userStatus";

const now = new Date("2026-10-07T12:00:00.000Z");
const none = { source: null, value: null };

const limited: UsageLimitStatus = {
  effective: {
    exempt: false,
    messagesPerDay: { source: { groupId: "group-1", kind: "group", name: "Research" }, value: 200 },
    messagesPerHour: { source: { kind: "installation" }, value: 30 },
    monthlyBudgetMicros: { source: { kind: "user" }, value: 10_000_000 }
  },
  installationCapMicros: 900_000_000,
  installationSpentMicros: 123_456_789,
  lastDay: { count: 40, freesAt: null },
  lastHour: { count: 30, freesAt: new Date("2026-10-07T12:20:00.000Z") },
  userSpentMicros: 3_200_000
};

function fixture(status: UsageLimitStatus | Error = limited) {
  const resolveAuth = vi.fn().mockResolvedValue({ user: { role: "user", status: "active" }, userId: "user-1" });
  const loadUsageLimitStatus = status instanceof Error
    ? vi.fn().mockRejectedValue(status)
    : vi.fn().mockResolvedValue(status);
  const GET = createUserUsageLimitStatusHandler({ now: () => now, repository: { loadUsageLimitStatus }, resolveAuth });
  return { GET, loadUsageLimitStatus, resolveAuth };
}

const request = () => new Request("http://local.test/api/me/usage-limits");

describe("GET /api/me/usage-limits", () => {
  it("requires a signed-in active account and reads nothing otherwise", async () => {
    const { GET, loadUsageLimitStatus, resolveAuth } = fixture();
    resolveAuth.mockResolvedValueOnce(null);
    const anonymous = await GET(request());
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("private, no-store");
    resolveAuth.mockResolvedValueOnce({ user: { role: "admin", status: "disabled" }, userId: "user-1" });
    expect((await GET(request())).status).toBe(403);
    expect(loadUsageLimitStatus).not.toHaveBeenCalled();
  });

  it("projects the caller's own limits and counts without any installation amount", async () => {
    const { GET, loadUsageLimitStatus } = fixture();
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(loadUsageLimitStatus).toHaveBeenCalledWith("user-1", now);
    expect(decodeUserUsageLimitStatusResponse(body)).toEqual({
      usageLimits: {
        installationExhausted: false,
        messages: {
          dayFreesAt: null,
          hourFreesAt: "2026-10-07T12:20:00.000Z",
          lastDay: 40,
          lastHour: 30,
          perDay: 200,
          perHour: 30
        },
        monthlyBudgetMicros: 10_000_000,
        monthSpentMicros: 3_200_000,
        periodStart: "2026-10-01T00:00:00.000Z",
        resetsAt: "2026-11-01T00:00:00.000Z"
      }
    });
    const text = JSON.stringify(body);
    // Neither the pooled cap, its spend nor where a limit comes from reaches the user.
    for (const secret of ["900000000", "123456789", "Research", "group-1", "installation\""]) {
      expect(text).not.toContain(secret);
    }
  });

  it("says only whether the pooled cap is reached", async () => {
    const exhausted = await (await fixture({ ...limited, installationSpentMicros: 900_000_000 }).GET(request())).json();
    expect(exhausted.usageLimits.installationExhausted).toBe(true);
    const uncapped = await (await fixture({ ...limited, installationCapMicros: null, installationSpentMicros: 0 }).GET(request())).json();
    expect(uncapped.usageLimits.installationExhausted).toBe(false);
  });

  it("answers a user without limits with nulls, not zeros", async () => {
    const body = await (await fixture({
      ...limited,
      effective: { exempt: true, messagesPerDay: none, messagesPerHour: none, monthlyBudgetMicros: none },
      installationCapMicros: null,
      lastHour: { count: 2, freesAt: null }
    }).GET(request())).json();
    expect(body.usageLimits).toMatchObject({
      messages: { perDay: null, perHour: null },
      monthlyBudgetMicros: null
    });
  });

  it("fails closed without guessed numbers when the status cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await fixture(new Error("database down: secret detail")).GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "usage_limits_unavailable" });
    expect(error).toHaveBeenCalledWith("usage_limits_unavailable");
    error.mockRestore();
  });
});

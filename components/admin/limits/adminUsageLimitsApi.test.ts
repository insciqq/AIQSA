import { describe, expect, it, vi } from "vitest";
import type { AdminUsageLimits } from "@/lib/contracts/usageLimits";
import {
  removeUserUsageLimits,
  requestAdminUsageLimits,
  saveGroupUsageLimits,
  saveInstallationUsageLimits,
  saveUserUsageLimits
} from "./adminUsageLimitsApi";

const unset = { messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: null };
const limits: AdminUsageLimits = {
  groups: [],
  installation: { ...unset, monthlyCapMicros: null, version: 1 },
  installationSpentMicros: 0,
  periodStart: "2026-10-01T00:00:00.000Z",
  resetsAt: "2026-11-01T00:00:00.000Z",
  users: []
};

function fetcher(body: unknown, status = 200) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status }));
}

describe("usage limits client", () => {
  it("sends JSON mutations to their resource paths and decodes the whole view", async () => {
    const send = fetcher({ limits });
    await expect(saveInstallationUsageLimits({ ...unset, expectedVersion: 1, monthlyCapMicros: 5 }, send)).resolves.toEqual({ limits, ok: true });
    await expect(saveGroupUsageLimits("group/1", { ...unset, messagesPerDay: 3 }, send)).resolves.toEqual({ limits, ok: true });
    await saveUserUsageLimits("user 1", { ...unset, exempt: true }, send);
    await removeUserUsageLimits("user 1", send);
    expect(send.mock.calls.map(([path, init]) => [path, init?.method, init?.body ?? null])).toEqual([
      ["/api/admin/usage-limits/installation", "PATCH", JSON.stringify({ ...unset, expectedVersion: 1, monthlyCapMicros: 5 })],
      ["/api/admin/usage-limits/groups/group%2F1", "PUT", JSON.stringify({ ...unset, messagesPerDay: 3 })],
      ["/api/admin/usage-limits/users/user%201", "PUT", JSON.stringify({ ...unset, exempt: true })],
      ["/api/admin/usage-limits/users/user%201", "DELETE", null]
    ]);
    expect(send.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store", headers: { "content-type": "application/json" } });
  });

  it("keeps stable error codes and treats a malformed answer as a failure", async () => {
    await expect(requestAdminUsageLimits(undefined, fetcher({ error: "usage_limits_stale" }, 409)))
      .resolves.toEqual({ error: "usage_limits_stale", ok: false });
    await expect(requestAdminUsageLimits(undefined, fetcher("nope", 500)))
      .resolves.toEqual({ error: "usage_limits_action_failed", ok: false });
    await expect(requestAdminUsageLimits(undefined, fetcher({ limits: { ...limits, installationSpentMicros: -1 } })))
      .resolves.toEqual({ error: "usage_limits_response_invalid", ok: false });
    await expect(requestAdminUsageLimits(undefined, vi.fn().mockRejectedValue(new TypeError("offline"))))
      .resolves.toEqual({ error: "network_error", ok: false });
  });
});

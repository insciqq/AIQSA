import { describe, expect, it, vi } from "vitest";
import { decodeAdminUsageLimitsResponse, type AdminUsageLimits } from "@/lib/contracts/usageLimits";
import { createAdminUsageLimitsHandlers } from "./handlers";
import type { UsageLimitsRepository } from "./repository";

const unset = { messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: null };
const none = { source: null, value: null };
const now = new Date("2026-10-07T12:00:00.000Z");

const view: AdminUsageLimits = {
  groups: [{ ...unset, archivedAt: null, groupId: "group-1", memberCount: 2, monthlyBudgetMicros: 5_000_000, name: "Research", version: 12 }],
  installation: { ...unset, monthlyCapMicros: 100_000_000, version: 3 },
  installationSpentMicros: 1_250_000,
  periodStart: "2026-10-01T00:00:00.000Z",
  resetsAt: "2026-11-01T00:00:00.000Z",
  users: [{
    displayName: "Ada",
    effective: {
      exempt: false,
      messagesPerDay: none,
      messagesPerHour: none,
      monthlyBudgetMicros: { source: { groupId: "group-1", kind: "group", name: "Research" }, value: 5_000_000 }
    },
    email: "ada@example.test",
    messagesLastDay: 4,
    messagesLastHour: 1,
    monthSpentMicros: 1_250_000,
    override: { ...unset, exempt: true, userId: "user-1", version: 15 },
    status: "active",
    userId: "user-1"
  }]
};

function fixture() {
  const resolveAuth = vi.fn().mockResolvedValue({ user: { role: "admin", status: "active" }, userId: "admin-1" });
  const repository = {
    deleteUserLimits: vi.fn().mockResolvedValue("written"),
    loadUsageLimitStatus: vi.fn(),
    putGroupLimits: vi.fn().mockResolvedValue("written"),
    putUserLimits: vi.fn().mockResolvedValue("written"),
    readAdminUsageLimits: vi.fn().mockResolvedValue(view),
    updateInstallation: vi.fn().mockResolvedValue({ ...view.installation, version: 4 })
  } satisfies Record<keyof UsageLimitsRepository, unknown>;
  const handlers = createAdminUsageLimitsHandlers({ now: () => now, repository, resolveAuth });
  return { handlers, repository, resolveAuth };
}

function request(method: string, body?: unknown, contentType = "application/json", query = "") {
  return new Request(`http://local.test/api/admin/usage-limits${query}`, {
    method,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": contentType } })
  });
}

const installation = { ...unset, expectedVersion: 3, monthlyCapMicros: 50_000_000 };

describe("administrator usage limit handlers", () => {
  it("requires an active administrator for every read and change", async () => {
    const { handlers, repository, resolveAuth } = fixture();
    for (const auth of [null, { user: { role: "user", status: "active" }, userId: "u" }, { user: { role: "admin", status: "disabled" }, userId: "a" }]) {
      resolveAuth.mockResolvedValue(auth);
      const status = auth ? 403 : 401;
      expect((await handlers.GET(request("GET"))).status).toBe(status);
      expect((await handlers.updateInstallation(request("PATCH", installation))).status).toBe(status);
      expect((await handlers.putGroup(request("PUT", unset), "group-1")).status).toBe(status);
      expect((await handlers.putUser(request("PUT", { ...unset, exempt: true }), "user-1")).status).toBe(status);
      expect((await handlers.deleteUser(request("DELETE"), "user-1")).status).toBe(status);
    }
    for (const method of Object.values(repository)) expect(method).not.toHaveBeenCalled();
  });

  it("answers with the whole decodable view and never lets it be cached", async () => {
    const { handlers, repository } = fixture();
    const response = await handlers.GET(request("GET"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(decodeAdminUsageLimitsResponse(await response.json())).toEqual({ limits: view });
    expect(repository.readAdminUsageLimits).toHaveBeenCalledWith(now);
  });

  it("saves the installation block with its expected version and reports a stale edit", async () => {
    const { handlers, repository } = fixture();
    const saved = await handlers.updateInstallation(request("PATCH", installation));
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual({ limits: view });
    expect(repository.updateInstallation).toHaveBeenCalledWith({ ...installation, userId: "admin-1" });
    repository.updateInstallation.mockResolvedValueOnce(null);
    const stale = await handlers.updateInstallation(request("PATCH", installation));
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ error: "usage_limits_stale" });
  });

  it("rejects non-JSON, partial, additive and out-of-range input before any change", async () => {
    const { handlers, repository } = fixture();
    expect((await handlers.updateInstallation(request("PATCH", JSON.stringify(installation), "text/plain"))).status).toBe(415);
    for (const body of [null, "{", { ...installation, expectedVersion: undefined }, { ...installation, version: 3 },
      { ...installation, monthlyCapMicros: -1 }, { ...installation, messagesPerHour: 1.5 },
      { ...installation, messagesPerDay: 100_001 }, { ...unset, expectedVersion: 3 }]) {
      const response = await handlers.updateInstallation(request("PATCH", body));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "usage_limits_input_invalid" });
    }
    expect((await handlers.putGroup(request("PUT", { ...unset, exempt: true }), "group-1")).status).toBe(400);
    expect((await handlers.putUser(request("PUT", unset), "user-1")).status).toBe(400);
    expect((await handlers.putUser(request("PUT", { ...unset, exempt: "no" }), "user-1")).status).toBe(400);
    for (const expectedVersion of [0, -1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1]) {
      expect((await handlers.putGroup(request("PUT", { ...unset, expectedVersion }), "group-1")).status).toBe(400);
      expect((await handlers.putUser(request("PUT", { ...unset, exempt: false, expectedVersion }), "user-1")).status).toBe(400);
    }
    for (const query of ["?expectedVersion=", "?expectedVersion=0", "?expectedVersion=01", "?expectedVersion=1.5", "?expectedVersion=x",
      "?expectedVersion=99999999999999999"]) {
      expect((await handlers.deleteUser(request("DELETE", undefined, undefined, query), "user-1")).status).toBe(400);
    }
    expect(repository.updateInstallation).not.toHaveBeenCalled();
    expect(repository.putGroupLimits).not.toHaveBeenCalled();
    expect(repository.putUserLimits).not.toHaveBeenCalled();
    expect(repository.deleteUserLimits).not.toHaveBeenCalled();
  });

  it("replaces a group allowance at its expected version and names a missing or malformed group", async () => {
    const { handlers, repository } = fixture();
    const limits = { ...unset, messagesPerHour: 20, monthlyBudgetMicros: 7_500_000 };
    // A first save sends no version: it expects no saved allowance.
    expect((await handlers.putGroup(request("PUT", limits), "group-1")).status).toBe(200);
    expect(repository.putGroupLimits).toHaveBeenCalledWith({
      groupId: "group-1", limits: { ...limits, expectedVersion: null }, userId: "admin-1"
    });
    expect((await handlers.putGroup(request("PUT", { ...limits, expectedVersion: 12 }), "group-1")).status).toBe(200);
    expect(repository.putGroupLimits).toHaveBeenLastCalledWith({
      groupId: "group-1", limits: { ...limits, expectedVersion: 12 }, userId: "admin-1"
    });
    repository.putGroupLimits.mockResolvedValueOnce("not_found");
    const missing = await handlers.putGroup(request("PUT", limits), "group-gone");
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "group_not_found" });
    expect((await handlers.putGroup(request("PUT", limits), "x".repeat(129))).status).toBe(404);
    expect(repository.putGroupLimits).toHaveBeenCalledTimes(3);
  });

  it("sets and removes a user override at its expected version and names a missing user", async () => {
    const { handlers, repository } = fixture();
    const limits = { ...unset, exempt: true, expectedVersion: 15 };
    expect((await handlers.putUser(request("PUT", limits), "user-1")).status).toBe(200);
    expect(repository.putUserLimits).toHaveBeenCalledWith({ limits, targetUserId: "user-1", userId: "admin-1" });
    const removed = await handlers.deleteUser(request("DELETE", undefined, undefined, "?expectedVersion=15"), "user-1");
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toEqual({ limits: view });
    expect(repository.deleteUserLimits).toHaveBeenCalledWith({ expectedVersion: 15, targetUserId: "user-1" });
    // Without a version the removal expects no override.
    await handlers.deleteUser(request("DELETE"), "user-1");
    expect(repository.deleteUserLimits).toHaveBeenLastCalledWith({ expectedVersion: null, targetUserId: "user-1" });
    repository.putUserLimits.mockResolvedValueOnce("not_found");
    repository.deleteUserLimits.mockResolvedValueOnce("not_found");
    expect((await handlers.putUser(request("PUT", limits), "user-gone")).status).toBe(404);
    const missing = await handlers.deleteUser(request("DELETE"), "user-gone");
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "user_not_found" });
  });

  it("refuses group and user saves made from an outdated version", async () => {
    const { handlers, repository } = fixture();
    repository.putGroupLimits.mockResolvedValueOnce("stale");
    repository.putUserLimits.mockResolvedValueOnce("stale");
    repository.deleteUserLimits.mockResolvedValueOnce("stale");
    for (const response of [
      await handlers.putGroup(request("PUT", { ...unset, expectedVersion: 11, messagesPerDay: 4 }), "group-1"),
      await handlers.putUser(request("PUT", { ...unset, exempt: false, messagesPerDay: 4 }), "user-1"),
      await handlers.deleteUser(request("DELETE", undefined, undefined, "?expectedVersion=14"), "user-1")
    ]) {
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "usage_limits_stale" });
    }
  });

  it("reports storage failures with a stable code and no detail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { handlers, repository } = fixture();
    repository.readAdminUsageLimits.mockRejectedValueOnce(new Error("relation does not exist"));
    const read = await handlers.GET(request("GET"));
    expect(read.status).toBe(503);
    await expect(read.json()).resolves.toEqual({ error: "usage_limits_action_failed" });
    repository.putGroupLimits.mockRejectedValueOnce(new Error("connection reset"));
    expect((await handlers.putGroup(request("PUT", unset), "group-1")).status).toBe(503);
  });
});

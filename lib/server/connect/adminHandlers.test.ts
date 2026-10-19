import { describe, expect, it, vi } from "vitest";
import {
  CONNECT_ADMIN_POLICY_CONFLICT_ERROR,
  connectAdminPolicyResponseSchema
} from "@/lib/contracts/connect";
import { createConnectAdminPolicyHandlers } from "./adminHandlers";
import type { ConnectPolicyRepository } from "./policyRepository";

function session(role: "admin" | "user" = "admin", status = "active") {
  return { expiresAt: new Date(Date.now() + 60_000), id: "session-1", user: { role, status }, userId: "admin-1" };
}

function setup(auth: ReturnType<typeof session> | null = session()) {
  const repository = {
    read: vi.fn<ConnectPolicyRepository["read"]>().mockResolvedValue({ enabled: false, version: 1 }),
    update: vi.fn<ConnectPolicyRepository["update"]>().mockResolvedValue({ kind: "ok", policy: { enabled: true, version: 2 } })
  };
  const onUpdated = vi.fn();
  const handlers = createConnectAdminPolicyHandlers({
    onUpdated,
    repository,
    resolveAuth: vi.fn().mockResolvedValue(auth) as never
  });
  return { handlers, onUpdated, repository };
}

function patch(body: unknown, contentType = "application/json") {
  return new Request("http://local.test/api/admin/connect", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": contentType },
    method: "PATCH"
  });
}

describe("AIQSA Connect administrator switch", () => {
  it("reads the switch for administrators only", async () => {
    const admin = setup();
    const response = await admin.handlers.GET(new Request("http://local.test/api/admin/connect"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(connectAdminPolicyResponseSchema.parse(await response.json())).toEqual({ connect: { enabled: false, version: 1 } });

    for (const [auth, status, error] of [
      [null, 401, "unauthorized"],
      [session("user"), 403, "forbidden"],
      [session("admin", "disabled"), 403, "forbidden"]
    ] as const) {
      const refused = setup(auth);
      const answer = await refused.handlers.GET(new Request("http://local.test/api/admin/connect"));
      expect(answer.status).toBe(status);
      await expect(answer.json()).resolves.toEqual({ error });
      expect(refused.repository.read).not.toHaveBeenCalled();
    }
  });

  it("turns the switch at the version the administrator read and applies the change", async () => {
    const { handlers, onUpdated, repository } = setup();
    const response = await handlers.PATCH(patch({ enabled: true, expectedVersion: 1 }));

    expect(response.status).toBe(200);
    expect(connectAdminPolicyResponseSchema.parse(await response.json())).toEqual({ connect: { enabled: true, version: 2 } });
    expect(repository.update).toHaveBeenCalledWith({ enabled: true, expectedVersion: 1, userId: "admin-1" });
    expect(onUpdated).toHaveBeenCalledWith({ enabled: true, version: 2 });
  });

  it("answers a stale version with the conflict error and changes nothing", async () => {
    const { handlers, onUpdated, repository } = setup();
    repository.update.mockResolvedValueOnce({ kind: "stale" });
    const response = await handlers.PATCH(patch({ enabled: false, expectedVersion: 1 }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: CONNECT_ADMIN_POLICY_CONFLICT_ERROR });
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it("requires JSON, an administrator and exactly the switch and its version", async () => {
    const { handlers, repository } = setup();
    expect((await handlers.PATCH(patch({ enabled: true, expectedVersion: 1 }, "text/plain"))).status).toBe(415);
    for (const body of [
      { enabled: true },
      { expectedVersion: 1 },
      { enabled: "true", expectedVersion: 1 },
      { enabled: true, expectedVersion: 0 },
      { enabled: true, expectedVersion: 1.5 },
      { enabled: true, expectedVersion: 1, internetEnabled: true },
      "not json"
    ]) {
      const response = await handlers.PATCH(patch(body));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "connect_policy_input_invalid" });
    }
    expect(repository.update).not.toHaveBeenCalled();

    const user = setup(session("user"));
    expect((await user.handlers.PATCH(patch({ enabled: true, expectedVersion: 1 }))).status).toBe(403);
    expect(user.repository.update).not.toHaveBeenCalled();
  });

  it("keeps store failures generic", async () => {
    const { handlers, repository } = setup();
    repository.update.mockRejectedValueOnce(new Error("connection to 10.0.0.5 refused"));
    const response = await handlers.PATCH(patch({ enabled: true, expectedVersion: 1 }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "connect_policy_unavailable" });
  });
});

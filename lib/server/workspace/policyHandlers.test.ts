import { describe, expect, it, vi } from "vitest";
import { WorkspacePolicyServiceError } from "./policyService";
import { createWorkspaceOverviewHandler, createWorkspacePolicyHandlers } from "./policyHandlers";

function session(role: "admin" | "user" = "admin") {
  return { user: { role, status: "active" }, userId: "user-1" };
}

describe("administrator Workspace policy handlers", () => {
  it("keeps overview metadata admin-only, validates pagination, and prevents caching", async () => {
    const service = { read: vi.fn().mockResolvedValue({ state: "unavailable", activeCount: null }) };
    const resolveAuth = vi.fn();
    const get = createWorkspaceOverviewHandler({ resolveAuth: resolveAuth as never, service: service as never });
    for (const auth of [null, session("user"), { ...session(), user: { role: "admin", status: "disabled" } }]) {
      resolveAuth.mockResolvedValue(auth);
      const response = await get(new Request("http://local.test/api/admin/workspace/overview"));
      expect(response.status).toBe(auth ? 403 : 401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(service.read).not.toHaveBeenCalled();
    resolveAuth.mockResolvedValue(session());
    for (const query of ["page=0", "page=-1", "page=1e2", "page=100001", "page=1&page=2", "filter=ready", "filter=all&filter=active", "chatId=private"]) {
      expect((await get(new Request(`http://local.test/api/admin/workspace/overview?${query}`))).status).toBe(400);
    }
    expect(service.read).not.toHaveBeenCalled();
    const response = await get(new Request("http://local.test/api/admin/workspace/overview?filter=all&page=3"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(service.read).toHaveBeenCalledWith({ filter: "all", page: 3 });
    service.read.mockRejectedValue(new Error("private runtime address"));
    const failed = await get(new Request("http://local.test/api/admin/workspace/overview"));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "workspace_overview_unavailable" });
  });
  it("authorizes reads and never calls the service for ordinary users", async () => {
    const service = { read: vi.fn() };
    const handlers = createWorkspacePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session("user")) as never,
      service: service as never
    });
    const response = await handlers.GET(new Request("http://local.test/api/admin/workspace"));
    expect(response.status).toBe(403);
    expect(service.read).not.toHaveBeenCalled();
  });

  it("accepts a bounded optimistic policy update while runtime is unavailable", async () => {
    const policy = {
      enabled: true,
      internetEnabled: false,
      runtime: { reasonCode: "workspace_runtime_unavailable", state: "unavailable" },
      version: 3
    };
    const service = { update: vi.fn().mockResolvedValue(policy) };
    const handlers = createWorkspacePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    const response = await handlers.PATCH(new Request("http://local.test/api/admin/workspace", {
      body: JSON.stringify({ enabled: true, expectedVersion: 2, internetEnabled: false }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }));
    expect(response.status).toBe(200);
    expect(service.update).toHaveBeenCalledWith({
      enabled: true,
      expectedVersion: 2,
      internetEnabled: false,
      userId: "user-1"
    });
    await expect(response.json()).resolves.toEqual({ workspace: policy });
  });

  it("rejects additive or empty updates and maps optimistic conflicts", async () => {
    const service = {
      update: vi.fn().mockRejectedValue(new WorkspacePolicyServiceError("workspace_policy_stale"))
    };
    const handlers = createWorkspacePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    for (const body of [
      { expectedVersion: 1 },
      { enabled: true, expectedVersion: 1, token: "forbidden" },
      { enabled: "true", expectedVersion: 1 }
    ]) {
      const response = await handlers.PATCH(new Request("http://local.test/api/admin/workspace", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }));
      expect(response.status).toBe(400);
    }
    const stale = await handlers.PATCH(new Request("http://local.test/api/admin/workspace", {
      body: JSON.stringify({ enabled: true, expectedVersion: 1 }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }));
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ error: "workspace_policy_stale" });
  });
});

import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { createBuiltInSkillAdminHandlers, type BuiltInSkillAdminService } from "./builtInSkillsAdmin";

function session(role: "admin" | "user", status: "active" | "disabled" = "active"): AuthenticatedSession {
  return { expiresAt: new Date(Date.now() + 60_000), id: "session-1", userId: "admin-1",
    user: { displayName: "Admin", email: "admin@example.test", id: "admin-1", role, status } };
}
const skill = { id: "skill-1", name: "health-questions", enabled: false, version: 3, assistantUsageCount: 1 };

function setup(auth: AuthenticatedSession | null, result: Awaited<ReturnType<BuiltInSkillAdminService["setEnabled"]>> = { kind: "ok", skill }) {
  const service = { list: vi.fn(async () => [skill]), setEnabled: vi.fn(async () => result) };
  const handlers = createBuiltInSkillAdminHandlers({ resolveAuth: vi.fn(async () => auth), service: () => service });
  const patch = (body: unknown, skillId = "skill-1") => handlers.update(new Request(`http://localhost/api/admin/skills/built-in/${skillId}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  }), { params: { skillId } });
  return { service, handlers, patch };
}

describe("built-in Skill administration", () => {
  it("is for active administrators only", async () => {
    for (const [auth, status] of [[null, 401], [session("user"), 403], [session("admin", "disabled"), 403]] as const) {
      const { service, handlers, patch } = setup(auth);
      expect((await handlers.list(new Request("http://localhost/api/admin/skills/built-in"))).status).toBe(status);
      expect((await patch({ enabled: false, expectedVersion: 2 })).status).toBe(status);
      expect(service.list).not.toHaveBeenCalled();
      expect(service.setEnabled).not.toHaveBeenCalled();
    }
  });

  it("lists and switches a shipped Skill under its version", async () => {
    const { service, handlers, patch } = setup(session("admin"));
    const list = await handlers.list(new Request("http://localhost/api/admin/skills/built-in"));
    await expect(list.json()).resolves.toEqual({ skills: [skill] });
    const response = await patch({ enabled: false, expectedVersion: 2 });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ skill });
    expect(service.setEnabled).toHaveBeenCalledWith("skill-1", false, 2);
  });

  it("refuses malformed input before any write and maps a stale version and a missing Skill", async () => {
    const { service, patch } = setup(session("admin"));
    for (const body of [{}, { enabled: "no", expectedVersion: 2 }, { enabled: true, expectedVersion: 0 },
      { enabled: true, expectedVersion: 2, archivedAt: null }, [true]]) {
      expect((await patch(body)).status).toBe(400);
    }
    expect((await patch({ enabled: true, expectedVersion: 2 }, "../other")).status).toBe(400);
    expect(service.setEnabled).not.toHaveBeenCalled();
    expect((await setup(session("admin"), { kind: "version_conflict" }).patch({ enabled: true, expectedVersion: 2 })).status).toBe(409);
    expect((await setup(session("admin"), { kind: "not_found" }).patch({ enabled: true, expectedVersion: 2 })).status).toBe(404);
  });
});

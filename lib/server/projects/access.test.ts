import { describe, expect, it, vi } from "vitest";
import { resolveChatAccess, resolveProjectAccess } from "./access";

function client(input: {
  chat?: { archived: boolean; permanentDeletionAt: Date | null; projectId: string | null; userId: string | null } | null;
  project?: Record<string, unknown> | null;
  user?: Record<string, unknown> | null;
}) {
  return {
    chat: { findUnique: vi.fn(async () => input.chat ?? null) },
    project: { findUnique: vi.fn(async () => input.project ?? null) },
    user: { findFirst: vi.fn(async () => input.user ?? null) }
  } as never;
}

describe("Project access resolver", () => {
  it("merges direct and active-group grants without treating admin as access", async () => {
    const access = await resolveProjectAccess(client({
      project: {
        accessRevision: 7,
        grants: [
          { group: null, groupId: null, role: "VIEWER", userId: "user-1" },
          { group: { id: "group-1", name: "Research" }, groupId: "group-1", role: "MANAGER", userId: null },
          { group: { id: "group-2", name: "Archived" }, groupId: "group-2", role: "OWNER", userId: null }
        ],
        id: "project-1",
        instructionsRevision: 3,
        memoryRevision: 2,
        policyRevision: 5,
        status: "ACTIVE"
      },
      user: { groups: [{ groupId: "group-1" }], id: "user-1", role: "admin" }
    }), { minimumRole: "CONTRIBUTOR", projectId: "project-1", userId: "user-1" });

    expect(access).toMatchObject({
      directRole: "VIEWER",
      effectiveRole: "MANAGER",
      groupGrants: [{ groupId: "group-1", groupName: "Research", role: "MANAGER" }]
    });
  });

  it("returns the same unavailable result for missing, disabled, and ungranted users", async () => {
    await expect(resolveProjectAccess(client({ project: null, user: { groups: [], id: "u" } }), {
      projectId: "missing", userId: "u"
    })).resolves.toBeNull();
    await expect(resolveProjectAccess(client({ project: { grants: [], id: "p", status: "ACTIVE" }, user: null }), {
      projectId: "p", userId: "u"
    })).resolves.toBeNull();
  });

  it("keeps personal ownership and Project RBAC as distinct chat boundaries", async () => {
    await expect(resolveChatAccess(client({
      chat: { archived: false, permanentDeletionAt: null, projectId: null, userId: "owner" }
    }), { chatId: "chat", userId: "other" })).resolves.toBeNull();

    const access = await resolveChatAccess(client({
      chat: { archived: false, permanentDeletionAt: null, projectId: "project", userId: null },
      project: {
        accessRevision: 1,
        grants: [{ group: null, groupId: null, role: "CONTRIBUTOR", userId: "member" }],
        id: "project",
        instructionsRevision: 1,
        memoryRevision: 0,
        policyRevision: 1,
        status: "ACTIVE"
      },
      user: { groups: [], id: "member" }
    }), { chatId: "chat", minimumProjectRole: "CONTRIBUTOR", requireMutable: true, userId: "member" });
    expect(access?.kind).toBe("project");
  });
});

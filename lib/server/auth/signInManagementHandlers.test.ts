import { describe, expect, it, vi } from "vitest";
import type { AdminGroupSignIn, AdminUserSignIn } from "@/lib/contracts/adminSignIn";
import type { AuthenticatedSession } from "./requestAuth";
import type { SignInManagementRepository } from "./signInManagement";
import { createAdminGroupSignInHandlers, createAdminUserSignInHandlers } from "./signInManagementHandlers";

const adminSession: AuthenticatedSession = {
  expiresAt: new Date("2026-10-09T00:00:00.000Z"),
  id: "session-admin",
  user: { displayName: "Admin", email: "admin@example.com", id: "admin", role: "admin", status: "active" },
  userId: "admin"
};

const group: AdminGroupSignIn = { externalNames: [], managedMembers: [], scimManaged: false };
const user: AdminUserSignIn = { hasPassword: true, identities: [], managedGroups: [] };

function repository(overrides: Partial<SignInManagementRepository> = {}): SignInManagementRepository {
  return {
    addExternalName: vi.fn(async () => ({ ok: true as const, value: group })),
    readGroup: vi.fn(async () => group),
    readUser: vi.fn(async () => user),
    removeExternalName: vi.fn(async () => ({ ok: true as const, value: group })),
    unlinkIdentity: vi.fn(async () => ({ ok: true as const, value: user })),
    ...overrides
  };
}

function deps(repo: SignInManagementRepository, session: AuthenticatedSession | null = adminSession) {
  return {
    currentIdentitySources: vi.fn(async () => ({ oidc: "https://idp.example/realms/main" })),
    repository: repo,
    resolveAuth: vi.fn(async () => session)
  };
}

function post(body: unknown): Request {
  return new Request("http://localhost:3000/api/admin/sign-in/x", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

describe("group external name handlers", () => {
  it("are administrator-only and privacy-neutral for unknown groups", async () => {
    const repo = repository({ readGroup: vi.fn(async () => null) });
    const nonAdmin = { ...adminSession, user: { ...adminSession.user, role: "user" } };

    expect((await createAdminGroupSignInHandlers(deps(repo, nonAdmin)).GET(new Request("http://localhost:3000/"), { params: { groupId: "g" } })).status).toBe(403);
    const missing = await createAdminGroupSignInHandlers(deps(repo)).GET(new Request("http://localhost:3000/"), { params: { groupId: "g" } });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "group_not_found" });
  });

  it("adds and removes exact names and maps refusals", async () => {
    const repo = repository({
      addExternalName: vi.fn(async () => ({ code: "external_name_duplicate" as const, ok: false as const }))
    });
    const { POST } = createAdminGroupSignInHandlers(deps(repo));

    const duplicate = await POST(post({ action: "add_external_name", source: "oidc", value: " /team " }), { params: { groupId: "g" } });
    expect(duplicate.status).toBe(409);
    expect(repo.addExternalName).toHaveBeenCalledWith({ groupId: "g", source: "oidc", value: " /team " });

    expect((await POST(post({ action: "remove_external_name", externalNameId: "n1" }), { params: { groupId: "g" } })).status).toBe(200);
    expect(repo.removeExternalName).toHaveBeenCalledWith({ externalNameId: "n1", groupId: "g" });
    expect((await POST(post({ action: "rename", value: "x" }), { params: { groupId: "g" } })).status).toBe(400);
  });
});

describe("user sign-in handlers", () => {
  it("read identities with the current sources and unlink with explicit last-method confirmation", async () => {
    const repo = repository({
      unlinkIdentity: vi.fn(async () => ({ code: "identity_last_sign_in_method" as const, ok: false as const }))
    });
    const handlers = createAdminUserSignInHandlers(deps(repo));

    expect((await handlers.GET(new Request("http://localhost:3000/"), { params: { userId: "u1" } })).status).toBe(200);
    expect(repo.readUser).toHaveBeenCalledWith("u1", { oidc: "https://idp.example/realms/main" });

    const last = await handlers.POST(post({ action: "unlink_identity", identityId: "i1" }), { params: { userId: "u1" } });
    expect(last.status).toBe(409);
    await expect(last.json()).resolves.toEqual({ error: "identity_last_sign_in_method" });

    await handlers.POST(post({ action: "unlink_identity", confirmLastSignInMethod: true, identityId: "i1" }), { params: { userId: "u1" } });
    expect(repo.unlinkIdentity).toHaveBeenLastCalledWith({
      confirmLastSignInMethod: true,
      currentSources: { oidc: "https://idp.example/realms/main" },
      identityId: "i1",
      userId: "u1"
    });
    expect((await handlers.POST(post({ action: "unlink_identity", confirmLastSignInMethod: "yes", identityId: "i1" }), { params: { userId: "u1" } })).status).toBe(400);
  });
});

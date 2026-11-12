import { AuthIdentityProvider, GroupExternalNameSource } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { EXTERNAL_GROUP_SOURCES } from "@/lib/contracts/authSignInMethods";
import {
  externalAdminRoleChange,
  externalIdentityPolicy,
  externalRoleManager,
  settleExternalIdentity,
  type ExternalIdentityInput
} from "./externalIdentity";

/** Any database access fails the test: these refusals are decided from the input alone. */
const untouchable = new Proxy({}, {
  get() {
    throw new Error("settlement touched the database");
  }
});

function input(overrides: Partial<ExternalIdentityInput> = {}): ExternalIdentityInput {
  return {
    displayName: "Synthetic User",
    email: "user@example.test",
    emailVerified: true,
    groups: [],
    now: new Date("2026-10-08T00:00:00.000Z"),
    policy: externalIdentityPolicy({ adminGroups: [], allowedGroups: [], autoCreateUsers: true, syncGroups: false }),
    provider: "oidc",
    source: "https://idp.example.test/realms/aiqsa",
    subject: "subject-1",
    ...overrides
  };
}

describe("external identity settlement rules", () => {
  it("names the same external methods as the database enums", () => {
    expect(Object.values(GroupExternalNameSource).sort()).toEqual([...EXTERNAL_GROUP_SOURCES].sort());
    expect(Object.values(AuthIdentityProvider).filter((provider) => !["google", "password", "yandex"].includes(provider)).sort())
      .toEqual([...EXTERNAL_GROUP_SOURCES].sort());
  });

  it("refuses before reading accounts when the email is missing or admission cannot pass", async () => {
    const restricted = externalIdentityPolicy({
      adminGroups: [],
      allowedGroups: ["aiqsa-users"],
      autoCreateUsers: true,
      syncGroups: false
    });

    for (const email of [null, "", "   ", "not-an-email"]) {
      await expect(settleExternalIdentity(untouchable as never, input({ email }))).resolves.toEqual({ status: "email_missing" });
    }
    await expect(settleExternalIdentity(untouchable as never, input({ groups: null, policy: restricted })))
      .resolves.toEqual({ status: "not_allowed" });
    await expect(settleExternalIdentity(untouchable as never, input({ groups: ["other"], policy: restricted })))
      .resolves.toEqual({ status: "not_allowed" });
    await expect(settleExternalIdentity(untouchable as never, input({ source: null })))
      .rejects.toThrow("external_identity_source_invalid");
    await expect(settleExternalIdentity(untouchable as never, input({ provider: "google" })))
      .rejects.toThrow("external_identity_source_invalid");
  });

  it("maps a method's group policy to groups admission without trusting unverified email by default", () => {
    expect(externalIdentityPolicy({
      adminGroups: ["admins"],
      allowedGroups: [],
      autoCreateUsers: false,
      syncGroups: true
    })).toEqual({
      adminGroups: ["admins"],
      admission: { allowedGroups: [], kind: "groups" },
      autoCreateUsers: false,
      syncGroups: true,
      trustUnverifiedEmail: false
    });
    expect(externalRoleManager("saml", "https://idp.example.test/realms/aiqsa"))
      .not.toBe(externalRoleManager("oidc", "https://idp.example.test/realms/aiqsa"));
  });

  it.each([
    ["promotes a member of an admin group", "user", null, ["admins"], 1, "promote"],
    ["leaves an existing admin in an admin group alone", "admin", null, ["admins"], 1, "none"],
    ["demotes an admin it promoted", "admin", "oidc:issuer", ["staff"], 1, "demote"],
    ["keeps the last active admin", "admin", "oidc:issuer", [], 0, "keep_last_admin"],
    ["never demotes a manual admin", "admin", null, [], 1, "none"],
    ["never demotes an admin another source promoted", "admin", "saml:issuer", [], 1, "none"],
    ["leaves an ordinary user alone", "user", null, ["staff"], 0, "none"]
  ] as const)("%s", (_name, role, roleManagedBy, groups, otherActiveAdmins, change) => {
    expect(externalAdminRoleChange({
      adminGroups: ["admins"],
      groups,
      manager: "oidc:issuer",
      otherActiveAdmins,
      role,
      roleManagedBy
    })).toBe(change);
  });
});

describe("external sign-in of a service account", () => {
  const serviceUser = {
    email: "user@example.test",
    id: "service-1",
    kind: "service",
    role: "user",
    roleManagedBy: null,
    scimDeactivatedAt: null,
    scimExternalId: null,
    status: "active"
  };

  function transaction(subjectIdentity: boolean) {
    const writes = vi.fn(() => {
      throw new Error("settlement wrote for a service account");
    });
    const tx = {
      // Locks: the email, the identity and the account rows.
      $queryRaw: vi.fn(async () => []),
      authIdentity: {
        create: writes,
        findUnique: vi.fn(async (query: { include?: object; where: Record<string, unknown> }) => {
          if (!subjectIdentity) return null;
          if ("provider_providerAccountId" in query.where) return { id: "identity-1", userId: serviceUser.id };
          if (query.include) {
            return {
              emailVerifiedAt: new Date("2026-10-01T00:00:00.000Z"),
              id: "identity-1",
              normalizedEmail: "user@example.test",
              source: input().source,
              user: serviceUser,
              userId: serviceUser.id
            };
          }
          return null;
        }),
        update: writes
      },
      user: {
        create: writes,
        findUnique: vi.fn(async () => serviceUser),
        update: writes
      }
    };
    return { tx, writes };
  }

  it("refuses a planted identity whose subject matches", async () => {
    const { tx, writes } = transaction(true);

    await expect(settleExternalIdentity(tx as never, input())).resolves.toEqual({ status: "not_allowed" });
    expect(writes).not.toHaveBeenCalled();
  });

  it("never links a new identity to it by a matching verified email", async () => {
    const { tx, writes } = transaction(false);

    await expect(settleExternalIdentity(tx as never, input())).resolves.toEqual({ status: "not_allowed" });
    expect(writes).not.toHaveBeenCalled();
  });
});

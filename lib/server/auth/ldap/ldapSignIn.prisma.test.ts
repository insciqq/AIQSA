// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { ldapSignInConfigSchema } from "@/lib/contracts/authSignInMethods";
import { createFakeLdapDirectory, type FakeLdapUser } from "@/tests/support/fakeLdapDirectory";
import { prisma } from "../../prisma";
import { getAuthConfig } from "../config";
import { completeExternalSignIn, externalRoleManager } from "../externalIdentity";
import { createPasswordLoginHandler } from "../handlers";
import { hashPassword } from "../password";
import { createPrismaPasswordAuthRepository } from "../passwordRepository";
import { createFixedWindowLoginRateLimiter } from "../rateLimit";
import { SECOND_FACTOR_COOKIE_NAME } from "../secondFactorChallenge";
import { hashToken } from "../token";
import { createLdapPasswordFormSignIn } from "./ldapSignIn";
import { ldapIdentitySource } from "./ldapValues";

const authConfig = getAuthConfig({ AIQSA_AUTH_SESSION_SECRET: "ldap-prisma-session-secret" });
const passwords = createPrismaPasswordAuthRepository(prisma);
const now = new Date();

type Fixture = {
  config: ReturnType<typeof ldapSignInConfigSchema.parse>;
  directoryUser(localPart: string, groups?: string[]): FakeLdapUser;
  email(localPart: string): string;
  group(label: string, ldapValue: string): Promise<string>;
  /** The login route with LDAP active on this run's directory. */
  login(
    users: FakeLdapUser[],
    input: { allowedGroups?: string[]; email: string; password: string; passwordLoginEnabled?: boolean }
  ): Promise<Response>;
  value(name: string): string;
};

async function withLdapData<T>(run: (fixture: Fixture) => Promise<T>): Promise<T> {
  const id = randomUUID();
  const domain = `ldap-${id}.example.com`;
  const base = `ou=people-${id},dc=example,dc=test`;
  const value = (name: string) => `${name}-${id}`;
  const email = (localPart: string) => `${localPart}@${domain}`;
  const groupIds: string[] = [];
  const config = ldapSignInConfigSchema.parse({
    adminGroups: [value("aiqsa-admins")],
    loginUsesUsername: true,
    syncGroups: true,
    url: "ldaps://ldap.example.test",
    userSearchBase: base,
    userSearchFilter: "(|(uid={{username}})(mail={{username}}))"
  });

  try {
    return await run({
      config,
      directoryUser(localPart, groups = []) {
        return {
          attributes: {
            cn: [`LDAP ${localPart}`],
            entryUUID: [value(`uuid-${localPart}`)],
            mail: [email(localPart)],
            memberOf: groups.map((group) => `cn=${group},ou=groups,dc=example,dc=test`),
            uid: [value(localPart)]
          },
          dn: `uid=${value(localPart)},${base}`,
          password: `directory-password-${localPart}`
        };
      },
      email,
      async group(label, ldapValue) {
        const group = await prisma.group.create({
          data: { externalNames: { create: [{ source: "ldap", value: ldapValue }] }, name: value(label) }
        });
        groupIds.push(group.id);
        return group.id;
      },
      async login(users, input) {
        const directory = createFakeLdapDirectory({ users });
        const POST = createPasswordLoginHandler({
          directorySignIn: createLdapPasswordFormSignIn({
            completeSignIn: (completion) => completeExternalSignIn(prisma, completion),
            connect: () => directory.connect,
            findUser: (userId) => prisma.user.findUnique({
              select: { displayName: true, email: true, id: true, role: true, status: true },
              where: { id: userId }
            }),
            floorMs: 0,
            recordOutcome: async () => undefined,
            resolveLdap: async () => ({
              activeVersion: 1,
              config: { ...config, allowedGroups: input.allowedGroups ?? config.allowedGroups },
              method: "ldap",
              secrets: {},
              source: "admin"
            })
          }),
          getConfig: () => authConfig,
          loginRateLimiter: createFixedWindowLoginRateLimiter(),
          repository: passwords,
          signInPolicy: async () => ({ passwordLoginEnabled: input.passwordLoginEnabled ?? true, registrationEnabled: true })
        });
        return POST(new Request("http://localhost:3000/api/auth/login", {
          body: JSON.stringify({ email: input.email, password: input.password }),
          headers: { "content-type": "application/json" },
          method: "POST"
        }));
      },
      value
    });
  } finally {
    await prisma.user.deleteMany({
      where: { authIdentities: { some: { normalizedEmail: { endsWith: `@${domain}` } } } }
    });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
    await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
  }
}

function sessionToken(response: Response): string {
  const cookie = response.headers.get("set-cookie") ?? "";
  return cookie.split(";")[0]!.split("=")[1] ?? "";
}

describe("LDAP sign-in through settlement", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates the account, binds its identity to the directory, syncs mapped groups and the admin role", async () => {
    await withLdapData(async (fixture) => {
      const researchers = await fixture.group("researchers", fixture.value("researchers"));
      const jane = fixture.directoryUser("jane", [fixture.value("researchers"), fixture.value("aiqsa-admins")]);

      const response = await fixture.login([jane], { email: fixture.value("jane"), password: jane.password });

      expect(response.status).toBe(200);
      const user = await prisma.user.findUniqueOrThrow({
        include: { authIdentities: true, groups: true },
        where: { email: fixture.email("jane") }
      });
      const source = ldapIdentitySource(fixture.config);
      expect(user).toMatchObject({ role: "admin", roleManagedBy: externalRoleManager("ldap", source), status: "active" });
      expect(user.authIdentities).toEqual([expect.objectContaining({
        emailVerifiedAt: null,
        passwordHash: null,
        provider: "ldap",
        providerAccountId: fixture.value("uuid-jane"),
        source
      })]);
      expect(user.groups.map((membership) => membership.groupId)).toEqual([researchers]);
      await expect(prisma.authSession.findUniqueOrThrow({
        select: { signInMethod: true, userId: true },
        where: { tokenHash: hashToken(sessionToken(response)) }
      })).resolves.toEqual({ signInMethod: "ldap", userId: user.id });
    });
  });

  it("asks a user with TOTP for the second step and creates no session", async () => {
    await withLdapData(async (fixture) => {
      const jane = fixture.directoryUser("jane");
      expect((await fixture.login([jane], { email: fixture.value("jane"), password: jane.password })).status).toBe(200);
      const user = await prisma.user.findUniqueOrThrow({ select: { id: true }, where: { email: fixture.email("jane") } });
      await prisma.authTotpFactor.create({
        data: { confirmedAt: now, secretEnvelope: "synthetic-envelope-not-read-here", userId: user.id }
      });
      const sessionsBefore = await prisma.authSession.count({ where: { userId: user.id } });

      const response = await fixture.login([jane], { email: fixture.email("jane"), password: jane.password });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "second_factor_required" });
      expect(response.headers.get("set-cookie")).toMatch(new RegExp(`^${SECOND_FACTOR_COOKIE_NAME}=`, "u"));
      await expect(prisma.authSession.count({ where: { userId: user.id } })).resolves.toBe(sessionsBefore);
    });
  });

  it("keeps a local password first while it is on, and links the directory account while it is off", async () => {
    await withLdapData(async (fixture) => {
      const localUser = await prisma.user.create({
        data: { displayName: "Break Glass", email: fixture.email("admin"), role: "user", status: "active" }
      });
      await prisma.authIdentity.create({
        data: {
          emailVerifiedAt: now,
          normalizedEmail: fixture.email("admin"),
          passwordHash: await hashPassword("local password"),
          provider: "password",
          providerAccountId: fixture.email("admin"),
          userId: localUser.id
        }
      });
      const directoryAdmin = fixture.directoryUser("admin");

      const local = await fixture.login([directoryAdmin], { email: fixture.email("admin"), password: "local password" });
      expect(local.status).toBe(200);
      const refused = await fixture.login([directoryAdmin], { email: fixture.email("admin"), password: directoryAdmin.password });
      expect(refused.status).toBe(401);
      await expect(prisma.authIdentity.count({ where: { provider: "ldap", userId: localUser.id } })).resolves.toBe(0);

      const directory = await fixture.login([directoryAdmin], {
        email: fixture.email("admin"),
        password: directoryAdmin.password,
        passwordLoginEnabled: false
      });
      expect(directory.status).toBe(200);
      await expect(prisma.authIdentity.findFirstOrThrow({
        select: { userId: true },
        where: { provider: "ldap", providerAccountId: fixture.value("uuid-admin") }
      })).resolves.toEqual({ userId: localUser.id });
    });
  });

  it("refuses a directory user outside the allowed groups without creating an account", async () => {
    await withLdapData(async (fixture) => {
      const outsider = fixture.directoryUser("outsider", [fixture.value("guests")]);
      const response = await fixture.login([outsider], {
        allowedGroups: [fixture.value("researchers")],
        email: fixture.value("outsider"),
        password: outsider.password
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "not_allowed" });
      await expect(prisma.user.count({ where: { email: fixture.email("outsider") } })).resolves.toBe(0);
    });
  });
});

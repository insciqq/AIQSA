// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { oidcSignInConfigSchema, type AuthSignInMethodConfig } from "@/lib/contracts/authSignInMethods";
import { createFakeOidcProvider, type FakeOidcProvider } from "@/tests/support/fakeOidcProvider";
import { prisma } from "../../prisma";
import { createAdminUserSessionCommands } from "../adminUserSessionCommands";
import { completeExternalSignIn, externalRoleManager } from "../externalIdentity";
import { createLogoutHandler } from "../handlers";
import { createPrismaAuthSessionStore } from "../prismaSessions";
import { createAuthSession, type SealedIdTokenHint } from "../requestAuth";
import { readCookie, SESSION_COOKIE_NAME } from "../session";
import { hashToken } from "../token";
import { createOidcClient } from "./oidcClient";
import { OIDC_ID_TOKEN_HINT_MAX_LENGTH, openOidcIdTokenHint } from "./oidcIdTokenHint";
import { createOidcSignInFlow } from "./oidcSignIn";

const now = new Date("2026-10-08T12:00:00.000Z");
const encryptionKey = randomBytes(32);
const key = () => encryptionKey;

type Fixture = {
  domain: string;
  email(localPart: string): string;
  group(label: string, value?: string): Promise<string>;
  idp: FakeOidcProvider;
  /** The configuration a sign-in with these overrides runs under. */
  oidcConfig(config?: Partial<AuthSignInMethodConfig<"oidc">>): AuthSignInMethodConfig<"oidc">;
  /** Runs one OIDC sign-in through the fake IdP, the flow and the real settlement. */
  signIn(input: {
    claims: Record<string, unknown>;
    config?: Partial<AuthSignInMethodConfig<"oidc">>;
  }): Promise<Awaited<ReturnType<ReturnType<typeof createOidcSignInFlow>["signIn"]>>>;
  value(name: string): string;
};

async function withOidc<T>(run: (fixture: Fixture) => Promise<T>): Promise<T> {
  const id = randomUUID();
  const domain = `oidc-${id}.example.com`;
  const idp = await createFakeOidcProvider({ issuer: `https://idp-${id}.example.test/realms/aiqsa`, now: () => now });
  const client = createOidcClient({ fetchImpl: idp.fetch, now: () => now.getTime() });
  const groupIds: string[] = [];
  const oidcConfig = (config: Partial<AuthSignInMethodConfig<"oidc">> = {}) =>
    oidcSignInConfigSchema.parse({ clientId: idp.clientId, issuer: idp.issuer, ...config });

  try {
    return await run({
      domain,
      email: (localPart) => `${localPart}@${domain}`,
      async group(label, value) {
        const group = await prisma.group.create({
          data: {
            externalNames: { create: value ? [{ source: "oidc", value }] : [] },
            name: `${label}-${id}`
          }
        });
        groupIds.push(group.id);
        return group.id;
      },
      idp,
      oidcConfig,
      async signIn(input) {
        idp.state.nonce = `nonce-${id}`;
        idp.state.idTokenClaims = input.claims;
        const flow = createOidcSignInFlow({
          client,
          config: oidcConfig(input.config),
          encryptionKey: key,
          secrets: { clientSecret: idp.clientSecret },
          settle: (settlement) => completeExternalSignIn(prisma, settlement)
        });
        return flow.signIn({
          code: "valid-code",
          codeVerifier: "verifier",
          nonce: `nonce-${id}`,
          now,
          redirectUri: "https://aiqsa.example/api/auth/oauth/oidc/callback",
          request: new Request("https://aiqsa.example/api/auth/oauth/oidc/callback", { headers: { "user-agent": "OIDC Prisma test" } }),
          secureCookie: true
        });
      },
      value: (name) => `${name}-${id}`
    });
  } finally {
    await prisma.user.deleteMany({
      where: { authIdentities: { some: { normalizedEmail: { endsWith: `@${domain}` } } } }
    });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
    await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
  }
}

function sessionToken(cookie: string): string {
  return readCookie(cookie.split(";")[0] ?? null, SESSION_COOKIE_NAME) ?? "";
}

/** The session row a sign-in's cookie names, with the id token hint it stored. */
async function signedInSession(result: { cookie?: string; status: string }) {
  expect(result.status).toBe("active");
  return prisma.authSession.findUniqueOrThrow({
    select: { id: true, idTokenHintEnvelope: true, revokedAt: true, userId: true },
    where: { tokenHash: hashToken(sessionToken(result.cookie ?? "")) }
  });
}

/** Records every id token the fake IdP issues from now on. */
function captureIdTokens(idp: FakeOidcProvider): string[] {
  const issued: string[] = [];
  idp.state.idToken = async () => {
    const token = await idp.sign(idp.standardClaims());
    issued.push(token);
    return token;
  };
  return issued;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("OIDC sign-in settlement", () => {
  it("creates an account bound to the issuer and subject and issues an oidc session", async () => {
    await withOidc(async (fixture) => {
      const email = fixture.email("new");
      const result = await fixture.signIn({ claims: { email, sub: fixture.value("subject") } });

      expect(result.status).toBe("active");
      const identity = await prisma.authIdentity.findFirstOrThrow({
        include: { user: true },
        where: { provider: "oidc", providerAccountId: fixture.value("subject") }
      });
      expect(identity).toMatchObject({ normalizedEmail: email, source: fixture.idp.issuer });
      expect(identity.user).toMatchObject({ displayName: "Person Example", email, status: "active" });
      expect(identity.emailVerifiedAt).toEqual(now);
      const session = await prisma.authSession.findUniqueOrThrow({
        where: { tokenHash: hashToken(sessionToken(result.status === "active" ? result.cookie : "")) }
      });
      expect(session).toMatchObject({ signInMethod: "oidc", userId: identity.userId });
    });
  });

  it("links an existing account only through a verified email or the explicit trust switch", async () => {
    await withOidc(async (fixture) => {
      const email = fixture.email("existing");
      const user = await prisma.user.create({ data: { displayName: "Existing", email, status: "active" } });

      await expect(fixture.signIn({ claims: { email, email_verified: false, sub: fixture.value("unverified") } }))
        .resolves.toEqual({ status: "account_conflict" });
      await expect(fixture.signIn({ claims: { email, email_verified: "true", sub: fixture.value("verified") } }))
        .resolves.toMatchObject({ status: "active" });
      await expect(prisma.authIdentity.findFirstOrThrow({ where: { providerAccountId: fixture.value("verified") } }))
        .resolves.toMatchObject({ userId: user.id });

      const other = fixture.email("trusted");
      const trustedUser = await prisma.user.create({ data: { displayName: "Trusted", email: other, status: "active" } });
      await expect(fixture.signIn({
        claims: { email: other, email_verified: undefined, sub: fixture.value("trusted") },
        config: { trustUnverifiedEmail: true }
      })).resolves.toMatchObject({ status: "active" });
      await expect(prisma.authIdentity.findFirstOrThrow({ where: { providerAccountId: fixture.value("trusted") } }))
        .resolves.toMatchObject({ userId: trustedUser.id });
    });
  });

  it("admits by allowed groups and refuses when the groups claim is missing", async () => {
    await withOidc(async (fixture) => {
      const config = { allowedGroups: [fixture.value("staff")], groupsFrom: "id_token" as const };

      await expect(fixture.signIn({ claims: { email: fixture.email("outsider"), groups: [fixture.value("guests")], sub: fixture.value("outsider") }, config }))
        .resolves.toEqual({ status: "not_allowed" });
      await expect(fixture.signIn({ claims: { email: fixture.email("missing"), groups: undefined, sub: fixture.value("missing") }, config }))
        .resolves.toEqual({ status: "not_allowed" });
      await expect(prisma.user.count({ where: { email: { endsWith: `@${fixture.domain}` } } })).resolves.toBe(0);

      await expect(fixture.signIn({ claims: { email: fixture.email("member"), groups: [fixture.value("staff")], sub: fixture.value("member") }, config }))
        .resolves.toMatchObject({ status: "active" });
    });
  });

  it("promotes admin-group members and demotes only the admins this issuer promoted", async () => {
    await withOidc(async (fixture) => {
      const admins = fixture.value("aiqsa-admins");
      const config = { adminGroups: [admins], groupsClaimPath: "realm_access.roles", groupsFrom: "id_token" as const };
      const email = fixture.email("promoted");
      // Another active admin, so a demotion never touches the last one.
      await prisma.user.create({ data: { displayName: "Other admin", email: fixture.email("other-admin"), role: "admin", status: "active" } });

      await fixture.signIn({ claims: { email, realm_access: { roles: [admins] }, sub: fixture.value("promoted") }, config });
      const promoted = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(promoted).toMatchObject({ role: "admin", roleManagedBy: externalRoleManager("oidc", fixture.idp.issuer) });

      // A missing claim changes nothing.
      await fixture.signIn({ claims: { email, realm_access: undefined, sub: fixture.value("promoted") }, config });
      await expect(prisma.user.findUniqueOrThrow({ where: { email } })).resolves.toMatchObject({ role: "admin" });

      await fixture.signIn({ claims: { email, realm_access: { roles: [] }, sub: fixture.value("promoted") }, config });
      await expect(prisma.user.findUniqueOrThrow({ where: { email } })).resolves.toMatchObject({ role: "user", roleManagedBy: null });

      const manual = fixture.email("manual");
      // A manual admin linked by a verified email keeps the role whatever the issuer lists.
      await prisma.user.create({ data: { displayName: "Manual admin", email: manual, role: "admin", status: "active" } });
      await fixture.signIn({ claims: { email: manual, realm_access: { roles: [] }, sub: fixture.value("manual") }, config });
      await expect(prisma.user.findUniqueOrThrow({ where: { email: manual } })).resolves.toMatchObject({ role: "admin" });
    });
  });

  it("syncs only groups named for OIDC, from userinfo when the id token has none", async () => {
    await withOidc(async (fixture) => {
      const named = await fixture.group("named", fixture.value("/team"));
      const formerlyNamed = await fixture.group("former", fixture.value("/old-team"));
      const unnamed = await fixture.group("unnamed");
      const email = fixture.email("synced");

      await fixture.signIn({ claims: { email, groups: [fixture.value("/old-team")], sub: fixture.value("synced") } });
      const userId = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
      await prisma.userGroup.create({ data: { groupId: unnamed, userId } });

      fixture.idp.state.userinfo = { groups: [fixture.value("/team")], sub: fixture.value("synced") };
      await fixture.signIn({ claims: { email, groups: undefined, sub: fixture.value("synced") } });

      const groups = await prisma.userGroup.findMany({ select: { groupId: true }, where: { userId } });
      expect(groups.map((group) => group.groupId).sort()).toEqual([named, unnamed].sort());
      expect(groups.map((group) => group.groupId)).not.toContain(formerlyNamed);
    });
  });

  it("refuses a known subject after the issuer changed until it is unlinked", async () => {
    await withOidc(async (fixture) => {
      const email = fixture.email("moved");
      const user = await prisma.user.create({ data: { displayName: "Moved", email, status: "active" } });
      await prisma.authIdentity.create({
        data: {
          emailVerifiedAt: now,
          normalizedEmail: email,
          provider: "oidc",
          providerAccountId: fixture.value("moved"),
          source: `${fixture.idp.issuer}-previous`,
          userId: user.id
        }
      });

      await expect(fixture.signIn({ claims: { email, sub: fixture.value("moved") } }))
        .resolves.toEqual({ status: "source_changed" });
      await expect(prisma.authSession.count({ where: { userId: user.id } })).resolves.toBe(0);
    });
  });

  it("refuses a sign-in without a usable email", async () => {
    await withOidc(async (fixture) => {
      fixture.idp.state.userinfo = { sub: fixture.value("no-email") };
      await expect(fixture.signIn({ claims: { email: undefined, email_verified: undefined, sub: fixture.value("no-email") } }))
        .resolves.toEqual({ status: "email_missing" });
    });
  });
});

describe("OIDC id token hint for IdP logout", () => {
  it("keeps the id token sealed to its session only while IdP logout is on and the token fits", async () => {
    await withOidc(async (fixture) => {
      const issued = captureIdTokens(fixture.idp);
      const claims = { email: fixture.email("hinted"), sub: fixture.value("hinted") };

      const kept = await signedInSession(await fixture.signIn({ claims, config: { idpLogout: true } }));
      const idToken = issued.at(-1)!;
      expect(kept.idTokenHintEnvelope).toBeTruthy();
      for (const part of idToken.split(".")) expect(kept.idTokenHintEnvelope).not.toContain(part);
      const config = fixture.oidcConfig({ idpLogout: true });
      expect(openOidcIdTokenHint({ config, hint: { envelope: kept.idTokenHintEnvelope!, sessionId: kept.id }, key })).toBe(idToken);

      const off = await signedInSession(await fixture.signIn({ claims, config: { idpLogout: false } }));
      expect(off.idTokenHintEnvelope).toBeNull();
      // A ciphertext copied to another session of the same user does not open there.
      expect(openOidcIdTokenHint({ config, hint: { envelope: kept.idTokenHintEnvelope!, sessionId: off.id }, key })).toBeNull();

      const oversized = await signedInSession(await fixture.signIn({
        claims: { ...claims, padding: "x".repeat(OIDC_ID_TOKEN_HINT_MAX_LENGTH) },
        config: { idpLogout: true }
      }));
      expect(issued.at(-1)!.length).toBeGreaterThan(OIDC_ID_TOKEN_HINT_MAX_LENGTH);
      expect(oversized.idTokenHintEnvelope).toBeNull();
    });
  });

  it("drops the hint whenever the session is revoked, by logout or by an administrator", async () => {
    await withOidc(async (fixture) => {
      const claims = { email: fixture.email("revoked"), sub: fixture.value("revoked") };
      const loggingOut = await fixture.signIn({ claims, config: { idpLogout: true } });
      const before = await signedInSession(loggingOut);
      const other = await signedInSession(await fixture.signIn({ claims, config: { idpLogout: true } }));
      expect(before.idTokenHintEnvelope).toBeTruthy();
      expect(other.idTokenHintEnvelope).toBeTruthy();
      const cookie = loggingOut.status === "active" ? loggingOut.cookie : "";
      const store = createPrismaAuthSessionStore(prisma);
      // Authenticating a request never reads the sealed token; logout asks for it.
      expect(await store.findSessionByTokenHash(hashToken(sessionToken(cookie)))).not.toHaveProperty("idTokenHintEnvelope");
      await expect(store.findSessionByTokenHash(hashToken(sessionToken(cookie)), { idTokenHint: true }))
        .resolves.toMatchObject({ idTokenHintEnvelope: before.idTokenHintEnvelope });

      // Logout hands the IdP step the hint it read before revoking, and the row keeps none.
      let handed: SealedIdTokenHint | null = null;
      const logout = createLogoutHandler({
        getConfig: () => ({ cookieSecure: true }),
        identityProviderLogout: async ({ idTokenHint }) => {
          handed = idTokenHint;
          return null;
        },
        sessions: store
      });
      const response = await logout(new Request("https://aiqsa.example/api/auth/logout", {
        body: "{}",
        headers: { "content-type": "application/json", cookie: cookie.split(";")[0]! },
        method: "POST"
      }));
      expect(response.status).toBe(204);
      expect(handed).toEqual({ envelope: before.idTokenHintEnvelope, sessionId: before.id });
      await expect(prisma.authSession.findUniqueOrThrow({ select: { idTokenHintEnvelope: true, revokedAt: true }, where: { id: before.id } }))
        .resolves.toEqual({ idTokenHintEnvelope: null, revokedAt: expect.any(Date) });

      // A hint written onto a revoked session is dropped as well.
      await prisma.authSession.update({ data: { idTokenHintEnvelope: other.idTokenHintEnvelope }, where: { id: before.id } });
      await expect(prisma.authSession.findUniqueOrThrow({ select: { idTokenHintEnvelope: true }, where: { id: before.id } }))
        .resolves.toEqual({ idTokenHintEnvelope: null });

      const admin = await prisma.user.create({ data: { displayName: "Admin", email: fixture.email("admin"), role: "admin", status: "active" } });
      await createAdminUserSessionCommands(prisma).revokeUserSessions({ revokedByUserId: admin.id, userId: other.userId });
      await expect(prisma.authSession.findUniqueOrThrow({ select: { idTokenHintEnvelope: true, revokedAt: true }, where: { id: other.id } }))
        .resolves.toEqual({ idTokenHintEnvelope: null, revokedAt: expect.any(Date) });
    });
  });

  it("never keeps a hint on a session another method signed in", async () => {
    await withOidc(async (fixture) => {
      const oidc = await signedInSession(await fixture.signIn({
        claims: { email: fixture.email("methods"), sub: fixture.value("methods") },
        config: { idpLogout: true }
      }));
      const bootstrap = await createAuthSession({
        secureCookie: true,
        sessions: createPrismaAuthSessionStore(prisma),
        signInMethod: "bootstrap",
        userId: oidc.userId
      });
      const row = await prisma.authSession.findUniqueOrThrow({ select: { idTokenHintEnvelope: true }, where: { id: bootstrap.sessionId } });
      expect(row.idTokenHintEnvelope).toBeNull();

      await expect(prisma.authSession.update({ data: { idTokenHintEnvelope: oidc.idTokenHintEnvelope }, where: { id: bootstrap.sessionId } }))
        .rejects.toThrow(/AuthSession_id_token_hint_check/u);
    });
  });
});

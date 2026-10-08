// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { oidcSignInConfigSchema, type AuthSignInMethodConfig } from "@/lib/contracts/authSignInMethods";
import { createFakeOidcProvider, type FakeOidcProvider } from "@/tests/support/fakeOidcProvider";
import { prisma } from "../../prisma";
import { completeExternalSignIn, externalRoleManager } from "../externalIdentity";
import { readCookie, SESSION_COOKIE_NAME } from "../session";
import { hashToken } from "../token";
import { createOidcClient } from "./oidcClient";
import { createOidcSignInFlow } from "./oidcSignIn";

const now = new Date("2026-10-08T12:00:00.000Z");

type Fixture = {
  domain: string;
  email(localPart: string): string;
  group(label: string, value?: string): Promise<string>;
  idp: FakeOidcProvider;
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
      async signIn(input) {
        idp.state.nonce = `nonce-${id}`;
        idp.state.idTokenClaims = input.claims;
        const flow = createOidcSignInFlow({
          client,
          config: oidcSignInConfigSchema.parse({ clientId: idp.clientId, issuer: idp.issuer, ...input.config }),
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

describe("OIDC sign-in settlement", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

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

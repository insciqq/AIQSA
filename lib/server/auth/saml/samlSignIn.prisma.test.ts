// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { samlSignInConfigSchema } from "@/lib/contracts/authSignInMethods";
import { samlServiceProvider } from "@/lib/contracts/samlSignIn";
import {
  createSamlTestIdp,
  encodeSamlTestResponse,
  samlAuthnRequestFromLocation,
  samlTestAssertion,
  samlTestResponse,
  signSamlTestAssertion
} from "@/tests/support/samlIdp";
import { prisma } from "../../prisma";
import { getAuthConfig } from "../config";
import { completeExternalSignIn, externalRoleManager } from "../externalIdentity";
import { createFixedWindowLoginRateLimiter } from "../rateLimit";
import { readCookie, SESSION_COOKIE_NAME } from "../session";
import type { ResolvedSignInMethod } from "../signInMethods";
import { hashToken } from "../token";
import { createSamlAcsHandler, createSamlStartHandler } from "./handlers";
import { createSamlReplayCache, createSamlRequestStore } from "./state";

// A loopback installation without proxy trust: its clients need no rate-limit identity.
const BASE_URL = "http://localhost:3000";
const config = getAuthConfig({
  AIQSA_APP_BASE_URL: BASE_URL,
  AIQSA_AUTH_SESSION_SECRET: "saml-prisma-test-secret"
});
const serviceProvider = samlServiceProvider(BASE_URL, null);
const idp = createSamlTestIdp({ entityId: `https://idp-${randomUUID()}.example.test/realms/aiqsa` });

type SamlFixture = {
  domain: string;
  email(localPart: string): string;
  group(label: string, externalName: string): Promise<string>;
  /** Signs in through the start route and the ACS, as a browser and the IdP would; the NameID is `value(subject)`. */
  signIn(input: { attributes: Record<string, string | string[]>; entityId?: string; subject: string }): Promise<Response>;
  /** A name unique to this run. */
  value(name: string): string;
};

function samlMethod(entityId: string, overrides: Record<string, unknown>): ResolvedSignInMethod<"saml"> {
  return {
    activeVersion: 1,
    config: samlSignInConfigSchema.parse({
      displayNameAttribute: "displayName",
      groupsAttribute: "groups",
      idpCertificates: [idp.certificate],
      idpEntityId: entityId,
      idpSsoUrl: "https://idp.example.test/realms/aiqsa/protocol/saml",
      ...overrides
    }),
    method: "saml",
    secrets: {},
    source: "admin"
  };
}

async function withSamlData<T>(overrides: Record<string, unknown>, run: (fixture: SamlFixture) => Promise<T>): Promise<T> {
  const id = randomUUID();
  const domain = `saml-${id}.example.com`;
  const groupIds: string[] = [];
  const requests = createSamlRequestStore();
  const replayCache = createSamlReplayCache();

  try {
    return await run({
      domain,
      email: (localPart) => `${localPart}@${domain}`,
      async group(label, externalName) {
        const group = await prisma.group.create({
          data: { externalNames: { create: [{ source: "saml", value: externalName }] }, name: `${label}-${id}` }
        });
        groupIds.push(group.id);
        return group.id;
      },
      async signIn(input) {
        const method = samlMethod(input.entityId ?? idp.entityId, overrides);
        const handlers = {
          acs: createSamlAcsHandler({
            completeSignIn: (signIn) => completeExternalSignIn(prisma, signIn),
            getConfig: () => config,
            loginRateLimiter: createFixedWindowLoginRateLimiter(),
            recordOutcome: async () => undefined,
            replayCache,
            requests,
            resolveMethod: async () => method
          }),
          start: createSamlStartHandler({
            getConfig: () => config,
            rateLimiter: createFixedWindowLoginRateLimiter(),
            requests,
            resolveMethod: async () => method
          })
        };
        const started = await handlers.start(new Request(`${BASE_URL}/api/auth/saml/start?next=%2Fc%2Fsaml-chat`));
        const location = new URL(started.headers.get("location")!);
        const requestId = samlAuthnRequestFromLocation(location).id;
        const assertion = signSamlTestAssertion(samlTestAssertion({
          acsUrl: serviceProvider.acsUrl,
          attributes: input.attributes,
          audience: serviceProvider.entityId,
          inResponseTo: requestId,
          issuer: method.config.idpEntityId,
          nameId: `${input.subject}-${id}`
        }), { idp });
        const body = new URLSearchParams({
          RelayState: location.searchParams.get("RelayState")!,
          SAMLResponse: encodeSamlTestResponse(samlTestResponse({
            assertions: [assertion],
            destination: serviceProvider.acsUrl,
            inResponseTo: requestId,
            issuer: method.config.idpEntityId
          }))
        });
        return handlers.acs(new Request(`${BASE_URL}/saml/acs`, {
          body: body.toString(),
          headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://idp.example.test" },
          method: "POST"
        }));
      },
      value: (name) => `${name}-${id}`
    });
  } finally {
    // Accounts created from an unverified SAML email have no email; their identity still names it.
    await prisma.user.deleteMany({ where: { authIdentities: { some: { normalizedEmail: { endsWith: `@${domain}` } } } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
    await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
  }
}

function outcome(response: Response): string | null {
  return new URL(response.headers.get("location")!).searchParams.get("saml");
}

async function identityOf(subject: string) {
  return prisma.authIdentity.findUniqueOrThrow({
    include: { user: { include: { groups: true } } },
    where: { provider_providerAccountId: { provider: "saml", providerAccountId: subject } }
  });
}

describe("SAML sign-in settlement", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates the account, syncs mapped groups, grants the admin role and issues a SAML session", async () => {
    await withSamlData({ adminGroups: ["saml-admins"], syncGroups: true }, async (fixture) => {
      const staffGroup = await fixture.group("staff", fixture.value("staff"));
      const otherGroup = await fixture.group("other", fixture.value("other"));
      const email = fixture.email("ada");

      const response = await fixture.signIn({
        attributes: { displayName: "Ada Synthetic", email, groups: [fixture.value("staff"), "saml-admins"] },
        subject: "ada"
      });

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`${BASE_URL}/c/saml-chat`);
      const token = readCookie(response.headers.get("set-cookie"), SESSION_COOKIE_NAME)!;
      const identity = await identityOf(fixture.value("ada"));
      expect(identity).toMatchObject({ normalizedEmail: email, provider: "saml", source: idp.entityId });
      // An unverified email never becomes the account's address unless the method trusts it.
      expect(identity.user).toMatchObject({
        displayName: "Ada Synthetic",
        email: null,
        role: "admin",
        roleManagedBy: externalRoleManager("saml", idp.entityId),
        status: "active"
      });
      expect(identity.user.groups.map((membership) => membership.groupId)).toEqual([staffGroup]);
      expect(identity.user.groups.map((membership) => membership.groupId)).not.toContain(otherGroup);
      await expect(prisma.authSession.findUniqueOrThrow({ select: { signInMethod: true, userId: true }, where: { tokenHash: hashToken(token) } }))
        .resolves.toEqual({ signInMethod: "saml", userId: identity.userId });
    });
  });

  it("finds the account again by its subject and leaves managed memberships alone when groups are missing", async () => {
    await withSamlData({ syncGroups: true }, async (fixture) => {
      const staffGroup = await fixture.group("staff", fixture.value("staff"));
      const email = fixture.email("grace");
      await fixture.signIn({ attributes: { email, groups: [fixture.value("staff")] }, subject: "grace" });
      const first = await prisma.authIdentity.findFirstOrThrow({ where: { normalizedEmail: email, provider: "saml" } });

      const again = await fixture.signIn({ attributes: { email: fixture.email("grace-renamed") }, subject: "grace" });

      expect(outcome(again)).toBeNull();
      const identity = await prisma.authIdentity.findUniqueOrThrow({
        include: { user: { include: { groups: true } } },
        where: { id: first.id }
      });
      expect(identity.user.groups.map((membership) => membership.groupId)).toEqual([staffGroup]);
      expect(identity.lastSyncWarning).toBe("groups_claim_missing");
      await expect(prisma.authIdentity.count({ where: { userId: identity.userId } })).resolves.toBe(1);
    });
  });

  it("links an existing account by email only when the method trusts the IdP's email", async () => {
    for (const trustUnverifiedEmail of [false, true]) {
      await withSamlData({ trustUnverifiedEmail }, async (fixture) => {
        const email = fixture.email("owner");
        const owner = await prisma.user.create({
          data: { displayName: "Existing Owner", email, role: "user", status: "active" }
        });

        const response = await fixture.signIn({ attributes: { email }, subject: "owner" });

        if (trustUnverifiedEmail) {
          expect(response.headers.get("location")).toBe(`${BASE_URL}/c/saml-chat`);
          await expect(prisma.authIdentity.count({ where: { provider: "saml", userId: owner.id } })).resolves.toBe(1);
        } else {
          expect(outcome(response)).toBe("account_conflict");
          expect(response.headers.get("set-cookie")).toBeNull();
          await expect(prisma.authIdentity.count({ where: { provider: "saml", userId: owner.id } })).resolves.toBe(0);
        }
      });
    }
  });

  it("refuses a known subject that signs in from another IdP entity as source_changed", async () => {
    await withSamlData({}, async (fixture) => {
      const email = fixture.email("moved");
      await fixture.signIn({ attributes: { email }, subject: "moved" });

      const moved = await fixture.signIn({ attributes: { email }, entityId: `${idp.entityId}/renamed`, subject: "moved" });

      expect(outcome(moved)).toBe("source_changed");
      await expect(prisma.authIdentity.findFirstOrThrow({ select: { source: true }, where: { normalizedEmail: email } }))
        .resolves.toEqual({ source: idp.entityId });
    });
  });
});

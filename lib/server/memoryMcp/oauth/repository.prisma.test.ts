import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  createInboundMcpTestClient,
  INBOUND_MCP_TEST_AUTHORITIES,
  liveInboundMcpFamilyCount,
  type InboundMcpTestClient
} from "@/tests/support/inboundMcpOAuth";
import { hashToken } from "../../auth/token";
import { prisma } from "../../prisma";
import { createPrismaRetentionRepository } from "../../retention/prune";
import {
  assertInboundMcpSkillsAuthority,
  createPrismaInboundMcpOAuthRepository,
  revokeInboundMcpGrantsForUser
} from "./repository";

const ISSUER = "https://aiqsa.example";
const RESOURCE = "https://aiqsa.example/mcp";
const REDIRECT_URI = "http://127.0.0.1:43119/callback";
const CHALLENGE = "A".repeat(43);

function time(value: string): Date {
  return new Date(value);
}

async function withFixture<T>(run: (input: Readonly<{
  clientId: string;
  repository: ReturnType<typeof createPrismaInboundMcpOAuthRepository>;
  userId: string;
}>) => Promise<T>): Promise<T> {
  const suffix = randomUUID();
  const clientId = `aiqsa_dcr_${suffix}`;
  const user = await prisma.user.create({
    data: {
      displayName: "Inbound MCP owner",
      email: `inbound-mcp-${suffix}@example.test`,
      status: "active"
    }
  });
  const repository = createPrismaInboundMcpOAuthRepository(prisma);
  await repository.createDynamicClient({
    applicationType: "NATIVE",
    clientId,
    clientName: "Repository test client",
    clientOrigin: "http://127.0.0.1:43119",
    clientUri: null,
    kind: "DYNAMIC_REGISTRATION",
    metadataExpiresAt: null,
    metadataFingerprint: hashToken(clientId),
    now: time("2026-09-03T01:00:00.000Z"),
    redirectUris: [REDIRECT_URI]
  });
  try {
    return await run({ clientId, repository, userId: user.id });
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.inboundMcpOAuthClient.deleteMany({ where: { clientId } });
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

/** Proves an interleaving: resolves once another backend of this database waits on a lock. */
async function waitForLockWaiter(): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS "waiting"
      FROM pg_stat_activity
      WHERE "datname" = current_database() AND "wait_event_type" = 'Lock'
    `;
    if ((row?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("expected_lock_waiter");
}

/**
 * A synthetic owner and test client whose repository can pause one transaction right before its
 * grant `lastUsedAt` write, after it already holds its token, family or code row locks.
 */
async function withRevocationRace<T>(run: (input: Readonly<{
  armPause(): Readonly<{ held: Promise<void>; release(): void }>;
  mcp: InboundMcpTestClient;
  userId: string;
}>) => Promise<T>): Promise<T> {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: {
      displayName: "Inbound MCP revocation race owner",
      email: `inbound-mcp-race-${suffix}@example.test`,
      status: "active"
    }
  });
  let pause: Readonly<{ held: () => void; released: Promise<void> }> | null = null;
  // Refresh issues its family and grant writes together; the pause signals only after the family
  // write has settled so the paused transaction really holds that row lock.
  let familyWrite: Promise<void> = Promise.resolve();
  const pausingClient = prisma.$extends({
    query: {
      inboundMcpOAuthGrant: {
        async update({ args, query }) {
          const current = pause;
          pause = null;
          if (current) {
            await familyWrite;
            current.held();
            await current.released;
          }
          return query(args);
        }
      },
      inboundMcpOAuthTokenFamily: {
        async update({ args, query }) {
          const settled = deferred();
          familyWrite = settled.promise;
          try {
            return await query(args);
          } finally {
            settled.resolve();
          }
        }
      }
    }
  });
  const mcp = await createInboundMcpTestClient(
    pausingClient as unknown as PrismaClient,
    time("2026-09-03T01:00:00.000Z")
  );
  try {
    return await run({
      armPause() {
        const held = deferred();
        const released = deferred();
        pause = { held: held.resolve, released: released.promise };
        return { held: held.promise, release: released.resolve };
      },
      mcp,
      userId: user.id
    });
  } finally {
    await prisma.user.deleteMany({ where: { id: user.id } });
    await mcp.cleanup();
  }
}

describe("Prisma inbound Memory MCP OAuth repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("isolates Skills scopes across issuance, narrowing refresh, reconsent and revocation", async () => {
    await withFixture(async ({ clientId, repository, userId }) => {
      const client = (await repository.findClient(clientId))!;
      const now = new Date();
      const authority = { resource: `${RESOURCE}/skills`, capability: "skills:store" as const };
      async function issue(scopes: readonly string[]) {
        const pair = { ...authority, clientId, codeHash: hashToken(randomUUID()), codeChallenge: CHALLENGE,
          redirectUri: REDIRECT_URI, issuer: ISSUER, now,
          accessExpiresAt: new Date(now.getTime() + 3_600_000), accessTokenHash: hashToken(randomUUID()),
          refreshExpiresAt: new Date(now.getTime() + 86_400_000), refreshTokenHash: hashToken(randomUUID()) };
        expect(await repository.approveAuthorization({ ...pair, scopes, clientRecordId: client.id,
          expiresAt: new Date(now.getTime() + 300_000), userId })).toBe(true);
        expect(await repository.exchangeAuthorizationCode(pair)).toEqual({ scopes });
        return pair;
      }
      async function resolve(pair: Awaited<ReturnType<typeof issue>>) {
        return repository.resolveAccessToken({ ...pair, tokenHash: pair.accessTokenHash });
      }
      const read = await issue(["skills:read"]);
      const readAuth = (await resolve(read))!;
      expect(readAuth.scopes).toEqual(["skills:read"]);
      expect(await prisma.$transaction((tx) => assertInboundMcpSkillsAuthority(tx, readAuth, "read"))).toBe(true);
      expect(await prisma.$transaction((tx) => assertInboundMcpSkillsAuthority(tx, readAuth, "write"))).toBe(false);
      expect(await repository.resolveAccessToken({ ...read, resource: RESOURCE, capability: "memory:facts", tokenHash: read.accessTokenHash })).toBeNull();
      expect(await repository.resolveAccessToken({ ...read, resource: `${RESOURCE}/hub`, capability: "mcp:hub", tokenHash: read.accessTokenHash })).toBeNull();
      const rotation = { ...read, presentedRefreshTokenHash: read.refreshTokenHash,
        nextRefreshTokenHash: hashToken(randomUUID()), accessTokenHash: hashToken(randomUUID()) };
      expect(await repository.rotateRefreshToken({ ...rotation, requestedScopes: ["skills:read", "skills:write"] })).toBe("invalid");
      expect(await repository.rotateRefreshToken(rotation)).toEqual({ scopes: ["skills:read"] });

      const write = await issue(["skills:read", "skills:write"]);
      expect(await resolve(read)).toBeNull();
      expect(await prisma.$transaction((tx) => assertInboundMcpSkillsAuthority(tx, readAuth, "read"))).toBe(false);
      const writeAuth = (await resolve(write))!;
      expect(await prisma.$transaction((tx) => assertInboundMcpSkillsAuthority(tx, writeAuth, "write"))).toBe(true);
      const narrowed = { ...write, presentedRefreshTokenHash: write.refreshTokenHash,
        nextRefreshTokenHash: hashToken(randomUUID()), accessTokenHash: hashToken(randomUUID()), requestedScopes: ["skills:read"] };
      expect(await repository.rotateRefreshToken(narrowed)).toEqual({ scopes: ["skills:read"] });
      const narrowedAuth = (await resolve({ ...write, accessTokenHash: narrowed.accessTokenHash }))!;
      expect(narrowedAuth.scopes).toEqual(["skills:read"]);
      expect(await repository.rotateRefreshToken({ ...narrowed,
        presentedRefreshTokenHash: narrowed.nextRefreshTokenHash, nextRefreshTokenHash: hashToken(randomUUID()),
        accessTokenHash: hashToken(randomUUID()), requestedScopes: ["skills:read", "skills:write"] })).toBe("invalid");
      // Immutable snapshots cannot be upgraded by changing a granted scope later.
      await expect(prisma.inboundMcpOAuthToken.update({ where: { id: narrowedAuth.tokenId }, data: { scopes: ["skills:read", "skills:write"] } })).rejects.toThrow();
      await expect(prisma.inboundMcpOAuthGrant.update({ where: { id: writeAuth.grantId }, data: { scopes: ["skills:read"] } })).rejects.toThrow();
      await expect(prisma.inboundMcpOAuthTokenFamily.update({ where: { id: writeAuth.familyId }, data: { scopes: ["skills:read"] } })).rejects.toThrow();
      const readAgain = await issue(["skills:read"]);
      expect(await resolve(write)).toBeNull();
      expect(await prisma.$transaction((tx) => assertInboundMcpSkillsAuthority(tx, writeAuth, "write"))).toBe(false);
      const readAgainAuth = (await resolve(readAgain))!;
      expect(await repository.revokeGrant({ grantId: readAgainAuth.grantId, now, userId })).toBe(true);
      expect(await resolve(readAgain)).toBeNull();
      expect(await prisma.$transaction((tx) => assertInboundMcpSkillsAuthority(tx, readAgainAuth, "read"))).toBe(false);
    });
  });

  it("holds Skills mutation authority until commit and rejects it after owner or grant revocation", async () => {
    await withFixture(async ({ clientId, repository, userId }) => {
      const client = (await repository.findClient(clientId))!;
      const now = new Date();
      const pair = { resource: `${RESOURCE}/skills`, capability: "skills:store" as const,
        clientId, codeHash: hashToken(randomUUID()), codeChallenge: CHALLENGE,
        redirectUri: REDIRECT_URI, issuer: ISSUER, now,
        accessExpiresAt: new Date(now.getTime() + 3_600_000), accessTokenHash: hashToken(randomUUID()),
        refreshExpiresAt: new Date(now.getTime() + 86_400_000), refreshTokenHash: hashToken(randomUUID()) };
      expect(await repository.approveAuthorization({ ...pair, scopes: ["skills:read", "skills:write"], clientRecordId: client.id,
        expiresAt: new Date(now.getTime() + 300_000), userId })).toBe(true);
      expect(await repository.exchangeAuthorizationCode(pair)).toEqual({ scopes: ["skills:read", "skills:write"] });
      const auth = (await repository.resolveAccessToken({ ...pair, tokenHash: pair.accessTokenHash }))!;
      await prisma.user.update({ where: { id: userId }, data: { status: "disabled" } });
      expect(await prisma.$transaction((tx) => assertInboundMcpSkillsAuthority(tx, auth, "write"))).toBe(false);
      await prisma.user.update({ where: { id: userId }, data: { status: "active" } });
      const held = deferred();
      const released = deferred();
      const guarded = prisma.$transaction(async (tx) => {
        expect(await assertInboundMcpSkillsAuthority(tx, auth, "write")).toBe(true);
        held.resolve();
        await released.promise;
      });
      await held.promise;
      const revoking = repository.revokeGrant({ grantId: auth.grantId, now, userId });
      try {
        await waitForLockWaiter();
      } finally {
        released.resolve();
      }
      await guarded;
      expect(await revoking).toBe(true);
      expect(await prisma.$transaction((tx) => assertInboundMcpSkillsAuthority(tx, auth, "write"))).toBe(false);
    });
  });

  it.each([false, true])("isolates both grant orders, reconsent, refresh and revocation (Hub first: %s)", async (hubFirst) => {
    await withFixture(async ({ clientId, repository, userId }) => {
      const client = (await repository.findClient(clientId))!;
      const now = time("2026-09-03T01:00:00.000Z");
      const memory = { resource: RESOURCE, capability: "memory:facts" as const };
      const hub = { resource: `${RESOURCE}/hub`, capability: "mcp:hub" as const };
      async function issue(authority: typeof memory | typeof hub) {
        const codeHash = hashToken(randomUUID());
        expect(await repository.approveAuthorization({ ...authority,
          clientRecordId: client.id, codeChallenge: CHALLENGE, codeHash,
          expiresAt: time("2026-09-03T01:05:00.000Z"), issuer: ISSUER,
          now, redirectUri: REDIRECT_URI, userId
        })).toBe(true);
        const exchange = { ...authority, codeHash, clientId, codeChallenge: CHALLENGE,
          redirectUri: REDIRECT_URI, issuer: ISSUER, now,
          accessExpiresAt: time("2026-09-03T02:00:00.000Z"), accessTokenHash: hashToken(randomUUID()),
          refreshExpiresAt: time("2026-10-03T01:00:00.000Z"), refreshTokenHash: hashToken(randomUUID()) };
        // Substituting the audience must neither consume nor broaden the code.
        expect(await repository.exchangeAuthorizationCode({ ...exchange,
          ...(authority === memory ? hub : memory) })).toBe(false);
        expect(await repository.exchangeAuthorizationCode(exchange)).toEqual({ scopes: [] });
        return exchange;
      }
      async function resolve(pair: Awaited<ReturnType<typeof issue>>, authority = pair) {
        return repository.resolveAccessToken({ ...authority, issuer: ISSUER, now, tokenHash: pair.accessTokenHash });
      }
      async function refresh(pair: Awaited<ReturnType<typeof issue>>) {
        const rotation = { ...pair, nextRefreshTokenHash: hashToken(randomUUID()),
          presentedRefreshTokenHash: pair.refreshTokenHash, accessTokenHash: hashToken(randomUUID()) };
        expect(await repository.rotateRefreshToken({ ...rotation,
          ...(pair.capability === "mcp:hub" ? memory : hub) })).toBe("invalid");
        expect(await repository.rotateRefreshToken(rotation)).toEqual({ scopes: [] });
        return { ...pair, accessTokenHash: rotation.accessTokenHash, refreshTokenHash: rotation.nextRefreshTokenHash };
      }
      const first = hubFirst ? hub : memory;
      const second = hubFirst ? memory : hub;
      const initialFirst = await issue(first);
      let secondPair = await issue(second);
      expect(await resolve(initialFirst)).toMatchObject({ userId, clientId, ...first });
      expect(await resolve(secondPair)).toMatchObject({ userId, clientId, ...second });
      expect(await resolve(initialFirst, secondPair)).toBeNull();
      expect(await resolve(secondPair, initialFirst)).toBeNull();
      let firstPair = await issue(first);
      expect(await resolve(initialFirst)).toBeNull();
      secondPair = await refresh(secondPair);
      const oldSecond = secondPair;
      secondPair = await issue(second);
      expect(await resolve(oldSecond)).toBeNull();
      firstPair = await refresh(firstPair);
      const firstGrant = (await resolve(firstPair))!;
      expect(await repository.revokeGrant({ grantId: firstGrant.grantId, now, userId })).toBe(true);
      expect(await resolve(firstPair)).toBeNull();
      secondPair = await refresh(secondPair);
      firstPair = await issue(first);
      const secondGrant = (await resolve(secondPair))!;
      expect(await repository.revokeGrant({ grantId: secondGrant.grantId, now, userId })).toBe(true);
      expect(await resolve(secondPair)).toBeNull();
      expect(await resolve(firstPair)).not.toBeNull();
      await prisma.user.update({ where: { id: userId }, data: { status: "disabled" } });
      expect(await resolve(firstPair)).toBeNull();
      expect(await repository.rotateRefreshToken({ ...firstPair,
        presentedRefreshTokenHash: firstPair.refreshTokenHash,
        nextRefreshTokenHash: hashToken(randomUUID()) })).toBe("invalid");
      await prisma.user.delete({ where: { id: userId } });
      expect(await resolve(firstPair)).toBeNull();
    });
  });

  it("keeps previous-writer material Memory-only and rejects mutable or inconsistent snapshots", async () => {
    await withFixture(async ({ clientId, repository, userId }) => {
      const client = (await repository.findClient(clientId))!;
      const now = time("2026-09-03T01:00:00.000Z");
      // No new fields: this is the previous release's grant/family/token writer shape.
      const grant = await prisma.inboundMcpOAuthGrant.create({
        data: { userId, oauthClientId: client.id, createdAt: now, connectedAt: now }
      });
      const legacyCode = await prisma.inboundMcpOAuthAuthorizationCode.create({ data: {
        grantId: grant.id, oauthClientId: client.id, grantRevision: grant.revision,
        codeHash: hashToken(randomUUID()), codeChallenge: CHALLENGE,
        issuer: ISSUER, resource: RESOURCE, redirectUri: REDIRECT_URI,
        createdAt: now, expiresAt: time("2026-09-03T01:05:00.000Z")
      } });
      expect(await repository.approveAuthorization({
        capability: "mcp:hub", resource: `${RESOURCE}/hub`, clientRecordId: client.id,
        codeChallenge: CHALLENGE, codeHash: hashToken(randomUUID()),
        expiresAt: legacyCode.expiresAt, issuer: ISSUER, now, redirectUri: REDIRECT_URI, userId
      })).toBe(true);
      const exchange = { clientId, codeHash: legacyCode.codeHash, codeChallenge: CHALLENGE,
        issuer: ISSUER, resource: RESOURCE, redirectUri: REDIRECT_URI, now,
        accessTokenHash: hashToken(randomUUID()), refreshTokenHash: hashToken(randomUUID()),
        accessExpiresAt: time("2026-09-03T02:00:00.000Z"), refreshExpiresAt: time("2026-10-03T01:00:00.000Z") };
      expect(await repository.exchangeAuthorizationCode({ ...exchange,
        resource: `${RESOURCE}/hub`, capability: "mcp:hub" })).toBe(false);
      expect(await repository.exchangeAuthorizationCode(exchange)).toEqual({ scopes: [] });
      await expect(prisma.inboundMcpOAuthAuthorizationCode.update({
        where: { id: legacyCode.id }, data: { resourcePath: "/mcp/hub", capability: "mcp:hub" }
      })).rejects.toThrow();
      const family = await prisma.inboundMcpOAuthTokenFamily.create({ data: {
        createdAt: now,
        grantId: grant.id, grantRevision: grant.revision, issuer: ISSUER, resource: RESOURCE,
        inactivityExpiresAt: time("2026-10-03T01:00:00.000Z")
      } });
      const tokenHash = hashToken(randomUUID());
      const token = await prisma.inboundMcpOAuthToken.create({ data: {
        createdAt: now, familyId: family.id, kind: "ACCESS", tokenHash, expiresAt: time("2026-09-03T02:00:00.000Z")
      } });
      const query = { issuer: ISSUER, resource: RESOURCE, now, tokenHash };
      expect(await repository.resolveAccessToken(query)).toMatchObject({ capability: "memory:facts", userId });
      expect(await repository.resolveAccessToken({ ...query, resource: `${RESOURCE}/hub`, capability: "mcp:hub" })).toBeNull();
      for (const table of ["InboundMcpOAuthGrant", "InboundMcpOAuthTokenFamily", "InboundMcpOAuthToken"]) {
        const id = table === "InboundMcpOAuthGrant" ? grant.id : table === "InboundMcpOAuthTokenFamily" ? family.id : token.id;
        await expect(prisma.$executeRawUnsafe(
          `UPDATE "${table}" SET "resourcePath"='/mcp/hub', "capability"='mcp:hub' WHERE "id"=$1`, id
        )).rejects.toThrow();
      }
      await expect(prisma.inboundMcpOAuthToken.create({ data: {
        familyId: family.id, kind: "ACCESS", tokenHash: hashToken(randomUUID()),
        resourcePath: "/mcp/hub", capability: "mcp:hub", expiresAt: token.expiresAt
      } })).rejects.toThrow();
      const refreshTokenHash = hashToken(randomUUID());
      await prisma.inboundMcpOAuthToken.create({ data: {
        createdAt: now, familyId: family.id, kind: "REFRESH", tokenHash: refreshTokenHash, expiresAt: family.inactivityExpiresAt
      } });
      const rotation = { issuer: ISSUER, resource: RESOURCE, clientId, now,
        presentedRefreshTokenHash: refreshTokenHash, nextRefreshTokenHash: hashToken(randomUUID()),
        accessTokenHash: hashToken(randomUUID()), accessExpiresAt: token.expiresAt,
        refreshExpiresAt: family.inactivityExpiresAt };
      expect(await repository.rotateRefreshToken(rotation)).toEqual({ scopes: [] });
      // Wrong resource replay must not revoke a valid Memory family.
      expect(await repository.rotateRefreshToken({ ...rotation, resource: `${RESOURCE}/hub`, capability: "mcp:hub" })).toBe("invalid");
      expect(await repository.resolveAccessToken(query)).not.toBeNull();
      expect(await repository.rotateRefreshToken(rotation)).toBe("reused");
      expect(await repository.resolveAccessToken(query)).toBeNull();
    });
  });

  it("consumes one code, rotates refresh tokens, and revokes on reuse", async () => {
    await withFixture(async ({ clientId, repository, userId }) => {
      const approvedAt = time("2026-09-03T01:00:00.000Z");
      const client = await repository.findClient(clientId);
      expect(client).not.toBeNull();
      const code = `code-${randomUUID()}`;
      await expect(repository.approveAuthorization({
        clientRecordId: client!.id,
        codeChallenge: CHALLENGE,
        codeHash: hashToken(code),
        expiresAt: time("2026-09-03T01:05:00.000Z"),
        issuer: ISSUER,
        now: approvedAt,
        redirectUri: REDIRECT_URI,
        resource: RESOURCE,
        userId
      })).resolves.toBe(true);

      const access1 = `access-${randomUUID()}`;
      const refresh1 = `refresh-${randomUUID()}`;
      const exchange = {
        accessExpiresAt: time("2026-09-03T02:01:00.000Z"),
        accessTokenHash: hashToken(access1),
        clientId,
        codeChallenge: CHALLENGE,
        codeHash: hashToken(code),
        issuer: ISSUER,
        now: time("2026-09-03T01:01:00.000Z"),
        redirectUri: REDIRECT_URI,
        refreshExpiresAt: time("2026-10-03T01:01:00.000Z"),
        refreshTokenHash: hashToken(refresh1),
        resource: RESOURCE
      };
      await expect(repository.exchangeAuthorizationCode(exchange)).resolves.toEqual({ scopes: [] });
      await expect(repository.exchangeAuthorizationCode(exchange)).resolves.toBe(false);
      await expect(repository.resolveAccessToken({
        issuer: ISSUER,
        now: time("2026-09-03T01:02:00.000Z"),
        resource: RESOURCE,
        tokenHash: hashToken(access1)
      })).resolves.toMatchObject({ clientId, userId });

      const access2 = `access-${randomUUID()}`;
      const refresh2 = `refresh-${randomUUID()}`;
      const rotation = {
        accessExpiresAt: time("2026-09-03T02:03:00.000Z"),
        accessTokenHash: hashToken(access2),
        clientId,
        issuer: ISSUER,
        nextRefreshTokenHash: hashToken(refresh2),
        now: time("2026-09-03T01:03:00.000Z"),
        presentedRefreshTokenHash: hashToken(refresh1),
        refreshExpiresAt: time("2026-10-03T01:03:00.000Z"),
        resource: RESOURCE
      };
      await expect(repository.rotateRefreshToken(rotation)).resolves.toEqual({ scopes: [] });
      await expect(repository.resolveAccessToken({
        issuer: ISSUER,
        now: time("2026-09-03T01:04:00.000Z"),
        resource: RESOURCE,
        tokenHash: hashToken(access2)
      })).resolves.toMatchObject({ clientId, userId });

      await expect(repository.rotateRefreshToken({
        ...rotation,
        accessTokenHash: hashToken(`unused-${randomUUID()}`),
        nextRefreshTokenHash: hashToken(`unused-${randomUUID()}`),
        now: time("2026-09-03T01:05:00.000Z")
      })).resolves.toBe("reused");
      await expect(repository.resolveAccessToken({
        issuer: ISSUER,
        now: time("2026-09-03T01:06:00.000Z"),
        resource: RESOURCE,
        tokenHash: hashToken(access2)
      })).resolves.toBeNull();
      await expect(prisma.inboundMcpOAuthToken.findMany({
        select: { tokenHash: true },
        where: { family: { grant: { userId } } }
      })).resolves.not.toContainEqual({ tokenHash: access1 });
    });
  });

  it("keeps grant revoke owner-bound and cascades OAuth state on account deletion", async () => {
    await withFixture(async ({ clientId, repository, userId }) => {
      const client = await repository.findClient(clientId);
      const code = `code-${randomUUID()}`;
      await repository.approveAuthorization({
        clientRecordId: client!.id,
        codeChallenge: CHALLENGE,
        codeHash: hashToken(code),
        expiresAt: time("2026-09-03T01:05:00.000Z"),
        issuer: ISSUER,
        now: time("2026-09-03T01:00:00.000Z"),
        redirectUri: REDIRECT_URI,
        resource: RESOURCE,
        userId
      });
      const grant = (await repository.listConnectedApps(userId))[0]!;
      await expect(repository.revokeGrant({
        grantId: grant.grantId,
        now: time("2026-09-03T01:01:00.000Z"),
        userId: randomUUID()
      })).resolves.toBe(false);
      await expect(repository.listConnectedApps(userId)).resolves.toMatchObject([
        { state: "ACTIVE" }
      ]);
      await expect(repository.revokeGrant({
        grantId: grant.grantId,
        now: time("2026-09-03T01:02:00.000Z"),
        userId
      })).resolves.toBe(true);
      await expect(repository.listConnectedApps(userId)).resolves.toMatchObject([
        { state: "REVOKED" }
      ]);

      await prisma.user.delete({ where: { id: userId } });
      await expect(prisma.inboundMcpOAuthGrant.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.inboundMcpOAuthClient.count({ where: { clientId } }))
        .resolves.toBe(1);
    });
  });

  it("fences a refresh that read the grant before an account revocation committed", async () => {
    await withRevocationRace(async ({ mcp, userId }) => {
      const connection = await mcp.connect(userId, INBOUND_MCP_TEST_AUTHORITIES.memory);
      const revocationHeld = deferred();
      const releaseRevocation = deferred();
      const revocation = prisma.$transaction(async (tx) => {
        const revoked = await revokeInboundMcpGrantsForUser(tx, {
          now: mcp.now,
          reason: "password_reset",
          userId
        });
        revocationHeld.resolve();
        await releaseRevocation.promise;
        return revoked;
      }, { timeout: 15_000 });
      await revocationHeld.promise;

      // The refresh sees the committed ACTIVE grant, rotates, then waits on the family row lock.
      const refresh = mcp.refresh(connection);
      await waitForLockWaiter();
      releaseRevocation.resolve();
      await expect(revocation).resolves.toBe(1);
      const refreshed = await refresh;

      expect(refreshed.outcome).toBe("rotated");
      await expect(mcp.access(refreshed.next!)).resolves.toBe(false);
      await expect(mcp.refresh(refreshed.next!)).resolves.toMatchObject({ outcome: "invalid" });
      await expect(liveInboundMcpFamilyCount(prisma, userId)).resolves.toBe(0);
    });
  });

  it("makes an account revocation wait for an in-flight refresh without deadlock", async () => {
    await withRevocationRace(async ({ armPause, mcp, userId }) => {
      const connection = await mcp.connect(userId, INBOUND_MCP_TEST_AUTHORITIES.hub);
      const pause = armPause();
      const refresh = mcp.refresh(connection);
      await pause.held;

      // The refresh holds its family row; the revocation must queue behind it, not take the
      // grant first and deadlock with the refresh's pending grant write.
      const revocation = prisma.$transaction((tx) => revokeInboundMcpGrantsForUser(tx, {
        now: mcp.now,
        reason: "admin_revoke_user",
        userId
      }));
      await waitForLockWaiter();
      pause.release();
      const [refreshed, revoked] = await Promise.all([refresh, revocation]);

      expect(revoked).toBe(1);
      expect(refreshed.outcome).toBe("rotated");
      await expect(mcp.access(refreshed.next!)).resolves.toBe(false);
      await expect(mcp.refresh(refreshed.next!)).resolves.toMatchObject({ outcome: "invalid" });
      await expect(prisma.inboundMcpOAuthTokenFamily.findMany({
        select: { revocationReason: true },
        where: { grant: { userId } }
      })).resolves.toEqual([{ revocationReason: "admin_revoke_user" }]);
      await expect(liveInboundMcpFamilyCount(prisma, userId)).resolves.toBe(0);
    });
  });

  it("fences the family of a code exchange racing an account revocation and allows reconsent", async () => {
    await withRevocationRace(async ({ armPause, mcp, userId }) => {
      const pending = await mcp.approve(userId, INBOUND_MCP_TEST_AUTHORITIES.memory);
      const pause = armPause();
      const exchange = mcp.exchange(pending);
      await pause.held;

      // The exchange has consumed the code and minted a family under the old grant revision.
      const revocation = prisma.$transaction((tx) => revokeInboundMcpGrantsForUser(tx, {
        now: mcp.now,
        reason: "password_change",
        userId
      }));
      await waitForLockWaiter();
      pause.release();
      const [exchanged, revoked] = await Promise.all([exchange, revocation]);

      expect(revoked).toBe(1);
      expect(exchanged).not.toBeNull();
      await expect(mcp.access(exchanged!)).resolves.toBe(false);
      await expect(mcp.refresh(exchanged!)).resolves.toMatchObject({ outcome: "invalid" });
      await expect(liveInboundMcpFamilyCount(prisma, userId)).resolves.toBe(0);

      const reconnected = await mcp.connect(userId, INBOUND_MCP_TEST_AUTHORITIES.memory);
      await expect(mcp.access(reconnected)).resolves.toBe(true);
      await expect(mcp.access(exchanged!)).resolves.toBe(false);
      await expect(liveInboundMcpFamilyCount(prisma, userId)).resolves.toBe(1);
    });
  });

  it("prunes terminal inbound OAuth state in bounded dependency order", async () => {
    const suffix = randomUUID();
    const owner = await prisma.user.create({
      data: {
        displayName: "Inbound MCP retention owner",
        email: `inbound-mcp-retention-${suffix}@example.test`,
        status: "active"
      }
    });
    const old = time("2026-01-01T00:00:00.000Z");
    const terminal = time("2026-01-02T00:00:00.000Z");
    const cutoff = time("2026-02-01T00:00:00.000Z");
    const unusedClientId = `aiqsa_dcr_unused_${suffix}`;
    const grantedClientId = `aiqsa_dcr_granted_${suffix}`;
    const unusedClient = await prisma.inboundMcpOAuthClient.create({
      data: {
        applicationType: "NATIVE",
        clientId: unusedClientId,
        clientName: "Unused retention client",
        clientOrigin: "http://127.0.0.1:43119",
        createdAt: old,
        kind: "DYNAMIC_REGISTRATION",
        metadataFingerprint: hashToken(unusedClientId),
        redirectUris: [REDIRECT_URI],
        updatedAt: old
      }
    });
    const grantedClient = await prisma.inboundMcpOAuthClient.create({
      data: {
        applicationType: "NATIVE",
        clientId: grantedClientId,
        clientName: "Granted retention client",
        clientOrigin: "http://127.0.0.1:43119",
        createdAt: old,
        kind: "DYNAMIC_REGISTRATION",
        metadataFingerprint: hashToken(grantedClientId),
        redirectUris: [REDIRECT_URI],
        updatedAt: old
      }
    });
    const grant = await prisma.inboundMcpOAuthGrant.create({
      data: {
        client: { connect: { id: grantedClient.id } },
        connectedAt: old,
        createdAt: old,
        revokedAt: terminal,
        state: "REVOKED",
        updatedAt: terminal,
        user: { connect: { id: owner.id } }
      }
    });
    const code = await prisma.inboundMcpOAuthAuthorizationCode.create({
      data: {
        client: { connect: { id: grantedClient.id } },
        codeChallenge: CHALLENGE,
        codeHash: hashToken(`retention-code-${suffix}`),
        consumedAt: terminal,
        createdAt: old,
        expiresAt: terminal,
        grant: {
          connect: {
            id_oauthClientId: {
              id: grant.id,
              oauthClientId: grantedClient.id
            }
          }
        },
        grantRevision: grant.revision,
        issuer: ISSUER,
        redirectUri: REDIRECT_URI,
        resource: RESOURCE
      }
    });
    const family = await prisma.inboundMcpOAuthTokenFamily.create({
      data: {
        createdAt: old,
        grantId: grant.id,
        grantRevision: grant.revision,
        inactivityExpiresAt: terminal,
        issuer: ISSUER,
        revocationReason: "retention_fixture",
        revokedAt: terminal,
        resource: RESOURCE,
        updatedAt: terminal
      }
    });
    const token = await prisma.inboundMcpOAuthToken.create({
      data: {
        createdAt: old,
        expiresAt: terminal,
        familyId: family.id,
        kind: "ACCESS",
        tokenHash: hashToken(`retention-token-${suffix}`)
      }
    });

    try {
      const repository = createPrismaRetentionRepository(prisma);
      const candidates = await repository.findPrunableInboundMcpOAuth({
        cutoff,
        limit: 10
      });
      expect(candidates.authorizationCodeIds).toContain(code.id);
      expect(candidates.tokenFamilyIds).toContain(family.id);
      expect(candidates.grantIds).toContain(grant.id);
      expect(candidates.clientIds).toContain(unusedClient.id);
      expect(candidates.clientIds).not.toContain(grantedClient.id);

      await expect(repository.deletePrunableInboundMcpOAuth({ candidates, cutoff }))
        .resolves.toEqual({
          authorizationCodes: 1,
          clients: 1,
          grants: 1,
          tokenFamilies: 1
        });
      await expect(prisma.inboundMcpOAuthToken.findUnique({ where: { id: token.id } }))
        .resolves.toBeNull();
    } finally {
      await prisma.user.deleteMany({ where: { id: owner.id } });
      await prisma.inboundMcpOAuthClient.deleteMany({
        where: { clientId: { in: [unusedClientId, grantedClientId] } }
      });
    }
  });
});

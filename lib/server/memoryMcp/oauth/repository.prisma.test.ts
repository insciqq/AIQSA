import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { hashToken } from "../../auth/token";
import { prisma } from "../../prisma";
import { createPrismaRetentionRepository } from "../../retention/prune";
import { createPrismaInboundMcpOAuthRepository } from "./repository";

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

describe("Prisma inbound Memory MCP OAuth repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
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
      await expect(repository.exchangeAuthorizationCode(exchange)).resolves.toBe(true);
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
      await expect(repository.rotateRefreshToken(rotation)).resolves.toBe("rotated");
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

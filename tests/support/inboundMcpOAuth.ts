// Synthetic inbound MCP OAuth connections for disposable-database tests. Token and code values are
// random; only their hashes reach the database.
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { hashToken } from "@/lib/server/auth/token";
import { createPrismaInboundMcpOAuthRepository } from "@/lib/server/memoryMcp/oauth/repository";

const ISSUER = "https://aiqsa.example";
const REDIRECT_URI = "http://127.0.0.1:43119/callback";
const CODE_CHALLENGE = "A".repeat(43);
const ACCESS_TTL_MS = 60 * 60 * 1_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export const INBOUND_MCP_TEST_AUTHORITIES = {
  hub: { capability: "mcp:hub", resource: `${ISSUER}/mcp/hub` },
  memory: { capability: "memory:facts", resource: `${ISSUER}/mcp` }
} as const;

export type InboundMcpTestAuthority =
  (typeof INBOUND_MCP_TEST_AUTHORITIES)[keyof typeof INBOUND_MCP_TEST_AUTHORITIES];

/** An approved consent whose authorization code was not exchanged yet. */
export type InboundMcpTestPendingCode = Readonly<{
  authority: InboundMcpTestAuthority;
  codeHash: string;
}>;

export type InboundMcpTestConnection = Readonly<{
  accessTokenHash: string;
  authority: InboundMcpTestAuthority;
  refreshTokenHash: string;
}>;

export type InboundMcpTestClient = Readonly<{
  /** Whether the access token authorizes a call at `now`. */
  access(connection: InboundMcpTestConnection): Promise<boolean>;
  approve(userId: string, authority: InboundMcpTestAuthority): Promise<InboundMcpTestPendingCode>;
  cleanup(): Promise<void>;
  clientId: string;
  /** Consent plus code exchange, the complete browser authorization flow. */
  connect(userId: string, authority: InboundMcpTestAuthority): Promise<InboundMcpTestConnection>;
  exchange(pending: InboundMcpTestPendingCode): Promise<InboundMcpTestConnection | null>;
  now: Date;
  /** Rotates the refresh token; a `rotated` outcome returns the successor connection. */
  refresh(connection: InboundMcpTestConnection): Promise<Readonly<{
    next: InboundMcpTestConnection | null;
    outcome: "invalid" | "reused" | "rotated";
  }>>;
  repository: ReturnType<typeof createPrismaInboundMcpOAuthRepository>;
}>;

function randomHash(): string {
  return hashToken(randomUUID());
}

/** Registers one public native client; `cleanup` removes it after the owning users are deleted. */
export async function createInboundMcpTestClient(
  prisma: PrismaClient,
  now: Date
): Promise<InboundMcpTestClient> {
  const clientId = `aiqsa_dcr_${randomUUID()}`;
  const repository = createPrismaInboundMcpOAuthRepository(prisma);
  const client = await repository.createDynamicClient({
    applicationType: "NATIVE",
    clientId,
    clientName: "Account security test client",
    clientOrigin: "http://127.0.0.1:43119",
    clientUri: null,
    kind: "DYNAMIC_REGISTRATION",
    metadataExpiresAt: null,
    metadataFingerprint: hashToken(clientId),
    now,
    redirectUris: [REDIRECT_URI]
  });
  const accessExpiresAt = new Date(now.getTime() + ACCESS_TTL_MS);
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TTL_MS);

  async function approve(userId: string, authority: InboundMcpTestAuthority) {
    const codeHash = randomHash();
    const approved = await repository.approveAuthorization({
      ...authority,
      clientRecordId: client.id,
      codeChallenge: CODE_CHALLENGE,
      codeHash,
      expiresAt: new Date(now.getTime() + 5 * 60 * 1_000),
      issuer: ISSUER,
      now,
      redirectUri: REDIRECT_URI,
      userId
    });
    if (!approved) throw new Error("inbound_mcp_test_consent_rejected");
    return { authority, codeHash };
  }

  async function exchange(pending: InboundMcpTestPendingCode) {
    const connection = {
      accessTokenHash: randomHash(),
      authority: pending.authority,
      refreshTokenHash: randomHash()
    };
    const exchanged = await repository.exchangeAuthorizationCode({
      ...pending.authority,
      accessExpiresAt,
      accessTokenHash: connection.accessTokenHash,
      clientId,
      codeChallenge: CODE_CHALLENGE,
      codeHash: pending.codeHash,
      issuer: ISSUER,
      now,
      redirectUri: REDIRECT_URI,
      refreshExpiresAt,
      refreshTokenHash: connection.refreshTokenHash
    });
    return exchanged ? connection : null;
  }

  return {
    async access(connection) {
      const resolved = await repository.resolveAccessToken({
        ...connection.authority,
        issuer: ISSUER,
        now,
        tokenHash: connection.accessTokenHash
      });
      return resolved !== null;
    },
    approve,
    async cleanup() {
      await prisma.inboundMcpOAuthClient.deleteMany({ where: { clientId } });
    },
    clientId,
    async connect(userId, authority) {
      const connection = await exchange(await approve(userId, authority));
      if (!connection) throw new Error("inbound_mcp_test_exchange_rejected");
      return connection;
    },
    exchange,
    now,
    async refresh(connection) {
      const next = {
        accessTokenHash: randomHash(),
        authority: connection.authority,
        refreshTokenHash: randomHash()
      };
      const outcome = await repository.rotateRefreshToken({
        ...connection.authority,
        accessExpiresAt,
        accessTokenHash: next.accessTokenHash,
        clientId,
        issuer: ISSUER,
        nextRefreshTokenHash: next.refreshTokenHash,
        now,
        presentedRefreshTokenHash: connection.refreshTokenHash,
        refreshExpiresAt
      });
      return { next: typeof outcome === "object" ? next : null,
        outcome: typeof outcome === "object" ? "rotated" as const : outcome };
    },
    repository
  };
}

/**
 * Token families that could still authorize: not revoked and minted under the current revision of
 * a grant that is still ACTIVE.
 */
export async function liveInboundMcpFamilyCount(
  prisma: PrismaClient,
  userId: string
): Promise<number> {
  const families = await prisma.inboundMcpOAuthTokenFamily.findMany({
    select: { grant: { select: { revision: true, state: true } }, grantRevision: true },
    where: { grant: { userId }, revokedAt: null }
  });
  return families.filter((family) =>
    family.grant.state === "ACTIVE" && family.grant.revision === family.grantRevision
  ).length;
}

import type {
  InboundMcpOAuthApplicationType,
  InboundMcpOAuthClientKind,
  Prisma,
  PrismaClient
} from "@prisma/client";
import { registeredRedirectUriMatches } from "./contracts";

export type InboundMcpOAuthClientRecord = Readonly<{
  applicationType: InboundMcpOAuthApplicationType;
  clientId: string;
  clientName: string;
  clientOrigin: string;
  clientUri: string | null;
  id: string;
  kind: InboundMcpOAuthClientKind;
  metadataExpiresAt: Date | null;
  metadataFingerprint: string;
  redirectUris: readonly string[];
}>;

export type InboundMcpConnectedApp = Readonly<{
  clientName: string;
  clientOrigin: string;
  connectedAt: Date;
  grantId: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  state: "ACTIVE" | "REVOKED";
}>;

export type InboundMcpOAuthRepository = Readonly<{
  approveAuthorization(input: Readonly<{
    clientRecordId: string;
    codeChallenge: string;
    codeHash: string;
    expiresAt: Date;
    issuer: string;
    now: Date;
    redirectUri: string;
    resource: string;
    userId: string;
  }>): Promise<boolean>;
  createDynamicClient(input: InboundMcpOAuthClientWrite): Promise<InboundMcpOAuthClientRecord>;
  exchangeAuthorizationCode(input: InboundMcpAuthorizationCodeExchange): Promise<boolean>;
  findClient(clientId: string): Promise<InboundMcpOAuthClientRecord | null>;
  listConnectedApps(userId: string): Promise<readonly InboundMcpConnectedApp[]>;
  resolveAccessToken(input: Readonly<{
    issuer: string;
    now: Date;
    resource: string;
    tokenHash: string;
  }>): Promise<Readonly<{
    clientId: string;
    expiresAt: Date;
    grantId: string;
    userId: string;
  }> | null>;
  revokeGrant(input: Readonly<{
    grantId: string;
    now: Date;
    userId: string;
  }>): Promise<boolean>;
  revokeTokenFamily(input: Readonly<{
    clientId: string;
    now: Date;
    tokenHash: string;
  }>): Promise<void>;
  rotateRefreshToken(input: InboundMcpRefreshTokenRotation): Promise<"invalid" | "reused" | "rotated">;
  upsertMetadataClient(input: InboundMcpOAuthClientWrite): Promise<InboundMcpOAuthClientRecord>;
}>;

export type InboundMcpOAuthClientWrite = Readonly<{
  applicationType: InboundMcpOAuthApplicationType;
  clientId: string;
  clientName: string;
  clientOrigin: string;
  clientUri: string | null;
  kind: InboundMcpOAuthClientKind;
  metadataExpiresAt: Date | null;
  metadataFingerprint: string;
  now: Date;
  redirectUris: readonly string[];
}>;

type IssuedTokenHashes = Readonly<{
  accessExpiresAt: Date;
  accessTokenHash: string;
  refreshExpiresAt: Date;
  refreshTokenHash: string;
}>;

export type InboundMcpAuthorizationCodeExchange = IssuedTokenHashes & Readonly<{
  clientId: string;
  codeChallenge: string;
  codeHash: string;
  issuer: string;
  now: Date;
  redirectUri: string;
  resource: string;
}>;

export type InboundMcpRefreshTokenRotation = Readonly<{
  accessExpiresAt: Date;
  accessTokenHash: string;
  clientId: string;
  issuer: string;
  nextRefreshTokenHash: string;
  now: Date;
  presentedRefreshTokenHash: string;
  refreshExpiresAt: Date;
  resource: string;
}>;

function clientRecord(input: Readonly<{
  applicationType: InboundMcpOAuthApplicationType;
  clientId: string;
  clientName: string;
  clientOrigin: string;
  clientUri: string | null;
  id: string;
  kind: InboundMcpOAuthClientKind;
  metadataExpiresAt: Date | null;
  metadataFingerprint: string;
  redirectUris: string[];
}>): InboundMcpOAuthClientRecord {
  return {
    ...input,
    redirectUris: Object.freeze([...input.redirectUris])
  };
}

function clientSelect() {
  return {
    applicationType: true,
    clientId: true,
    clientName: true,
    clientOrigin: true,
    clientUri: true,
    id: true,
    kind: true,
    metadataExpiresAt: true,
    metadataFingerprint: true,
    redirectUris: true
  } as const;
}

async function revokeFamilies(
  tx: Prisma.TransactionClient,
  grantIds: readonly string[],
  now: Date,
  reason: string
): Promise<void> {
  if (grantIds.length === 0) return;
  await tx.inboundMcpOAuthTokenFamily.updateMany({
    data: { revokedAt: now, revocationReason: reason },
    where: { grantId: { in: [...grantIds] }, revokedAt: null }
  });
}

async function markRefreshReuse(
  tx: Prisma.TransactionClient,
  familyId: string,
  now: Date
): Promise<void> {
  await tx.inboundMcpOAuthTokenFamily.updateMany({
    data: { revokedAt: now, revocationReason: "refresh_token_reuse" },
    where: { id: familyId, revokedAt: null }
  });
}

function activeGrant(input: Readonly<{
  grant: Readonly<{
    revision: number;
    state: string;
    user: Readonly<{ status: string }>;
  }>;
  grantRevision: number;
}>): boolean {
  return input.grant.state === "ACTIVE" &&
    input.grant.revision === input.grantRevision &&
    input.grant.user.status === "active";
}

export function createPrismaInboundMcpOAuthRepository(
  prisma: PrismaClient
): InboundMcpOAuthRepository {
  return Object.freeze({
    approveAuthorization(input) {
      return prisma.$transaction(async (tx) => {
        const [client, user] = await Promise.all([
          tx.inboundMcpOAuthClient.findUnique({
            select: { applicationType: true, id: true, redirectUris: true },
            where: { id: input.clientRecordId }
          }),
          tx.user.findUnique({
            select: { id: true, status: true },
            where: { id: input.userId }
          })
        ]);
        if (!client || !user || user.status !== "active" ||
          !client.redirectUris.some((registered) => registeredRedirectUriMatches({
            applicationType: client.applicationType,
            presented: input.redirectUri,
            registered
          }))) return false;

        const existing = await tx.inboundMcpOAuthGrant.findUnique({
          select: { id: true, revision: true },
          where: {
            userId_oauthClientId: {
              oauthClientId: client.id,
              userId: user.id
            }
          }
        });
        let grant: { id: string; revision: number };
        if (existing) {
          await revokeFamilies(tx, [existing.id], input.now, "reauthorized");
          await tx.inboundMcpOAuthAuthorizationCode.deleteMany({
            where: { consumedAt: null, grantId: existing.id }
          });
          grant = await tx.inboundMcpOAuthGrant.update({
            data: {
              connectedAt: input.now,
              updatedAt: input.now,
              lastUsedAt: null,
              revision: { increment: 1 },
              revokedAt: null,
              state: "ACTIVE"
            },
            select: { id: true, revision: true },
            where: { id: existing.id }
          });
        } else {
          grant = await tx.inboundMcpOAuthGrant.create({
            data: {
              client: { connect: { id: client.id } },
              connectedAt: input.now,
              createdAt: input.now,
              updatedAt: input.now,
              user: { connect: { id: user.id } }
            },
            select: { id: true, revision: true }
          });
        }
        await tx.inboundMcpOAuthAuthorizationCode.create({
          data: {
            codeChallenge: input.codeChallenge,
            codeHash: input.codeHash,
            createdAt: input.now,
            expiresAt: input.expiresAt,
            grantId: grant.id,
            grantRevision: grant.revision,
            issuer: input.issuer,
            oauthClientId: client.id,
            redirectUri: input.redirectUri,
            resource: input.resource
          }
        });
        await tx.inboundMcpOAuthClient.update({
          data: { lastUsedAt: input.now },
          where: { id: client.id }
        });
        return true;
      });
    },

    async createDynamicClient(input) {
      return clientRecord(await prisma.inboundMcpOAuthClient.create({
        data: {
          applicationType: input.applicationType,
          clientId: input.clientId,
          clientName: input.clientName,
          clientOrigin: input.clientOrigin,
          clientUri: input.clientUri,
          createdAt: input.now,
          kind: "DYNAMIC_REGISTRATION",
          metadataExpiresAt: null,
          metadataFingerprint: input.metadataFingerprint,
          redirectUris: [...input.redirectUris],
          updatedAt: input.now
        },
        select: clientSelect()
      }));
    },

    exchangeAuthorizationCode(input) {
      return prisma.$transaction(async (tx) => {
        const code = await tx.inboundMcpOAuthAuthorizationCode.findUnique({
          include: {
            client: { select: { clientId: true, id: true } },
            grant: {
              include: {
                user: { select: { id: true, status: true } }
              }
            }
          },
          where: { codeHash: input.codeHash }
        });
        if (!code || code.consumedAt || code.expiresAt <= input.now ||
          code.client.clientId !== input.clientId ||
          code.codeChallenge !== input.codeChallenge ||
          code.redirectUri !== input.redirectUri || code.issuer !== input.issuer ||
          code.resource !== input.resource ||
          !activeGrant({ grant: code.grant, grantRevision: code.grantRevision })) {
          return false;
        }
        const consumed = await tx.inboundMcpOAuthAuthorizationCode.updateMany({
          data: { consumedAt: input.now },
          where: { codeHash: input.codeHash, consumedAt: null, expiresAt: { gt: input.now } }
        });
        if (consumed.count !== 1) return false;
        const family = await tx.inboundMcpOAuthTokenFamily.create({
          data: {
            grantId: code.grantId,
            grantRevision: code.grantRevision,
            createdAt: input.now,
            inactivityExpiresAt: input.refreshExpiresAt,
            issuer: input.issuer,
            lastUsedAt: input.now,
            resource: input.resource,
            updatedAt: input.now
          },
          select: { id: true }
        });
        await tx.inboundMcpOAuthToken.createMany({
          data: [{
            createdAt: input.now,
            expiresAt: input.accessExpiresAt,
            familyId: family.id,
            kind: "ACCESS",
            tokenHash: input.accessTokenHash
          }, {
            createdAt: input.now,
            expiresAt: input.refreshExpiresAt,
            familyId: family.id,
            kind: "REFRESH",
            tokenHash: input.refreshTokenHash
          }]
        });
        await Promise.all([
          tx.inboundMcpOAuthGrant.update({
            data: { lastUsedAt: input.now },
            where: { id: code.grantId }
          }),
          tx.inboundMcpOAuthClient.update({
            data: { lastUsedAt: input.now },
            where: { id: code.oauthClientId }
          })
        ]);
        return true;
      });
    },

    async findClient(clientId) {
      const client = await prisma.inboundMcpOAuthClient.findUnique({
        select: clientSelect(),
        where: { clientId }
      });
      return client ? clientRecord(client) : null;
    },

    async listConnectedApps(userId) {
      const grants = await prisma.inboundMcpOAuthGrant.findMany({
        orderBy: [{ connectedAt: "desc" }, { id: "desc" }],
        select: {
          client: { select: { clientName: true, clientOrigin: true } },
          connectedAt: true,
          id: true,
          lastUsedAt: true,
          revokedAt: true,
          state: true
        },
        where: { userId }
      });
      return grants.map((grant) => ({
        clientName: grant.client.clientName,
        clientOrigin: grant.client.clientOrigin,
        connectedAt: grant.connectedAt,
        grantId: grant.id,
        lastUsedAt: grant.lastUsedAt,
        revokedAt: grant.revokedAt,
        state: grant.state
      }));
    },

    resolveAccessToken(input) {
      return prisma.$transaction(async (tx) => {
        const token = await tx.inboundMcpOAuthToken.findUnique({
          include: {
            family: {
              include: {
                grant: {
                  include: {
                    client: { select: { clientId: true, id: true } },
                    user: { select: { id: true, status: true } }
                  }
                }
              }
            }
          },
          where: { tokenHash: input.tokenHash }
        });
        if (!token || token.kind !== "ACCESS" || token.expiresAt <= input.now ||
          token.family.revokedAt || token.family.inactivityExpiresAt <= input.now ||
          token.family.issuer !== input.issuer || token.family.resource !== input.resource ||
          !activeGrant({
            grant: token.family.grant,
            grantRevision: token.family.grantRevision
          })) return null;
        await Promise.all([
          tx.inboundMcpOAuthToken.update({
            data: { lastUsedAt: input.now },
            where: { id: token.id }
          }),
          tx.inboundMcpOAuthTokenFamily.update({
            data: { lastUsedAt: input.now },
            where: { id: token.familyId }
          }),
          tx.inboundMcpOAuthGrant.update({
            data: { lastUsedAt: input.now },
            where: { id: token.family.grantId }
          }),
          tx.inboundMcpOAuthClient.update({
            data: { lastUsedAt: input.now },
            where: { id: token.family.grant.client.id }
          })
        ]);
        return {
          clientId: token.family.grant.client.clientId,
          expiresAt: token.expiresAt,
          grantId: token.family.grantId,
          userId: token.family.grant.user.id
        };
      });
    },

    revokeGrant(input) {
      return prisma.$transaction(async (tx) => {
        const revoked = await tx.inboundMcpOAuthGrant.updateMany({
          data: {
            revision: { increment: 1 },
            revokedAt: input.now,
            state: "REVOKED"
          },
          where: { id: input.grantId, state: "ACTIVE", userId: input.userId }
        });
        if (revoked.count !== 1) return false;
        await revokeFamilies(tx, [input.grantId], input.now, "connected_app_revoked");
        await tx.inboundMcpOAuthAuthorizationCode.deleteMany({
          where: { consumedAt: null, grantId: input.grantId }
        });
        return true;
      });
    },

    async revokeTokenFamily(input) {
      await prisma.$transaction(async (tx) => {
        const token = await tx.inboundMcpOAuthToken.findUnique({
          select: {
            family: {
              select: {
                grant: { select: { client: { select: { clientId: true } } } },
                id: true
              }
            }
          },
          where: { tokenHash: input.tokenHash }
        });
        if (!token || token.family.grant.client.clientId !== input.clientId) return;
        await tx.inboundMcpOAuthTokenFamily.updateMany({
          data: { revokedAt: input.now, revocationReason: "revocation_endpoint" },
          where: { id: token.family.id, revokedAt: null }
        });
      });
    },

    rotateRefreshToken(input) {
      return prisma.$transaction(async (tx) => {
        const token = await tx.inboundMcpOAuthToken.findUnique({
          include: {
            family: {
              include: {
                grant: {
                  include: {
                    client: { select: { clientId: true, id: true } },
                    user: { select: { status: true } }
                  }
                }
              }
            }
          },
          where: { tokenHash: input.presentedRefreshTokenHash }
        });
        if (!token || token.kind !== "REFRESH" ||
          token.family.grant.client.clientId !== input.clientId) return "invalid";
        if (token.consumedAt) {
          await markRefreshReuse(tx, token.familyId, input.now);
          return "reused";
        }
        if (token.expiresAt <= input.now || token.family.revokedAt ||
          token.family.inactivityExpiresAt <= input.now ||
          token.family.issuer !== input.issuer || token.family.resource !== input.resource ||
          !activeGrant({
            grant: token.family.grant,
            grantRevision: token.family.grantRevision
          })) return "invalid";
        const consumed = await tx.inboundMcpOAuthToken.updateMany({
          data: { consumedAt: input.now, lastUsedAt: input.now },
          where: { consumedAt: null, id: token.id }
        });
        if (consumed.count !== 1) {
          await markRefreshReuse(tx, token.familyId, input.now);
          return "reused";
        }
        await tx.inboundMcpOAuthToken.createMany({
          data: [{
            createdAt: input.now,
            expiresAt: input.accessExpiresAt,
            familyId: token.familyId,
            kind: "ACCESS",
            tokenHash: input.accessTokenHash
          }, {
            createdAt: input.now,
            expiresAt: input.refreshExpiresAt,
            familyId: token.familyId,
            kind: "REFRESH",
            tokenHash: input.nextRefreshTokenHash
          }]
        });
        await Promise.all([
          tx.inboundMcpOAuthTokenFamily.update({
            data: {
              inactivityExpiresAt: input.refreshExpiresAt,
              lastUsedAt: input.now
            },
            where: { id: token.familyId }
          }),
          tx.inboundMcpOAuthGrant.update({
            data: { lastUsedAt: input.now },
            where: { id: token.family.grantId }
          }),
          tx.inboundMcpOAuthClient.update({
            data: { lastUsedAt: input.now },
            where: { id: token.family.grant.client.id }
          })
        ]);
        return "rotated";
      });
    },

    upsertMetadataClient(input) {
      return prisma.$transaction(async (tx) => {
        const existing = await tx.inboundMcpOAuthClient.findUnique({
          select: clientSelect(),
          where: { clientId: input.clientId }
        });
        if (!existing) {
          return clientRecord(await tx.inboundMcpOAuthClient.create({
            data: {
              applicationType: input.applicationType,
              clientId: input.clientId,
              clientName: input.clientName,
              clientOrigin: input.clientOrigin,
              clientUri: input.clientUri,
              createdAt: input.now,
              kind: "CLIENT_ID_METADATA_DOCUMENT",
              metadataExpiresAt: input.metadataExpiresAt,
              metadataFingerprint: input.metadataFingerprint,
              redirectUris: [...input.redirectUris],
              updatedAt: input.now
            },
            select: clientSelect()
          }));
        }
        if (existing.kind !== "CLIENT_ID_METADATA_DOCUMENT") {
          throw new Error("inbound_mcp_client_kind_conflict");
        }
        if (existing.metadataFingerprint !== input.metadataFingerprint) {
          const grants = await tx.inboundMcpOAuthGrant.findMany({
            select: { id: true },
            where: { oauthClientId: existing.id, state: "ACTIVE" }
          });
          await revokeFamilies(
            tx,
            grants.map((grant) => grant.id),
            input.now,
            "client_metadata_changed"
          );
          await tx.inboundMcpOAuthGrant.updateMany({
            data: {
              revision: { increment: 1 },
              revokedAt: input.now,
              state: "REVOKED"
            },
            where: { oauthClientId: existing.id, state: "ACTIVE" }
          });
        }
        return clientRecord(await tx.inboundMcpOAuthClient.update({
          data: {
            applicationType: input.applicationType,
            clientName: input.clientName,
            clientOrigin: input.clientOrigin,
            clientUri: input.clientUri,
            metadataExpiresAt: input.metadataExpiresAt,
            metadataFingerprint: input.metadataFingerprint,
            redirectUris: [...input.redirectUris],
            updatedAt: input.now
          },
          select: clientSelect(),
          where: { id: existing.id }
        }));
      });
    }
  });
}

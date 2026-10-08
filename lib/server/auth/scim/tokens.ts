import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { ADMIN_SCIM_ACTIVE_TOKEN_MAX, type AdminScimToken } from "@/lib/contracts/adminScim";
import { retainDatabaseFailure } from "../../observability/databaseFailure";
import { hashToken, verifyTokenHash } from "../token";

const TOKEN_PREFIX = "aiqsa_scim_";
const TOKEN_PATTERN = /^aiqsa_scim_[A-Za-z0-9_-]{43}$/u;
const DISPLAY_PREFIX_RANDOM_CHARACTERS = 4;
const REVOKED_TOKENS_LISTED = 10;
/** `lastUsedAt` moves at most this often, so a sync does not rewrite the row per request. */
const LAST_USED_RESOLUTION_MS = 60_000;

export type IssuedScimToken = { displayPrefix: string; token: string; tokenHash: string };

/** A new bearer token: 256 random bits behind a recognizable prefix. Only its hash is stored. */
export function issueScimToken(): IssuedScimToken {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    displayPrefix: token.slice(0, TOKEN_PREFIX.length + DISPLAY_PREFIX_RANDOM_CHARACTERS),
    token,
    tokenHash: hashToken(token)
  };
}

/** Whether a presented value has the shape of a SCIM token, before any lookup. */
export function isScimTokenFormat(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export type ScimTokenRepository = {
  /**
   * Whether the token is a current SCIM token: looked up by its hash, compared in constant
   * time, not revoked. Records `lastUsedAt` at a one-minute resolution.
   */
  authenticate(token: string, now: Date): Promise<boolean>;
  /** Null when the active-token limit is reached. */
  create(input: { actorUserId: string; now: Date }): Promise<{ token: string } | null>;
  list(): Promise<AdminScimToken[]>;
  /** False when the token is unknown or already revoked. */
  revoke(input: { now: Date; tokenId: string }): Promise<boolean>;
  /** Issues a replacement and revokes the token in one step; null when it is not active. */
  rotate(input: { actorUserId: string; now: Date; tokenId: string }): Promise<{ token: string } | null>;
};

function projection(row: {
  createdAt: Date;
  displayPrefix: string;
  id: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}): AdminScimToken {
  return {
    createdAt: row.createdAt.toISOString(),
    displayPrefix: row.displayPrefix,
    id: row.id,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null
  };
}

const tokenSelect = {
  createdAt: true,
  displayPrefix: true,
  id: true,
  lastUsedAt: true,
  revokedAt: true
} as const;

/** Serializes token issuance so the active-token limit stays exact. */
async function lockTokenIssuance(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw<Array<{ lock: string }>>`
    SELECT pg_advisory_xact_lock(hashtextextended('aiqsa:scim-token-issuance', 0))::text AS "lock"
  `;
}

async function insertToken(tx: Prisma.TransactionClient, input: { actorUserId: string; now: Date }): Promise<string> {
  const issued = issueScimToken();
  await tx.authScimToken.create({
    data: {
      createdAt: input.now,
      createdByUserId: input.actorUserId,
      displayPrefix: issued.displayPrefix,
      tokenHash: issued.tokenHash
    }
  });
  return issued.token;
}

export function createPrismaScimTokenRepository(prisma: PrismaClient): ScimTokenRepository {
  return {
    async authenticate(token, now) {
      if (!isScimTokenFormat(token)) return false;
      const tokenHash = hashToken(token);
      const row = await prisma.authScimToken.findUnique({
        select: { id: true, revokedAt: true, tokenHash: true },
        where: { tokenHash }
      }).catch(retainDatabaseFailure);
      if (!row || row.revokedAt !== null || !verifyTokenHash(token, row.tokenHash)) return false;
      await prisma.authScimToken.updateMany({
        data: { lastUsedAt: now },
        where: {
          id: row.id,
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - LAST_USED_RESOLUTION_MS) } }],
          revokedAt: null
        }
      }).catch(retainDatabaseFailure);
      return true;
    },

    async create(input) {
      return prisma.$transaction(async (tx) => {
        await lockTokenIssuance(tx);
        const active = await tx.authScimToken.count({ where: { revokedAt: null } });
        if (active >= ADMIN_SCIM_ACTIVE_TOKEN_MAX) return null;
        return { token: await insertToken(tx, input) };
      }).catch(retainDatabaseFailure);
    },

    async list() {
      const [active, revoked] = await Promise.all([
        prisma.authScimToken.findMany({ orderBy: [{ createdAt: "desc" }, { id: "asc" }], select: tokenSelect, where: { revokedAt: null } }),
        prisma.authScimToken.findMany({
          orderBy: [{ revokedAt: "desc" }, { id: "asc" }],
          select: tokenSelect,
          take: REVOKED_TOKENS_LISTED,
          where: { revokedAt: { not: null } }
        })
      ]).catch(retainDatabaseFailure);
      return [...active, ...revoked].map(projection);
    },

    async revoke(input) {
      const revoked = await prisma.authScimToken.updateMany({
        data: { revokedAt: input.now },
        where: { id: input.tokenId, revokedAt: null }
      }).catch(retainDatabaseFailure);
      return revoked.count === 1;
    },

    async rotate(input) {
      return prisma.$transaction(async (tx) => {
        await lockTokenIssuance(tx);
        const revoked = await tx.authScimToken.updateMany({
          data: { revokedAt: input.now },
          where: { id: input.tokenId, revokedAt: null }
        });
        if (revoked.count !== 1) return null;
        return { token: await insertToken(tx, input) };
      }).catch(retainDatabaseFailure);
    }
  };
}

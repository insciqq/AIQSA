import { Prisma, type ConnectPairing, type PrismaClient } from "@prisma/client";
import {
  CONNECT_ARCH_VALUES,
  CONNECT_MAX_DEVICES_PER_USER,
  CONNECT_OS_VALUES,
  CONNECT_VERSION_PATTERN,
  type ConnectArch,
  type ConnectOs
} from "@/lib/contracts/connect";
import type { ConnectDeviceRecord } from "./relay";

/** The facts a pairing client reported about its computer, kept on the pairing and its device. */
export type ConnectMachineFacts = Readonly<{
  arch: ConnectArch;
  clientVersion: string;
  hostname: string;
  name: string;
  os: ConnectOs;
}>;

export type ConnectStreamDevice = ConnectDeviceRecord & Readonly<{ tokenHash: string; userActive: boolean }>;

export type ConnectPairingRecord = ConnectMachineFacts & Readonly<{
  approvedUserId: string | null;
  consumedAt: Date | null;
  createdAt: Date;
  deniedAt: Date | null;
  expiresAt: Date;
  id: string;
  pollSecretHash: string;
}>;

export type ConnectPairingApproval = "approved" | "device_limit" | "expired" | "unauthorized";
export type ConnectPairingConsumption =
  | Readonly<{ deviceId: string; kind: "consumed"; userId: string }>
  | Readonly<{ kind: "device_limit" }>
  | Readonly<{ kind: "unavailable" }>;

export type ConnectRepository = Readonly<{
  /** Approves a pending, unexpired pairing for the signed-in account within its device limit. */
  approvePairing(input: Readonly<{ authSessionId: string; now: Date; userCodeHash: string; userId: string }>): Promise<ConnectPairingApproval>;
  /** Creates the device and consumes the approved pairing in one transaction; the caller mints the token. */
  consumePairing(input: Readonly<{ id: string; now: Date; tokenHash: string }>): Promise<ConnectPairingConsumption>;
  /** Null when the code is already taken by another pairing. */
  createPairing(input: ConnectMachineFacts & Readonly<{
    createdAt: Date;
    expiresAt: Date;
    pollSecretHash: string;
    userCodeHash: string;
  }>): Promise<Readonly<{ id: string }> | null>;
  deleteDevice(input: Readonly<{ id: string; userId: string }>): Promise<boolean>;
  denyPairing(input: Readonly<{ now: Date; userCodeHash: string }>): Promise<"denied" | "expired">;
  deviceExists(input: Readonly<{ id: string; userId: string }>): Promise<boolean>;
  findPairing(id: string): Promise<ConnectPairingRecord | null>;
  findPairingByCode(userCodeHash: string): Promise<ConnectPairingRecord | null>;
  /**
   * The device a stream token names. It waits for a transaction that is
   * revoking the device, so a stream never opens on a device that revocation
   * removes.
   */
  findStreamDevice(tokenHash: string): Promise<ConnectStreamDevice | null>;
  /** Whether the browser session still authorizes its account: not revoked, not expired, account active. */
  isAuthSessionActive(input: Readonly<{ now: Date; sessionId: string; userId: string }>): Promise<boolean>;
  listDevices(userId: string): Promise<ConnectDeviceRecord[]>;
  /** False when the device is gone or its account is no longer active. */
  touchDevice(input: Readonly<{ clientVersion?: string; id: string; lastSeenAt: Date; tokenHash: string }>): Promise<boolean>;
}>;

function isOs(value: string): value is ConnectOs {
  return (CONNECT_OS_VALUES as readonly string[]).includes(value);
}

function isArch(value: string): value is ConnectArch {
  return (CONNECT_ARCH_VALUES as readonly string[]).includes(value);
}

type DeviceRow = Readonly<{
  arch: string;
  clientVersion: string;
  createdAt: Date;
  hostname: string;
  id: string;
  lastSeenAt: Date | null;
  name: string;
  os: string;
  userId: string;
}>;

/** Rows always hold contract values; one that does not stays unusable instead of reaching a client. */
function deviceRecord(row: DeviceRow): ConnectDeviceRecord | null {
  if (!isOs(row.os) || !isArch(row.arch) || !CONNECT_VERSION_PATTERN.test(row.clientVersion)) return null;
  return {
    arch: row.arch,
    clientVersion: row.clientVersion,
    createdAt: row.createdAt,
    hostname: row.hostname,
    id: row.id,
    lastSeenAt: row.lastSeenAt,
    name: row.name,
    os: row.os,
    userId: row.userId
  };
}

function pairingRecord(row: ConnectPairing): ConnectPairingRecord | null {
  if (!isOs(row.os) || !isArch(row.arch)) return null;
  return {
    approvedUserId: row.approvedUserId,
    arch: row.arch,
    clientVersion: row.clientVersion,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
    deniedAt: row.deniedAt,
    expiresAt: row.expiresAt,
    hostname: row.hostname,
    id: row.id,
    name: row.name,
    os: row.os,
    pollSecretHash: row.pollSecretHash
  };
}

const deviceSelect = {
  arch: true,
  clientVersion: true,
  createdAt: true,
  hostname: true,
  id: true,
  lastSeenAt: true,
  name: true,
  os: true,
  userId: true
} as const;

/**
 * Serializes device creation and approval per account, so the device limit
 * counts devices and outstanding approvals exactly.
 */
async function lockAccountDevices(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw<Array<{ lock: string }>>`
    SELECT pg_advisory_xact_lock(hashtextextended(${`aiqsa:connect-devices:${userId}`}, 0))::text AS "lock"
  `;
}

export function createPrismaConnectRepository(prisma: PrismaClient): ConnectRepository {
  return {
    async approvePairing(input) {
      return prisma.$transaction(async (tx) => {
        await lockAccountDevices(tx, input.userId);
        // Shares the approving session's row: a revocation of that session in
        // flight commits first, and its revoked state refuses the approval.
        const sessions = await tx.$queryRaw<Array<{
          expiresAt: Date;
          revokedAt: Date | null;
          userId: string;
          userStatus: string;
        }>>`
          SELECT session."expiresAt", session."revokedAt", session."userId", account."status"::text AS "userStatus"
          FROM "AuthSession" AS session
          JOIN "User" AS account ON account."id" = session."userId"
          WHERE session."id" = ${input.authSessionId}
          FOR SHARE OF session
        `;
        const session = sessions[0];
        if (!session || session.userId !== input.userId || session.revokedAt !== null ||
          session.expiresAt <= input.now || session.userStatus !== "active") {
          return "unauthorized";
        }
        const pairing = await tx.connectPairing.findUnique({
          select: { approvedUserId: true, consumedAt: true, deniedAt: true, expiresAt: true },
          where: { userCodeHash: input.userCodeHash }
        });
        if (!pairing || pairing.approvedUserId !== null || pairing.deniedAt !== null || pairing.consumedAt !== null ||
          pairing.expiresAt <= input.now) {
          return "expired";
        }
        const devices = await tx.connectDevice.count({ where: { userId: input.userId } });
        const approvals = await tx.connectPairing.count({
          where: { approvedUserId: input.userId, consumedAt: null, expiresAt: { gt: input.now } }
        });
        if (devices + approvals >= CONNECT_MAX_DEVICES_PER_USER) return "device_limit";
        const approved = await tx.connectPairing.updateMany({
          data: { approvedUserId: input.userId },
          where: {
            approvedUserId: null,
            consumedAt: null,
            deniedAt: null,
            expiresAt: { gt: input.now },
            userCodeHash: input.userCodeHash
          }
        });
        return approved.count === 1 ? "approved" : "expired";
      });
    },

    async consumePairing(input) {
      const pairing = await prisma.connectPairing.findUnique({ where: { id: input.id } });
      const userId = pairing?.approvedUserId;
      if (!pairing || !userId) return { kind: "unavailable" };
      return prisma.$transaction(async (tx) => {
        await lockAccountDevices(tx, userId);
        // The account row first, as account revocations lock it: a revocation
        // in flight commits before this reads the account and the pairing.
        const accounts = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT "status"::text AS "status" FROM "User" WHERE "id" = ${userId} FOR SHARE
        `;
        if (accounts[0]?.status !== "active") return { kind: "unavailable" as const };
        if (await tx.connectDevice.count({ where: { userId } }) >= CONNECT_MAX_DEVICES_PER_USER) {
          return { kind: "device_limit" as const };
        }
        const consumed = await tx.connectPairing.updateMany({
          data: { consumedAt: input.now },
          where: { approvedUserId: userId, consumedAt: null, deniedAt: null, expiresAt: { gt: input.now }, id: input.id }
        });
        if (consumed.count !== 1) return { kind: "unavailable" as const };
        const device = await tx.connectDevice.create({
          data: {
            arch: pairing.arch,
            clientVersion: pairing.clientVersion,
            createdAt: input.now,
            hostname: pairing.hostname,
            name: pairing.name,
            os: pairing.os,
            tokenHash: input.tokenHash,
            userId
          },
          select: { id: true }
        });
        return { deviceId: device.id, kind: "consumed" as const, userId };
      });
    },

    async createPairing(input) {
      try {
        return await prisma.connectPairing.create({
          data: {
            arch: input.arch,
            clientVersion: input.clientVersion,
            createdAt: input.createdAt,
            expiresAt: input.expiresAt,
            hostname: input.hostname,
            name: input.name,
            os: input.os,
            pollSecretHash: input.pollSecretHash,
            userCodeHash: input.userCodeHash
          },
          select: { id: true }
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
        throw error;
      }
    },

    async deleteDevice(input) {
      const deleted = await prisma.connectDevice.deleteMany({ where: { id: input.id, userId: input.userId } });
      return deleted.count === 1;
    },

    async denyPairing(input) {
      const denied = await prisma.connectPairing.updateMany({
        data: { deniedAt: input.now },
        where: {
          approvedUserId: null,
          consumedAt: null,
          deniedAt: null,
          expiresAt: { gt: input.now },
          userCodeHash: input.userCodeHash
        }
      });
      return denied.count === 1 ? "denied" : "expired";
    },

    async deviceExists(input) {
      const device = await prisma.connectDevice.findFirst({ select: { id: true }, where: { id: input.id, userId: input.userId } });
      return device !== null;
    },

    async findPairing(id) {
      const row = await prisma.connectPairing.findUnique({ where: { id } });
      return row ? pairingRecord(row) : null;
    },

    async findPairingByCode(userCodeHash) {
      const row = await prisma.connectPairing.findUnique({ where: { userCodeHash } });
      return row ? pairingRecord(row) : null;
    },

    async findStreamDevice(tokenHash) {
      const rows = await prisma.$queryRaw<Array<DeviceRow & { tokenHash: string; userStatus: string }>>`
        SELECT device."id", device."userId", device."name", device."hostname", device."os", device."arch",
          device."clientVersion", device."tokenHash", device."createdAt", device."lastSeenAt",
          account."status"::text AS "userStatus"
        FROM "ConnectDevice" AS device
        JOIN "User" AS account ON account."id" = device."userId"
        WHERE device."tokenHash" = CAST(${tokenHash} AS CHAR(64))
        FOR KEY SHARE OF device
      `;
      const row = rows[0];
      const record = row ? deviceRecord(row) : null;
      return row && record ? { ...record, tokenHash: row.tokenHash, userActive: row.userStatus === "active" } : null;
    },

    async isAuthSessionActive(input) {
      const session = await prisma.authSession.findFirst({
        select: { id: true },
        where: {
          expiresAt: { gt: input.now },
          id: input.sessionId,
          revokedAt: null,
          user: { status: "active" },
          userId: input.userId
        }
      });
      return session !== null;
    },

    async listDevices(userId) {
      const rows = await prisma.connectDevice.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: deviceSelect,
        take: CONNECT_MAX_DEVICES_PER_USER,
        where: { userId }
      });
      return rows.flatMap((row) => deviceRecord(row) ?? []);
    },

    async touchDevice(input) {
      const touched = await prisma.connectDevice.updateMany({
        data: { lastSeenAt: input.lastSeenAt, ...(input.clientVersion ? { clientVersion: input.clientVersion } : {}) },
        where: { id: input.id, tokenHash: input.tokenHash, user: { status: "active" } }
      });
      return touched.count === 1;
    }
  };
}

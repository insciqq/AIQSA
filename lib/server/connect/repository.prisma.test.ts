// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CONNECT_MAX_DEVICES_PER_USER } from "@/lib/contracts/connect";
import { prisma } from "../prisma";
import { createPrismaConnectPolicyRepository } from "./policyRepository";
import { createPrismaConnectRepository } from "./repository";
import { revokeConnectDevicesForUser } from "./revocation";

const repository = createPrismaConnectRepository(prisma);
const users: string[] = [];
const machine = { arch: "arm64", clientVersion: "0.3.20", hostname: "synthetic.local", name: "Synthetic", os: "darwin" } as const;
const hex = () => randomBytes(32).toString("hex");

async function account(status: "active" | "disabled" = "active"): Promise<string> {
  const id = `connect-test-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Synthetic Connect owner", email: `${id}@example.test`, id, status } });
  users.push(id);
  return id;
}

async function authSession(userId: string) {
  return prisma.authSession.create({ data: { expiresAt: new Date(Date.now() + 3_600_000), tokenHash: hex(), userId } });
}

async function pairing(now = new Date(), facts: Partial<typeof machine> = {}) {
  const userCodeHash = hex();
  const created = await repository.createPairing({
    ...machine,
    ...facts,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 600_000),
    pollSecretHash: hex(),
    userCodeHash
  });
  if (!created) throw new Error("pairing not created");
  return { id: created.id, userCodeHash };
}

async function device(userId: string) {
  const tokenHash = hex();
  const created = await prisma.connectDevice.create({ data: { ...machine, tokenHash, userId }, select: { id: true } });
  return { id: created.id, tokenHash };
}

afterEach(async () => {
  const ids = users.splice(0);
  await prisma.connectPairing.deleteMany({ where: { OR: [{ approvedUserId: { in: ids } }, { hostname: "synthetic.local" }] } });
  await prisma.authSession.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("persisted AIQSA Connect pairing", () => {
  it("approves a pending code once and consumes the approval into exactly one device", async () => {
    const userId = await account();
    const session = await authSession(userId);
    const { id, userCodeHash } = await pairing();
    const now = new Date();

    expect(await repository.findPairingByCode(userCodeHash)).toMatchObject({ approvedUserId: null, id, name: "Synthetic" });
    await expect(repository.approvePairing({ authSessionId: session.id, now, userCodeHash, userId })).resolves.toBe("approved");
    await expect(repository.approvePairing({ authSessionId: session.id, now, userCodeHash, userId })).resolves.toBe("expired");

    const tokenHashes = [hex(), hex()];
    const [first, second] = await Promise.all(tokenHashes.map((tokenHash) => repository.consumePairing({ id, now: new Date(), tokenHash })));
    const consumed = [first, second].filter((result) => result?.kind === "consumed");
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ account: { displayName: "Synthetic Connect owner", email: `${userId}@example.test` } });
    expect([first, second].filter((result) => result?.kind === "unavailable")).toHaveLength(1);
    const devices = await prisma.connectDevice.findMany({ where: { userId } });
    expect(devices).toHaveLength(1);
    expect(tokenHashes).toContain(devices[0]!.tokenHash);
    expect(await repository.findPairing(id)).toMatchObject({ approvedUserId: userId, consumedAt: expect.any(Date) });
    await expect(repository.consumePairing({ id, now: new Date(), tokenHash: hex() })).resolves.toEqual({ kind: "unavailable" });
  });

  it("denies, expires and refuses a revoked approver or a code taken by another pairing", async () => {
    const userId = await account();
    const session = await authSession(userId);
    const denied = await pairing();
    await expect(repository.denyPairing({ now: new Date(), userCodeHash: denied.userCodeHash })).resolves.toBe("denied");
    await expect(repository.approvePairing({ authSessionId: session.id, now: new Date(), userCodeHash: denied.userCodeHash, userId }))
      .resolves.toBe("expired");

    const old = await pairing(new Date(Date.now() - 3_600_000));
    await expect(repository.approvePairing({ authSessionId: session.id, now: new Date(), userCodeHash: old.userCodeHash, userId }))
      .resolves.toBe("expired");
    await expect(repository.denyPairing({ now: new Date(), userCodeHash: old.userCodeHash })).resolves.toBe("expired");

    const pending = await pairing();
    await prisma.authSession.update({ data: { revokedAt: new Date(), revokedReason: "logout" }, where: { id: session.id } });
    await expect(repository.approvePairing({ authSessionId: session.id, now: new Date(), userCodeHash: pending.userCodeHash, userId }))
      .resolves.toBe("unauthorized");

    await expect(repository.createPairing({
      ...machine,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
      pollSecretHash: hex(),
      userCodeHash: pending.userCodeHash
    })).resolves.toBeNull();
  });

  it("counts devices and outstanding approvals against the account's limit", async () => {
    const userId = await account();
    const session = await authSession(userId);
    for (let index = 0; index < CONNECT_MAX_DEVICES_PER_USER - 1; index += 1) await device(userId);
    const last = await pairing();
    const excess = await pairing();

    await expect(repository.approvePairing({ authSessionId: session.id, now: new Date(), userCodeHash: last.userCodeHash, userId }))
      .resolves.toBe("approved");
    await expect(repository.approvePairing({ authSessionId: session.id, now: new Date(), userCodeHash: excess.userCodeHash, userId }))
      .resolves.toBe("device_limit");
    await device(userId);
    await expect(repository.consumePairing({ id: last.id, now: new Date(), tokenHash: hex() })).resolves.toEqual({ kind: "device_limit" });
  });

  it("enforces the stored formats and states in the database itself", async () => {
    const userId = await account();
    const rejected = (work: Promise<unknown>) => expect(work).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    await rejected(prisma.$executeRaw`INSERT INTO "ConnectDevice" ("id", "userId", "name", "hostname", "os", "arch", "clientVersion", "tokenHash")
      VALUES (${randomUUID()}, ${userId}, 'Synthetic', 'synthetic.local', 'linux', 'amd64', '0.3.20', ${hex().toUpperCase()})`);
    await rejected(prisma.$executeRaw`INSERT INTO "ConnectPairing" ("id", "userCodeHash", "pollSecretHash", "name", "hostname", "os", "arch",
      "clientVersion", "createdAt", "expiresAt")
      VALUES (${randomUUID()}, ${hex()}, ${hex()}, 'Synthetic', 'synthetic.local', 'linux', 'amd64', '0.3.20', now(), now())`);
    await rejected(prisma.$executeRaw`INSERT INTO "ConnectPairing" ("id", "userCodeHash", "pollSecretHash", "name", "hostname", "os", "arch",
      "clientVersion", "approvedUserId", "deniedAt", "createdAt", "expiresAt")
      VALUES (${randomUUID()}, ${hex()}, ${hex()}, 'Synthetic', 'synthetic.local', 'linux', 'amd64', '0.3.20', ${userId}, now(), now(),
        now() + interval '10 minutes')`);
    await rejected(prisma.$executeRaw`INSERT INTO "ConnectPairing" ("id", "userCodeHash", "pollSecretHash", "name", "hostname", "os", "arch",
      "clientVersion", "consumedAt", "createdAt", "expiresAt")
      VALUES (${randomUUID()}, ${hex()}, ${hex()}, 'Synthetic', 'synthetic.local', 'linux', 'amd64', '0.3.20', now(), now(),
        now() + interval '10 minutes')`);
    await rejected(prisma.$executeRaw`INSERT INTO "ConnectPolicy" ("id", "enabled", "version", "updatedAt") VALUES ('second', true, 1, now())`);
  });
});

describe("persisted AIQSA Connect devices", () => {
  it("finds a stream's device by token, refreshes it and knows when its account is no longer active", async () => {
    const userId = await account();
    const paired = await device(userId);
    const stored = await repository.findStreamDevice(paired.tokenHash);
    expect(stored).toMatchObject({ id: paired.id, lastSeenAt: null, tokenHash: paired.tokenHash, userActive: true, userId });
    await expect(repository.findStreamDevice(hex())).resolves.toBeNull();

    const seenAt = new Date("2026-10-19T10:00:00.000Z");
    await expect(repository.touchDevice({ clientVersion: "0.3.21", id: paired.id, lastSeenAt: seenAt, tokenHash: paired.tokenHash }))
      .resolves.toBe(true);
    await expect(repository.touchDevice({ id: paired.id, lastSeenAt: seenAt, tokenHash: hex() })).resolves.toBe(false);
    expect(await repository.listDevices(userId)).toEqual([expect.objectContaining({ clientVersion: "0.3.21", lastSeenAt: seenAt })]);

    await prisma.user.update({ data: { status: "disabled" }, where: { id: userId } });
    expect(await repository.findStreamDevice(paired.tokenHash)).toMatchObject({ userActive: false });
    await expect(repository.touchDevice({ id: paired.id, lastSeenAt: new Date(), tokenHash: paired.tokenHash })).resolves.toBe(false);
  });

  it("waits for a revocation in flight before it answers a stream's lookup", async () => {
    const userId = await account();
    const paired = await device(userId);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let deleted: () => void = () => undefined;
    const deleting = new Promise<void>((resolve) => {
      deleted = resolve;
    });
    const revocation = prisma.$transaction(async (tx) => {
      await tx.connectDevice.deleteMany({ where: { userId } });
      deleted();
      await held;
    }, { timeout: 20_000 });
    await deleting;
    const lookup = repository.findStreamDevice(paired.tokenHash);
    const settled = vi.fn();
    void lookup.then(settled);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).not.toHaveBeenCalled();
    release();
    await revocation;
    await expect(lookup).resolves.toBeNull();
  });

  it("deletes and lists only the owner's devices", async () => {
    const owner = await account();
    const other = await account();
    const own = await device(owner);
    const foreign = await device(other);

    await expect(repository.deviceExists({ id: foreign.id, userId: owner })).resolves.toBe(false);
    await expect(repository.deleteDevice({ id: foreign.id, userId: owner })).resolves.toBe(false);
    expect((await repository.listDevices(owner)).map((entry) => entry.id)).toEqual([own.id]);
    await expect(repository.deleteDevice({ id: own.id, userId: owner })).resolves.toBe(true);
    await expect(repository.deviceExists({ id: own.id, userId: owner })).resolves.toBe(false);
    await expect(repository.deviceExists({ id: foreign.id, userId: other })).resolves.toBe(true);
  });

  it("knows whether a browser session still authorizes its account", async () => {
    const userId = await account();
    const session = await authSession(userId);
    const other = await account();

    await expect(repository.isAuthSessionActive({ now: new Date(), sessionId: session.id, userId })).resolves.toBe(true);
    await expect(repository.isAuthSessionActive({ now: new Date(), sessionId: session.id, userId: other })).resolves.toBe(false);
    await prisma.authSession.update({ data: { revokedAt: new Date(), revokedReason: "logout" }, where: { id: session.id } });
    await expect(repository.isAuthSessionActive({ now: new Date(), sessionId: session.id, userId })).resolves.toBe(false);
  });

  it("revokes an account's devices and unconsumed approvals inside the caller's transaction", async () => {
    const userId = await account();
    const session = await authSession(userId);
    const other = await account();
    await device(userId);
    const kept = await device(other);
    const approved = await pairing();
    await repository.approvePairing({ authSessionId: session.id, now: new Date(), userCodeHash: approved.userCodeHash, userId });
    const relay = { disconnectUser: vi.fn() };

    await prisma.$transaction((tx) => revokeConnectDevicesForUser(tx, { userId }, relay));

    expect(await prisma.connectDevice.count({ where: { userId } })).toBe(0);
    await expect(repository.findPairing(approved.id)).resolves.toBeNull();
    await expect(repository.deviceExists({ id: kept.id, userId: other })).resolves.toBe(true);
    expect(relay.disconnectUser).toHaveBeenCalledWith(userId, { activeAuthSessionIds: [session.id] });
  });
});

describe("persisted AIQSA Connect switch", () => {
  it("changes only at the version the administrator read", async () => {
    const policies = createPrismaConnectPolicyRepository(prisma);
    const before = await policies.read();
    const adminId = await account();
    try {
      await expect(policies.update({ enabled: !before.enabled, expectedVersion: before.version + 1, userId: adminId }))
        .resolves.toEqual({ kind: "stale" });
      await expect(policies.update({ enabled: !before.enabled, expectedVersion: before.version, userId: adminId }))
        .resolves.toEqual({ kind: "ok", policy: { enabled: !before.enabled, version: before.version + 1 } });
      expect(await prisma.connectPolicy.findUnique({ where: { id: "installation" } })).toMatchObject({ updatedByUserId: adminId });
    } finally {
      await prisma.connectPolicy.update({ data: { enabled: before.enabled, updatedByUserId: null }, where: { id: "installation" } });
    }
  });
});

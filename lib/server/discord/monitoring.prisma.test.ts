// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DISCORD_MONITORING_KEYS_MAX } from "../../contracts/discord";
import { prisma } from "../prisma";
import { createPrismaDiscordMonitoringKeyStore, hashDiscordMonitoringSecret, newDiscordMonitoringSecret } from "./monitoring";

/**
 * Monitoring keys on a disposable database: the cap of five active keys under
 * concurrent creates, hashes only, revocation and the recorded last use. Keys
 * other tests left active are revoked first, since the cap counts every key;
 * each test removes the keys and the administrator it made.
 */

const store = createPrismaDiscordMonitoringKeyStore(prisma);
const users: string[] = [];

afterEach(async () => {
  await prisma.discordMonitoringKey.deleteMany({ where: { createdByUserId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
afterAll(() => prisma.$disconnect());

async function admin(): Promise<string> {
  const id = `discord-monitoring-${randomUUID()}`;
  users.push(id);
  await prisma.user.create({ data: { displayName: "Admin", id, role: "admin", status: "active" } });
  return id;
}

describe("Discord monitoring keys (stateful)", () => {
  it("lets at most five keys be active, even from concurrent creates, and keeps only their hashes", async () => {
    const createdByUserId = await admin();
    await prisma.discordMonitoringKey.updateMany({ data: { revokedAt: new Date() }, where: { revokedAt: null } });
    const secrets = Array.from({ length: 8 }, () => newDiscordMonitoringSecret());
    const outcomes = await Promise.all(secrets.map((secret) => store.create({
      createdByUserId, keyHash: hashDiscordMonitoringSecret(secret), now: new Date()
    })));
    expect(outcomes.filter((outcome) => outcome !== "limit")).toHaveLength(DISCORD_MONITORING_KEYS_MAX);
    expect(outcomes.filter((outcome) => outcome === "limit")).toHaveLength(3);
    const stored = await prisma.discordMonitoringKey.findMany({ select: { keyHash: true }, where: { createdByUserId } });
    for (const row of stored) expect(secrets).not.toContain(row.keyHash);
    const listed = await store.list();
    expect(listed.slice(0, 5).every((key) => key.revokedAt === null)).toBe(true);
    expect(JSON.stringify(listed)).not.toMatch(/[0-9a-f]{64}/u);
  });

  it("verifies only an active key's secret, records its use at most once a minute and refuses it once revoked", async () => {
    const createdByUserId = await admin();
    await prisma.discordMonitoringKey.updateMany({ data: { revokedAt: new Date() }, where: { revokedAt: null } });
    const secret = newDiscordMonitoringSecret();
    const key = await store.create({ createdByUserId, keyHash: hashDiscordMonitoringSecret(secret), now: new Date() });
    if (key === "limit") throw new Error("limit");
    const first = new Date();
    expect(await store.verify(secret, first)).toBe(true);
    expect(await store.verify(secret, new Date(first.getTime() + 30_000))).toBe(true);
    expect((await prisma.discordMonitoringKey.findUnique({ where: { id: key.id } }))!.lastUsedAt).toEqual(first);
    expect(await store.verify(newDiscordMonitoringSecret(), first)).toBe(false);
    expect(await store.verify("not a key", first)).toBe(false);

    expect(await store.revoke({ id: key.id, now: first })).toBe(true);
    expect(await store.revoke({ id: key.id, now: new Date(first.getTime() + 1_000) })).toBe(true);
    expect((await prisma.discordMonitoringKey.findUnique({ where: { id: key.id } }))!.revokedAt).toEqual(first);
    expect(await store.verify(secret, first)).toBe(false);
    expect(await store.revoke({ id: randomUUID(), now: first })).toBe(false);
  });
});

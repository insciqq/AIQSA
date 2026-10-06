import { createECDH, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createPrismaVapidKeyStore, openVapidKeyPair, sealVapidPrivateKey } from "./vapidKeys";
import { generateVapidKeyPair, vapidAuthorization } from "./webPushCrypto";

const encryptionKey = randomBytes(32);

function fakePrisma() {
  let row: { privateKeyEnvelope: string; publicKey: string } | null = null;
  const sqlText = (query: Prisma.Sql) => query.sql;
  return {
    $executeRaw: vi.fn(async (query: Prisma.Sql) => {
      expect(sqlText(query)).toContain("ON CONFLICT");
      const [, publicKey, privateKeyEnvelope] = query.values as string[];
      if (row) return 0;
      row = { privateKeyEnvelope: privateKeyEnvelope!, publicKey: publicKey! };
      return 1;
    }),
    $queryRaw: vi.fn(async () => row ? [row] : []),
    get row() { return row; }
  };
}

describe("VAPID key store", () => {
  it("creates the key pair once, keeps the private key encrypted and caches it", async () => {
    const prisma = fakePrisma();
    const generate = vi.fn(generateVapidKeyPair);
    const load = createPrismaVapidKeyStore(prisma as never, () => encryptionKey, generate);
    const [first, second] = await Promise.all([load(), load()]);
    expect(first).toEqual(second);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(prisma.row!.privateKeyEnvelope).not.toContain(first.privateKey);
    expect(prisma.row!.publicKey).toBe(first.publicKey);
    await load();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);

    // Another process reads the stored pair instead of generating its own.
    const other = createPrismaVapidKeyStore(prisma as never, () => encryptionKey, generate);
    expect(await other()).toEqual(first);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("converges on the stored row when a concurrent creator won", async () => {
    const prisma = fakePrisma();
    const winner = generateVapidKeyPair();
    const loser = generateVapidKeyPair();
    prisma.$queryRaw.mockResolvedValueOnce([]);
    await createPrismaVapidKeyStore(prisma as never, () => encryptionKey, () => winner)();
    prisma.$queryRaw.mockResolvedValueOnce([]);
    expect(await createPrismaVapidKeyStore(prisma as never, () => encryptionKey, () => loser)()).toEqual(winner);
  });

  it("opens only with the installation key and the matching public key, and retries after a failure", async () => {
    const keys = generateVapidKeyPair();
    const envelope = sealVapidPrivateKey(keys, encryptionKey);
    expect(openVapidKeyPair({ privateKeyEnvelope: envelope, publicKey: keys.publicKey }, encryptionKey)).toEqual(keys);
    expect(() => openVapidKeyPair({ privateKeyEnvelope: envelope, publicKey: keys.publicKey }, randomBytes(32))).toThrow();
    expect(() => openVapidKeyPair({ privateKeyEnvelope: envelope, publicKey: generateVapidKeyPair().publicKey }, encryptionKey)).toThrow();

    const prisma = fakePrisma();
    let available = false;
    const load = createPrismaVapidKeyStore(prisma as never, () => {
      if (!available) throw new Error("secret_encryption_invalid_key");
      return encryptionKey;
    });
    await expect(load()).rejects.toThrow("secret_encryption_invalid_key");
    available = true;
    await expect(load()).resolves.toMatchObject({ publicKey: expect.any(String) });
  });

  it("generates and opens 32-byte scalars, padding keys stored before padding", () => {
    // About one ECDH key in 256 has a leading zero byte that getPrivateKey() drops.
    for (let index = 0; index < 512; index++) {
      expect(Buffer.from(generateVapidKeyPair().privateKey, "base64url")).toHaveLength(32);
    }
    const ecdh = createECDH("prime256v1");
    const scalar = Buffer.concat([Buffer.alloc(1), randomBytes(31)]);
    ecdh.setPrivateKey(scalar);
    const stored = { privateKey: scalar.subarray(1).toString("base64url"),
      publicKey: ecdh.getPublicKey(null, "uncompressed").toString("base64url") };
    const opened = openVapidKeyPair({ privateKeyEnvelope: sealVapidPrivateKey(stored, encryptionKey),
      publicKey: stored.publicKey }, encryptionKey);
    expect(opened).toEqual({ privateKey: scalar.toString("base64url"), publicKey: stored.publicKey });
    expect(vapidAuthorization({ audience: "https://push.example", keys: opened, now: new Date(),
      subject: "mailto:admin@example.com" })).toContain(`k=${stored.publicKey}`);
  });
});

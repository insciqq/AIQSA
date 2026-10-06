import { Prisma, type PrismaClient } from "@prisma/client";
import { decryptSecretEnvelope, encryptSecretEnvelope, type SecretEnvelopeContext } from "../secrets/envelope";
import { decodeBase64Url, generateVapidKeyPair, padVapidPrivateKey, type VapidKeyPair } from "./webPushCrypto";

export const BROWSER_PUSH_VAPID_KEY_ID = "installation";
const VAPID_PRIVATE_KEY_PURPOSE = "browser_push_vapid_private_key";

type StoredVapidPrivateKey = Readonly<{ privateKey: string; version: 1 }>;

/** The envelope is bound to its public key, so a swapped row cannot decrypt. */
function context(publicKey: string): SecretEnvelopeContext {
  return { ownerId: BROWSER_PUSH_VAPID_KEY_ID, purpose: VAPID_PRIVATE_KEY_PURPOSE, valueId: publicKey };
}

export function sealVapidPrivateKey(keys: VapidKeyPair, encryptionKey: Buffer): string {
  return encryptSecretEnvelope({ privateKey: keys.privateKey, version: 1 } satisfies StoredVapidPrivateKey,
    encryptionKey, context(keys.publicKey));
}

export function openVapidKeyPair(row: Readonly<{ privateKeyEnvelope: string; publicKey: string }>, encryptionKey: Buffer): VapidKeyPair {
  const stored = decryptSecretEnvelope<StoredVapidPrivateKey>(row.privateKeyEnvelope, encryptionKey, context(row.publicKey));
  // Keys stored before generation padded the scalar may be shorter than 32 bytes.
  const scalar = stored?.version === 1 && typeof stored.privateKey === "string" ? decodeBase64Url(stored.privateKey) : null;
  if (!scalar || scalar.length < 1 || scalar.length > 32 || decodeBase64Url(row.publicKey)?.length !== 65) {
    throw new Error("browser_push_vapid_key_invalid");
  }
  return { privateKey: padVapidPrivateKey(scalar).toString("base64url"), publicKey: row.publicKey };
}

/**
 * Loads the installation's VAPID key pair, creating it on first use. Racing
 * creators converge on the first committed row; the result is cached for the
 * process. No environment variable is involved beyond `AIQSA_ENCRYPTION_KEY`.
 */
export function createPrismaVapidKeyStore(
  prisma: Pick<PrismaClient, "$executeRaw" | "$queryRaw">,
  encryptionKey: () => Buffer,
  generate: () => VapidKeyPair = generateVapidKeyPair
): () => Promise<VapidKeyPair> {
  let cached: Promise<VapidKeyPair> | null = null;
  async function load(): Promise<VapidKeyPair> {
    const key = encryptionKey();
    const read = async () => (await prisma.$queryRaw<Array<{ privateKeyEnvelope: string; publicKey: string }>>(Prisma.sql`
      SELECT "publicKey", "privateKeyEnvelope" FROM "BrowserPushVapidKey" WHERE "id" = ${BROWSER_PUSH_VAPID_KEY_ID}
    `))[0];
    const existing = await read();
    if (existing) return openVapidKeyPair(existing, key);
    const created = generate();
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "BrowserPushVapidKey" ("id", "publicKey", "privateKeyEnvelope")
      VALUES (${BROWSER_PUSH_VAPID_KEY_ID}, ${created.publicKey}, ${sealVapidPrivateKey(created, key)})
      ON CONFLICT ("id") DO NOTHING
    `);
    const stored = await read();
    if (!stored) throw new Error("browser_push_vapid_key_invalid");
    return openVapidKeyPair(stored, key);
  }
  return () => {
    cached ??= load().catch((error: unknown) => {
      cached = null;
      throw error;
    });
    return cached;
  };
}

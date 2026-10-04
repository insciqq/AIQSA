import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";

/**
 * Web Push message encryption (RFC 8291, `aes128gcm` of RFC 8188) and VAPID
 * (RFC 8292) with Node's own crypto. One record per message: AIQSA payloads
 * are small, content-free JSON.
 */

const CURVE = "prime256v1";
/** Record size advertised in the header; one record always fits a push message. */
const RECORD_SIZE = 4096;
/** The ciphertext of one record must stay within the push services' 4096-byte message limit. */
export const WEB_PUSH_MAX_PLAINTEXT_BYTES = 3_000;
const VAPID_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

export type VapidKeyPair = Readonly<{
  /** Uncompressed P-256 point, base64url (65 bytes). */
  publicKey: string;
  /** Private scalar, base64url (32 bytes). */
  privateKey: string;
}>;

export function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

/** A valid uncompressed P-256 public point, as browsers send `p256dh`. */
export function isP256PublicKey(value: Buffer): boolean {
  if (value.length !== 65 || value[0] !== 0x04) return false;
  try {
    // computeSecret validates that the point lies on the curve.
    const probe = createECDH(CURVE);
    probe.generateKeys();
    probe.computeSecret(value);
    return true;
  } catch {
    return false;
  }
}

export function generateVapidKeyPair(): VapidKeyPair {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey().toString("base64url"),
    publicKey: ecdh.getPublicKey(null, "uncompressed").toString("base64url")
  };
}

/** Encryption inputs that tests fix to reproduce the RFC 8291 example. */
export type WebPushEncryptionOverrides = Readonly<{
  /** Application server ECDH private key (32 bytes). */
  senderPrivateKey?: Buffer;
  salt?: Buffer;
}>;

/**
 * Encrypts one push message body for a subscription's `p256dh` and `auth`
 * keys. Returns the complete `aes128gcm` body: header and one final record.
 */
export function encryptWebPushPayload(
  plaintext: Buffer,
  subscription: Readonly<{ auth: Buffer; p256dh: Buffer }>,
  overrides: WebPushEncryptionOverrides = {}
): Buffer {
  if (plaintext.length > WEB_PUSH_MAX_PLAINTEXT_BYTES) throw new Error("web_push_payload_too_large");
  if (subscription.auth.length !== 16 || subscription.p256dh.length !== 65) throw new Error("web_push_subscription_invalid");
  const sender = createECDH(CURVE);
  if (overrides.senderPrivateKey) sender.setPrivateKey(overrides.senderPrivateKey);
  else sender.generateKeys();
  const senderPublic = sender.getPublicKey(null, "uncompressed");
  const sharedSecret = sender.computeSecret(subscription.p256dh);
  const salt = overrides.salt ?? randomBytes(16);
  if (salt.length !== 16) throw new Error("web_push_salt_invalid");

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), subscription.p256dh, senderPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", sharedSecret, subscription.auth, keyInfo, 32));
  const contentKey = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12));

  const cipher = createCipheriv("aes-128-gcm", contentKey, nonce);
  // 0x02 marks the last (and only) record; no further padding.
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([0x02])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.length, 20);
  return Buffer.concat([header, senderPublic, ciphertext]);
}

function signingKey(keys: VapidKeyPair) {
  const publicKey = decodeBase64Url(keys.publicKey);
  if (!publicKey || publicKey.length !== 65) throw new Error("web_push_vapid_key_invalid");
  return createPrivateKey({
    format: "jwk",
    key: {
      crv: "P-256",
      d: keys.privateKey,
      kty: "EC",
      x: publicKey.subarray(1, 33).toString("base64url"),
      y: publicKey.subarray(33, 65).toString("base64url")
    }
  });
}

/**
 * The `Authorization` header for one push service origin: an ES256 VAPID JWT
 * with the endpoint origin as audience and the installation as subject.
 */
export function vapidAuthorization(input: Readonly<{
  audience: string;
  keys: VapidKeyPair;
  now: Date;
  subject: string;
}>): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    aud: input.audience,
    exp: Math.floor(input.now.getTime() / 1000) + VAPID_TOKEN_LIFETIME_SECONDS,
    sub: input.subject
  })).toString("base64url");
  const signingInput = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(signingInput), { dsaEncoding: "ieee-p1363", key: signingKey(input.keys) });
  return `vapid t=${signingInput}.${signature.toString("base64url")}, k=${input.keys.publicKey}`;
}

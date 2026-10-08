import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import {
  decryptSecretEnvelope,
  encryptSecretEnvelope,
  getSecretEncryptionKey,
  type SecretEnvelopeContext
} from "../secrets/envelope";

/** RFC 6238 parameters every authenticator app defaults to: HMAC-SHA1, 30 s, 6 digits. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_SECRET_BYTES = 20;
/** Steps accepted on each side of the current one, for clock drift and slow typing. */
export const TOTP_WINDOW_STEPS = 1;
export const TOTP_ISSUER = "AIQSA";
export const RECOVERY_CODE_COUNT = 10;
/** Ten Crockford base32 characters: 50 bits each. */
export const RECOVERY_CODE_LENGTH = 10;

const RFC4648_BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TOTP_SECRET_PURPOSE = "auth_totp_secret";
const TOTP_SECRET_VALUE_ID = "totp";
const RECOVERY_CODE_KEY_DOMAIN = "aiqsa:auth-totp-recovery-code-key:v1\0";
const RECOVERY_CODE_HASH_DOMAIN = "aiqsa:auth-totp-recovery-code:v1\0";
const MAX_CODE_INPUT_LENGTH = 32;

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += RFC4648_BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += RFC4648_BASE32[(value << (5 - bits)) & 31];
  }

  return output;
}

/** Strict unpadded upper-case RFC 4648 base32, as this module writes it; null otherwise. */
export function decodeBase32(value: string): Buffer | null {
  if (!/^[A-Z2-7]+$/u.test(value)) {
    return null;
  }

  let bits = 0;
  let current = 0;
  const bytes: number[] = [];

  for (const character of value) {
    current = (current << 5) | RFC4648_BASE32.indexOf(character);
    bits += 5;

    if (bits >= 8) {
      bytes.push((current >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  const decoded = Buffer.from(bytes);

  return encodeBase32(decoded) === value ? decoded : null;
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(TOTP_SECRET_BYTES));
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/** RFC 4226 HOTP over the step counter (RFC 6238 with HMAC-SHA1). */
export function totpCodeAt(secret: Uint8Array, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;

  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Six digits, ignoring spaces an app or the user may insert; null for anything else. */
export function normalizeTotpCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_CODE_INPUT_LENGTH) {
    return null;
  }

  const code = value.replace(/\s+/gu, "");

  return new RegExp(`^[0-9]{${TOTP_DIGITS}}$`, "u").test(code) ? code : null;
}

function sameText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");

  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * The step a code belongs to within the window, or null. Replay guard: only a step after
 * `lastUsedStep` counts, so a code is accepted once and never after a later code was used.
 */
export function matchTotpStep(input: {
  code: string;
  lastUsedStep: number | null;
  now: Date;
  secret: Uint8Array;
}): number | null {
  const current = totpStep(input.now);
  let matched: number | null = null;

  // Every candidate is computed and compared, so timing does not reveal which step matched.
  for (let step = current - TOTP_WINDOW_STEPS; step <= current + TOTP_WINDOW_STEPS; step += 1) {
    const fresh = input.lastUsedStep === null || step > input.lastUsedStep;

    if (sameText(totpCodeAt(input.secret, step), input.code) && fresh && matched === null) {
      matched = step;
    }
  }

  return matched;
}

export function totpProvisioningUri(input: { accountLabel: string; secret: string }): string {
  const label = `${TOTP_ISSUER}:${input.accountLabel}`;
  const query = new URLSearchParams({
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    issuer: TOTP_ISSUER,
    period: String(TOTP_PERIOD_SECONDS),
    secret: input.secret
  });

  return `otpauth://totp/${encodeURIComponent(label).replace("%3A", ":")}?${query.toString()}`;
}

function totpSecretContext(userId: string): SecretEnvelopeContext {
  // Pending and confirmed secrets share one context, so confirming moves the envelope as is.
  return { ownerId: userId, purpose: TOTP_SECRET_PURPOSE, valueId: TOTP_SECRET_VALUE_ID };
}

export function encryptTotpSecret(input: { key: Buffer; secret: string; userId: string }): string {
  return encryptSecretEnvelope({ secret: input.secret, version: 1 }, input.key, totpSecretContext(input.userId), {
    maxPlaintextBytes: 1_024
  });
}

/** The secret bytes of an envelope this module wrote for this user; throws otherwise. */
export function decryptTotpSecret(input: { envelope: string; key: Buffer; userId: string }): Buffer {
  const stored = decryptSecretEnvelope<unknown>(input.envelope, input.key, totpSecretContext(input.userId), {
    maxPlaintextBytes: 1_024
  });
  const secret = typeof stored === "object" && stored && "secret" in stored && "version" in stored &&
    stored.version === 1 && typeof stored.secret === "string"
    ? decodeBase32(stored.secret)
    : null;

  if (!secret || secret.length !== TOTP_SECRET_BYTES) {
    throw new Error("totp_secret_invalid");
  }

  return secret;
}

/** Recovery codes as shown once: `XXXXX-XXXXX`, Crockford base32. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const characters = Array.from({ length: RECOVERY_CODE_LENGTH }, () => CROCKFORD_BASE32[randomInt(32)]).join("");

    return `${characters.slice(0, 5)}-${characters.slice(5)}`;
  });
}

/**
 * The canonical form of a typed recovery code: case, spaces and dashes are ignored, and the
 * letters people confuse with digits (O, I, L) read as those digits. Null when it cannot be one.
 */
export function normalizeRecoveryCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_CODE_INPUT_LENGTH) {
    return null;
  }

  const code = value
    .replace(/[\s-]+/gu, "")
    .toUpperCase()
    .replace(/O/gu, "0")
    .replace(/[IL]/gu, "1");

  return code.length === RECOVERY_CODE_LENGTH && [...code].every((character) => CROCKFORD_BASE32.includes(character))
    ? code
    : null;
}

/**
 * The recovery-code hash key. It derives from the encryption key that already protects the
 * TOTP secrets, so the codes stop working exactly when the secrets become unreadable, and a
 * database copy alone cannot test guesses offline.
 */
export function deriveRecoveryCodeKey(encryptionKey: Buffer): Buffer {
  return createHmac("sha256", encryptionKey).update(RECOVERY_CODE_KEY_DOMAIN, "utf8").digest();
}

export function hashRecoveryCode(input: { code: string; key: Buffer; userId: string }): string {
  return createHmac("sha256", input.key)
    .update(RECOVERY_CODE_HASH_DOMAIN, "utf8")
    .update(input.userId, "utf8")
    .update("\0", "utf8")
    .update(input.code, "utf8")
    .digest("hex");
}

/** The installation's TOTP keys; throws `SecretEnvelopeError` without a usable encryption key. */
export function getTotpKeys(env: Record<string, string | undefined> = process.env): { encryptionKey: Buffer; recoveryCodeKey: Buffer } {
  const encryptionKey = getSecretEncryptionKey(env);

  return { encryptionKey, recoveryCodeKey: deriveRecoveryCodeKey(encryptionKey) };
}

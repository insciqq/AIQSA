import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

const PASSWORD_HASH_VERSION = "aiqsa-scrypt-v1";
const PASSWORD_KEY_LENGTH = 64;
const SCRYPT_PARAMS = {
  N: 16384,
  maxmem: 32 * 1024 * 1024,
  p: 1,
  r: 8
};

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 1024;

export function normalizeAuthEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeAuthDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

export function authEmailDomain(normalizedEmail: string): string | null {
  const atIndex = normalizedEmail.lastIndexOf("@");

  if (atIndex < 0 || atIndex === normalizedEmail.length - 1) {
    return null;
  }

  return normalizeAuthDomain(normalizedEmail.slice(atIndex + 1));
}

export function isPlausibleEmail(email: string): boolean {
  const normalized = normalizeAuthEmail(email);

  return normalized.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return "password_too_short";
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    return "password_too_long";
  }

  return null;
}

function encode(value: Buffer): string {
  return value.toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function deriveKey(password: string, salt: Buffer, keyLength: number, params: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, params, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, PASSWORD_KEY_LENGTH, SCRYPT_PARAMS);
  const params = `N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`;

  return `${PASSWORD_HASH_VERSION}$${params}$${encode(salt)}$${encode(key)}`;
}

export async function verifyPassword(password: string, passwordHash: string | null | undefined): Promise<boolean> {
  if (!passwordHash) {
    return false;
  }

  const [version, params, encodedSalt, encodedKey] = passwordHash.split("$");

  if (version !== PASSWORD_HASH_VERSION || !params || !encodedSalt || !encodedKey) {
    return false;
  }

  const parsedParams = new Map(params.split(",").map((entry) => {
    const [key, value] = entry.split("=");

    return [key, value] as const;
  }));
  const N = Number(parsedParams.get("N"));
  const r = Number(parsedParams.get("r"));
  const p = Number(parsedParams.get("p"));

  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  const salt = decode(encodedSalt);
  const expected = decode(encodedKey);
  const actual = await deriveKey(password, salt, expected.length, {
    N,
    maxmem: SCRYPT_PARAMS.maxmem,
    p,
    r
  });

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

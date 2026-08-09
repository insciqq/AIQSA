import {
  createHmac,
  createSecretKey,
  timingSafeEqual,
  type KeyObject
} from "node:crypto";
import { inspect } from "node:util";

const KEYRING_ENV_NAME = "AIQSA_MEMORY_FINGERPRINT_KEYRING";
const KEYRING_MAX_BYTES = 32_768;
const KEYRING_MAX_KEYS = 256;
const REQUIRED_KEY_IDS_MAX = 4_096;
const FINGERPRINT_VALUE_MAX_BYTES = 1_048_576;
const KEY_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const CANONICAL_256_BIT_BASE64_PATTERN = /^[A-Za-z0-9+/]{43}=$/u;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const FINGERPRINT_PURPOSES = new Set<MemorySuppressionFingerprintPurpose>([
  "canonical_key",
  "normalized_value"
]);

export const MEMORY_SUPPRESSION_GUARDED_OPERATIONS = [
  "automatic_extraction",
  "resume",
  "redream",
  "rebuild"
] as const;

export type MemorySuppressionGuardedOperation =
  (typeof MEMORY_SUPPRESSION_GUARDED_OPERATIONS)[number];
export type MemorySuppressionPreflightOperation = MemorySuppressionGuardedOperation | "restore";
export type MemorySuppressionFingerprintPurpose = "canonical_key" | "normalized_value";

export type MemorySuppressionFingerprintInput = {
  normalizationVersion: string;
  purpose: MemorySuppressionFingerprintPurpose;
  userId: string;
  value: string;
};

export type MemorySuppressionFingerprint = {
  fingerprint: string;
  fingerprintKeyVersion: string;
};

export type MemorySuppressionKeyringErrorCode =
  | "memory_suppression_fingerprint_input_invalid"
  | "memory_suppression_keyring_invalid";

export class MemorySuppressionKeyringError extends Error {
  constructor(code: MemorySuppressionKeyringErrorCode) {
    super(code);
    this.name = "MemorySuppressionKeyringError";
  }
}

export type MemorySuppressionFingerprintVerification =
  | { status: "match" }
  | { status: "mismatch" }
  | {
      code: "memory_suppression_fingerprint_invalid";
      status: "blocked";
    }
  | {
      code: "memory_suppression_historical_key_missing";
      missingKeyIds: readonly string[];
      status: "blocked";
    };

export type MemorySuppressionKeyringConfiguration =
  | {
      keyring: MemorySuppressionKeyring;
      status: "ready";
    }
  | {
      code: "memory_suppression_keyring_invalid";
      status: "blocked";
    };

export type MemorySuppressionKeyPreflight =
  | {
      operation: MemorySuppressionPreflightOperation;
      status: "ready";
    }
  | {
      code:
        | "memory_suppression_historical_key_missing"
        | "memory_suppression_keyring_invalid"
        | "memory_suppression_required_key_ids_invalid";
      missingKeyIds: readonly string[];
      operation: MemorySuppressionPreflightOperation;
      status: "blocked";
    };

function invalidKeyring(): never {
  throw new MemorySuppressionKeyringError("memory_suppression_keyring_invalid");
}

function invalidFingerprintInput(): never {
  throw new MemorySuppressionKeyringError("memory_suppression_fingerprint_input_invalid");
}

function validKeyId(value: string): boolean {
  return KEY_ID_PATTERN.test(value) && value !== "current";
}

function decodeKey(value: string): KeyObject {
  if (!CANONICAL_256_BIT_BASE64_PATTERN.test(value)) {
    return invalidKeyring();
  }

  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length !== 32 ||
    decoded.toString("base64") !== value ||
    new Set(decoded).size < 16
  ) {
    decoded.fill(0);
    return invalidKeyring();
  }

  const key = createSecretKey(decoded);
  decoded.fill(0);
  return key;
}

function boundedContextPart(value: string, maxBytes: number): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function fingerprintPayload(input: MemorySuppressionFingerprintInput): Buffer {
  if (
    !boundedContextPart(input.userId, 256) ||
    !boundedContextPart(input.normalizationVersion, 128) ||
    !FINGERPRINT_PURPOSES.has(input.purpose) ||
    !input.value ||
    Buffer.byteLength(input.value, "utf8") > FINGERPRINT_VALUE_MAX_BYTES
  ) {
    return invalidFingerprintInput();
  }

  return Buffer.from(
    JSON.stringify({
      domain: "aiqsa.memory.suppression",
      normalizationVersion: input.normalizationVersion,
      purpose: input.purpose,
      userId: input.userId,
      value: input.value,
      version: "v1"
    }),
    "utf8"
  );
}

function decodeFingerprint(value: string): Buffer | null {
  if (!FINGERPRINT_PATTERN.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value ? decoded : null;
}

export class MemorySuppressionKeyring {
  readonly currentKeyId: string;
  readonly keyIds: readonly string[];
  readonly #keysById: ReadonlyMap<string, KeyObject>;

  private constructor(currentKeyId: string, keysById: ReadonlyMap<string, KeyObject>) {
    this.currentKeyId = currentKeyId;
    this.keyIds = Object.freeze([...keysById.keys()].sort());
    this.#keysById = keysById;
    Object.freeze(this);
  }

  static parse(value: string | undefined): MemorySuppressionKeyring {
    if (
      !value ||
      value.trim() !== value ||
      Buffer.byteLength(value, "utf8") > KEYRING_MAX_BYTES
    ) {
      return invalidKeyring();
    }

    const entries = value.split(",");
    if (entries.length < 2 || entries.length > KEYRING_MAX_KEYS + 1) {
      return invalidKeyring();
    }

    const currentSeparator = entries[0]?.indexOf("=") ?? -1;
    if (currentSeparator !== 7 || entries[0]?.slice(0, currentSeparator) !== "current") {
      return invalidKeyring();
    }
    const currentKeyId = entries[0].slice(currentSeparator + 1);
    if (!validKeyId(currentKeyId)) {
      return invalidKeyring();
    }

    const keysById = new Map<string, KeyObject>();
    const encodedKeys = new Set<string>();
    for (const entry of entries.slice(1)) {
      const separator = entry.indexOf("=");
      if (separator <= 0) {
        return invalidKeyring();
      }
      const keyId = entry.slice(0, separator);
      const encodedKey = entry.slice(separator + 1);
      if (
        !validKeyId(keyId) ||
        keysById.has(keyId) ||
        encodedKeys.has(encodedKey)
      ) {
        return invalidKeyring();
      }
      encodedKeys.add(encodedKey);
      keysById.set(keyId, decodeKey(encodedKey));
    }

    if (!keysById.has(currentKeyId)) {
      return invalidKeyring();
    }

    return new MemorySuppressionKeyring(currentKeyId, keysById);
  }

  hasKey(keyId: string): boolean {
    return this.#keysById.has(keyId);
  }

  fingerprint(input: MemorySuppressionFingerprintInput): MemorySuppressionFingerprint {
    const key = this.#keysById.get(this.currentKeyId);
    if (!key) {
      return invalidKeyring();
    }

    return Object.freeze({
      fingerprint: createHmac("sha256", key).update(fingerprintPayload(input)).digest("base64url"),
      fingerprintKeyVersion: this.currentKeyId
    });
  }

  verify(
    input: MemorySuppressionFingerprintInput,
    stored: MemorySuppressionFingerprint
  ): MemorySuppressionFingerprintVerification {
    if (!validKeyId(stored.fingerprintKeyVersion)) {
      return Object.freeze({
        code: "memory_suppression_fingerprint_invalid",
        status: "blocked"
      });
    }

    const key = this.#keysById.get(stored.fingerprintKeyVersion);
    if (!key) {
      return Object.freeze({
        code: "memory_suppression_historical_key_missing",
        missingKeyIds: Object.freeze([stored.fingerprintKeyVersion]),
        status: "blocked"
      });
    }

    const actual = decodeFingerprint(stored.fingerprint);
    if (!actual) {
      return Object.freeze({
        code: "memory_suppression_fingerprint_invalid",
        status: "blocked"
      });
    }

    const expected = createHmac("sha256", key).update(fingerprintPayload(input)).digest();
    return Object.freeze({
      status: timingSafeEqual(actual, expected) ? "match" : "mismatch"
    });
  }

  toJSON(): { currentKeyId: string; keyIds: readonly string[] } {
    return {
      currentKeyId: this.currentKeyId,
      keyIds: this.keyIds
    };
  }

  [inspect.custom](): { currentKeyId: string; keyIds: readonly string[] } {
    return this.toJSON();
  }
}

export function parseMemorySuppressionKeyring(value: string | undefined): MemorySuppressionKeyring {
  return MemorySuppressionKeyring.parse(value);
}

export function loadMemorySuppressionKeyring(
  env: Record<string, string | undefined> = process.env
): MemorySuppressionKeyringConfiguration {
  try {
    return Object.freeze({
      keyring: parseMemorySuppressionKeyring(env[KEYRING_ENV_NAME]),
      status: "ready"
    });
  } catch (error) {
    if (
      error instanceof MemorySuppressionKeyringError &&
      error.message === "memory_suppression_keyring_invalid"
    ) {
      return Object.freeze({
        code: "memory_suppression_keyring_invalid",
        status: "blocked"
      });
    }
    throw error;
  }
}

function normalizeRequiredKeyIds(requiredKeyIds: readonly string[]): readonly string[] | null {
  if (!Array.isArray(requiredKeyIds) || requiredKeyIds.length > REQUIRED_KEY_IDS_MAX) {
    return null;
  }

  const unique = new Set<string>();
  for (const keyId of requiredKeyIds) {
    if (typeof keyId !== "string" || !validKeyId(keyId)) {
      return null;
    }
    unique.add(keyId);
  }
  return Object.freeze([...unique].sort());
}

export function preflightMemorySuppressionKeys(
  configuration: MemorySuppressionKeyringConfiguration,
  requiredKeyIds: readonly string[],
  operation: MemorySuppressionPreflightOperation
): MemorySuppressionKeyPreflight {
  const normalizedRequiredKeyIds = normalizeRequiredKeyIds(requiredKeyIds);
  if (!normalizedRequiredKeyIds) {
    return Object.freeze({
      code: "memory_suppression_required_key_ids_invalid",
      missingKeyIds: Object.freeze([]),
      operation,
      status: "blocked"
    });
  }

  if (configuration.status === "blocked") {
    return Object.freeze({
      code: configuration.code,
      missingKeyIds: Object.freeze([]),
      operation,
      status: "blocked"
    });
  }

  const missingKeyIds = normalizedRequiredKeyIds.filter(
    (keyId) => !configuration.keyring.hasKey(keyId)
  );
  if (missingKeyIds.length > 0) {
    return Object.freeze({
      code: "memory_suppression_historical_key_missing",
      missingKeyIds: Object.freeze(missingKeyIds),
      operation,
      status: "blocked"
    });
  }

  return Object.freeze({ operation, status: "ready" });
}

export function preflightMemorySuppressionRestore(
  configuration: MemorySuppressionKeyringConfiguration,
  requiredKeyIds: readonly string[]
): MemorySuppressionKeyPreflight {
  return preflightMemorySuppressionKeys(configuration, requiredKeyIds, "restore");
}

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = "v2";
const MAX_CONTEXT_PART_BYTES = 512;
const MAX_PLAINTEXT_BYTES = 1_048_576;
/** Hard ceiling for a purpose that declares a larger bounded plaintext. */
const MAX_PLAINTEXT_BYTES_CEILING = 16 * 1_048_576;

export type SecretEnvelopeOptions = Readonly<{
  /** The caller's own serialized value bound; defaults to 1 MiB. */
  maxPlaintextBytes?: number;
}>;

function plaintextLimit(options: SecretEnvelopeOptions): number {
  const limit = options.maxPlaintextBytes ?? MAX_PLAINTEXT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PLAINTEXT_BYTES_CEILING) throw new Error("invalid");
  return limit;
}

export type SecretEnvelopeContext = {
  ownerId: string;
  purpose: string;
  valueId: string;
};

export type SecretEnvelopeErrorCode =
  | "secret_encryption_invalid_context"
  | "secret_encryption_invalid_envelope"
  | "secret_encryption_invalid_key";

export class SecretEnvelopeError extends Error {
  constructor(code: SecretEnvelopeErrorCode) {
    super(code);
    this.name = "SecretEnvelopeError";
  }
}

function canonicalBase64(value: string): string {
  return value.replace(/=+$/u, "");
}

function boundedContextPart(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_CONTEXT_PART_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function authenticatedContext(context: SecretEnvelopeContext): Buffer {
  if (
    !boundedContextPart(context.purpose) ||
    !boundedContextPart(context.ownerId) ||
    !boundedContextPart(context.valueId)
  ) {
    throw new SecretEnvelopeError("secret_encryption_invalid_context");
  }

  return Buffer.from(
    JSON.stringify({
      ownerId: context.ownerId,
      purpose: context.purpose,
      valueId: context.valueId,
      version: ENVELOPE_VERSION
    }),
    "utf8"
  );
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("invalid");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("invalid");
  }
  return decoded;
}

export function parseSecretEncryptionKey(value: string | undefined): Buffer {
  if (!value?.trim()) {
    throw new SecretEnvelopeError("secret_encryption_invalid_key");
  }

  const normalized = value.trim();
  let key: Buffer;
  try {
    key = Buffer.from(normalized, "base64");
  } catch {
    throw new SecretEnvelopeError("secret_encryption_invalid_key");
  }

  if (key.length !== 32 || canonicalBase64(key.toString("base64")) !== canonicalBase64(normalized)) {
    throw new SecretEnvelopeError("secret_encryption_invalid_key");
  }

  return key;
}

export function getSecretEncryptionKey(
  env: Record<string, string | undefined> = process.env
): Buffer {
  return parseSecretEncryptionKey(env.AIQSA_ENCRYPTION_KEY);
}

export function encryptSecretEnvelope(
  value: unknown,
  key: Buffer,
  context: SecretEnvelopeContext,
  options: SecretEnvelopeOptions = {}
): string {
  try {
    const limit = plaintextLimit(options);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    if (plaintext.length > limit) {
      throw new Error("invalid");
    }

    const nonce = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, key, nonce);
    cipher.setAAD(authenticatedContext(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      ENVELOPE_VERSION,
      nonce.toString("base64url"),
      ciphertext.toString("base64url"),
      tag.toString("base64url")
    ].join(".");
  } catch (error) {
    if (error instanceof SecretEnvelopeError) {
      throw error;
    }
    throw new SecretEnvelopeError("secret_encryption_invalid_envelope");
  }
}

export function decryptSecretEnvelope<T>(
  envelope: string,
  key: Buffer,
  context: SecretEnvelopeContext,
  options: SecretEnvelopeOptions = {}
): T {
  try {
    const limit = plaintextLimit(options);
    const [version, nonceValue, ciphertextValue, tagValue, extra] = envelope.split(".");
    if (version !== ENVELOPE_VERSION || !nonceValue || !ciphertextValue || !tagValue || extra ||
      ciphertextValue.length > Math.ceil(limit / 3) * 4) {
      throw new Error("invalid");
    }

    const nonce = decodeBase64Url(nonceValue);
    const ciphertext = decodeBase64Url(ciphertextValue);
    const tag = decodeBase64Url(tagValue);
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > limit) {
      throw new Error("invalid");
    }

    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAAD(authenticatedContext(context));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length > limit) {
      throw new Error("invalid");
    }

    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch (error) {
    if (error instanceof SecretEnvelopeError && error.message === "secret_encryption_invalid_context") {
      throw error;
    }
    throw new SecretEnvelopeError("secret_encryption_invalid_envelope");
  }
}

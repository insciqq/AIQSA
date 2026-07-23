import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = "v1";
const MAX_PLAINTEXT_BYTES = 1_048_576;

export class McpEncryptionError extends Error {
  constructor(code: "mcp_encryption_invalid_envelope" | "mcp_encryption_invalid_key") {
    super(code);
    this.name = "McpEncryptionError";
  }
}

export function parseMcpEncryptionKey(value: string | undefined): Buffer {
  if (!value?.trim()) {
    throw new McpEncryptionError("mcp_encryption_invalid_key");
  }

  let key: Buffer;
  try {
    key = Buffer.from(value.trim(), "base64");
  } catch {
    throw new McpEncryptionError("mcp_encryption_invalid_key");
  }

  if (key.length !== 32 || key.toString("base64").replace(/=+$/u, "") !== value.trim().replace(/=+$/u, "")) {
    throw new McpEncryptionError("mcp_encryption_invalid_key");
  }

  return key;
}

export function getMcpEncryptionKey(
  env: Record<string, string | undefined> = process.env
): Buffer {
  return parseMcpEncryptionKey(env.AIQSA_ENCRYPTION_KEY);
}

export function encryptMcpEnvelope(value: unknown, key: Buffer): string {
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new McpEncryptionError("mcp_encryption_invalid_envelope");
  }

  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    nonce.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url")
  ].join(".");
}

export function decryptMcpEnvelope<T>(envelope: string, key: Buffer): T {
  try {
    const [version, nonceValue, ciphertextValue, tagValue, extra] = envelope.split(".");
    if (version !== ENVELOPE_VERSION || !nonceValue || !ciphertextValue || !tagValue || extra) {
      throw new Error("invalid");
    }

    const nonce = Buffer.from(nonceValue, "base64url");
    const ciphertext = Buffer.from(ciphertextValue, "base64url");
    const tag = Buffer.from(tagValue, "base64url");
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_PLAINTEXT_BYTES) {
      throw new Error("invalid");
    }

    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    throw new McpEncryptionError("mcp_encryption_invalid_envelope");
  }
}

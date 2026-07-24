import { describe, expect, it } from "vitest";
import {
  decryptSecretEnvelope,
  encryptSecretEnvelope,
  getSecretEncryptionKey,
  parseSecretEncryptionKey,
  SecretEnvelopeError,
  type SecretEnvelopeContext
} from "./envelope";

const KEY = Buffer.alloc(32, 0x2a);
const OTHER_KEY = Buffer.alloc(32, 0x7b);
const CONTEXT: SecretEnvelopeContext = {
  ownerId: "credential-1",
  purpose: "provider_credential",
  valueId: "version-3"
};

function expectError(operation: () => unknown, code: SecretEnvelopeError["message"]): void {
  try {
    operation();
    throw new Error("Expected secret envelope operation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(SecretEnvelopeError);
    expect(error).toMatchObject({ message: code, name: "SecretEnvelopeError" });
  }
}

describe("secret encryption key", () => {
  it("accepts one canonical base64-encoded 32-byte installation key", () => {
    const encoded = KEY.toString("base64");

    expect(parseSecretEncryptionKey(encoded)).toEqual(KEY);
    expect(parseSecretEncryptionKey(encoded.replace(/=+$/u, ""))).toEqual(KEY);
    expect(getSecretEncryptionKey({ AIQSA_ENCRYPTION_KEY: encoded })).toEqual(KEY);
  });

  it("rejects missing, malformed, and incorrectly sized keys", () => {
    for (const value of [
      undefined,
      "",
      "not-base64!",
      Buffer.alloc(31).toString("base64"),
      `${KEY.toString("base64")}!`
    ]) {
      expectError(() => parseSecretEncryptionKey(value), "secret_encryption_invalid_key");
    }
  });
});

describe("purpose-bound v2 envelopes", () => {
  it("round-trips structured values with fresh nonces", () => {
    const value = { apiKey: "private-value", enabled: true };
    const first = encryptSecretEnvelope(value, KEY, CONTEXT);
    const second = encryptSecretEnvelope(value, KEY, CONTEXT);

    expect(first).toMatch(/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(first).not.toContain("private-value");
    expect(first).not.toBe(second);
    expect(decryptSecretEnvelope<typeof value>(first, KEY, CONTEXT)).toEqual(value);
  });

  it("rejects cross-purpose, cross-owner, and cross-value replay", () => {
    const envelope = encryptSecretEnvelope({ token: "secret" }, KEY, CONTEXT);

    for (const context of [
      { ...CONTEXT, purpose: "smtp_password" },
      { ...CONTEXT, ownerId: "credential-2" },
      { ...CONTEXT, valueId: "version-4" }
    ]) {
      expectError(
        () => decryptSecretEnvelope(envelope, KEY, context),
        "secret_encryption_invalid_envelope"
      );
    }
  });

  it("fails closed for tampering, the wrong key, and malformed envelopes", () => {
    const envelope = encryptSecretEnvelope({ token: "secret" }, KEY, CONTEXT);
    const parts = envelope.split(".");
    parts[3] = `${parts[3]?.startsWith("A") ? "B" : "A"}${parts[3]?.slice(1)}`;

    for (const operation of [
      () => decryptSecretEnvelope(parts.join("."), KEY, CONTEXT),
      () => decryptSecretEnvelope(envelope, OTHER_KEY, CONTEXT),
      () => decryptSecretEnvelope("v1.invalid.envelope.value", KEY, CONTEXT)
    ]) {
      expectError(operation, "secret_encryption_invalid_envelope");
    }
  });

  it("rejects invalid context and oversized plaintext", () => {
    expectError(
      () => encryptSecretEnvelope("value", KEY, { ...CONTEXT, purpose: "" }),
      "secret_encryption_invalid_context"
    );
    expectError(
      () => encryptSecretEnvelope("x".repeat(1_048_576), KEY, CONTEXT),
      "secret_encryption_invalid_envelope"
    );
  });
});

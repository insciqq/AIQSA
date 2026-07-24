import { describe, expect, it } from "vitest";
import {
  decryptMcpEnvelope,
  encryptMcpEnvelope,
  getMcpEncryptionKey,
  McpEncryptionError,
  mcpOAuthClientSecretEnvelopeContext,
  mcpOAuthTokenEnvelopeContext,
  mcpPersonalConfigEnvelopeContext,
  mcpRuntimeGenerationEnvelopeContext,
  mcpSharedConfigEnvelopeContext,
  parseMcpEncryptionKey
} from "./encryption";

const KEY = Buffer.alloc(32, 0x2a);
const OTHER_KEY = Buffer.alloc(32, 0x7b);
const CONTEXT = mcpSharedConfigEnvelopeContext("server-1", 3);

function expectEncryptionError(operation: () => unknown, message: McpEncryptionError["message"]): void {
  try {
    operation();
    throw new Error("Expected MCP encryption operation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(McpEncryptionError);
    expect(error).toMatchObject({ message, name: "McpEncryptionError" });
  }
}

describe("MCP encryption keys", () => {
  it("accepts one canonical base64-encoded 32-byte installation key", () => {
    const encoded = KEY.toString("base64");

    expect(parseMcpEncryptionKey(encoded)).toEqual(KEY);
    expect(parseMcpEncryptionKey(encoded.replace(/=+$/u, ""))).toEqual(KEY);
    expect(getMcpEncryptionKey({ AIQSA_ENCRYPTION_KEY: encoded })).toEqual(KEY);
  });

  it("rejects missing, malformed, and incorrectly sized keys with a stable error", () => {
    for (const value of [
      undefined,
      "",
      "not-base64!",
      Buffer.alloc(31).toString("base64"),
      `${KEY.toString("base64")}!`
    ]) {
      expectEncryptionError(
        () => parseMcpEncryptionKey(value),
        "mcp_encryption_invalid_key"
      );
    }
  });
});

describe("purpose-bound MCP v2 envelopes", () => {
  it("round-trips structured values and uses a fresh authenticated nonce", () => {
    const value = { apiKey: "private-value", enabled: true, retries: 3 };
    const first = encryptMcpEnvelope(value, KEY, CONTEXT);
    const second = encryptMcpEnvelope(value, KEY, CONTEXT);

    expect(first).toMatch(/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(first).not.toContain("private-value");
    expect(first).not.toBe(second);
    expect(decryptMcpEnvelope<typeof value>(first, KEY, CONTEXT)).toEqual(value);
    expect(decryptMcpEnvelope<typeof value>(second, KEY, CONTEXT)).toEqual(value);
  });

  it("rejects cross-purpose, cross-owner, cross-version, and cross-generation replay", () => {
    const envelope = encryptMcpEnvelope({ token: "secret" }, KEY, CONTEXT);
    const crossingContexts = [
      mcpSharedConfigEnvelopeContext("server-2", 3),
      mcpSharedConfigEnvelopeContext("server-1", 4),
      mcpPersonalConfigEnvelopeContext("server-1", 3),
      mcpOAuthClientSecretEnvelopeContext("server-1", 3),
      mcpOAuthTokenEnvelopeContext("server-1", 3),
      mcpRuntimeGenerationEnvelopeContext("server-1", "3")
    ];

    for (const context of crossingContexts) {
      expectEncryptionError(
        () => decryptMcpEnvelope(envelope, KEY, context),
        "mcp_encryption_invalid_envelope"
      );
    }
  });

  it("fails closed for v1, tampering, the wrong key, and malformed envelope structure", () => {
    const envelope = encryptMcpEnvelope({ token: "secret" }, KEY, CONTEXT);
    const parts = envelope.split(".");
    parts[3] = `${parts[3]?.startsWith("A") ? "B" : "A"}${parts[3]?.slice(1)}`;
    const tampered = parts.join(".");

    for (const operation of [
      () => decryptMcpEnvelope(tampered, KEY, CONTEXT),
      () => decryptMcpEnvelope(envelope, OTHER_KEY, CONTEXT),
      () => decryptMcpEnvelope("v1.invalid.envelope.value", KEY, CONTEXT),
      () => decryptMcpEnvelope("v2.invalid.envelope.value", KEY, CONTEXT)
    ]) {
      expectEncryptionError(operation, "mcp_encryption_invalid_envelope");
    }
  });

  it("rejects non-positive generations and plaintext beyond the bounded envelope size", () => {
    expectEncryptionError(
      () => mcpSharedConfigEnvelopeContext("server-1", 0),
      "mcp_encryption_invalid_envelope"
    );
    expectEncryptionError(
      () => encryptMcpEnvelope("x".repeat(1_048_576), KEY, CONTEXT),
      "mcp_encryption_invalid_envelope"
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  decryptProviderCredentialSecret,
  encryptProviderCredentialSecret,
  normalizeProviderCredentialSecret
} from "./credentialSecrets";

const KEY = Buffer.alloc(32, 0x2a);

describe("provider credential secrets", () => {
  it("round-trips only under the exact credential/value identity", () => {
    const envelope = encryptProviderCredentialSecret({
      credentialId: "credential-1",
      key: KEY,
      secret: "sk-private-value",
      valueId: "version-2"
    });

    expect(envelope).toMatch(/^v2\./u);
    expect(envelope).not.toContain("sk-private-value");
    expect(decryptProviderCredentialSecret({
      credentialId: "credential-1",
      envelope,
      key: KEY,
      valueId: "version-2"
    })).toBe("sk-private-value");
    expect(() => decryptProviderCredentialSecret({
      credentialId: "credential-1",
      envelope,
      key: KEY,
      valueId: "version-3"
    })).toThrow("secret_encryption_invalid_envelope");
  });

  it.each(["", "   ", "key\nheader", "x".repeat(16 * 1024 + 1)])(
    "rejects an invalid provider secret",
    (secret) => {
      expect(() => normalizeProviderCredentialSecret(secret))
        .toThrow("provider_credential_secret_invalid");
    }
  );
});

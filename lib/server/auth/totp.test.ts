// @vitest-environment node

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeBase32,
  decryptTotpSecret,
  deriveRecoveryCodeKey,
  encodeBase32,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  getTotpKeys,
  hashRecoveryCode,
  matchTotpStep,
  normalizeRecoveryCode,
  normalizeTotpCode,
  RECOVERY_CODE_COUNT,
  TOTP_SECRET_BYTES,
  totpCodeAt,
  totpProvisioningUri,
  totpStep
} from "./totp";

/** The RFC 6238 Appendix B SHA-1 seed. */
const rfcSecret = Buffer.from("12345678901234567890", "ascii");
const key = randomBytes(32);

describe("TOTP core", () => {
  it("matches the RFC 6238 SHA-1 test vectors, in 8 digits and in the 6 apps use", () => {
    const vectors: Array<[number, string]> = [
      [59, "94287082"],
      [1_111_111_109, "07081804"],
      [1_111_111_111, "14050471"],
      [1_234_567_890, "89005924"],
      [2_000_000_000, "69279037"],
      [20_000_000_000, "65353130"]
    ];

    for (const [seconds, expected] of vectors) {
      const step = totpStep(new Date(seconds * 1000));

      expect(totpCodeAt(rfcSecret, step, 8)).toBe(expected);
      expect(totpCodeAt(rfcSecret, step)).toBe(expected.slice(-6));
    }
  });

  it("round-trips 20-byte secrets through strict base32", () => {
    const secret = generateTotpSecret();

    expect(secret).toMatch(/^[A-Z2-7]{32}$/u);
    expect(decodeBase32(secret)).toHaveLength(TOTP_SECRET_BYTES);
    expect(encodeBase32(decodeBase32(secret)!)).toBe(secret);
    expect(encodeBase32(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(decodeBase32("mzxw6ytboi")).toBeNull();
    expect(decodeBase32("MZXW6YTBOI==")).toBeNull();
    expect(decodeBase32("MZXW6YTBO1")).toBeNull();
  });

  it("accepts the current step and one step on each side, nothing further", () => {
    const now = new Date(1_111_111_111_000);
    const step = totpStep(now);

    for (const offset of [-1, 0, 1]) {
      expect(matchTotpStep({ code: totpCodeAt(rfcSecret, step + offset), lastUsedStep: null, now, secret: rfcSecret }))
        .toBe(step + offset);
    }
    for (const offset of [-2, 2]) {
      expect(matchTotpStep({ code: totpCodeAt(rfcSecret, step + offset), lastUsedStep: null, now, secret: rfcSecret }))
        .toBeNull();
    }
    expect(matchTotpStep({ code: "000000", lastUsedStep: null, now, secret: randomBytes(20) })).toBeNull();
  });

  it("refuses a code from a step that was already used or precedes the last used one", () => {
    const now = new Date(1_234_567_890_000);
    const step = totpStep(now);
    const current = totpCodeAt(rfcSecret, step);

    expect(matchTotpStep({ code: current, lastUsedStep: step - 1, now, secret: rfcSecret })).toBe(step);
    // The same code in the same step is a replay.
    expect(matchTotpStep({ code: current, lastUsedStep: step, now, secret: rfcSecret })).toBeNull();
    // An older code stays refused after a newer one was used.
    expect(matchTotpStep({ code: totpCodeAt(rfcSecret, step - 1), lastUsedStep: step, now, secret: rfcSecret })).toBeNull();
    // The next step's code is still fresh.
    expect(matchTotpStep({ code: totpCodeAt(rfcSecret, step + 1), lastUsedStep: step, now, secret: rfcSecret })).toBe(step + 1);
  });

  it("normalizes typed codes and refuses anything else", () => {
    expect(normalizeTotpCode("123 456")).toBe("123456");
    expect(normalizeTotpCode(" 123456 ")).toBe("123456");
    for (const value of ["12345", "1234567", "12345a", "", 123456, null, "1".repeat(64)]) {
      expect(normalizeTotpCode(value)).toBeNull();
    }
  });

  it("builds the provisioning URI authenticator apps scan", () => {
    const uri = new URL(totpProvisioningUri({ accountLabel: "ada@example.test", secret: "JBSWY3DPEHPK3PXP" }));

    expect(uri.protocol).toBe("otpauth:");
    expect(uri.host).toBe("totp");
    expect(decodeURIComponent(uri.pathname)).toBe("/AIQSA:ada@example.test");
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      algorithm: "SHA1",
      digits: "6",
      issuer: "AIQSA",
      period: "30",
      secret: "JBSWY3DPEHPK3PXP"
    });
  });

  it("keeps the secret in a purpose- and owner-bound envelope", () => {
    const secret = generateTotpSecret();
    const envelope = encryptTotpSecret({ key, secret, userId: "user-1" });

    expect(envelope).not.toContain(secret);
    expect(decryptTotpSecret({ envelope, key, userId: "user-1" })).toEqual(decodeBase32(secret));
    expect(() => decryptTotpSecret({ envelope, key, userId: "user-2" })).toThrow();
    expect(() => decryptTotpSecret({ envelope, key: randomBytes(32), userId: "user-1" })).toThrow();
  });

  it("derives keys only from a valid encryption key", () => {
    expect(() => getTotpKeys({})).toThrow("secret_encryption_invalid_key");
    const keys = getTotpKeys({ AIQSA_ENCRYPTION_KEY: key.toString("base64") });

    expect(keys.encryptionKey).toEqual(key);
    expect(keys.recoveryCodeKey).toEqual(deriveRecoveryCodeKey(key));
    expect(keys.recoveryCodeKey).not.toEqual(key);
  });
});

describe("recovery codes", () => {
  it("generates ten distinct codes of at least 40 bits each", () => {
    const codes = generateRecoveryCodes();

    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) {
      // Ten Crockford base32 characters: 50 bits.
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/u);
      expect(normalizeRecoveryCode(code)).toBe(code.replace("-", ""));
    }
  });

  it("reads codes the way people type them", () => {
    expect(normalizeRecoveryCode("abcde-fghjk")).toBe("ABCDEFGHJK");
    expect(normalizeRecoveryCode(" o1l2i 3456 7")).toBe("0112134567");
    for (const value of ["ABCDE-FGHJ", "ABCDE-FGHJKM", "ABCDE-FGHJU", "", null, "A".repeat(40)]) {
      expect(normalizeRecoveryCode(value)).toBeNull();
    }
  });

  it("hashes codes per user under a key derived from the encryption key", () => {
    const recoveryKey = deriveRecoveryCodeKey(key);
    const hash = hashRecoveryCode({ code: "ABCDEFGHJK", key: recoveryKey, userId: "user-1" });

    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hash).toBe(hashRecoveryCode({ code: "ABCDEFGHJK", key: recoveryKey, userId: "user-1" }));
    expect(hash).not.toBe(hashRecoveryCode({ code: "ABCDEFGHJK", key: recoveryKey, userId: "user-2" }));
    expect(hash).not.toBe(hashRecoveryCode({ code: "ABCDEFGHJK", key: deriveRecoveryCodeKey(randomBytes(32)), userId: "user-1" }));
  });
});

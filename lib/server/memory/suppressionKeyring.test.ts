import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { loadMemorySuppressionKeyring, MEMORY_SUPPRESSION_GUARDED_OPERATIONS, MemorySuppressionKeyringError, parseMemorySuppressionKeyring, preflightMemorySuppressionKeys, type MemorySuppressionFingerprintInput } from "./suppressionKeyring";

function encodedKey(offset: number): string {
  return Buffer.from(Array.from({ length: 32 }, (_, index) => (index + offset) % 256)).toString(
    "base64"
  );
}

const KEY_V1 = encodedKey(11);
const KEY_V2 = encodedKey(73);
const INPUT: MemorySuppressionFingerprintInput = {
  normalizationVersion: "v1",
  purpose: "normalized_value",
  userId: "00000000-0000-4000-8000-000000000001",
  value: "normalized private value"
};

function expectInvalidKeyring(value: string | undefined): void {
  try {
    parseMemorySuppressionKeyring(value);
    throw new Error("Expected keyring parsing to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(MemorySuppressionKeyringError);
    expect(error).toMatchObject({
      message: "memory_suppression_keyring_invalid",
      name: "MemorySuppressionKeyringError"
    });
    if (value) {
      expect(String(error)).not.toContain(value);
      expect(inspect(error)).not.toContain(value);
    }
  }
}

describe("Memory suppression fingerprint keyring", () => {
  it("parses one strict current-key declaration and exposes only safe metadata", () => {
    const keyring = parseMemorySuppressionKeyring(`current=v2,v1=${KEY_V1},v2=${KEY_V2}`);

    expect(keyring.currentKeyId).toBe("v2");
    expect(keyring.keyIds).toEqual(["v1", "v2"]);
    expect(keyring.hasKey("v1")).toBe(true);
    expect(keyring.hasKey("missing")).toBe(false);
    expect(JSON.parse(JSON.stringify(keyring))).toEqual({
      currentKeyId: "v2",
      keyIds: ["v1", "v2"]
    });
    expect(inspect(keyring)).not.toContain(KEY_V1);
    expect(inspect(keyring)).not.toContain(KEY_V2);
    expect(JSON.stringify(keyring)).not.toContain(KEY_V1);
    expect(JSON.stringify(keyring)).not.toContain(KEY_V2);
  });

  it("fails closed for missing, malformed, duplicate, missing-current, and weak keyrings", () => {
    for (const value of [
      undefined,
      "",
      ` current=v1,v1=${KEY_V1}`,
      `v1=${KEY_V1}`,
      `current=v2,v1=${KEY_V1}`,
      `current=v1,v1=${KEY_V1},v1=${KEY_V2}`,
      `current=v1,v1=${KEY_V1},v2=${KEY_V1}`,
      `current=current,current=${KEY_V1}`,
      `current=V1,V1=${KEY_V1}`,
      `current=v1,v1=${Buffer.alloc(31, 1).toString("base64")}`,
      `current=v1,v1=${Buffer.alloc(32, 0).toString("base64")}`,
      `current=v1,v1=${KEY_V1.slice(0, -1)}`,
      `current=v1,v1=${KEY_V1}!`
    ]) {
      expectInvalidKeyring(value);
    }
  });

  it("loads feature-local blocked status without accepting the encryption key as a substitute", () => {
    const encryptionOnly = loadMemorySuppressionKeyring({
      AIQSA_ENCRYPTION_KEY: KEY_V1
    });
    expect(encryptionOnly).toEqual({
      code: "memory_suppression_keyring_invalid",
      status: "blocked"
    });

    const configured = loadMemorySuppressionKeyring({
      AIQSA_ENCRYPTION_KEY: KEY_V2,
      AIQSA_MEMORY_FINGERPRINT_KEYRING: `current=v1,v1=${KEY_V1}`
    });
    expect(configured.status).toBe("ready");
    expect(JSON.stringify(configured)).not.toContain(KEY_V1);
    expect(JSON.stringify(configured)).not.toContain(KEY_V2);
  });
});

describe("Memory suppression fingerprints", () => {
  it("creates deterministic domain-separated HMAC-SHA-256 fingerprints with the current ID", () => {
    const keyring = parseMemorySuppressionKeyring(`current=v1,v1=${KEY_V1}`);
    const baseline = keyring.fingerprint(INPUT);

    expect(baseline).toEqual(keyring.fingerprint(INPUT));
    expect(baseline).toEqual({
      fingerprint: "1ar4R601FRQWlUi97BunhUpnLyMneq30CoUEeafFTnI",
      fingerprintKeyVersion: "v1"
    });
    expect(baseline.fingerprint).not.toContain(INPUT.value);

    for (const changed of [
      { ...INPUT, userId: "00000000-0000-4000-8000-000000000002" },
      { ...INPUT, purpose: "canonical_key" as const },
      { ...INPUT, normalizationVersion: "v2" }
    ]) {
      expect(keyring.fingerprint(changed).fingerprint).not.toBe(baseline.fingerprint);
    }
  });

  it("verifies retained rotation keys while writing only with the new current key", () => {
    const oldKeyring = parseMemorySuppressionKeyring(`current=v1,v1=${KEY_V1}`);
    const oldFingerprint = oldKeyring.fingerprint(INPUT);
    const rotated = parseMemorySuppressionKeyring(
      `current=v2,v1=${KEY_V1},v2=${KEY_V2}`
    );

    expect(rotated.verify(INPUT, oldFingerprint)).toEqual({ status: "match" });
    expect(rotated.verify({ ...INPUT, value: "different" }, oldFingerprint)).toEqual({
      status: "mismatch"
    });
    expect(rotated.fingerprint(INPUT).fingerprintKeyVersion).toBe("v2");

    const withoutHistoricalKey = parseMemorySuppressionKeyring(`current=v2,v2=${KEY_V2}`);
    expect(withoutHistoricalKey.verify(INPUT, oldFingerprint)).toEqual({
      code: "memory_suppression_historical_key_missing",
      missingKeyIds: ["v1"],
      status: "blocked"
    });
  });

  it("blocks malformed stored fingerprints and invalid private input without echoing it", () => {
    const keyring = parseMemorySuppressionKeyring(`current=v1,v1=${KEY_V1}`);
    expect(
      keyring.verify(INPUT, {
        fingerprint: "not-a-fingerprint",
        fingerprintKeyVersion: "v1"
      })
    ).toEqual({
      code: "memory_suppression_fingerprint_invalid",
      status: "blocked"
    });

    const privateValue = "private-value-that-must-not-escape";
    try {
      keyring.fingerprint({ ...INPUT, value: privateValue, userId: "" });
      throw new Error("Expected fingerprinting to fail.");
    } catch (error) {
      expect(error).toMatchObject({
        message: "memory_suppression_fingerprint_input_invalid"
      });
      expect(String(error)).not.toContain(privateValue);
      expect(inspect(error)).not.toContain(privateValue);
    }
  });
});

describe("Memory suppression key preflight", () => {
  const configured = loadMemorySuppressionKeyring({
    AIQSA_MEMORY_FINGERPRINT_KEYRING: `current=v2,v1=${KEY_V1},v2=${KEY_V2}`
  });

  it("blocks every protected automatic operation when a historical key is missing", () => {
    for (const operation of MEMORY_SUPPRESSION_GUARDED_OPERATIONS) {
      expect(preflightMemorySuppressionKeys(configured, ["v1", "v0", "v0"], operation)).toEqual({
        code: "memory_suppression_historical_key_missing",
        missingKeyIds: ["v0"],
        operation,
        status: "blocked"
      });
    }
  });
});

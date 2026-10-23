import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RUNNER_RELAY_PROOF_MAX_SKEW_SECONDS,
  runnerRelayProofKey,
  signRunnerRelayProof,
  verifyRunnerRelayProof
} from "./runnerGatewayProof";

const runnerToken = "synthetic-runner-token-".padEnd(48, "0");
const otherRunnerToken = "another-synthetic-runner-token-".padEnd(48, "0");
const key = runnerRelayProofKey(runnerToken)!;
const subject = { bearer: "b".repeat(43), method: "POST", path: "mcp" } as const;
const now = Date.UTC(2026, 9, 7, 12, 0, 0);
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

describe("runner relay proof", () => {
  it("derives a purpose-separated key and fails closed without a usable runner token", () => {
    expect(key).toHaveLength(32);
    expect(runnerRelayProofKey(` ${runnerToken}\n`)).toEqual(key);
    expect(key.equals(Buffer.from(runnerToken))).toBe(false);
    expect(key.equals(createHash("sha256").update(runnerToken).digest())).toBe(false);
    expect(runnerRelayProofKey(otherRunnerToken)).not.toEqual(key);
    const proof = signRunnerRelayProof(key, subject, now);
    for (const token of [undefined, "", "   ", "t".repeat(31)]) {
      expect(runnerRelayProofKey(token)).toBeNull();
      expect(verifyRunnerRelayProof(runnerRelayProofKey(token), proof, subject, now)).toBe(false);
    }
  });

  it("binds the proof to the key, method, endpoint and bearer", () => {
    const proof = signRunnerRelayProof(key, subject, now);
    expect(proof).toMatch(/^v1\.[0-9]{10}\.[A-Za-z0-9_-]{43}$/u);
    expect(verifyRunnerRelayProof(key, proof, subject, now)).toBe(true);
    for (const other of [{ method: "GET" }, { path: "v1/responses" }, { bearer: "c".repeat(43) }]) {
      expect(verifyRunnerRelayProof(key, proof, { ...subject, ...other }, now)).toBe(false);
    }
    expect(verifyRunnerRelayProof(runnerRelayProofKey(otherRunnerToken), proof, subject, now)).toBe(false);
  });

  it("accepts only a bounded clock skew, so an old proof cannot be replayed", () => {
    const proof = signRunnerRelayProof(key, subject, now);
    const skew = RUNNER_RELAY_PROOF_MAX_SKEW_SECONDS * 1000;
    expect(verifyRunnerRelayProof(key, proof, subject, now + skew)).toBe(true);
    expect(verifyRunnerRelayProof(key, proof, subject, now - skew)).toBe(true);
    expect(verifyRunnerRelayProof(key, proof, subject, now + skew + 1000)).toBe(false);
    expect(verifyRunnerRelayProof(key, proof, subject, now - skew - 1000)).toBe(false);
  });

  it("refuses malformed, duplicated or non-canonical headers", () => {
    const proof = signRunnerRelayProof(key, subject, now);
    const [, timestamp, mac] = proof.split(".");
    // The last character carries two unused bits; setting one decodes to the same MAC bytes.
    const nonCanonicalMac = `${mac.slice(0, 42)}${BASE64URL[BASE64URL.indexOf(mac.slice(-1)) + 1]}`;
    expect(Buffer.from(nonCanonicalMac, "base64url")).toEqual(Buffer.from(mac, "base64url"));
    const nonCanonical = `v1.${timestamp}.${nonCanonicalMac}`;
    for (const value of [null, "", "v1", proof.replace(/^v1\./u, "v2."), `${proof}x`, ` ${proof}`,
      `${proof}, ${proof}`, `v1.${timestamp}`, `v1..${mac}`, `v1.${timestamp}.${mac}.${mac}`,
      `v1.${timestamp}.${mac}=`, nonCanonical, `v1.${timestamp}.${"A".repeat(43)}`, "v".repeat(4096)]) {
      expect(verifyRunnerRelayProof(key, value, subject, now)).toBe(false);
    }
  });
});

// @vitest-environment node

import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  decodeBase32,
  deriveRecoveryCodeKey,
  encryptTotpSecret,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  totpCodeAt,
  totpStep
} from "./totp";
import { replaceRecoveryCodes, totpFactorBinding, verifySecondFactorAttempt } from "./totpFactor";

const encryptionKey = randomBytes(32);
const keys = { encryptionKey, recoveryCodeKey: deriveRecoveryCodeKey(encryptionKey) };
const now = new Date("2026-10-08T12:00:00.000Z");
const secret = generateTotpSecret();
const factor = {
  confirmedAt: new Date("2026-10-01T00:00:00.000Z"),
  lastUsedStep: BigInt(totpStep(now) - 5),
  secretEnvelope: encryptTotpSecret({ key: encryptionKey, secret, userId: "user-1" }),
  userId: "user-1"
};

function transaction(spentRecoveryCodes = 1) {
  return {
    authRecoveryCode: {
      count: vi.fn(async () => 3),
      createMany: vi.fn(async (input: { data: object[] }) => ({ count: input.data.length })),
      deleteMany: vi.fn(async () => ({ count: 10 })),
      updateMany: vi.fn(async () => ({ count: spentRecoveryCodes }))
    },
    authTotpFactor: { update: vi.fn(async () => ({})) }
  };
}

describe("second-factor verification", () => {
  it("accepts the current code and records its step as used", async () => {
    const tx = transaction();
    const code = totpCodeAt(decodeBase32(secret)!, totpStep(now));

    await expect(verifySecondFactorAttempt(tx as never, { attempt: { code, kind: "totp" }, factor, keys, now }))
      .resolves.toEqual({ userId: "user-1" });
    expect(tx.authTotpFactor.update).toHaveBeenCalledWith({
      data: { lastUsedStep: BigInt(totpStep(now)) },
      where: { userId: "user-1" }
    });
  });

  it("refuses a replayed, wrong or malformed code and changes nothing", async () => {
    const tx = transaction();
    const step = totpStep(now);
    const used = { ...factor, lastUsedStep: BigInt(step) };
    const current = totpCodeAt(decodeBase32(secret)!, step);

    for (const [attemptFactor, code] of [[used, current], [factor, "000000"], [factor, "12345"], [factor, null]] as const) {
      await expect(verifySecondFactorAttempt(tx as never, { attempt: { code, kind: "totp" }, factor: attemptFactor, keys, now }))
        .resolves.toBeNull();
    }
    expect(tx.authTotpFactor.update).not.toHaveBeenCalled();
  });

  it("spends a recovery code exactly once through a conditional update", async () => {
    const tx = transaction(1);

    await expect(verifySecondFactorAttempt(tx as never, { attempt: { code: "abcde fghjk", kind: "recovery" }, factor, keys, now }))
      .resolves.toEqual({ userId: "user-1" });
    expect(tx.authRecoveryCode.updateMany).toHaveBeenCalledWith({
      data: { usedAt: now },
      where: {
        codeHash: hashRecoveryCode({ code: "ABCDEFGHJK", key: keys.recoveryCodeKey, userId: "user-1" }),
        usedAt: null,
        userId: "user-1"
      }
    });

    const spent = transaction(0);
    await expect(verifySecondFactorAttempt(spent as never, { attempt: { code: "ABCDE-FGHJK", kind: "recovery" }, factor, keys, now }))
      .resolves.toBeNull();
    await expect(verifySecondFactorAttempt(spent as never, { attempt: { code: "nope", kind: "recovery" }, factor, keys, now }))
      .resolves.toBeNull();
    expect(spent.authRecoveryCode.updateMany).toHaveBeenCalledTimes(1);
  });

  it("never verifies against an unconfirmed factor", async () => {
    const tx = transaction();
    const pending = { ...factor, confirmedAt: null, secretEnvelope: null };

    await expect(verifySecondFactorAttempt(tx as never, {
      attempt: { code: totpCodeAt(decodeBase32(secret)!, totpStep(now)), kind: "totp" },
      factor: pending,
      keys,
      now
    })).resolves.toBeNull();
    await expect(totpFactorBinding(tx as never, pending)).resolves.toBeNull();
  });

  it("binds challenges to the confirmation, the last used step and the spent recovery codes", async () => {
    await expect(totpFactorBinding(transaction() as never, factor))
      .resolves.toBe(`${factor.confirmedAt.getTime()}:${factor.lastUsedStep}:3`);
  });

  it("replaces all recovery codes with ten new hashed ones", async () => {
    const tx = transaction();
    const codes = await replaceRecoveryCodes(tx as never, { keys, userId: "user-1" });

    expect(codes).toHaveLength(10);
    expect(tx.authRecoveryCode.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(tx.authRecoveryCode.createMany).toHaveBeenCalledWith({
      data: codes.map((code) => ({
        codeHash: hashRecoveryCode({ code: normalizeRecoveryCode(code)!, key: keys.recoveryCodeKey, userId: "user-1" }),
        userId: "user-1"
      }))
    });
    expect(JSON.stringify(tx.authRecoveryCode.createMany.mock.calls)).not.toContain(codes[0]!.replace("-", ""));
  });
});

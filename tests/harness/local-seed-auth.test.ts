import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../lib/server/auth/password";
import {
  assertLocalSeedRuntime,
  ensureLocalOperatorPasswordHash,
  isLocalSeedRuntime,
  LOCAL_OPERATOR_EMAIL,
  LOCAL_OPERATOR_PASSWORD
} from "../../prisma/local-seed-auth";

describe("local seed auth", () => {
  it("keeps the documented disposable local credential stable", () => {
    expect(LOCAL_OPERATOR_EMAIL).toBe("operator@aiqsa.local");
    expect(LOCAL_OPERATOR_PASSWORD).toBe("AIQSA-local-2026!");
  });

  it("allows only an explicitly local non-production runtime", () => {
    expect(isLocalSeedRuntime({ APP_ENV: "local" })).toBe(true);
    expect(isLocalSeedRuntime({ APP_ENV: "local", NODE_ENV: "development" })).toBe(true);
    expect(isLocalSeedRuntime({ APP_ENV: "local", NODE_ENV: "test" })).toBe(true);
    expect(() => assertLocalSeedRuntime({ APP_ENV: "local", NODE_ENV: "test" })).not.toThrow();
  });

  it("retains a matching password hash and repairs wrong or malformed hashes", async () => {
    const matchingHash = await hashPassword(LOCAL_OPERATOR_PASSWORD);
    const wrongHash = await hashPassword("different-local-password");

    await expect(ensureLocalOperatorPasswordHash(matchingHash)).resolves.toBe(matchingHash);

    const repairedWrongHash = await ensureLocalOperatorPasswordHash(wrongHash);
    const repairedMalformedHash = await ensureLocalOperatorPasswordHash("not-a-valid-password-hash");

    expect(repairedWrongHash).not.toBe(wrongHash);
    await expect(verifyPassword(LOCAL_OPERATOR_PASSWORD, repairedWrongHash)).resolves.toBe(true);
    await expect(verifyPassword(LOCAL_OPERATOR_PASSWORD, repairedMalformedHash)).resolves.toBe(true);
  });

  it.each([
    { env: {}, reason: "unset APP_ENV" },
    { env: { APP_ENV: "production" }, reason: "production APP_ENV" },
    { env: { APP_ENV: "staging" }, reason: "non-local APP_ENV" },
    { env: { APP_ENV: "LOCAL" }, reason: "non-exact local APP_ENV" },
    { env: { APP_ENV: " local " }, reason: "padded local APP_ENV" },
    { env: { APP_ENV: "local", NODE_ENV: "production" }, reason: "production NODE_ENV" },
    { env: { APP_ENV: "local", NODE_ENV: " Production " }, reason: "normalized production NODE_ENV" }
  ])("rejects $reason", ({ env }) => {
    expect(isLocalSeedRuntime(env)).toBe(false);
    expect(() => assertLocalSeedRuntime(env)).toThrow(
      "AIQSA demo seed requires APP_ENV=local and refuses NODE_ENV=production"
    );
  });
});

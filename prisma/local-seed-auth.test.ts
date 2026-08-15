import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../lib/server/auth/password";
import {
  assertLocalSeedRuntime,
  ensureLocalFixturePasswordHash,
  ensureLocalOperatorPasswordHash,
  isLocalSeedRuntime,
  LOCAL_OPERATOR_EMAIL,
  LOCAL_OPERATOR_PASSWORD
} from "./local-seed-auth";
import {
  LOCAL_MCP_MEMBER,
  LOCAL_ORDINARY_USERS,
  LOCAL_RESTRICTED_MEMBER
} from "./local-seed-fixtures";

describe("local seed auth", () => {
  it("keeps the documented disposable local credential stable", () => {
    expect(LOCAL_OPERATOR_EMAIL).toBe("operator@aiqsa.local");
    expect(LOCAL_OPERATOR_PASSWORD).toBe("AIQSA-local-2026!");
  });

  it("defines exactly two deterministic ordinary-user credentials for disposable seeds", () => {
    expect(LOCAL_ORDINARY_USERS).toHaveLength(2);
    expect(LOCAL_ORDINARY_USERS).toEqual([LOCAL_MCP_MEMBER, LOCAL_RESTRICTED_MEMBER]);
    expect(LOCAL_ORDINARY_USERS.map((user) => user.email)).toEqual([
      "mcp-member@aiqsa.local",
      "restricted-member@aiqsa.local"
    ]);
    expect(new Set(LOCAL_ORDINARY_USERS.map((user) => user.id)).size).toBe(2);
    expect(new Set(LOCAL_ORDINARY_USERS.map((user) => user.password)).size).toBe(2);
  });

  it("allows only an explicit non-production test runtime", () => {
    expect(isLocalSeedRuntime({ AIQSA_TEST_MODE: "1" })).toBe(true);
    expect(isLocalSeedRuntime({ AIQSA_TEST_MODE: "1", NODE_ENV: "development" })).toBe(true);
    expect(isLocalSeedRuntime({ AIQSA_TEST_MODE: "1", NODE_ENV: "test" })).toBe(true);
    expect(() => assertLocalSeedRuntime({ AIQSA_TEST_MODE: "1", NODE_ENV: "test" })).not.toThrow();
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

    const fixtureHash = await ensureLocalFixturePasswordHash(LOCAL_MCP_MEMBER.password, null);
    await expect(verifyPassword(LOCAL_MCP_MEMBER.password, fixtureHash)).resolves.toBe(true);
  });

  it.each([
    { env: {}, reason: "unset test mode" },
    { env: { AIQSA_TEST_MODE: "true" }, reason: "non-exact test mode" },
    { env: { AIQSA_TEST_MODE: " 1 " }, reason: "padded test mode" },
    { env: { AIQSA_TEST_MODE: "1", NODE_ENV: "production" }, reason: "production NODE_ENV" },
    { env: { AIQSA_TEST_MODE: "1", NODE_ENV: " Production " }, reason: "normalized production NODE_ENV" }
  ])("rejects $reason", ({ env }) => {
    expect(isLocalSeedRuntime(env)).toBe(false);
    expect(() => assertLocalSeedRuntime(env)).toThrow(
      "AIQSA demo seed requires AIQSA_TEST_MODE=1 and refuses NODE_ENV=production"
    );
  });
});

import { describe, expect, it } from "vitest";
import { hashPassword, isPlausibleEmail, normalizeAuthEmail, validatePassword, verifyPassword } from "./password";

describe("password auth helpers", () => {
  it("normalizes and validates login emails", () => {
    expect(normalizeAuthEmail("  Operator@AIQSA.Local ")).toBe("operator@aiqsa.local");
    expect(isPlausibleEmail("operator@aiqsa.local")).toBe(true);
    expect(isPlausibleEmail("not-an-email")).toBe(false);
  });

  it("validates password length bounds", () => {
    expect(validatePassword("short")).toBe("password_too_short");
    expect(validatePassword("long-enough")).toBeNull();
  });

  it("hashes passwords with a versioned scrypt format and verifies by timing-safe compare", async () => {
    const passwordHash = await hashPassword("correct-password");

    expect(passwordHash).toMatch(/^aiqsa-scrypt-v1\$/);
    await expect(verifyPassword("correct-password", passwordHash)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", passwordHash)).resolves.toBe(false);
    await expect(verifyPassword("correct-password", "unknown-format")).resolves.toBe(false);
  });
});

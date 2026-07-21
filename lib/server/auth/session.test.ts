import { describe, expect, it } from "vitest";
import {
  createSessionClearCookie,
  createSessionSetCookie,
  createSessionToken,
  readCookie,
  SESSION_COOKIE_NAME,
  sessionExpiresAt
} from "./session";
import { hashToken, verifyTokenHash } from "./token";

describe("auth token and session helpers", () => {
  it("verifies token hashes without storing plaintext", () => {
    const hash = hashToken("local-token");

    expect(hash).not.toBe("local-token");
    expect(verifyTokenHash("local-token", hash)).toBe(true);
    expect(verifyTokenHash("wrong-token", hash)).toBe(false);
  });

  it("creates opaque session tokens", () => {
    const token = createSessionToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(token).not.toContain(".");
  });

  it("computes the configured session expiry", () => {
    const expiresAt = sessionExpiresAt(new Date("2026-06-06T00:00:00.000Z"));

    expect(expiresAt.toISOString()).toBe("2026-06-13T00:00:00.000Z");
  });

  it("creates and clears HttpOnly cookies", () => {
    const token = createSessionToken();
    const cookie = createSessionSetCookie(token);

    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("Secure");
    expect(readCookie(cookie, SESSION_COOKIE_NAME)).toBe(token);
    expect(createSessionClearCookie()).toContain("Max-Age=0");
  });

  it("adds Secure to session cookies when requested", () => {
    const token = createSessionToken();

    expect(createSessionSetCookie(token, { secure: true })).toContain("Secure");
    expect(createSessionClearCookie({ secure: true })).toContain("Secure");
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  clearSamlBrowserBindingCookie,
  createSamlBrowserBinding,
  readSamlBrowserBinding,
  SAML_BINDING_COOKIE_NAME,
  samlBindingMatches
} from "./binding";
import { createSamlRequestId } from "./relayState";

const secret = "binding-test-secret";

function cookieHeader(setCookie: string): string {
  return setCookie.split(";")[0]!;
}

describe("SAML browser binding", () => {
  it("is a Lax, HttpOnly cookie scoped to the start and completion routes that names its request", () => {
    const requestId = createSamlRequestId();
    const binding = createSamlBrowserBinding({ maxAgeSeconds: 600, requestId, secret, secure: true });

    expect(binding.cookie).toMatch(new RegExp(`^${SAML_BINDING_COOKIE_NAME}=`, "u"));
    expect(binding.cookie).toContain("; Path=/api/auth/saml; HttpOnly; SameSite=Lax; Max-Age=600; Secure");
    expect(createSamlBrowserBinding({ maxAgeSeconds: 600, requestId, secret, secure: false }).cookie).not.toContain("Secure");
    expect(clearSamlBrowserBindingCookie(false)).toBe(`${SAML_BINDING_COOKIE_NAME}=; Path=/api/auth/saml; HttpOnly; SameSite=Lax; Max-Age=0`);

    const read = readSamlBrowserBinding(cookieHeader(binding.cookie), secret);
    expect(read).toEqual({ nonce: expect.any(String), requestId });
    expect(samlBindingMatches(read!.nonce, binding.hash)).toBe(true);
    expect(binding.hash).not.toContain(read!.nonce);
  });

  it("refuses a missing, forged or foreign cookie, and a nonce of another request", () => {
    const requestId = createSamlRequestId();
    const binding = createSamlBrowserBinding({ maxAgeSeconds: 600, requestId, secret, secure: false });
    const header = cookieHeader(binding.cookie);
    const [id, nonce, mac] = header.slice(`${SAML_BINDING_COOKIE_NAME}=`.length).split(".");
    const other = createSamlBrowserBinding({ maxAgeSeconds: 600, requestId: createSamlRequestId(), secret, secure: false });

    for (const value of [
      null,
      "",
      `${SAML_BINDING_COOKIE_NAME}=`,
      `${SAML_BINDING_COOKIE_NAME}=${createSamlRequestId()}.${nonce}.${mac}`,
      `${SAML_BINDING_COOKIE_NAME}=${id}.${"A".repeat(43)}.${mac}`,
      `${SAML_BINDING_COOKIE_NAME}=${id}.${nonce}.${mac}.extra`
    ]) {
      expect(readSamlBrowserBinding(value, secret), String(value)).toBeNull();
    }
    expect(readSamlBrowserBinding(header, "another-installation")).toBeNull();
    const otherNonce = readSamlBrowserBinding(cookieHeader(other.cookie), secret)!.nonce;
    expect(samlBindingMatches(otherNonce, binding.hash)).toBe(false);
  });
});

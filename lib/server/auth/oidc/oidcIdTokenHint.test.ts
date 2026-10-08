// @vitest-environment node

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { oidcSignInConfigSchema } from "@/lib/contracts/authSignInMethods";
import { SecretEnvelopeError } from "../../secrets/envelope";
import { OIDC_ID_TOKEN_HINT_MAX_LENGTH, openOidcIdTokenHint, sealOidcIdTokenHint } from "./oidcIdTokenHint";

const key = randomBytes(32);
const config = oidcSignInConfigSchema.parse({ clientId: "aiqsa-client", issuer: "https://idp.example.test/realms/main" });
const idToken = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzdWJqZWN0LTEiLCJlbWFpbCI6InBlcnNvbkBleGFtcGxlLnRlc3QifQ.c2lnbmF0dXJl";
const unusableKey = () => {
  throw new SecretEnvelopeError("secret_encryption_invalid_key");
};

function seal(token = idToken) {
  return sealOidcIdTokenHint({ config, idToken: token, key: () => key });
}

describe("OIDC ID token hint", () => {
  it("seals the token to a fresh session id, without the token or its claims in the envelope", () => {
    const sealed = seal()!;
    const other = seal()!;

    expect(sealed.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(sealed.sessionId).not.toBe(other.sessionId);
    for (const part of [idToken, ...idToken.split(".")]) {
      expect(sealed.envelope).not.toContain(part);
    }
    expect(openOidcIdTokenHint({ config, hint: sealed, key: () => key })).toBe(idToken);
  });

  it("opens only under the session id it was sealed to", () => {
    const sealed = seal()!;
    const other = seal()!;

    expect(openOidcIdTokenHint({ config, hint: { envelope: sealed.envelope, sessionId: other.sessionId }, key: () => key })).toBeNull();
  });

  it("keeps a token of at most 6 KiB", () => {
    const longest = `${"a".repeat(OIDC_ID_TOKEN_HINT_MAX_LENGTH - 4)}.b.c`;
    const sealed = seal(longest);

    expect(openOidcIdTokenHint({ config, hint: sealed, key: () => key })).toBe(longest);
    expect(seal(`${longest}d`)).toBeNull();
    expect(seal("")).toBeNull();
  });

  it("keeps nothing and never throws without a usable encryption key", () => {
    expect(sealOidcIdTokenHint({ config, idToken, key: unusableKey })).toBeNull();
  });

  it("opens nothing under another key, from a damaged envelope or without a hint, and never throws", () => {
    const sealed = seal()!;
    const [version, nonce, ciphertext, tag] = sealed.envelope.split(".");
    const flipped = `${ciphertext!.startsWith("A") ? "B" : "A"}${ciphertext!.slice(1)}`;

    expect(openOidcIdTokenHint({ config, hint: sealed, key: () => randomBytes(32) })).toBeNull();
    expect(openOidcIdTokenHint({ config, hint: sealed, key: unusableKey })).toBeNull();
    expect(openOidcIdTokenHint({ config, hint: { ...sealed, envelope: [version, nonce, flipped, tag].join(".") }, key: () => key })).toBeNull();
    expect(openOidcIdTokenHint({ config, hint: { ...sealed, envelope: "not-an-envelope" }, key: () => key })).toBeNull();
    expect(openOidcIdTokenHint({ config, hint: null, key: () => key })).toBeNull();
  });

  it("never hands the token to an IdP that did not issue it", () => {
    const sealed = seal()!;

    for (const changed of [
      { ...config, issuer: "https://other-idp.example.test/realms/main" },
      { ...config, clientId: "another-client" }
    ]) {
      expect(openOidcIdTokenHint({ config: changed, hint: sealed, key: () => key })).toBeNull();
    }
  });
});

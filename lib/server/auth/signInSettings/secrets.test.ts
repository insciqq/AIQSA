import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applySignInSecretActions,
  decryptSignInSecrets,
  encryptSignInSecrets,
  normalizeSignInSecretActions,
  signInSecretFields,
  signInSecretPurpose
} from "./secrets";

const key = randomBytes(32);

describe("sign-in secret envelopes", () => {
  it("binds each envelope to its method's purpose and generation", () => {
    expect(signInSecretPurpose("google")).toBe("auth-sign-in:google");
    const envelope = encryptSignInSecrets({ generation: 3, key, method: "google", secrets: { clientSecret: "s3cret-value" } });

    expect(envelope).not.toContain("s3cret-value");
    expect(decryptSignInSecrets({ envelope, generation: 3, key, method: "google" })).toEqual({ clientSecret: "s3cret-value" });
    // Another method's purpose or another generation never opens it.
    expect(() => decryptSignInSecrets({ envelope, generation: 3, key, method: "yandex" })).toThrow();
    expect(() => decryptSignInSecrets({ envelope, generation: 4, key, method: "google" })).toThrow();
    expect(() => decryptSignInSecrets({ envelope, generation: 3, key: randomBytes(32), method: "google" })).toThrow();
  });

  it("lists the write-only fields from the method's secret contract", () => {
    expect(signInSecretFields("google")).toEqual(["clientSecret"]);
    expect(signInSecretFields("ldap")).toEqual(["bindPassword"]);
    expect(signInSecretFields("saml")).toEqual([]);
  });

  it("accepts only preserve, replace and confirmed clear for the method's own fields", () => {
    expect(normalizeSignInSecretActions("google", undefined)).toEqual({});
    expect(normalizeSignInSecretActions("google", {
      clientSecret: { kind: "replace", value: "new-secret" }
    })).toEqual({ clientSecret: { kind: "replace", value: "new-secret" } });
    expect(normalizeSignInSecretActions("ldap", { bindPassword: { confirm: true, kind: "clear" } }))
      .toEqual({ bindPassword: { confirm: true, kind: "clear" } });

    for (const invalid of [
      { clientSecret: { kind: "clear" } },
      { clientSecret: { kind: "replace", value: "" } },
      { clientSecret: { kind: "replace", value: "x", extra: true } },
      { bindPassword: { kind: "preserve" } },
      { clientSecret: "plain" },
      []
    ]) {
      expect(() => normalizeSignInSecretActions("google", invalid)).toThrow();
    }
  });

  it("keeps a stored secret for an empty field and removes it only on an explicit clear", () => {
    const stored = { bindPassword: "old" };

    expect(applySignInSecretActions(stored, {})).toEqual({ changed: false, secrets: { bindPassword: "old" } });
    expect(applySignInSecretActions(stored, { bindPassword: { kind: "preserve" } }))
      .toEqual({ changed: false, secrets: { bindPassword: "old" } });
    expect(applySignInSecretActions(stored, { bindPassword: { kind: "replace", value: "new" } }))
      .toEqual({ changed: true, secrets: { bindPassword: "new" } });
    expect(applySignInSecretActions(stored, { bindPassword: { confirm: true, kind: "clear" } }))
      .toEqual({ changed: true, secrets: {} });
  });
});

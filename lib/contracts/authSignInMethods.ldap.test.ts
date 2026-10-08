import { describe, expect, it } from "vitest";
import { ldapSignInConfigSchema } from "./authSignInMethods";

const base = { url: "ldaps://dc1.corp.example.test", userSearchBase: "DC=corp,DC=example,DC=test" };

describe("LDAP sign-in contract", () => {
  it("defaults to email sign-in, verified TLS, cn group values and trusted directory email", () => {
    expect(ldapSignInConfigSchema.parse(base)).toMatchObject({
      bindDn: null,
      caCertificatePem: null,
      groupValueForm: "cn",
      loginUsesUsername: false,
      startTls: false,
      testUsername: null,
      tlsRejectUnauthorized: true,
      trustUnverifiedEmail: true,
      userSearchFilter: "(mail={{username}})"
    });
  });

  it("accepts a server URL with a port and refuses paths, queries and credentials", () => {
    expect(ldapSignInConfigSchema.safeParse({ ...base, url: "ldap://10.0.0.5:3389" }).success).toBe(true);
    expect(ldapSignInConfigSchema.safeParse({ ...base, url: "ldaps://dc1.corp.example.test/" }).success).toBe(true);
    for (const url of [
      "ldap://dc1.corp.example.test/dc=corp",
      "ldap://dc1.corp.example.test?base",
      "ldap://admin:secret@dc1.corp.example.test",
      "ldapi:///var/run/slapd.sock"
    ]) {
      expect(ldapSignInConfigSchema.safeParse({ ...base, url }).success).toBe(false);
    }
  });

  it("needs the username placeholder in the filter", () => {
    expect(ldapSignInConfigSchema.safeParse({ ...base, userSearchFilter: "(uid=jdoe)" }).success).toBe(false);
    expect(ldapSignInConfigSchema.safeParse({ ...base, userSearchFilter: "(sAMAccountName={{username}})" }).success).toBe(true);
  });

  it("allows StartTLS only on ldap://", () => {
    expect(ldapSignInConfigSchema.safeParse({ ...base, startTls: true }).success).toBe(false);
    expect(ldapSignInConfigSchema.safeParse({ ...base, startTls: true, url: "ldap://dc1.corp.example.test" }).success).toBe(true);
  });

  it("takes only PEM certificate blocks as the CA", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----";

    expect(ldapSignInConfigSchema.safeParse({ ...base, caCertificatePem: pem }).success).toBe(true);
    expect(ldapSignInConfigSchema.safeParse({ ...base, caCertificatePem: `${pem}\n${pem}\n` }).success).toBe(true);
    expect(ldapSignInConfigSchema.safeParse({ ...base, caCertificatePem: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" }).success)
      .toBe(false);
  });
});

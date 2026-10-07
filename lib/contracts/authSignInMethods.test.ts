import { describe, expect, it } from "vitest";
import {
  AUTH_SESSION_SIGN_IN_METHODS,
  AUTH_SIGN_IN_METHOD_SCHEMAS,
  AUTH_SIGN_IN_METHODS,
  externalGroupNameSchema,
  isAuthSessionSignInMethod,
  isExternalGroupSource,
  ldapSignInConfigSchema,
  oidcSignInConfigSchema,
  samlSignInConfigSchema,
  trustedHeaderSignInConfigSchema
} from "./authSignInMethods";

const samlBase = {
  idpCertificates: ["-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----"],
  idpEntityId: "https://idp.example.test/realms/aiqsa",
  idpSsoUrl: "https://idp.example.test/realms/aiqsa/protocol/saml"
};

describe("sign-in method contracts", () => {
  it("has one config and one secret schema for every configurable method", () => {
    expect(Object.keys(AUTH_SIGN_IN_METHOD_SCHEMAS).sort()).toEqual([...AUTH_SIGN_IN_METHODS].sort());
    expect(AUTH_SESSION_SIGN_IN_METHODS).toEqual(expect.arrayContaining(["bootstrap", "invite", "password"]));
    expect(isAuthSessionSignInMethod("trusted_header")).toBe(true);
    expect(isAuthSessionSignInMethod("scim")).toBe(false);
    expect(isExternalGroupSource("ldap")).toBe(true);
    expect(isExternalGroupSource("google")).toBe(false);
  });

  it("fills the documented policy defaults per method", () => {
    const oidc = oidcSignInConfigSchema.parse({ clientId: "aiqsa", issuer: "https://idp.example.test/realms/aiqsa" });
    const ldap = ldapSignInConfigSchema.parse({ url: "ldaps://dc.example.test", userSearchBase: "dc=example,dc=test" });
    const trustedHeader = trustedHeaderSignInConfigSchema.parse({ emailHeader: "X-Auth-Request-Email" });

    expect(oidc).toMatchObject({
      adminGroups: [],
      allowedGroups: [],
      autoCreateUsers: true,
      groupsClaimPath: "groups",
      groupsFrom: "id_token_then_userinfo",
      scopes: "openid email profile",
      syncGroups: false,
      trustUnverifiedEmail: false
    });
    expect(ldap).toMatchObject({
      attributes: { displayName: "displayName", email: "mail", groups: "memberOf", id: "entryUUID" },
      tlsRejectUnauthorized: true,
      trustUnverifiedEmail: true
    });
    expect(trustedHeader).not.toHaveProperty("trustUnverifiedEmail");
    expect(samlSignInConfigSchema.parse(samlBase)).toMatchObject({
      allowSha1: false,
      requireSignedAssertion: true,
      trustUnverifiedEmail: false
    });
  });

  it("refuses unknown fields, unsafe URLs and a SAML method that requires no signature", () => {
    expect(oidcSignInConfigSchema.safeParse({
      clientId: "aiqsa",
      clientSecret: "belongs-to-the-secrets",
      issuer: "https://idp.example.test"
    }).success).toBe(false);
    for (const issuer of ["https://user:secret@idp.example.test", "ftp://idp.example.test", "https://idp.example.test/#x"]) {
      expect(oidcSignInConfigSchema.safeParse({ clientId: "aiqsa", issuer }).success).toBe(false);
    }
    expect(ldapSignInConfigSchema.safeParse({
      url: "https://dc.example.test",
      userSearchBase: "dc=example,dc=test"
    }).success).toBe(false);
    expect(samlSignInConfigSchema.safeParse({
      ...samlBase,
      requireSignedAssertion: false,
      requireSignedResponse: false
    }).success).toBe(false);
  });

  it("keeps external group names exact and bounded", () => {
    expect(externalGroupNameSchema.parse(" /Team Leads ")).toBe(" /Team Leads ");
    expect(externalGroupNameSchema.safeParse("").success).toBe(false);
    expect(externalGroupNameSchema.safeParse("admins\u0000").success).toBe(false);
    expect(externalGroupNameSchema.safeParse("g".repeat(513)).success).toBe(false);
    expect(oidcSignInConfigSchema.safeParse({
      adminGroups: Array.from({ length: 101 }, (_, index) => `group-${index}`),
      clientId: "aiqsa",
      issuer: "https://idp.example.test"
    }).success).toBe(false);
  });
});

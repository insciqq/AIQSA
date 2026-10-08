// @vitest-environment node

import { describe, expect, it } from "vitest";
import { isMultiTenantOidcIssuer, oidcSignInConfigSchema } from "@/lib/contracts/authSignInMethods";
import { claimAtPath, extractOidcGroups, oidcDisplayName, oidcEmailVerified } from "./oidcClaims";

describe("OIDC claims", () => {
  it("reads only own properties along a dot path", () => {
    const claims = { realm_access: { roles: ["a"] } };
    expect(claimAtPath(claims, "realm_access.roles")).toEqual(["a"]);
    expect(claimAtPath(claims, "realm_access.constructor")).toBeUndefined();
    expect(claimAtPath(claims, "__proto__.toString")).toBeUndefined();
    expect(claimAtPath({ a: "text" }, "a.length")).toBeUndefined();
  });

  it.each([
    ["a string", { groups: "team" }, ["team"]],
    ["an array with non-strings ignored and duplicates merged", { groups: ["a", 1, null, "", "b", "a", { x: 1 }] }, ["a", "b"]],
    ["an empty array", { groups: [] }, []],
    ["a missing claim", {}, null],
    ["an empty string", { groups: "" }, null],
    ["an object", { groups: { a: true } }, null],
    ["more than 1 000 values", { groups: Array.from({ length: 1_001 }, (_, index) => `g${index}`) }, null],
    ["a value longer than 512 characters", { groups: ["ok", "x".repeat(513)] }, null],
    ["an Entra overage pointer", { _claim_names: { groups: "src1" }, groups: ["stale"] }, null]
  ])("extracts groups from %s", (_name, claims, expected) => {
    expect(extractOidcGroups(claims, "groups")).toEqual(expected);
  });

  it("accepts exactly 1 000 values of 512 characters", () => {
    const groups = Array.from({ length: 1_000 }, (_, index) => `${index}`.padEnd(512, "x"));
    expect(extractOidcGroups({ groups }, "groups")).toHaveLength(1_000);
  });

  it("treats only boolean true and the string \"true\" as a verified email", () => {
    expect(oidcEmailVerified({ email_verified: true })).toBe(true);
    expect(oidcEmailVerified({ email_verified: "true" })).toBe(true);
    for (const value of [false, "false", "TRUE", 1, undefined]) {
      expect(oidcEmailVerified({ email_verified: value })).toBe(false);
    }
  });

  it("prefers name, then preferred_username, else leaves the fallback to settlement", () => {
    expect(oidcDisplayName({ name: " Person ", preferred_username: "p" })).toBe("Person");
    expect(oidcDisplayName({ name: " ", preferred_username: "p" })).toBe("p");
    expect(oidcDisplayName({})).toBe("");
  });
});

describe("OIDC configuration contract", () => {
  it("applies the defaults and offers group sync", () => {
    expect(oidcSignInConfigSchema.parse({ clientId: "client", issuer: "https://idp.example/realms/main" })).toEqual({
      adminGroups: [],
      allowedGroups: [],
      autoCreateUsers: true,
      autoRedirect: false,
      buttonLabel: "SSO",
      clientId: "client",
      groupsClaimPath: "groups",
      groupsFrom: "id_token_then_userinfo",
      idpLogout: false,
      issuer: "https://idp.example/realms/main",
      scopes: "openid email profile",
      syncGroups: true,
      trustUnverifiedEmail: false
    });
  });

  it.each([
    ["scopes without openid", { scopes: "email profile" }],
    ["a claim path with an empty segment", { groupsClaimPath: "realm_access..roles" }],
    ["a claim path with spaces", { groupsClaimPath: "my groups" }],
    ["an issuer with credentials", { issuer: "https://user:pass@idp.example" }]
  ])("refuses %s", (_name, overrides) => {
    expect(oidcSignInConfigSchema.safeParse({ clientId: "client", issuer: "https://idp.example", ...overrides }).success).toBe(false);
  });

  it("recognizes multi-tenant issuers", () => {
    expect(isMultiTenantOidcIssuer("https://login.microsoftonline.com/common/v2.0")).toBe(true);
    expect(isMultiTenantOidcIssuer("https://login.microsoftonline.com/Organizations/v2.0")).toBe(true);
    expect(isMultiTenantOidcIssuer("https://login.microsoftonline.com/consumers/v2.0")).toBe(true);
    expect(isMultiTenantOidcIssuer("https://login.microsoftonline.com/{tenantid}/v2.0")).toBe(true);
    expect(isMultiTenantOidcIssuer("https://login.microsoftonline.com/%7BtenantId%7D/v2.0")).toBe(true);
    expect(isMultiTenantOidcIssuer("https://login.microsoftonline.com/6f1c4b2a-0000-4000-8000-000000000000/v2.0")).toBe(false);
    expect(isMultiTenantOidcIssuer("https://keycloak.lan/realms/common")).toBe(false);
  });
});

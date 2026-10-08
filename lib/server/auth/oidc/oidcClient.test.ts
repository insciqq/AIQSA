// @vitest-environment node

import { generateKeyPair, UnsecuredJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { oidcSignInConfigSchema, type AuthSignInMethodConfig } from "@/lib/contracts/authSignInMethods";
import { createFakeOidcProvider, type FakeOidcProvider } from "@/tests/support/fakeOidcProvider";
import { createOidcClient, OidcError, type OidcClient } from "./oidcClient";

const now = new Date("2026-10-08T12:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1000);
const redirectUri = "https://aiqsa.example/api/auth/oauth/oidc/callback";

let idp: FakeOidcProvider;
let client: OidcClient;

function config(overrides: Partial<AuthSignInMethodConfig<"oidc">> = {}): AuthSignInMethodConfig<"oidc"> {
  return oidcSignInConfigSchema.parse({ clientId: idp.clientId, issuer: idp.issuer, ...overrides });
}

async function signIn(overrides: Partial<AuthSignInMethodConfig<"oidc">> = {}) {
  return client.signIn({
    code: "valid-code",
    codeVerifier: "verifier-value",
    config: config(overrides),
    nonce: "nonce-1",
    now,
    redirectUri,
    secrets: { clientSecret: idp.clientSecret }
  });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OidcError);
    // The error carries only the code: no token, claim or response.
    expect((error as Error).message).toBe((error as OidcError).code);
    return (error as OidcError).code;
  }
  throw new Error("expected a refusal");
}

function requests(route: string) {
  return idp.state.requests.filter((request) => request.route === route);
}

beforeEach(async () => {
  idp = await createFakeOidcProvider({ now: () => now });
  idp.state.nonce = "nonce-1";
  client = createOidcClient({ fetchImpl: idp.fetch, now: () => now.getTime() });
});

describe("OIDC authorization", () => {
  it("builds the authorization URL from discovery with PKCE S256, nonce, state and scopes", async () => {
    const url = await client.authorizationUrl({
      codeChallenge: "challenge",
      config: config({ scopes: "openid email profile groups" }),
      nonce: "nonce-1",
      redirectUri,
      state: "state-1"
    });

    expect(`${url.origin}${url.pathname}`).toBe(`${idp.issuer}/protocol/openid-connect/auth`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: idp.clientId,
      code_challenge: "challenge",
      code_challenge_method: "S256",
      nonce: "nonce-1",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile groups",
      state: "state-1"
    });
  });

  it("caches discovery per issuer and never caches a failure", async () => {
    idp.state.failures.discovery = 503;
    expect(await refusal(client.authorizationUrl({ codeChallenge: "c", config: config(), nonce: "n", redirectUri, state: "s" })))
      .toBe("discovery_unreachable");
    delete idp.state.failures.discovery;
    await client.authorizationUrl({ codeChallenge: "c", config: config(), nonce: "n", redirectUri, state: "s" });
    await client.authorizationUrl({ codeChallenge: "c", config: config(), nonce: "n", redirectUri, state: "s" });
    expect(requests("discovery")).toHaveLength(2);
  });

  it("refuses an issuer the discovery document does not name exactly, and multi-tenant issuers without a request", async () => {
    idp.state.discovery.issuer = `${idp.issuer}/`;
    expect(await refusal(client.authorizationUrl({ codeChallenge: "c", config: config(), nonce: "n", redirectUri, state: "s" })))
      .toBe("issuer_mismatch");

    const before = idp.state.requests.length;
    for (const issuer of [
      "https://login.microsoftonline.com/common/v2.0",
      "https://login.microsoftonline.com/organizations/v2.0",
      "https://login.microsoftonline.com/{tenantid}/v2.0"
    ]) {
      expect(await refusal(client.authorizationUrl({ codeChallenge: "c", config: config({ issuer }), nonce: "n", redirectUri, state: "s" })))
        .toBe("multi_tenant_issuer");
    }
    expect(idp.state.requests).toHaveLength(before);
  });
});

describe("OIDC sign-in", () => {
  it("exchanges the code with client_secret_basic and PKCE and returns the validated claims", async () => {
    await expect(signIn()).resolves.toEqual({
      displayName: "Person Example",
      email: "person@example.test",
      emailVerified: true,
      groups: ["/staff"],
      subject: "subject-1"
    });

    const [token] = requests("token");
    expect(Object.fromEntries(token!.body!)).toEqual({
      code: "valid-code",
      code_verifier: "verifier-value",
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    });
    expect(token!.headers.get("authorization")).toBe(
      `Basic ${Buffer.from(`${idp.clientId}:${idp.clientSecret}`).toString("base64")}`
    );
    // The id token carried email and groups: no userinfo request.
    expect(requests("userinfo")).toHaveLength(0);
  });

  it("uses client_secret_post when the provider supports only that", async () => {
    idp.state.discovery.token_endpoint_auth_methods_supported = ["client_secret_post", "private_key_jwt"];
    await signIn();
    const [token] = requests("token");
    expect(token!.headers.get("authorization")).toBeNull();
    expect(token!.body!.get("client_id")).toBe(idp.clientId);
    expect(token!.body!.get("client_secret")).toBe(idp.clientSecret);
  });

  it("accepts the string \"true\" as a verified email and treats a missing flag as unverified", async () => {
    idp.state.idTokenClaims = { email_verified: "true" };
    expect((await signIn()).emailVerified).toBe(true);
    idp.state.idTokenClaims = { email_verified: undefined };
    expect((await signIn()).emailVerified).toBe(false);
    idp.state.idTokenClaims = { email_verified: "yes" };
    expect((await signIn()).emailVerified).toBe(false);
  });

  it("falls back to preferred_username for the display name", async () => {
    idp.state.idTokenClaims = { name: undefined, preferred_username: "person" };
    expect((await signIn()).displayName).toBe("person");
  });

  it("accepts tokens within the 60 s clock tolerance", async () => {
    idp.state.idTokenClaims = { exp: nowSeconds - 50, iat: nowSeconds + 50 };
    await expect(signIn()).resolves.toMatchObject({ subject: "subject-1" });
  });

  it.each([
    ["a wrong issuer", { iss: "https://other.example.test/realms/main" }],
    ["an issuer differing only by a trailing slash", { iss: `${"https://idp.example.test/realms/main"}/` }],
    ["a wrong audience", { aud: "another-client" }],
    ["several audiences without azp", { aud: ["aiqsa-client", "another-client"] }],
    ["several audiences with another azp", { aud: ["aiqsa-client", "another-client"], azp: "another-client" }],
    ["a single audience with another azp", { azp: "another-client" }],
    ["a wrong nonce", { nonce: "nonce-2" }],
    ["a missing nonce", { nonce: undefined }],
    ["an expired token", { exp: nowSeconds - 61 }],
    ["a token issued in the future", { iat: nowSeconds + 120 }],
    ["a token without iat", { iat: undefined }],
    ["an empty subject", { sub: "" }]
  ])("refuses an id token with %s", async (_name, claims) => {
    idp.state.idTokenClaims = claims;
    expect(await refusal(signIn())).toBe("id_token_invalid");
  });

  it("accepts several audiences when azp is the client", async () => {
    idp.state.idTokenClaims = { aud: ["aiqsa-client", "another-client"], azp: "aiqsa-client" };
    await expect(signIn()).resolves.toMatchObject({ subject: "subject-1" });
  });

  it("refuses alg none, an HS256 token signed with the client secret and a key the provider does not publish", async () => {
    idp.state.idToken = async () => new UnsecuredJWT(idp.standardClaims()).encode();
    expect(await refusal(signIn())).toBe("id_token_invalid");

    idp.state.idToken = () => idp.sign(idp.standardClaims(), { alg: "HS256", key: new TextEncoder().encode(idp.clientSecret) });
    expect(await refusal(signIn())).toBe("id_token_invalid");

    const stranger = await generateKeyPair("RS256");
    idp.state.idToken = () => idp.sign(idp.standardClaims(), { key: stranger.privateKey });
    expect(await refusal(signIn())).toBe("id_token_invalid");
  });

  it("follows a key rotation through the published key set", async () => {
    await signIn();
    await idp.rotateKey();
    await expect(signIn()).resolves.toMatchObject({ subject: "subject-1" });
    expect(requests("jwks")).toHaveLength(2);
  });

  it("refuses a failed exchange and a response without an id token", async () => {
    idp.state.failures.token = 400;
    expect(await refusal(signIn())).toBe("token_exchange_failed");
    delete idp.state.failures.token;
    idp.state.tokenResponse = { access_token: "fake-access-token", token_type: "Bearer" };
    expect(await refusal(signIn())).toBe("token_exchange_failed");
  });

  it("reports an unreachable key set", async () => {
    idp.state.failures.jwks = "network";
    expect(await refusal(signIn())).toBe("jwks_unreachable");
  });
});

describe("OIDC groups and userinfo", () => {
  it("reads groups from a nested claim path", async () => {
    idp.state.idTokenClaims = { realm_access: { roles: ["aiqsa-admin", "offline_access"] } };
    expect((await signIn({ groupsClaimPath: "realm_access.roles", groupsFrom: "id_token" })).groups)
      .toEqual(["aiqsa-admin", "offline_access"]);
    idp.state.idTokenClaims = { resource_access: { "aiqsa-client": { roles: ["editor"] } } };
    expect((await signIn({ groupsClaimPath: "resource_access.aiqsa-client.roles", groupsFrom: "id_token" })).groups)
      .toEqual(["editor"]);
  });

  it("reads groups from userinfo when configured, with the access token, checking its subject", async () => {
    idp.state.userinfo = { groups: ["/from-userinfo"], sub: "subject-1" };
    expect((await signIn({ groupsFrom: "userinfo" })).groups).toEqual(["/from-userinfo"]);
    expect(requests("userinfo")[0]!.headers.get("authorization")).toBe("Bearer fake-access-token");
  });

  it("falls back to userinfo when the id token has no groups", async () => {
    idp.state.idTokenClaims = { groups: undefined };
    idp.state.userinfo = { groups: "/single", sub: "subject-1" };
    expect((await signIn()).groups).toEqual(["/single"]);
  });

  it("keeps groups missing (null) when neither token nor userinfo has them", async () => {
    idp.state.idTokenClaims = { groups: undefined };
    idp.state.userinfo = { sub: "subject-1" };
    expect((await signIn()).groups).toBeNull();
    expect((await signIn({ groupsFrom: "id_token" })).groups).toBeNull();
  });

  it("treats an Entra overage as missing groups without asking userinfo", async () => {
    idp.state.idTokenClaims = { _claim_names: { groups: "src1" }, _claim_sources: { src1: { endpoint: "https://graph.example" } }, groups: undefined };
    expect((await signIn()).groups).toBeNull();
    expect(requests("userinfo")).toHaveLength(0);
  });

  it("refuses userinfo for another subject", async () => {
    idp.state.idTokenClaims = { groups: undefined };
    idp.state.userinfo = { groups: ["/staff"], sub: "subject-2" };
    expect(await refusal(signIn())).toBe("userinfo_subject_mismatch");
  });

  it("takes the email from userinfo when the id token has none", async () => {
    idp.state.idTokenClaims = { email: undefined, email_verified: undefined };
    idp.state.userinfo = { email: "from-userinfo@example.test", email_verified: "true", sub: "subject-1" };
    await expect(signIn()).resolves.toMatchObject({ email: "from-userinfo@example.test", emailVerified: true });
  });

  it("refuses groups from userinfo when the provider has no userinfo endpoint", async () => {
    idp.state.discovery.userinfo_endpoint = undefined;
    expect(await refusal(signIn({ groupsFrom: "userinfo" }))).toBe("userinfo_unsupported");
  });
});

describe("OIDC logout", () => {
  it("builds the end-session URL with client_id and post_logout_redirect_uri, never an id token hint", async () => {
    const url = new URL((await client.endSessionUrl({ config: config(), postLogoutRedirectUri: "https://aiqsa.example/login" }))!);
    expect(`${url.origin}${url.pathname}`).toBe(`${idp.issuer}/protocol/openid-connect/logout`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: idp.clientId,
      post_logout_redirect_uri: "https://aiqsa.example/login"
    });
  });

  it("returns null without an end-session endpoint or when discovery fails", async () => {
    idp.state.discovery.end_session_endpoint = undefined;
    expect(await client.endSessionUrl({ config: config(), postLogoutRedirectUri: "https://aiqsa.example/login" })).toBeNull();
    const failing = createOidcClient({ fetchImpl: async () => { throw new TypeError("offline"); } });
    expect(await failing.endSessionUrl({ config: config(), postLogoutRedirectUri: "https://aiqsa.example/login" })).toBeNull();
  });
});

describe("OIDC tester", () => {
  async function test(overrides: Partial<AuthSignInMethodConfig<"oidc">> = {}, clientSecret = idp.clientSecret) {
    return client.test({
      appBaseUrl: "https://aiqsa.example",
      config: config(overrides),
      secrets: { clientSecret },
      signal: new AbortController().signal
    });
  }

  it("passes a reachable, consistent provider and probes the client credentials with an unknown code", async () => {
    await expect(test()).resolves.toEqual({ code: "oidc_checked", passed: true });
    const [probe] = requests("token");
    expect(probe!.body!.get("redirect_uri")).toBe(redirectUri);
    expect(probe!.body!.get("code")).not.toBe("valid-code");
  });

  it.each([
    ["discovery_unreachable", () => { idp.state.failures.discovery = "network"; }],
    ["issuer_mismatch", () => { idp.state.discovery.issuer = "https://other.example.test"; }],
    ["pkce_unsupported", () => { idp.state.discovery.code_challenge_methods_supported = ["plain"]; }],
    ["response_type_unsupported", () => { idp.state.discovery.response_types_supported = ["id_token"]; }],
    ["id_token_alg_unsupported", () => { idp.state.discovery.id_token_signing_alg_values_supported = ["HS256", "none"]; }],
    ["client_auth_unsupported", () => { idp.state.discovery.token_endpoint_auth_methods_supported = ["private_key_jwt"]; }],
    ["discovery_invalid", () => { idp.state.discovery.token_endpoint = undefined; }],
    ["jwks_unreachable", () => { idp.state.failures.jwks = 500; }],
    ["client_rejected", () => { idp.state.failures.token = 401; }],
    ["token_endpoint_unreachable", () => { idp.state.failures.token = "network"; }]
  ] as const)("reports %s", async (code, arrange) => {
    arrange();
    await expect(test()).resolves.toEqual({ code, passed: false });
  });

  it("reports a key set without usable signing keys", async () => {
    const original = idp.fetch;
    const fetchImpl: typeof fetch = async (resource, init) => {
      const response = await original(resource, init);
      return String(resource).endsWith("/certs")
        ? new Response(JSON.stringify({ keys: [{ k: "c2VjcmV0", kty: "oct" }] }), { status: 200 })
        : response;
    };
    client = createOidcClient({ fetchImpl });
    await expect(test()).resolves.toEqual({ code: "jwks_invalid", passed: false });
  });

  it("refuses a multi-tenant issuer and userinfo groups without a userinfo endpoint", async () => {
    await expect(test({ issuer: "https://login.microsoftonline.com/common/v2.0" }))
      .resolves.toEqual({ code: "multi_tenant_issuer", passed: false });
    idp.state.discovery.userinfo_endpoint = undefined;
    await expect(test({ groupsFrom: "userinfo" })).resolves.toEqual({ code: "userinfo_unsupported", passed: false });
  });

  it("never puts the client secret into a verdict", async () => {
    idp.state.failures.token = 401;
    expect(JSON.stringify(await test())).not.toContain(idp.clientSecret);
  });
});

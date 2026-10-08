import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";

/**
 * An in-process OpenID provider for tests: discovery, JWKS, token and userinfo endpoints behind
 * a `fetch` the OIDC client is given. Signing keys are generated per provider; nothing leaves
 * the process.
 */
export type FakeOidcProvider = Awaited<ReturnType<typeof createFakeOidcProvider>>;

type Route = "discovery" | "jwks" | "token" | "userinfo";

export const FAKE_OIDC_ISSUER = "https://idp.example.test/realms/main";
export const FAKE_OIDC_CLIENT_ID = "aiqsa-client";
export const FAKE_OIDC_CLIENT_SECRET = "fake-client-secret-value";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

export async function createFakeOidcProvider(input: { issuer?: string; now?: () => Date } = {}) {
  const issuer = input.issuer ?? FAKE_OIDC_ISSUER;
  const base = issuer.replace(/\/+$/u, "");
  const clock = input.now ?? (() => new Date());
  const pair = await generateKeyPair("RS256", { extractable: true });
  let keyId = "key-1";
  let signingKey: SigningKey = pair.privateKey;
  let jwks: { keys: JWK[] } = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: "RS256", kid: keyId, use: "sig" }] };

  const state = {
    /** Merged into the discovery document; `undefined` values remove a field. */
    discovery: {} as Record<string, unknown>,
    /** Claims merged into the next id tokens. */
    idTokenClaims: {} as Record<string, unknown>,
    /** Overrides the whole id token. */
    idToken: null as (() => Promise<string>) | null,
    /** The nonce the next id token carries (the test sets it from the authorization URL). */
    nonce: "",
    requests: [] as { body: URLSearchParams | null; headers: Headers; route: Route; url: string }[],
    /** Per-route failure: an HTTP status, or `"network"` to throw. */
    failures: {} as Partial<Record<Route, number | "network">>,
    tokenResponse: null as Record<string, unknown> | null,
    userinfo: { email: "person@example.test", email_verified: true, sub: "subject-1" } as Record<string, unknown>
  };

  function discoveryDocument(): Record<string, unknown> {
    const document: Record<string, unknown> = {
      authorization_endpoint: `${base}/protocol/openid-connect/auth`,
      code_challenge_methods_supported: ["plain", "S256"],
      end_session_endpoint: `${base}/protocol/openid-connect/logout`,
      id_token_signing_alg_values_supported: ["RS256", "ES256"],
      issuer,
      jwks_uri: `${base}/protocol/openid-connect/certs`,
      response_types_supported: ["code", "id_token", "code id_token"],
      token_endpoint: `${base}/protocol/openid-connect/token`,
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      userinfo_endpoint: `${base}/protocol/openid-connect/userinfo`
    };
    for (const [key, value] of Object.entries(state.discovery)) {
      if (value === undefined) delete document[key];
      else document[key] = value;
    }
    return document;
  }

  /** Signs claims with the provider's current key (or the given one) and algorithm. */
  async function sign(
    claims: JWTPayload,
    options: { alg?: string; key?: SigningKey | Uint8Array; kid?: string } = {}
  ): Promise<string> {
    const alg = options.alg ?? "RS256";
    return new SignJWT(claims)
      .setProtectedHeader({ alg, kid: options.kid ?? keyId, typ: "JWT" })
      .sign(options.key ?? signingKey);
  }

  function standardClaims(): JWTPayload {
    const now = Math.floor(clock().getTime() / 1000);
    return {
      aud: FAKE_OIDC_CLIENT_ID,
      email: "person@example.test",
      email_verified: true,
      exp: now + 300,
      groups: ["/staff"],
      iat: now,
      iss: issuer,
      name: "Person Example",
      nonce: state.nonce,
      sub: "subject-1",
      ...state.idTokenClaims
    };
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
  }

  const routes: Record<string, Route> = {
    [`${base}/.well-known/openid-configuration`]: "discovery"
  };

  const fetchImpl: typeof fetch = async (resource, init) => {
    const url = typeof resource === "string" ? resource : resource instanceof URL ? resource.toString() : resource.url;
    const path = url.split("?")[0]!;
    const document = discoveryDocument();
    const route: Route | undefined = routes[path] ??
      (path === document.jwks_uri ? "jwks" : path === document.token_endpoint ? "token" : path === document.userinfo_endpoint ? "userinfo" : undefined);
    if (!route) return new Response(null, { status: 404 });
    const headers = new Headers(init?.headers);
    const body = init?.body instanceof URLSearchParams ? new URLSearchParams(init.body) : null;
    state.requests.push({ body, headers, route, url });
    const failure = state.failures[route];
    if (failure === "network") throw new TypeError("fetch failed");
    if (typeof failure === "number") return json({ error: failure === 401 ? "invalid_client" : "server_error" }, failure);

    switch (route) {
      case "discovery":
        return json(document);
      case "jwks":
        return json(jwks);
      case "token":
        if (state.tokenResponse) return json(state.tokenResponse);
        if (body?.get("code") !== "valid-code") return json({ error: "invalid_grant" }, 400);
        return json({
          access_token: "fake-access-token",
          expires_in: 300,
          id_token: state.idToken ? await state.idToken() : await sign(standardClaims()),
          token_type: "Bearer"
        });
      case "userinfo":
        if (headers.get("authorization") !== "Bearer fake-access-token") return json({ error: "invalid_token" }, 401);
        return json(state.userinfo);
    }
  };

  return {
    clientId: FAKE_OIDC_CLIENT_ID,
    clientSecret: FAKE_OIDC_CLIENT_SECRET,
    fetch: fetchImpl,
    issuer,
    /** Replaces the signing key (rotation): new id tokens use it and the JWKS lists only it. */
    async rotateKey() {
      const next = await generateKeyPair("RS256", { extractable: true });
      keyId = `key-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      signingKey = next.privateKey;
      jwks = { keys: [{ ...(await exportJWK(next.publicKey)), alg: "RS256", kid: keyId, use: "sig" }] };
    },
    sign,
    standardClaims,
    state
  };
}

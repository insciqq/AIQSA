// @vitest-environment node

import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT
} from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  buildOAuthAuthorizationUrl,
  exchangeOAuthCode,
  OAuthProviderError,
  verifyGoogleIdToken
} from "./oauthProviders";

const config = {
  clientId: "client-id",
  clientSecret: "client-secret"
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json"
    },
    status
  });
}

describe("OAuth provider protocol", () => {
  it("builds Google and Yandex authorization requests with state and PKCE S256", () => {
    const common = {
      clientId: "client-id",
      codeChallenge: "challenge",
      nonce: "nonce",
      state: "state"
    };
    const google = buildOAuthAuthorizationUrl({
      ...common,
      provider: "google",
      redirectUri: "https://aiqsa.example/api/auth/oauth/google/callback"
    });
    const yandex = buildOAuthAuthorizationUrl({
      ...common,
      provider: "yandex",
      redirectUri: "https://aiqsa.example/api/auth/oauth/yandex/callback"
    });

    expect(google.origin).toBe("https://accounts.google.com");
    expect(google.searchParams.get("scope")).toBe("openid email profile");
    expect(google.searchParams.get("nonce")).toBe("nonce");
    expect(google.searchParams.get("code_challenge_method")).toBe("S256");
    expect(google.searchParams.get("redirect_uri")).toBe(
      "https://aiqsa.example/api/auth/oauth/google/callback"
    );
    expect(google.searchParams.get("state")).toBe("state");
    expect(yandex.origin).toBe("https://oauth.yandex.ru");
    expect(yandex.searchParams.get("scope")).toBe("login:info login:email");
    expect(yandex.searchParams.get("code_challenge_method")).toBe("S256");
    expect(yandex.searchParams.get("redirect_uri")).toBe(
      "https://aiqsa.example/api/auth/oauth/yandex/callback"
    );
    expect(yandex.searchParams.get("state")).toBe("state");
  });

  it("exchanges a Google code and validates the returned ID token through the injected verifier", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ id_token: "signed-google-token" })
    );
    const googleIdTokenVerifier = vi.fn(async () => ({
      displayName: "Google User",
      email: "user@example.com",
      providerAccountId: "google-subject"
    }));

    await expect(
      exchangeOAuthCode({
        code: "authorization-code",
        codeVerifier: "verifier",
        config,
        fetchImpl,
        googleIdTokenVerifier,
        nonce: "nonce",
        provider: "google",
        redirectUri: "https://aiqsa.example/api/auth/oauth/google/callback"
      })
    ).resolves.toEqual({
      displayName: "Google User",
      email: "user@example.com",
      providerAccountId: "google-subject"
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    const body = init?.body as URLSearchParams;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init?.method).toBe("POST");
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("client_secret")).toBe("client-secret");
    expect(body.get("code")).toBe("authorization-code");
    expect(body.get("code_verifier")).toBe("verifier");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("redirect_uri")).toBe(
      "https://aiqsa.example/api/auth/oauth/google/callback"
    );
    expect(googleIdTokenVerifier).toHaveBeenCalledWith({
      clientId: "client-id",
      idToken: "signed-google-token",
      nonce: "nonce"
    });
  });

  it("verifies Google signature, issuer, audience, expiry, nonce, subject, and verified email", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.alg = "RS256";
    publicJwk.kid = "test-key";
    publicJwk.use = "sig";
    const keySet = createLocalJWKSet({
      keys: [publicJwk]
    });
    const idToken = await new SignJWT({
      email: "verified@example.com",
      email_verified: true,
      name: "Verified Google User",
      nonce: "expected-nonce"
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://accounts.google.com")
      .setAudience("client-id")
      .setSubject("google-subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      verifyGoogleIdToken({
        clientId: "client-id",
        idToken,
        keySet,
        nonce: "expected-nonce"
      })
    ).resolves.toEqual({
      displayName: "Verified Google User",
      email: "verified@example.com",
      providerAccountId: "google-subject"
    });
    await expect(
      verifyGoogleIdToken({
        clientId: "client-id",
        idToken,
        keySet,
        nonce: "wrong-nonce"
      })
    ).rejects.toBeInstanceOf(OAuthProviderError);
    await expect(
      verifyGoogleIdToken({
        clientId: "another-client",
        idToken,
        keySet,
        nonce: "expected-nonce"
      })
    ).rejects.toBeInstanceOf(OAuthProviderError);

    const unverifiedEmailToken = await new SignJWT({
      email: "unverified@example.com",
      email_verified: false,
      nonce: "expected-nonce"
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://accounts.google.com")
      .setAudience("client-id")
      .setSubject("unverified-google-subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      verifyGoogleIdToken({
        clientId: "client-id",
        idToken: unverifiedEmailToken,
        keySet,
        nonce: "expected-nonce"
      })
    ).rejects.toBeInstanceOf(OAuthProviderError);
  });

  it("uses Yandex's OAuth authorization scheme and validates the profile client id", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "yandex-access-token" }))
      .mockResolvedValueOnce(
        jsonResponse({
          client_id: "client-id",
          default_email: "user@yandex.example",
          id: "yandex-subject",
          real_name: "Yandex User"
        })
      );

    await expect(
      exchangeOAuthCode({
        code: "authorization-code",
        codeVerifier: "verifier",
        config,
        fetchImpl,
        nonce: "unused-by-yandex",
        provider: "yandex",
        redirectUri: "https://aiqsa.example/api/auth/oauth/yandex/callback"
      })
    ).resolves.toEqual({
      displayName: "Yandex User",
      email: "user@yandex.example",
      providerAccountId: "yandex-subject"
    });

    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[0]!;
    const tokenBody = tokenInit?.body as URLSearchParams;
    expect(tokenUrl).toBe("https://oauth.yandex.ru/token");
    expect(tokenInit?.method).toBe("POST");
    expect(tokenBody.get("client_id")).toBe("client-id");
    expect(tokenBody.get("client_secret")).toBe("client-secret");
    expect(tokenBody.get("code")).toBe("authorization-code");
    expect(tokenBody.get("code_verifier")).toBe("verifier");
    expect(tokenBody.get("grant_type")).toBe("authorization_code");
    expect(tokenBody.has("redirect_uri")).toBe(false);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://login.yandex.ru/info?format=json",
      expect.objectContaining({
        headers: {
          authorization: "OAuth yandex-access-token"
        }
      })
    );
  });

  it("rejects a Yandex profile issued for another client without exposing its response", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token" }))
      .mockResolvedValueOnce(
        jsonResponse({
          client_id: "another-client",
          default_email: "user@example.com",
          id: "subject"
        })
      );

    await expect(
      exchangeOAuthCode({
        code: "code",
        codeVerifier: "verifier",
        config,
        fetchImpl,
        nonce: "nonce",
        provider: "yandex",
        redirectUri: "https://aiqsa.example/api/auth/oauth/yandex/callback"
      })
    ).rejects.toBeInstanceOf(OAuthProviderError);
  });
});

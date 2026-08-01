import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuthConfig, resetAuthConfigWarningsForTests, TEST_AUTH_TOKEN } from "./config";
import { hashToken } from "./token";

describe("auth config", () => {
  afterEach(() => {
    resetAuthConfigWarningsForTests();
    vi.restoreAllMocks();
  });

  it("derives Secure cookies from the public app URL unless explicitly overridden", () => {
    expect(
      getAuthConfig({
        AIQSA_BOOTSTRAP_AUTH_TOKEN: "local-token",
        AIQSA_BOOTSTRAP_LOGIN_ENABLED: "1",
        AIQSA_APP_BASE_URL: "http://localhost:3000",
        AIQSA_AUTH_SESSION_SECRET: "secret"
      }).cookieSecure
    ).toBe(false);

    expect(
      getAuthConfig({
        AIQSA_BOOTSTRAP_AUTH_TOKEN: "local-token",
        AIQSA_BOOTSTRAP_LOGIN_ENABLED: "1",
        AIQSA_COOKIE_SECURE: "1",
        AIQSA_APP_BASE_URL: "http://localhost:3000",
        AIQSA_AUTH_SESSION_SECRET: "secret"
      }).cookieSecure
    ).toBe(true);
  });

  it("enables Secure cookies for HTTPS unless explicitly disabled", () => {
    expect(
      getAuthConfig({
        AIQSA_BOOTSTRAP_AUTH_TOKEN: "deploy-token",
        AIQSA_BOOTSTRAP_LOGIN_ENABLED: "1",
        AIQSA_APP_BASE_URL: "https://aiqsa.example",
        AIQSA_AUTH_SESSION_SECRET: "secret"
      }).cookieSecure
    ).toBe(true);

    expect(
      getAuthConfig({
        AIQSA_BOOTSTRAP_AUTH_TOKEN: "deploy-token",
        AIQSA_BOOTSTRAP_LOGIN_ENABLED: "1",
        AIQSA_COOKIE_SECURE: "0",
        AIQSA_APP_BASE_URL: "https://aiqsa.example",
        AIQSA_AUTH_SESSION_SECRET: "secret"
      }).cookieSecure
    ).toBe(false);
  });

  it("keeps forwarded IP trust disabled unless explicitly enabled", () => {
    expect(getAuthConfig({ NODE_ENV: "test" })).toMatchObject({
      trustForwardedFor: false,
      trustedProxyConfigurationValid: true,
      trustedProxyCount: 0
    });
    expect(
      getAuthConfig({
        AIQSA_TRUST_PROXY_HEADERS: "true",
        NODE_ENV: "test"
      }).trustForwardedFor
    ).toBe(true);
    expect(
      getAuthConfig({
        AIQSA_TRUST_PROXY_HEADERS: "true",
        NODE_ENV: "test"
      }).trustedProxyCount
    ).toBe(1);
    expect(
      getAuthConfig({
        AIQSA_TRUSTED_PROXY_COUNT: "2",
        AIQSA_TRUST_PROXY_HEADERS: "true",
        NODE_ENV: "test"
      }).trustedProxyCount
    ).toBe(2);
    expect(
      getAuthConfig({
        AIQSA_TRUSTED_PROXY_COUNT: "9",
        AIQSA_TRUST_PROXY_HEADERS: "true",
        NODE_ENV: "test"
      })
    ).toMatchObject({
      trustForwardedFor: true,
      trustedProxyConfigurationValid: false,
      trustedProxyCount: 0
    });
    expect(
      getAuthConfig({
        AIQSA_TRUSTED_PROXY_COUNT: "1",
        NODE_ENV: "test"
      }).trustedProxyConfigurationValid
    ).toBe(false);
  });

  it("separates session auth readiness from bootstrap token availability", () => {
    const config = getAuthConfig({
      AIQSA_AUTH_SESSION_SECRET: "secret"
    });

    expect(config.configured).toBe(true);
    expect(config.bootstrapConfigured).toBe(false);
    expect(config.bootstrapLoginEnabled).toBe(false);
  });

  it("enables each OAuth provider only when its client id and secret are paired", () => {
    const config = getAuthConfig({
      AIQSA_GOOGLE_OAUTH_CLIENT_ID: " google-client ",
      AIQSA_GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
      AIQSA_YANDEX_OAUTH_CLIENT_ID: "partial-yandex",
      AIQSA_AUTH_SESSION_SECRET: "secret"
    });

    expect(config.oauthProviders).toEqual({
      google: {
        clientId: "google-client",
        clientSecret: "google-secret"
      }
    });
  });

  it("enables bootstrap login only when explicitly requested or in allowed test mode", () => {
    expect(
      getAuthConfig({
        AIQSA_BOOTSTRAP_AUTH_TOKEN: "local-token",
        AIQSA_AUTH_SESSION_SECRET: "secret"
      })
    ).toMatchObject({
      bootstrapConfigured: false,
      bootstrapLoginEnabled: false
    });
    expect(
      getAuthConfig({
        AIQSA_BOOTSTRAP_AUTH_TOKEN: "local-token",
        AIQSA_BOOTSTRAP_LOGIN_ENABLED: "1",
        AIQSA_AUTH_SESSION_SECRET: "secret"
      })
    ).toMatchObject({
      bootstrapConfigured: true,
      bootstrapLoginEnabled: true
    });
    expect(
      getAuthConfig({
        AIQSA_TEST_MODE: "1",
        PLAYWRIGHT_TEST_AUTH: "1"
      })
    ).toMatchObject({
      bootstrapConfigured: true,
      bootstrapLoginEnabled: true,
      testAuthEnabled: true
    });
  });

  it("does not enable deterministic test auth in production or without explicit test mode", () => {
    expect(
      getAuthConfig({
        AIQSA_TEST_MODE: "1",
        NODE_ENV: "production",
        PLAYWRIGHT_TEST_AUTH: "1"
      })
    ).toMatchObject({
      bootstrapConfigured: false,
      bootstrapLoginEnabled: false,
      configured: false,
      testAuthEnabled: false
    });
    expect(
      getAuthConfig({
        NODE_ENV: "test",
        PLAYWRIGHT_TEST_AUTH: "1"
      })
    ).toMatchObject({
      bootstrapConfigured: false,
      bootstrapLoginEnabled: false,
      configured: false,
      testAuthEnabled: false
    });
  });

  it("warns once when the known dev bootstrap token is configured outside test mode and enabled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = {
      AIQSA_BOOTSTRAP_AUTH_TOKEN_SHA256: hashToken(TEST_AUTH_TOKEN),
      AIQSA_BOOTSTRAP_LOGIN_ENABLED: "1",
      AIQSA_AUTH_SESSION_SECRET: "secret"
    };

    getAuthConfig(env);
    getAuthConfig(env);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("known development bootstrap token");
  });
});

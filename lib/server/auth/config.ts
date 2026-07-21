import { hashToken } from "./token";
import type { OAuthProviderId } from "../../auth/oauth";
import {
  isNonLocalRuntimeEnv,
  isTestAuthAllowedEnv
} from "./csrf";

export const DEFAULT_BOOTSTRAP_USER_ID = "00000000-0000-4000-8000-000000000001";
export const TEST_AUTH_TOKEN = "aiqsa-test-token";
const TEST_SESSION_SECRET = "aiqsa-test-session-secret";
const TEST_AUTH_TOKEN_HASH = hashToken(TEST_AUTH_TOKEN);
const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);

export type AuthConfig = {
  appEnv: string;
  appBaseUrl: string;
  bootstrapConfigured: boolean;
  bootstrapLoginEnabled: boolean;
  bootstrapTokenHash: string;
  bootstrapUserId: string;
  cookieSecure: boolean;
  configured: boolean;
  oauthProviders: Partial<Record<OAuthProviderId, OAuthProviderConfig>>;
  sessionSecret: string;
  testAuthEnabled: boolean;
  trustForwardedFor: boolean;
  trustedProxyCount: number;
};

export type OAuthProviderConfig = {
  clientId: string;
  clientSecret: string;
};

function usableSecret(value: string | undefined): value is string {
  return Boolean(value && value.trim() && !value.startsWith("replace-with-"));
}

function oauthProviderConfig(clientId: string | undefined, clientSecret: string | undefined): OAuthProviderConfig | null {
  if (!usableSecret(clientId) || !usableSecret(clientSecret)) {
    return null;
  }

  return {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim()
  };
}

function normalizedEnvValue(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function optionalBoolean(value: string | undefined): boolean | null {
  const normalized = normalizedEnvValue(value);

  if (TRUE_ENV_VALUES.has(normalized)) {
    return true;
  }

  if (FALSE_ENV_VALUES.has(normalized)) {
    return false;
  }

  return null;
}

function optionalPositiveInteger(value: string | undefined): number | null {
  if (!value?.trim()) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

export function isNonLocalRuntime(env: Record<string, string | undefined>): boolean {
  return isNonLocalRuntimeEnv(env);
}

export function isTestAuthEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return isTestAuthAllowedEnv(env);
}

function shouldWarnForDevBootstrapToken(
  env: Record<string, string | undefined>,
  bootstrapTokenHash: string,
  testAuthEnabled: boolean
): boolean {
  return bootstrapTokenHash === TEST_AUTH_TOKEN_HASH && isNonLocalRuntime(env) && !testAuthEnabled;
}

let warnedDevBootstrapToken = false;

export function resetAuthConfigWarningsForTests(): void {
  warnedDevBootstrapToken = false;
}

export function getAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const testAuthEnabled = isTestAuthEnabled(env);
  const bootstrapLoginEnabled = (optionalBoolean(env.AIQSA_BOOTSTRAP_LOGIN_ENABLED) ?? false) || testAuthEnabled;
  const cookieSecure = optionalBoolean(env.AIQSA_COOKIE_SECURE) ?? isNonLocalRuntime(env);
  const trustForwardedFor = optionalBoolean(env.AIQSA_TRUST_PROXY_HEADERS) ?? false;
  const sessionSecret = usableSecret(env.AUTH_SESSION_SECRET)
    ? env.AUTH_SESSION_SECRET
    : testAuthEnabled
      ? TEST_SESSION_SECRET
      : "";
  const bootstrapTokenHash = usableSecret(env.AIQSA_BOOTSTRAP_AUTH_TOKEN_SHA256)
    ? env.AIQSA_BOOTSTRAP_AUTH_TOKEN_SHA256
    : usableSecret(env.AIQSA_BOOTSTRAP_AUTH_TOKEN)
      ? hashToken(env.AIQSA_BOOTSTRAP_AUTH_TOKEN)
      : testAuthEnabled
        ? TEST_AUTH_TOKEN_HASH
        : "";
  const googleOAuth = oauthProviderConfig(
    env.AIQSA_GOOGLE_OAUTH_CLIENT_ID,
    env.AIQSA_GOOGLE_OAUTH_CLIENT_SECRET
  );
  const yandexOAuth = oauthProviderConfig(
    env.AIQSA_YANDEX_OAUTH_CLIENT_ID,
    env.AIQSA_YANDEX_OAUTH_CLIENT_SECRET
  );

  if (
    bootstrapLoginEnabled &&
    shouldWarnForDevBootstrapToken(env, bootstrapTokenHash, testAuthEnabled) &&
    !warnedDevBootstrapToken
  ) {
    warnedDevBootstrapToken = true;
    console.warn(
      "AIQSA bootstrap recovery login is enabled with the known development bootstrap token hash outside APP_ENV=local. Generate a unique AIQSA_BOOTSTRAP_AUTH_TOKEN or AIQSA_BOOTSTRAP_AUTH_TOKEN_SHA256 before exposing the app."
    );
  }

  return {
    appEnv: env.APP_ENV || "",
    appBaseUrl: env.AIQSA_APP_BASE_URL?.trim() || "http://localhost:3000",
    bootstrapConfigured: bootstrapLoginEnabled && Boolean(bootstrapTokenHash),
    bootstrapLoginEnabled,
    bootstrapTokenHash,
    bootstrapUserId: env.AIQSA_BOOTSTRAP_USER_ID || DEFAULT_BOOTSTRAP_USER_ID,
    cookieSecure,
    configured: Boolean(sessionSecret),
    oauthProviders: {
      ...(googleOAuth ? { google: googleOAuth } : {}),
      ...(yandexOAuth ? { yandex: yandexOAuth } : {})
    },
    sessionSecret,
    testAuthEnabled,
    trustForwardedFor,
    trustedProxyCount: trustForwardedFor ? optionalPositiveInteger(env.AIQSA_TRUSTED_PROXY_COUNT) ?? 1 : 0
  };
}

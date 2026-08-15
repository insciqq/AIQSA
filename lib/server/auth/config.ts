import { hashToken } from "./token";
import type { OAuthProviderId } from "../../auth/oauth";
import { isTestAuthAllowedEnv } from "./csrf";
import { getRuntimePeerSecret, isLoopbackHostname } from "./clientIdentity";

export const DEFAULT_BOOTSTRAP_USER_ID = "00000000-0000-4000-8000-000000000001";
export const TEST_AUTH_TOKEN = "aiqsa-test-token";
const TEST_SESSION_SECRET = "aiqsa-test-session-secret";
const TEST_AUTH_TOKEN_HASH = hashToken(TEST_AUTH_TOKEN);
const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);
export const MAX_TRUSTED_PROXY_COUNT = 8;

export type ClientIdentityMode =
  | "direct_loopback"
  | "direct_peer"
  | "invalid"
  | "trusted_proxy";

export type AuthConfig = {
  appBaseUrl: string;
  bootstrapConfigured: boolean;
  bootstrapLoginEnabled: boolean;
  bootstrapTokenHash: string;
  bootstrapUserId: string;
  clientIdentityMode: ClientIdentityMode;
  cookieSecure: boolean;
  configured: boolean;
  oauthProviders: Partial<Record<OAuthProviderId, OAuthProviderConfig>>;
  runtimePeerSecret: string;
  sessionSecret: string;
  testAuthEnabled: boolean;
  trustForwardedFor: boolean;
  trustedProxyConfigurationValid: boolean;
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
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TRUSTED_PROXY_COUNT) {
    return null;
  }

  return parsed;
}

function secureCookieDefault(appBaseUrl: string): boolean {
  try {
    return new URL(appBaseUrl).protocol === "https:";
  } catch {
    return false;
  }
}

function clientIdentityMode(input: {
  appBaseUrl: string;
  bindAddress: string;
  trustForwardedFor: boolean;
  trustedProxyConfigurationValid: boolean;
}): ClientIdentityMode {
  if (!input.trustedProxyConfigurationValid) {
    return "invalid";
  }

  let baseUrl: URL;

  try {
    baseUrl = new URL(input.appBaseUrl);
  } catch {
    return "invalid";
  }

  if (
    !new Set(["http:", "https:"]).has(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password
  ) {
    return "invalid";
  }

  const loopbackBind = isLoopbackHostname(input.bindAddress);

  if (input.trustForwardedFor) {
    return loopbackBind ? "trusted_proxy" : "invalid";
  }

  if (
    baseUrl.protocol !== "http:" ||
    loopbackBind !== isLoopbackHostname(baseUrl.hostname)
  ) {
    return "invalid";
  }

  return loopbackBind ? "direct_loopback" : "direct_peer";
}

export function isTestAuthEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return isTestAuthAllowedEnv(env);
}

function shouldWarnForDevBootstrapToken(
  bootstrapTokenHash: string,
  testAuthEnabled: boolean
): boolean {
  return bootstrapTokenHash === TEST_AUTH_TOKEN_HASH && !testAuthEnabled;
}

let warnedDevBootstrapToken = false;

export function getAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const testAuthEnabled = isTestAuthEnabled(env);
  const bootstrapLoginEnabled = (optionalBoolean(env.AIQSA_BOOTSTRAP_LOGIN_ENABLED) ?? false) || testAuthEnabled;
  const appBaseUrl = env.AIQSA_APP_BASE_URL?.trim() || "http://localhost:3000";
  const cookieSecure = optionalBoolean(env.AIQSA_COOKIE_SECURE) ?? secureCookieDefault(appBaseUrl);
  const trustProxyValue = env.AIQSA_TRUST_PROXY_HEADERS?.trim() ?? "";
  const trustProxySetting = optionalBoolean(trustProxyValue);
  const trustForwardedFor = trustProxySetting ?? false;
  const proxyCountSetting = env.AIQSA_TRUSTED_PROXY_COUNT?.trim() ?? "";
  const parsedProxyCount = optionalPositiveInteger(proxyCountSetting);
  const trustedProxyConfigurationValid =
    (!trustProxyValue && !proxyCountSetting) ||
    (trustProxySetting !== null &&
      (trustForwardedFor
        ? !proxyCountSetting || parsedProxyCount !== null
        : !proxyCountSetting));
  const bindAddress = env.AIQSA_BIND_ADDRESS?.trim() || "127.0.0.1";
  const resolvedClientIdentityMode = clientIdentityMode({
    appBaseUrl,
    bindAddress,
    trustForwardedFor,
    trustedProxyConfigurationValid
  });
  const sessionSecret = usableSecret(env.AIQSA_AUTH_SESSION_SECRET)
    ? env.AIQSA_AUTH_SESSION_SECRET
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
    shouldWarnForDevBootstrapToken(bootstrapTokenHash, testAuthEnabled) &&
    !warnedDevBootstrapToken
  ) {
    warnedDevBootstrapToken = true;
    console.warn(
      "AIQSA bootstrap recovery login is enabled with the known development bootstrap token hash outside test mode. Generate a unique AIQSA_BOOTSTRAP_AUTH_TOKEN or AIQSA_BOOTSTRAP_AUTH_TOKEN_SHA256 before exposing the app."
    );
  }

  return {
    appBaseUrl,
    bootstrapConfigured: bootstrapLoginEnabled && Boolean(bootstrapTokenHash),
    bootstrapLoginEnabled,
    bootstrapTokenHash,
    bootstrapUserId: env.AIQSA_BOOTSTRAP_USER_ID || DEFAULT_BOOTSTRAP_USER_ID,
    clientIdentityMode: resolvedClientIdentityMode,
    cookieSecure,
    configured: Boolean(sessionSecret),
    oauthProviders: {
      ...(googleOAuth ? { google: googleOAuth } : {}),
      ...(yandexOAuth ? { yandex: yandexOAuth } : {})
    },
    runtimePeerSecret: getRuntimePeerSecret(),
    sessionSecret,
    testAuthEnabled,
    trustForwardedFor,
    trustedProxyConfigurationValid,
    trustedProxyCount: trustForwardedFor
      ? proxyCountSetting
        ? parsedProxyCount ?? 0
        : 1
      : 0
  };
}

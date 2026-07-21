import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey
} from "jose";
import type { OAuthProviderId } from "../../auth/oauth";
import type { OAuthProviderConfig } from "./config";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");
const YANDEX_AUTHORIZE_URL = "https://oauth.yandex.ru/authorize";
const YANDEX_TOKEN_URL = "https://oauth.yandex.ru/token";
const YANDEX_PROFILE_URL = "https://login.yandex.ru/info?format=json";
const OAUTH_RESPONSE_MAX_BYTES = 64 * 1024;
const OAUTH_REQUEST_TIMEOUT_MS = 10_000;

const googleJwks = createRemoteJWKSet(GOOGLE_JWKS_URL, {
  timeoutDuration: OAUTH_REQUEST_TIMEOUT_MS
});

export type OAuthAuthorizationInput = {
  clientId: string;
  codeChallenge: string;
  nonce: string;
  provider: OAuthProviderId;
  redirectUri: string;
  state: string;
};

export type OAuthIdentityProfile = {
  displayName: string;
  email: string;
  providerAccountId: string;
};

export type GoogleIdTokenVerifier = (input: {
  clientId: string;
  idToken: string;
  nonce: string;
}) => Promise<OAuthIdentityProfile>;

export type OAuthCodeExchangeInput = {
  code: string;
  codeVerifier: string;
  config: OAuthProviderConfig;
  fetchImpl?: typeof fetch;
  googleIdTokenVerifier?: GoogleIdTokenVerifier;
  nonce: string;
  provider: OAuthProviderId;
  redirectUri: string;
};

export class OAuthProviderError extends Error {
  constructor() {
    super("oauth_provider_failed");
    this.name = "OAuthProviderError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cleanDisplayName(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 160) : "";
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));

  if (Number.isFinite(declaredLength) && declaredLength > OAUTH_RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new OAuthProviderError();
  }

  if (!response.body) {
    throw new OAuthProviderError();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      total += value.byteLength;
      if (total > OAUTH_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new OAuthProviderError();
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new OAuthProviderError();
  }
}

async function fetchJson(input: {
  fetchImpl: typeof fetch;
  init: RequestInit;
  url: string;
}): Promise<unknown> {
  let response: Response;

  try {
    response = await input.fetchImpl(input.url, {
      ...input.init,
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new OAuthProviderError();
  }

  const body = await readBoundedJson(response);

  if (!response.ok) {
    throw new OAuthProviderError();
  }

  return body;
}

function googleTokenForm(input: OAuthCodeExchangeInput): URLSearchParams {
  return new URLSearchParams({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri
  });
}

function yandexTokenForm(input: OAuthCodeExchangeInput): URLSearchParams {
  return new URLSearchParams({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: "authorization_code"
  });
}

function stringClaim(payload: JWTPayload, key: string): string {
  const value = payload[key];

  if (typeof value !== "string" || !value.trim()) {
    throw new OAuthProviderError();
  }

  return value.trim();
}

export function buildOAuthAuthorizationUrl(input: OAuthAuthorizationInput): URL {
  if (input.provider === "google") {
    const url = new URL(GOOGLE_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: input.clientId,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      nonce: input.nonce,
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: input.state
    }).toString();
    return url;
  }

  const url = new URL(YANDEX_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: "login:info login:email",
    state: input.state
  }).toString();
  return url;
}

export async function verifyGoogleIdToken(input: {
  clientId: string;
  idToken: string;
  keySet?: JWTVerifyGetKey;
  nonce: string;
}): Promise<OAuthIdentityProfile> {
  if (!input.idToken || input.idToken.length > 32_768) {
    throw new OAuthProviderError();
  }

  let payload: JWTPayload;

  try {
    ({ payload } = await jwtVerify(input.idToken, input.keySet ?? googleJwks, {
      algorithms: ["RS256"],
      audience: input.clientId,
      issuer: ["https://accounts.google.com", "accounts.google.com"]
    }));
  } catch {
    throw new OAuthProviderError();
  }

  if (payload.nonce !== input.nonce || payload.email_verified !== true) {
    throw new OAuthProviderError();
  }

  const email = stringClaim(payload, "email");

  return {
    displayName: cleanDisplayName(payload.name) || email.split("@")[0] || "AIQSA User",
    email,
    providerAccountId: stringClaim(payload, "sub")
  };
}

async function exchangeGoogleCode(input: OAuthCodeExchangeInput): Promise<OAuthIdentityProfile> {
  const response = await fetchJson({
    fetchImpl: input.fetchImpl ?? fetch,
    init: {
      body: googleTokenForm(input),
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      method: "POST"
    },
    url: GOOGLE_TOKEN_URL
  });

  if (!isRecord(response) || typeof response.id_token !== "string") {
    throw new OAuthProviderError();
  }

  return (input.googleIdTokenVerifier ?? verifyGoogleIdToken)({
    clientId: input.config.clientId,
    idToken: response.id_token,
    nonce: input.nonce
  });
}

async function exchangeYandexCode(input: OAuthCodeExchangeInput): Promise<OAuthIdentityProfile> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const tokenResponse = await fetchJson({
    fetchImpl,
    init: {
      body: yandexTokenForm(input),
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      method: "POST"
    },
    url: YANDEX_TOKEN_URL
  });

  if (!isRecord(tokenResponse) || typeof tokenResponse.access_token !== "string" || !tokenResponse.access_token) {
    throw new OAuthProviderError();
  }

  const profile = await fetchJson({
    fetchImpl,
    init: {
      headers: {
        authorization: `OAuth ${tokenResponse.access_token}`
      },
      method: "GET"
    },
    url: YANDEX_PROFILE_URL
  });

  if (
    !isRecord(profile) ||
    profile.client_id !== input.config.clientId ||
    typeof profile.id !== "string" ||
    !profile.id.trim() ||
    typeof profile.default_email !== "string" ||
    !profile.default_email.trim()
  ) {
    throw new OAuthProviderError();
  }

  const displayName =
    cleanDisplayName(profile.real_name) ||
    cleanDisplayName(profile.display_name) ||
    [cleanDisplayName(profile.first_name), cleanDisplayName(profile.last_name)].filter(Boolean).join(" ");

  return {
    displayName: displayName || profile.default_email.split("@")[0] || "AIQSA User",
    email: profile.default_email.trim(),
    providerAccountId: profile.id.trim()
  };
}

export async function exchangeOAuthCode(input: OAuthCodeExchangeInput): Promise<OAuthIdentityProfile> {
  return input.provider === "google" ? exchangeGoogleCode(input) : exchangeYandexCode(input);
}

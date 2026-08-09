import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { safeInternalPath } from "../../auth/internalPath";
import {
  isOAuthProviderId,
  type OAuthLoginOutcome,
  type OAuthProviderId
} from "../../auth/oauth";
import type { AuthConfig } from "./config";
import { resolveLoginRateLimitIdentity } from "./clientIdentity";
import type { OAuthIdentityRepository } from "./oauthRepository";
import {
  buildOAuthAuthorizationUrl,
  exchangeOAuthCode,
  type GoogleIdTokenVerifier
} from "./oauthProviders";
import { isPlausibleEmail, normalizeAuthEmail } from "./password";
import {
  createFixedWindowLoginRateLimiter,
  resolveLoginRateLimiter,
  type LoginRateLimiter
} from "./rateLimit";
import { createAuthSession, type AuthSessionStore } from "./requestAuth";
import { readCookie } from "./session";

export const OAUTH_FLOW_COOKIE_NAME = "aiqsa_oauth_flow";
export const OAUTH_FLOW_MAX_AGE_SECONDS = 10 * 60;
export const OAUTH_PROVIDER_ADMISSION_MAX_ATTEMPTS = 60;
export const OAUTH_PROVIDER_ADMISSION_WINDOW_MS = 10 * 60 * 1000;

type OAuthFlow = {
  codeVerifier: string;
  nextPath: string;
  nonce: string;
  provider: OAuthProviderId;
  state: string;
};

type OAuthRouteContext = {
  params: Promise<{ provider: string }> | { provider: string };
};

type OAuthStartHandlerDeps = {
  getConfig(): AuthConfig;
  now?: () => Date;
  randomToken?: () => string;
};

type OAuthCallbackHandlerDeps = {
  exchangeCode?: typeof exchangeOAuthCode;
  fetchImpl?: typeof fetch;
  getConfig(): AuthConfig;
  googleIdTokenVerifier?: GoogleIdTokenVerifier;
  loginRateLimiter?: LoginRateLimiter;
  now?: () => Date;
  oauthFlowRateLimiter?: LoginRateLimiter;
  oauthProviderRateLimiter?: LoginRateLimiter;
  repository: OAuthIdentityRepository;
  sessions: AuthSessionStore;
};

const defaultOAuthLoginRateLimiter = createFixedWindowLoginRateLimiter();
const OAUTH_FLOW_ADMISSION_KEY_DOMAIN = "aiqsa:oauth-flow-admission:v1\0";

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function codeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function oauthRedirectUri(config: AuthConfig, provider: OAuthProviderId): string {
  return new URL(`/api/auth/oauth/${provider}/callback`, config.appBaseUrl).toString();
}

function flowCookie(value: string, input: { maxAge: number; secure: boolean }): string {
  const attributes = [
    `${OAUTH_FLOW_COOKIE_NAME}=${value}`,
    "Path=/api/auth/oauth",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${input.maxAge}`
  ];

  if (input.secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

function clearFlowCookie(secure: boolean): string {
  return flowCookie("", {
    maxAge: 0,
    secure
  });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({
    location,
    "referrer-policy": "no-referrer"
  });

  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }

  return new Response(null, {
    headers,
    status: 303
  });
}

function outcomeUrl(input: {
  appBaseUrl: string;
  nextPath: string;
  outcome: OAuthLoginOutcome;
  provider: OAuthProviderId;
}): string {
  const url = new URL("/login", input.appBaseUrl);
  url.searchParams.set("oauth", input.outcome);
  url.searchParams.set("provider", input.provider);

  if (input.nextPath !== "/") {
    url.searchParams.set("next", safeInternalPath(input.nextPath, input.appBaseUrl));
  }

  return url.toString();
}

function exactMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);

  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function oauthFlowAdmissionKey(input: {
  flowToken: string;
  provider: OAuthProviderId;
  secret: string;
  state: string;
}): string {
  const proofDigest = createHmac("sha256", input.secret)
    .update(OAUTH_FLOW_ADMISSION_KEY_DOMAIN, "utf8")
    .update(input.provider, "utf8")
    .update("\0", "utf8")
    .update(input.flowToken, "utf8")
    .update("\0", "utf8")
    .update(input.state, "utf8")
    .digest("hex");

  return `oauth-callback:${input.provider}:flow:${proofDigest}`;
}

function oauthProviderAdmissionKey(provider: OAuthProviderId): string {
  return `oauth-callback:${provider}:installation`;
}

function singleQueryValue(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);

  return values.length === 1 && values[0] ? values[0] : null;
}

async function signFlow(flow: OAuthFlow, config: AuthConfig, now: Date): Promise<string> {
  return new SignJWT({
    codeVerifier: flow.codeVerifier,
    nextPath: flow.nextPath,
    nonce: flow.nonce,
    provider: flow.provider,
    state: flow.state
  })
    .setProtectedHeader({
      alg: "HS256",
      typ: "JWT"
    })
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(now.getTime() / 1000) + OAUTH_FLOW_MAX_AGE_SECONDS)
    .sign(new TextEncoder().encode(config.sessionSecret));
}

async function verifyFlow(token: string, config: AuthConfig, now: Date): Promise<OAuthFlow | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(config.sessionSecret), {
      algorithms: ["HS256"],
      currentDate: now,
      maxTokenAge: `${OAUTH_FLOW_MAX_AGE_SECONDS}s`
    });

    if (
      !isOAuthProviderId(payload.provider) ||
      typeof payload.state !== "string" ||
      !payload.state ||
      typeof payload.codeVerifier !== "string" ||
      !payload.codeVerifier ||
      typeof payload.nonce !== "string" ||
      !payload.nonce ||
      typeof payload.nextPath !== "string"
    ) {
      return null;
    }

    return {
      codeVerifier: payload.codeVerifier,
      nextPath: safeInternalPath(payload.nextPath, config.appBaseUrl),
      nonce: payload.nonce,
      provider: payload.provider,
      state: payload.state
    };
  } catch {
    return null;
  }
}

function unavailable(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

export function createOAuthStartHandler(deps: OAuthStartHandlerDeps) {
  return async function GET(request: Request, context: OAuthRouteContext): Promise<Response> {
    const { provider: rawProvider } = await context.params;
    const config = deps.getConfig();

    if (!config.configured) {
      return Response.json({ error: "auth_not_configured" }, { status: 503 });
    }

    if (!isOAuthProviderId(rawProvider)) {
      return unavailable();
    }

    const providerConfig = config.oauthProviders[rawProvider];

    if (!providerConfig) {
      return unavailable();
    }

    const nextPath = safeInternalPath(new URL(request.url).searchParams.get("next"), config.appBaseUrl);
    const token = deps.randomToken ?? randomToken;
    const flow: OAuthFlow = {
      codeVerifier: token(),
      nextPath,
      nonce: token(),
      provider: rawProvider,
      state: token()
    };
    const redirectUri = oauthRedirectUri(config, rawProvider);
    const authorizationUrl = buildOAuthAuthorizationUrl({
      clientId: providerConfig.clientId,
      codeChallenge: codeChallenge(flow.codeVerifier),
      nonce: flow.nonce,
      provider: rawProvider,
      redirectUri,
      state: flow.state
    });
    const signedFlow = await signFlow(flow, config, deps.now?.() ?? new Date());

    return redirect(authorizationUrl.toString(), [
      flowCookie(signedFlow, {
        maxAge: OAUTH_FLOW_MAX_AGE_SECONDS,
        secure: config.cookieSecure
      })
    ]);
  };
}

export function createOAuthCallbackHandler(deps: OAuthCallbackHandlerDeps) {
  const testFlowRateLimiter = createFixedWindowLoginRateLimiter({
    maxAttempts: 1,
    windowMs: OAUTH_FLOW_MAX_AGE_SECONDS * 1000
  });
  const testProviderRateLimiter = createFixedWindowLoginRateLimiter({
    maxAttempts: OAUTH_PROVIDER_ADMISSION_MAX_ATTEMPTS,
    windowMs: OAUTH_PROVIDER_ADMISSION_WINDOW_MS
  });

  return async function GET(request: Request, context: OAuthRouteContext): Promise<Response> {
    const { provider: rawProvider } = await context.params;
    const config = deps.getConfig();

    if (!config.configured || !isOAuthProviderId(rawProvider)) {
      return unavailable();
    }

    const providerConfig = config.oauthProviders[rawProvider];

    if (!providerConfig) {
      return unavailable();
    }

    const clearCookie = clearFlowCookie(config.cookieSecure);
    const now = deps.now?.() ?? new Date();
    const flowToken = readCookie(request.headers.get("cookie"), OAUTH_FLOW_COOKIE_NAME);
    const flow = flowToken ? await verifyFlow(flowToken, config, now) : null;
    const query = new URL(request.url).searchParams;
    const state = singleQueryValue(query, "state");

    if (!flow || flow.provider !== rawProvider || !state || !exactMatch(state, flow.state)) {
      return redirect(
        outcomeUrl({
          appBaseUrl: config.appBaseUrl,
          nextPath: "/",
          outcome: "failed",
          provider: rawProvider
        }),
        [clearCookie]
      );
    }

    const providerErrors = query.getAll("error");
    const codes = query.getAll("code");

    if (providerErrors.length > 1 || codes.length > 1 || (providerErrors.length > 0 && codes.length > 0)) {
      return redirect(
        outcomeUrl({
          appBaseUrl: config.appBaseUrl,
          nextPath: flow.nextPath,
          outcome: "failed",
          provider: rawProvider
        }),
        [clearCookie]
      );
    }

    const providerError = providerErrors[0] || null;

    if (providerError) {
      return redirect(
        outcomeUrl({
          appBaseUrl: config.appBaseUrl,
          nextPath: flow.nextPath,
          outcome: providerError === "access_denied" ? "cancelled" : "failed",
          provider: rawProvider
        }),
        [clearCookie]
      );
    }

    const code = codes[0] || null;

    if (!code) {
      return redirect(
        outcomeUrl({
          appBaseUrl: config.appBaseUrl,
          nextPath: flow.nextPath,
          outcome: "failed",
          provider: rawProvider
        }),
        [clearCookie]
      );
    }

    const loginRateLimiter = resolveLoginRateLimiter(
      deps.loginRateLimiter,
      defaultOAuthLoginRateLimiter
    );
    const oauthFlowRateLimiter = resolveLoginRateLimiter(
      deps.oauthFlowRateLimiter,
      testFlowRateLimiter
    );
    const oauthProviderRateLimiter = resolveLoginRateLimiter(
      deps.oauthProviderRateLimiter,
      testProviderRateLimiter
    );
    const clientIdentity = resolveLoginRateLimitIdentity(request, config);

    if (clientIdentity.status === "unavailable") {
      return redirect(
        outcomeUrl({
          appBaseUrl: config.appBaseUrl,
          nextPath: flow.nextPath,
          outcome: "failed",
          provider: rawProvider
        }),
        [clearCookie]
      );
    }

    const rateLimitKey = clientIdentity.status === "available"
      ? `oauth-callback:${rawProvider}:client:${clientIdentity.key}`
      : null;

    if (rateLimitKey) {
      const rateLimit = await loginRateLimiter.check(rateLimitKey);

      if (!rateLimit.allowed) {
        const response = redirect(
          outcomeUrl({
            appBaseUrl: config.appBaseUrl,
            nextPath: flow.nextPath,
            outcome: "failed",
            provider: rawProvider
          }),
          [clearCookie]
        );
        response.headers.set("retry-after", String(rateLimit.retryAfterSeconds));
        return response;
      }
    }

    const flowRateLimit = await oauthFlowRateLimiter.check(oauthFlowAdmissionKey({
      flowToken: flowToken!,
      provider: rawProvider,
      secret: config.sessionSecret,
      state: flow.state
    }));

    if (!flowRateLimit.allowed) {
      const response = redirect(
        outcomeUrl({
          appBaseUrl: config.appBaseUrl,
          nextPath: flow.nextPath,
          outcome: "failed",
          provider: rawProvider
        }),
        [clearCookie]
      );
      response.headers.set("retry-after", String(flowRateLimit.retryAfterSeconds));
      return response;
    }

    const providerRateLimit = await oauthProviderRateLimiter.check(
      oauthProviderAdmissionKey(rawProvider)
    );

    if (!providerRateLimit.allowed) {
      const response = redirect(
        outcomeUrl({
          appBaseUrl: config.appBaseUrl,
          nextPath: flow.nextPath,
          outcome: "failed",
          provider: rawProvider
        }),
        [clearCookie]
      );
      response.headers.set("retry-after", String(providerRateLimit.retryAfterSeconds));
      return response;
    }

    try {
      const profile = await (deps.exchangeCode ?? exchangeOAuthCode)({
        code,
        codeVerifier: flow.codeVerifier,
        config: providerConfig,
        fetchImpl: deps.fetchImpl,
        googleIdTokenVerifier: deps.googleIdTokenVerifier,
        nonce: flow.nonce,
        provider: rawProvider,
        redirectUri: oauthRedirectUri(config, rawProvider)
      });
      const normalizedEmail = normalizeAuthEmail(profile.email);

      if (!isPlausibleEmail(normalizedEmail) || !profile.providerAccountId.trim()) {
        throw new Error("invalid_oauth_profile");
      }

      const settlement = await deps.repository.settleIdentity({
        displayName: profile.displayName,
        email: normalizedEmail,
        now,
        provider: rawProvider,
        providerAccountId: profile.providerAccountId
      });

      if (settlement.status !== "active") {
        return redirect(
          outcomeUrl({
            appBaseUrl: config.appBaseUrl,
            nextPath: flow.nextPath,
            outcome: settlement.status,
            provider: rawProvider
          }),
          [clearCookie]
        );
      }

      const session = await createAuthSession({
        now,
        request,
        secureCookie: config.cookieSecure,
        sessions: deps.sessions,
        userId: settlement.userId
      });
      if (rateLimitKey) {
        await loginRateLimiter.reset(rateLimitKey);
      }

      return redirect(new URL(flow.nextPath, config.appBaseUrl).toString(), [clearCookie, session.cookie]);
    } catch {
      return redirect(
        outcomeUrl({
          appBaseUrl: config.appBaseUrl,
          nextPath: flow.nextPath,
          outcome: "failed",
          provider: rawProvider
        }),
        [clearCookie]
      );
    }
  };
}

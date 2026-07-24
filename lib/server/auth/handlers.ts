import { createSessionClearCookie, createSessionToken } from "./session";
import { validateRunAccess, type ResolvedEntitlements } from "./entitlements";
import type { AuthMailer } from "./mailer";
import {
  hashPassword as hashPasswordDefault,
  isPlausibleEmail,
  normalizeAuthEmail,
  validatePassword,
  verifyPassword as verifyPasswordDefault
} from "./password";
import type { PasswordAuthRepository, PasswordIdentityRecord } from "./passwordRepository";
import {
  createFixedWindowLoginRateLimiter,
  type LoginRateLimiter
} from "./rateLimit";
import {
  createAuthSession,
  prepareAuthSession,
  revokeRequestSession,
  type AuthSessionStore,
  type RequestAuthResolver
} from "./requestAuth";
import { hashToken, verifyTokenHash as verifyTokenHashDefault } from "./token";
import type { AuthConfig } from "./config";

export type SafeUser = {
  displayName: string;
  email: string | null;
  id: string;
  role: string;
  status: string;
};

export type SafeUserWithGroups = SafeUser & {
  groups: {
    groupId: string;
    name: string;
    role: string;
  }[];
};

export type AuthHandlerDeps = {
  findUserById(userId: string): Promise<SafeUser | null>;
  getConfig(): AuthConfig;
  loginRateLimiter?: LoginRateLimiter;
  sessions: AuthSessionStore;
  verifyTokenHash?: (token: string, expectedHash: string) => boolean;
};

export type MeHandlerDeps = {
  findUserWithGroups(userId: string): Promise<SafeUserWithGroups | null>;
  resolveAuth: RequestAuthResolver;
};

export type MessageAccessHandlerDeps = {
  findOwnedChat(chatId: string, userId: string): Promise<{ id: string } | null>;
  loadEntitlements(userId: string): Promise<ResolvedEntitlements>;
  resolveAuth: RequestAuthResolver;
};

type LogoutHandlerDeps = {
  getConfig(): Pick<AuthConfig, "cookieSecure">;
  sessions: AuthSessionStore;
};

export type PasswordLoginHandlerDeps = {
  getConfig(): AuthConfig;
  loginRateLimiter?: LoginRateLimiter;
  repository: PasswordAuthRepository;
  verifyPassword?: (password: string, passwordHash: string | null | undefined) => Promise<boolean>;
};

export type PasswordResetRequestHandlerDeps = {
  clock?: () => number;
  getConfig(): AuthConfig;
  mailer: AuthMailer;
  now?: () => Date;
  repository: PasswordAuthRepository;
  resetRateLimiter?: LoginRateLimiter;
  responseFloorMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type PasswordResetCompleteHandlerDeps = {
  getConfig(): AuthConfig;
  passwordHasher?: (password: string) => Promise<string>;
  now?: () => Date;
  repository: PasswordAuthRepository;
  resetCompleteRateLimiter?: LoginRateLimiter;
};

const defaultLoginRateLimiter = createFixedWindowLoginRateLimiter();
const defaultResetRateLimiter = createFixedWindowLoginRateLimiter();
const defaultResetCompleteRateLimiter = createFixedWindowLoginRateLimiter();
export const UNKNOWN_LOGIN_RATE_LIMIT_KEY = "unknown-client";
export const PASSWORD_RESET_MAX_AGE_SECONDS = 60 * 60;
export const PASSWORD_RESET_RESPONSE_FLOOR_MS = 100;
const DUMMY_PASSWORD_HASH =
  "aiqsa-scrypt-v1$N=16384,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$rmM9JCGyQbwbUPgnezPVMCI7l8Gg0Gv7nvxL4hxR8ngyb8E3JmLHq607G0T-uTPPDSb_c-X3RWDvsVF8ZusM3Q";

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, { status: 401 });
}

function isActiveUser(user: SafeUser): boolean {
  return user.status === "active";
}

export function isJsonContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";

  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function requireJsonContentType(request: Request): Response | null {
  if (isJsonContentType(request.headers.get("content-type"))) {
    return null;
  }

  return json({ error: "json_required" }, { status: 415 });
}

function cleanIpValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed && !trimmed.includes(",") ? trimmed : null;
}

function forwardedForIp(value: string | null, trustedProxyCount: number): string | null {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!entries?.length) {
    return null;
  }

  const clientIndex = entries.length - trustedProxyCount - 1;

  return clientIndex >= 0 ? entries[clientIndex] : null;
}

export function getLoginRateLimitKey(
  request: Request,
  trustForwardedFor: boolean,
  trustedProxyCount = trustForwardedFor ? 1 : 0
): string {
  if (trustForwardedFor) {
    const forwardedFor = forwardedForIp(request.headers.get("x-forwarded-for"), Math.max(1, trustedProxyCount));

    if (forwardedFor) {
      return `ip:${forwardedFor}`;
    }

    const realIp = cleanIpValue(request.headers.get("x-real-ip"));

    if (realIp) {
      return `ip:${realIp}`;
    }
  }

  return UNKNOWN_LOGIN_RATE_LIMIT_KEY;
}

function tokenFromBody(body: unknown): unknown {
  return typeof body === "object" && body && "token" in body ? body.token : undefined;
}

function bootstrapRateLimitKey(input: { config: AuthConfig; request: Request }): string {
  const identityKey = getLoginRateLimitKey(input.request, input.config.trustForwardedFor, input.config.trustedProxyCount);

  return `bootstrap-login:${identityKey}`;
}

function credentialRateLimitKey(input: {
  config: AuthConfig;
  email: string;
  prefix: string;
  request: Request;
}): string {
  const identityKey = getLoginRateLimitKey(input.request, input.config.trustForwardedFor, input.config.trustedProxyCount);

  return `${input.prefix}:${identityKey}:email:${hashToken(input.email).slice(0, 32)}`;
}

function credentialClientRateLimitKey(input: {
  config: AuthConfig;
  prefix: string;
  request: Request;
}): string {
  const identityKey = getLoginRateLimitKey(input.request, input.config.trustForwardedFor, input.config.trustedProxyCount);

  return `${input.prefix}:${identityKey}:client`;
}

function credentialTokenRateLimitKey(input: { prefix: string; token: string }): string {
  return `${input.prefix}:token:${hashToken(input.token).slice(0, 32)}`;
}

function rateLimitedResponse(rateLimit: { retryAfterSeconds: number }): Response {
  return json(
    { error: "rate_limited" },
    {
      headers: {
        "retry-after": String(rateLimit.retryAfterSeconds)
      },
      status: 429
    }
  );
}

function credentialsFromBody(body: unknown): { email: string; password: string } | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const email = "email" in body ? body.email : undefined;
  const password = "password" in body ? body.password : undefined;

  return typeof email === "string" && typeof password === "string" ? { email, password } : null;
}

function emailFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("email" in body) || typeof body.email !== "string") {
    return null;
  }

  return body.email;
}

function resetCompleteBody(body: unknown): { password: string; token: string } | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const token = "token" in body ? body.token : undefined;
  const password = "password" in body ? body.password : undefined;

  return typeof token === "string" && typeof password === "string" ? { password, token } : null;
}

function isActiveVerifiedPasswordIdentity(
  identity: PasswordIdentityRecord | null
): identity is PasswordIdentityRecord {
  return Boolean(identity?.emailVerifiedAt && identity.user.status === "active");
}

function passwordResetExpiresAt(now: Date): Date {
  return new Date(now.getTime() + PASSWORD_RESET_MAX_AGE_SECONDS * 1000);
}

function passwordResetUrl(baseUrl: string, token: string): string {
  const url = new URL("/login", baseUrl);

  url.searchParams.set("reset", token);

  return url.toString();
}

function passwordResetEmail(input: { resetUrl: string; to: string }): { subject: string; text: string; to: string } {
  return {
    subject: "Reset your AIQSA password",
    text: [
      "A password reset was requested for your AIQSA account.",
      "",
      "Open this link to set a new password:",
      input.resetUrl,
      "",
      "If you did not request this reset, ignore this email."
    ].join("\n"),
    to: input.to
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForResponseFloor(input: {
  clock: () => number;
  floorMs: number;
  sleepFor: (milliseconds: number) => Promise<void>;
  startedAtMs: number;
}): Promise<void> {
  const remainingMs = Math.max(0, input.floorMs - (input.clock() - input.startedAtMs));

  if (remainingMs > 0) {
    await input.sleepFor(remainingMs);
  }
}

export function createTokenLoginHandler(deps: AuthHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const config = deps.getConfig();

    if (!config.configured) {
      return json({ error: "auth_not_configured" }, { status: 503 });
    }

    if (!config.bootstrapLoginEnabled) {
      return json({ error: "not_found" }, { status: 404 });
    }

    if (!config.bootstrapConfigured) {
      return json({ error: "bootstrap_not_configured" }, { status: 503 });
    }

    const contentTypeError = requireJsonContentType(request);

    if (contentTypeError) {
      return contentTypeError;
    }

    const loginRateLimiter = deps.loginRateLimiter ?? defaultLoginRateLimiter;
    const rateLimitKey = bootstrapRateLimitKey({ config, request });
    const rateLimit = loginRateLimiter.check(rateLimitKey);

    if (!rateLimit.allowed) {
      return rateLimitedResponse(rateLimit);
    }

    const body = await readJson(request);
    const token = tokenFromBody(body);

    if (typeof token !== "string" || !token) {
      return json({ error: "token_required" }, { status: 400 });
    }

    const verifyTokenHash = deps.verifyTokenHash ?? verifyTokenHashDefault;

    if (!verifyTokenHash(token, config.bootstrapTokenHash)) {
      return unauthorized();
    }

    const user = await deps.findUserById(config.bootstrapUserId);

    if (!user) {
      return json({ error: "bootstrap_user_not_found" }, { status: 500 });
    }

    if (!isActiveUser(user)) {
      return unauthorized();
    }

    const session = await createAuthSession({
      request,
      secureCookie: config.cookieSecure,
      sessions: deps.sessions,
      userId: user.id
    });
    loginRateLimiter.reset(rateLimitKey);

    return json(
      {
        user
      },
      {
        headers: {
          "set-cookie": session.cookie
        }
      }
    );
  };
}

export function createPasswordLoginHandler(deps: PasswordLoginHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const config = deps.getConfig();

    if (!config.configured) {
      return json({ error: "auth_not_configured" }, { status: 503 });
    }

    const contentTypeError = requireJsonContentType(request);

    if (contentTypeError) {
      return contentTypeError;
    }

    const credentials = credentialsFromBody(await readJson(request));

    if (!credentials || !credentials.email.trim() || !credentials.password) {
      return json({ error: "credentials_required" }, { status: 400 });
    }

    const normalizedEmail = normalizeAuthEmail(credentials.email);

    if (!isPlausibleEmail(normalizedEmail)) {
      return unauthorized();
    }

    const rateLimitKey = credentialRateLimitKey({
      config,
      email: normalizedEmail,
      prefix: "password-login",
      request
    });
    const clientRateLimitKey = credentialClientRateLimitKey({
      config,
      prefix: "password-login",
      request
    });
    const loginRateLimiter = deps.loginRateLimiter ?? defaultLoginRateLimiter;
    const clientRateLimit = loginRateLimiter.check(clientRateLimitKey);

    if (!clientRateLimit.allowed) {
      return rateLimitedResponse(clientRateLimit);
    }

    const rateLimit = loginRateLimiter.check(rateLimitKey);

    if (!rateLimit.allowed) {
      return rateLimitedResponse(rateLimit);
    }

    const identity = await deps.repository.findPasswordIdentityByEmail(normalizedEmail);
    const verifyPassword = deps.verifyPassword ?? verifyPasswordDefault;
    const usablePasswordHash =
      isActiveVerifiedPasswordIdentity(identity) && identity.passwordHash ? identity.passwordHash : DUMMY_PASSWORD_HASH;
    const passwordOk = await verifyPassword(credentials.password, usablePasswordHash);

    if (!identity?.passwordHash || !passwordOk || !isActiveVerifiedPasswordIdentity(identity)) {
      return unauthorized();
    }

    const session = prepareAuthSession({
      request,
      secureCookie: config.cookieSecure
    });
    const currentCredential = await deps.repository.createSessionForCurrentPassword({
      identityId: identity.id,
      passwordHash: identity.passwordHash,
      session: session.input
    });

    if (!currentCredential) {
      return unauthorized();
    }

    loginRateLimiter.reset(clientRateLimitKey);
    loginRateLimiter.reset(rateLimitKey);

    return json(
      {
        user: currentCredential.user
      },
      {
        headers: {
          "set-cookie": session.cookie
        }
      }
    );
  };
}

export function createPasswordResetRequestHandler(deps: PasswordResetRequestHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const config = deps.getConfig();

    if (!config.configured) {
      return json({ error: "auth_not_configured" }, { status: 503 });
    }

    const contentTypeError = requireJsonContentType(request);

    if (contentTypeError) {
      return contentTypeError;
    }

    const email = emailFromBody(await readJson(request));

    if (!email?.trim()) {
      return json({ error: "email_required" }, { status: 400 });
    }

    const normalizedEmail = normalizeAuthEmail(email);

    if (!isPlausibleEmail(normalizedEmail)) {
      return json({ ok: true });
    }

    const rateLimitKey = credentialRateLimitKey({
      config,
      email: normalizedEmail,
      prefix: "password-reset",
      request
    });
    const clientRateLimitKey = credentialClientRateLimitKey({
      config,
      prefix: "password-reset",
      request
    });
    const resetRateLimiter = deps.resetRateLimiter ?? defaultResetRateLimiter;
    const clientRateLimit = resetRateLimiter.check(clientRateLimitKey);

    if (!clientRateLimit.allowed) {
      return rateLimitedResponse(clientRateLimit);
    }

    const rateLimit = resetRateLimiter.check(rateLimitKey);

    if (!rateLimit.allowed) {
      return rateLimitedResponse(rateLimit);
    }

    const clock = deps.clock ?? Date.now;
    const startedAtMs = clock();

    const identity = await deps.repository.findPasswordIdentityByEmail(normalizedEmail);

    if (isActiveVerifiedPasswordIdentity(identity)) {
      const now = deps.now?.() ?? new Date();
      const token = createSessionToken();

      await deps.repository.createPasswordResetToken({
        expiresAt: passwordResetExpiresAt(now),
        identityId: identity.id,
        normalizedEmail,
        sentToEmail: identity.user.email ?? identity.normalizedEmail,
        tokenHash: hashToken(token),
        userId: identity.userId
      });
      void deps.mailer
        .send(
          passwordResetEmail({
            resetUrl: passwordResetUrl(config.appBaseUrl, token),
            to: identity.user.email ?? identity.normalizedEmail
          }),
          "password_reset"
        )
        .catch(() => undefined);
    }

    await waitForResponseFloor({
      clock,
      floorMs: deps.responseFloorMs ?? PASSWORD_RESET_RESPONSE_FLOOR_MS,
      sleepFor: deps.sleep ?? sleep,
      startedAtMs
    });

    return json({ ok: true });
  };
}

export function createPasswordResetCompleteHandler(deps: PasswordResetCompleteHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const contentTypeError = requireJsonContentType(request);

    if (contentTypeError) {
      return contentTypeError;
    }

    const body = resetCompleteBody(await readJson(request));

    if (!body || !body.token.trim() || !body.password) {
      return json({ error: "reset_token_password_required" }, { status: 400 });
    }

    const passwordError = validatePassword(body.password);

    if (passwordError) {
      return json({ error: passwordError }, { status: 400 });
    }

    const config = deps.getConfig();
    const rateLimiter = deps.resetCompleteRateLimiter ?? defaultResetCompleteRateLimiter;
    const clientRateLimitKey = credentialClientRateLimitKey({
      config,
      prefix: "password-reset-complete",
      request
    });
    const tokenRateLimitKey = credentialTokenRateLimitKey({
      prefix: "password-reset-complete",
      token: body.token
    });
    const clientRateLimit = rateLimiter.check(clientRateLimitKey);

    if (!clientRateLimit.allowed) {
      return rateLimitedResponse(clientRateLimit);
    }

    const tokenRateLimit = rateLimiter.check(tokenRateLimitKey);

    if (!tokenRateLimit.allowed) {
      return rateLimitedResponse(tokenRateLimit);
    }

    const now = deps.now?.() ?? new Date();
    const passwordHash = await (deps.passwordHasher ?? hashPasswordDefault)(body.password);
    const result = await deps.repository.completePasswordReset({
      now,
      passwordHash,
      tokenHash: hashToken(body.token)
    });

    if (!result) {
      return json({ error: "invalid_or_expired_reset_token" }, { status: 400 });
    }

    return json({ ok: true });
  };
}

export function createLogoutHandler(deps: LogoutHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const contentTypeError = requireJsonContentType(request);

    if (contentTypeError) {
      return contentTypeError;
    }

    const config = deps.getConfig();
    await revokeRequestSession({
      request,
      revokedReason: "logout",
      sessions: deps.sessions
    });

    return new Response(null, {
      headers: {
        "set-cookie": createSessionClearCookie({
          secure: config.cookieSecure
        })
      },
      status: 204
    });
  };
}

export function createMeHandler(deps: MeHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) {
      return unauthorized();
    }

    const user = await deps.findUserWithGroups(auth.userId);

    if (!user) {
      return unauthorized();
    }

    return json({ user });
  };
}

export function createMessageAccessValidationHandler(deps: MessageAccessHandlerDeps) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ chatId: string }> | { chatId: string } }
  ): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) {
      return unauthorized();
    }

    const params = await context.params;
    const chat = await deps.findOwnedChat(params.chatId, auth.userId);

    if (!chat) {
      return json({ error: "chat_not_found" }, { status: 404 });
    }

    const body = await readJson(request);
    const provider = typeof body === "object" && body && "provider" in body ? body.provider : undefined;
    const modelId = typeof body === "object" && body && "modelId" in body ? body.modelId : undefined;
    const searchStrategy =
      typeof body === "object" && body && "searchStrategy" in body ? body.searchStrategy : undefined;

    if (typeof provider !== "string" || typeof modelId !== "string") {
      return json({ error: "provider_model_required" }, { status: 400 });
    }

    const entitlements = await deps.loadEntitlements(auth.userId);
    const access = validateRunAccess(entitlements, {
      modelId,
      provider,
      searchStrategy: typeof searchStrategy === "string" ? searchStrategy : null
    });

    if (!access.ok) {
      return json({ error: access.code }, { status: 403 });
    }

    return json({
      chatId: chat.id,
      modelId,
      ok: true,
      provider,
      searchStrategy: typeof searchStrategy === "string" ? searchStrategy : null
    });
  };
}

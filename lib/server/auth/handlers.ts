import { createSecondFactorChallengeCookie } from "./secondFactorChallenge";
import { createSessionClearCookie, createSessionToken, getSessionFromRequest } from "./session";
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
  LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
  resolveLoginRateLimiter,
  type LoginRateLimitDecision,
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
import { resolveLoginRateLimitIdentity } from "./clientIdentity";
import { refuseWhenPasswordSignInOff, type SignInPolicyReader } from "./signInPolicy";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import {
  waitForAuthResponseFloor
} from "./responseFloor";

export { getLoginRateLimitKey } from "./clientIdentity";

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
  /** False for accounts that sign in only through an external identity provider. */
  hasPassword?: boolean;
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

type LogoutHandlerDeps = {
  getConfig(): Pick<AuthConfig, "cookieSecure">;
  /**
   * Where the browser goes next to end the identity provider's session of a just revoked
   * session that `signInMethod` signed in (OIDC IdP logout), or null. Never fails the logout.
   */
  identityProviderLogout?(input: { signInMethod: string | null }): Promise<string | null>;
  sessions: AuthSessionStore;
};

export type PasswordLoginHandlerDeps = {
  getConfig(): AuthConfig;
  loginRateLimiter?: LoginRateLimiter;
  repository: PasswordAuthRepository;
  /** The password sign-in switch; absent means on. */
  signInPolicy?: SignInPolicyReader;
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
  signInPolicy?: SignInPolicyReader;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type PasswordResetCompleteHandlerDeps = {
  getConfig(): AuthConfig;
  /** The password-login limiter whose account lock a completed reset clears. */
  loginRateLimiter?: LoginRateLimiter;
  passwordHasher?: (password: string) => Promise<string>;
  now?: () => Date;
  repository: PasswordAuthRepository;
  resetCompleteRateLimiter?: LoginRateLimiter;
  signInPolicy?: SignInPolicyReader;
};

const defaultLoginRateLimiter = createFixedWindowLoginRateLimiter();
const defaultResetRateLimiter = createFixedWindowLoginRateLimiter();
const defaultResetCompleteRateLimiter = createFixedWindowLoginRateLimiter();
export const PASSWORD_RESET_MAX_AGE_SECONDS = 60 * 60;
/**
 * Account-wide password-login attempts tolerated from identified sources before the
 * account counts as under distributed attack. Twice the per-source budget, so one or two
 * sources exhausting their own budgets never change what any other source may do.
 */
export const PASSWORD_LOGIN_DISTRIBUTED_CEILING = 2 * LOGIN_RATE_LIMIT_MAX_ATTEMPTS;
const DUMMY_PASSWORD_HASH =
  "aiqsa-scrypt-v1$N=16384,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$rmM9JCGyQbwbUPgnezPVMCI7l8Gg0Gv7nvxL4hxR8ngyb8E3JmLHq607G0T-uTPPDSb_c-X3RWDvsVF8ZusM3Q";

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

async function readJson(request: Request): Promise<unknown> {
  return readJsonBodyOrNull(request, "auth");
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, { status: 401 });
}

function authAdmissionUnavailable(): Response {
  return json({ error: "auth_admission_unavailable" }, { status: 503 });
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

function tokenFromBody(body: unknown): unknown {
  return typeof body === "object" && body && "token" in body ? body.token : undefined;
}

function bootstrapRateLimitKey(
  input: { config: AuthConfig; request: Request }
): { key: string; status: "available" } | { status: "unavailable" } {
  const identity = resolveLoginRateLimitIdentity(input.request, input.config);

  if (identity.status === "unavailable") {
    return identity;
  }

  return {
    key: identity.status === "available"
      ? `bootstrap-login:client:${identity.key}`
      : "bootstrap-login:installation",
    status: "available"
  };
}

function credentialRateLimitKey(input: {
  email: string;
  prefix: string;
}): string {
  return `${input.prefix}:account:${hashToken(input.email).slice(0, 32)}`;
}

/** One source's share of an account key, so its attempts on that account stay its own. */
function accountSourceRateLimitKey(accountKey: string, source: string): string {
  return `${accountKey}:client:${source}`;
}

function credentialClientRateLimitKey(input: {
  config: AuthConfig;
  prefix: string;
  request: Request;
}):
  | { key: string; source: string; status: "available" }
  | { status: "not_required" }
  | { status: "unavailable" } {
  const identity = resolveLoginRateLimitIdentity(input.request, input.config);

  return identity.status === "available"
    ? { key: `${input.prefix}:client:${identity.key}`, source: identity.key, status: "available" }
    : identity;
}

/**
 * Account admission for a password login. Each source checks its own share of the account
 * key, so one source exhausting its attempts cannot lock the owner out from another source.
 * The account-wide count still bounds distributed guessing: past the ceiling every source
 * keeps exactly one attempt per window instead of a blanket 429, so guesses stay bounded by
 * the number of sources while an owner on a clean source still signs in. Without a source
 * identity all callers are one source and the account key remains the shared limit.
 */
async function admitPasswordLoginAccount(
  limiter: LoginRateLimiter,
  input: { accountKey: string; source: string | null }
): Promise<LoginRateLimitDecision> {
  if (!input.source) {
    return limiter.check(input.accountKey);
  }

  const account = await limiter.check(input.accountKey, {
    maxAttempts: PASSWORD_LOGIN_DISTRIBUTED_CEILING
  });

  return limiter.check(
    accountSourceRateLimitKey(input.accountKey, input.source),
    account.allowed ? undefined : { maxAttempts: 1 }
  );
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

    const loginRateLimiter = resolveLoginRateLimiter(
      deps.loginRateLimiter,
      defaultLoginRateLimiter
    );
    const rateLimitIdentity = bootstrapRateLimitKey({ config, request });

    if (rateLimitIdentity.status === "unavailable") {
      return authAdmissionUnavailable();
    }

    const rateLimitKey = rateLimitIdentity.key;
    const rateLimit = await loginRateLimiter.check(rateLimitKey);

    if (!rateLimit.allowed) {
      return rateLimitedResponse(rateLimit);
    }

    const body = await readJson(request);
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) return bodyError;
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
      signInMethod: "bootstrap",
      userId: user.id
    });
    await loginRateLimiter.reset(rateLimitKey);

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

    const clientIdentity = credentialClientRateLimitKey({
      config,
      prefix: "password-login",
      request
    });

    if (clientIdentity.status === "unavailable") {
      return authAdmissionUnavailable();
    }

    const clientRateLimitKey = clientIdentity.status === "available"
      ? clientIdentity.key
      : null;
    const source = clientIdentity.status === "available" ? clientIdentity.source : null;
    const loginRateLimiter = resolveLoginRateLimiter(
      deps.loginRateLimiter,
      defaultLoginRateLimiter
    );

    if (clientRateLimitKey) {
      const clientRateLimit = await loginRateLimiter.check(clientRateLimitKey);

      if (!clientRateLimit.allowed) {
        return rateLimitedResponse(clientRateLimit);
      }
    }

    const rawBody = await readJson(request);
    const bodyError = requestBodyErrorResponse(rawBody);
    if (bodyError) return bodyError;
    const credentials = credentialsFromBody(rawBody);

    if (!credentials || !credentials.email.trim() || !credentials.password) {
      return json({ error: "credentials_required" }, { status: 400 });
    }

    // Local passwords only: a directory sign-in sharing this form branches off above.
    const passwordSignInOff = await refuseWhenPasswordSignInOff(deps.signInPolicy);
    if (passwordSignInOff) return passwordSignInOff;

    const normalizedEmail = normalizeAuthEmail(credentials.email);

    if (!isPlausibleEmail(normalizedEmail)) {
      return unauthorized();
    }

    const rateLimitKey = credentialRateLimitKey({
      email: normalizedEmail,
      prefix: "password-login"
    });
    const rateLimit = await admitPasswordLoginAccount(loginRateLimiter, {
      accountKey: rateLimitKey,
      source
    });

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

    // Success clears only the account's keys. The source budget merely gets back the
    // attempt this login used, so logging into an own account never restores the
    // budget a source spent on other accounts.
    await Promise.all([
      loginRateLimiter.reset(rateLimitKey),
      ...(source ? [loginRateLimiter.reset(accountSourceRateLimitKey(rateLimitKey, source))] : []),
      ...(clientRateLimitKey ? [loginRateLimiter.release(clientRateLimitKey)] : [])
    ]);

    // A verified password of a user with TOTP creates no session, only a challenge that the
    // second-factor route redeems; its own limits bound the code guesses.
    if (currentCredential.kind === "second_factor_required") {
      return json(
        { status: "second_factor_required" },
        {
          headers: {
            "set-cookie": await createSecondFactorChallengeCookie(currentCredential.challenge, {
              config,
              now: new Date()
            })
          }
        }
      );
    }

    return json(
      {
        user: {
          displayName: currentCredential.user.displayName,
          email: currentCredential.user.email,
          id: currentCredential.user.id,
          role: currentCredential.user.role,
          status: currentCredential.user.status
        }
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

    const passwordSignInOff = await refuseWhenPasswordSignInOff(deps.signInPolicy);
    if (passwordSignInOff) return passwordSignInOff;

    const clientIdentity = credentialClientRateLimitKey({
      config,
      prefix: "password-reset",
      request
    });

    if (clientIdentity.status === "unavailable") {
      return authAdmissionUnavailable();
    }

    const clientRateLimitKey = clientIdentity.status === "available"
      ? clientIdentity.key
      : null;
    const resetRateLimiter = resolveLoginRateLimiter(
      deps.resetRateLimiter,
      defaultResetRateLimiter
    );

    if (clientRateLimitKey) {
      const clientRateLimit = await resetRateLimiter.check(clientRateLimitKey);

      if (!clientRateLimit.allowed) {
        return rateLimitedResponse(clientRateLimit);
      }
    }

    const rawBody = await readJson(request);
    const bodyError = requestBodyErrorResponse(rawBody);
    if (bodyError) return bodyError;
    const email = emailFromBody(rawBody);

    if (!email?.trim()) {
      return json({ error: "email_required" }, { status: 400 });
    }

    const normalizedEmail = normalizeAuthEmail(email);

    if (!isPlausibleEmail(normalizedEmail)) {
      return json({ ok: true });
    }

    const rateLimitKey = credentialRateLimitKey({
      email: normalizedEmail,
      prefix: "password-reset"
    });
    const clock = deps.clock ?? Date.now;
    const startedAtMs = clock();
    // The account budget bounds reset mail, not requests: once it is spent the request
    // still gets the generic answer, only without another token or email. A spent budget
    // means any owner was just mailed links that outlive the window, so a third party can
    // no longer turn the owner's own reset request into a 429.
    const mailBudget = await resetRateLimiter.check(rateLimitKey);
    const identity = mailBudget.allowed
      ? await deps.repository.findPasswordIdentityByEmail(normalizedEmail)
      : null;

    if (isActiveVerifiedPasswordIdentity(identity)) {
      const now = deps.now?.() ?? new Date();
      const token = createSessionToken();

      const created = await deps.repository.createPasswordResetToken({
        expiresAt: passwordResetExpiresAt(now),
        identityId: identity.id,
        normalizedEmail,
        sentToEmail: identity.user.email ?? identity.normalizedEmail,
        tokenHash: hashToken(token),
        userId: identity.userId
      });
      if (created) {
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
    }

    await waitForAuthResponseFloor({
      clock,
      floorMs: deps.responseFloorMs,
      sleep: deps.sleep,
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

    const passwordSignInOff = await refuseWhenPasswordSignInOff(deps.signInPolicy);
    if (passwordSignInOff) return passwordSignInOff;

    const config = deps.getConfig();
    const rateLimiter = resolveLoginRateLimiter(
      deps.resetCompleteRateLimiter,
      defaultResetCompleteRateLimiter
    );
    const loginRateLimiter = resolveLoginRateLimiter(
      deps.loginRateLimiter,
      defaultLoginRateLimiter
    );
    const clientIdentity = config.configured
      ? credentialClientRateLimitKey({
          config,
          prefix: "password-reset-complete",
          request
        })
      : { status: "not_required" as const };

    if (clientIdentity.status === "unavailable") {
      return authAdmissionUnavailable();
    }

    const clientRateLimitKey = clientIdentity.status === "available"
      ? clientIdentity.key
      : null;

    if (clientRateLimitKey) {
      const clientRateLimit = await rateLimiter.check(clientRateLimitKey);

      if (!clientRateLimit.allowed) {
        return rateLimitedResponse(clientRateLimit);
      }
    }

    const rawBody = await readJson(request);
    const bodyError = requestBodyErrorResponse(rawBody);
    if (bodyError) return bodyError;
    const body = resetCompleteBody(rawBody);

    if (!body || !body.token.trim() || !body.password) {
      return json({ error: "reset_token_password_required" }, { status: 400 });
    }

    const passwordError = validatePassword(body.password);

    if (passwordError) {
      return json({ error: passwordError }, { status: 400 });
    }

    if (!config.configured) {
      return json({ error: "auth_not_configured" }, { status: 503 });
    }

    const tokenRateLimitKey = credentialTokenRateLimitKey({
      prefix: "password-reset-complete",
      token: body.token
    });

    const tokenRateLimit = await rateLimiter.check(tokenRateLimitKey);

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

    // A completed reset proves control of the account's mailbox, so it lifts the account's
    // password-login lock and this source's share of it, never a source budget. The reset
    // is already committed; failing to clear the lock only delays login to window end.
    const loginAccountKey = credentialRateLimitKey({
      email: result.normalizedEmail,
      prefix: "password-login"
    });
    await Promise.all([
      loginRateLimiter.reset(loginAccountKey),
      ...(clientIdentity.status === "available"
        ? [loginRateLimiter.reset(accountSourceRateLimitKey(loginAccountKey, clientIdentity.source))]
        : [])
    ]).catch(() => undefined);

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
    const token = deps.identityProviderLogout ? getSessionFromRequest(request) : undefined;
    const session = token ? await deps.sessions.findSessionByTokenHash(hashToken(token)) : null;
    // The local session is revoked first, whatever the identity provider does next.
    const revoked = await revokeRequestSession({
      request,
      revokedReason: "logout",
      sessions: deps.sessions
    });
    const clearCookie = createSessionClearCookie({
      secure: config.cookieSecure
    });
    const redirectTo = revoked > 0 && session && deps.identityProviderLogout
      ? await deps.identityProviderLogout({ signInMethod: session.signInMethod ?? null }).catch(() => null)
      : null;

    if (redirectTo) {
      return json({ redirectTo }, { headers: { "set-cookie": clearCookie } });
    }

    return new Response(null, {
      headers: {
        "set-cookie": clearCookie
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

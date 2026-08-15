import type { AuthConfig } from "./config";
import {
  resolveLoginRateLimitIdentity,
  type LoginRateLimitIdentity
} from "./clientIdentity";
import { deliverAuthEmail, type AuthMailer } from "./mailer";
import { hashPassword as hashPasswordDefault, isPlausibleEmail, normalizeAuthEmail, validatePassword } from "./password";
import type { AuthRegistrationRepository } from "./registrationRepository";
import {
  createFixedWindowLoginRateLimiter,
  resolveLoginRateLimiter,
  type LoginRateLimiter
} from "./rateLimit";
import {
  createSessionSetCookie,
  createSessionToken,
  sessionExpiresAt
} from "./session";
import { hashToken } from "./token";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import {
  waitForAuthResponseFloor
} from "./responseFloor";

export type RegisterHandlerDeps = {
  clock?: () => number;
  getConfig(): AuthConfig;
  mailer: AuthMailer;
  now?: () => Date;
  registrationRateLimiter?: LoginRateLimiter;
  repository: AuthRegistrationRepository;
  responseFloorMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type EmailVerificationHandlerDeps = {
  getConfig(): AuthConfig;
  passwordHasher?: (password: string) => Promise<string>;
  now?: () => Date;
  repository: AuthRegistrationRepository;
  verificationRateLimiter?: LoginRateLimiter;
};

export type InviteAcceptanceHandlerDeps = {
  getConfig(): AuthConfig;
  inviteAcceptanceRateLimiter?: LoginRateLimiter;
  now?: () => Date;
  repository: AuthRegistrationRepository;
};

const defaultRegistrationRateLimiter = createFixedWindowLoginRateLimiter();
const defaultInviteAcceptanceRateLimiter = createFixedWindowLoginRateLimiter();
const defaultVerificationRateLimiter = createFixedWindowLoginRateLimiter();
export const EMAIL_VERIFICATION_MAX_AGE_SECONDS = 24 * 60 * 60;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

async function readJson(request: Request): Promise<unknown> {
  return readJsonBodyOrNull(request, "auth");
}

function isJsonContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";

  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function requireJsonContentType(request: Request): Response | null {
  if (isJsonContentType(request.headers.get("content-type"))) {
    return null;
  }

  return json({ error: "json_required" }, { status: 415 });
}

function registerBody(body: unknown): {
  displayName: string;
  email: string;
  inviteToken: string | null;
} | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const email = "email" in body ? body.email : undefined;
  const displayName = "displayName" in body ? body.displayName : undefined;
  const inviteToken = "inviteToken" in body ? body.inviteToken : undefined;

  if (typeof email !== "string") {
    return null;
  }

  return {
    displayName: typeof displayName === "string" ? displayName.trim() : "",
    email,
    inviteToken: typeof inviteToken === "string" && inviteToken.trim() ? inviteToken.trim() : null
  };
}

function verifyBody(body: unknown): { password: string; token: string } | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  return {
    password: "password" in body && typeof body.password === "string" ? body.password : "",
    token: "token" in body && typeof body.token === "string" ? body.token : ""
  };
}

function inviteAcceptanceBody(body: unknown): { displayName: string; password: string; token: string } | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  return {
    displayName: "displayName" in body && typeof body.displayName === "string" ? body.displayName.trim() : "",
    password: "password" in body && typeof body.password === "string" ? body.password : "",
    token: "token" in body && typeof body.token === "string" ? body.token.trim() : ""
  };
}

function credentialRateLimitKey(input: {
  email: string;
  prefix: string;
}): string {
  return `${input.prefix}:account:${hashToken(input.email).slice(0, 32)}`;
}

function credentialClientRateLimitKey(input: {
  config: AuthConfig;
  prefix: string;
  request: Request;
}): LoginRateLimitIdentity {
  const identity = resolveLoginRateLimitIdentity(input.request, input.config);

  return identity.status === "available"
    ? { key: `${input.prefix}:client:${identity.key}`, status: "available" }
    : identity;
}

function inviteTokenRateLimitKey(token: string): string {
  return `invite-acceptance:token:${hashToken(token).slice(0, 32)}`;
}

function verificationTokenRateLimitKey(token: string): string {
  return `email-verification:token:${hashToken(token).slice(0, 32)}`;
}

function requestUserAgent(request: Request): string | null {
  const value = request.headers.get("user-agent")?.trim();

  return value ? value.slice(0, 512) : null;
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

function authAdmissionUnavailable(): Response {
  return json({ error: "auth_admission_unavailable" }, { status: 503 });
}

function verificationExpiresAt(now: Date): Date {
  return new Date(now.getTime() + EMAIL_VERIFICATION_MAX_AGE_SECONDS * 1000);
}

function verificationUrl(baseUrl: string, token: string): string {
  const url = new URL("/login", baseUrl);

  url.searchParams.set("verify", token);

  return url.toString();
}

function verificationEmail(input: { to: string; verificationUrl: string }): { subject: string; text: string; to: string } {
  return {
    subject: "Verify your AIQSA email",
    text: [
      "An AIQSA access request was created for this email address.",
      "",
      "Open this link to verify your email:",
      input.verificationUrl,
      "",
      "If you did not request access, ignore this email."
    ].join("\n"),
    to: input.to
  };
}

export function createInviteAcceptanceHandler(deps: InviteAcceptanceHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const config = deps.getConfig();

    if (!config.configured) {
      return json({ error: "auth_not_configured" }, { status: 503 });
    }

    const contentTypeError = requireJsonContentType(request);

    if (contentTypeError) {
      return contentTypeError;
    }

    const rateLimiter = resolveLoginRateLimiter(
      deps.inviteAcceptanceRateLimiter,
      defaultInviteAcceptanceRateLimiter
    );
    const clientIdentity = credentialClientRateLimitKey({
      config,
      prefix: "invite-acceptance",
      request
    });

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
    const body = inviteAcceptanceBody(rawBody);

    if (!body?.token || !body.password) {
      return json({ error: "invite_token_password_required" }, { status: 400 });
    }

    const passwordError = validatePassword(body.password);

    if (passwordError) {
      return json({ error: passwordError }, { status: 400 });
    }

    const tokenRateLimitKey = inviteTokenRateLimitKey(body.token);

    const tokenRateLimit = await rateLimiter.check(tokenRateLimitKey);

    if (!tokenRateLimit.allowed) {
      return rateLimitedResponse(tokenRateLimit);
    }

    const now = deps.now?.() ?? new Date();
    const sessionToken = createSessionToken();
    const result = await deps.repository.acceptInvite({
      displayName: body.displayName,
      inviteTokenHash: hashToken(body.token),
      now,
      passwordHash: await hashPasswordDefault(body.password),
      session: {
        createdByUserAgent: requestUserAgent(request),
        expiresAt: sessionExpiresAt(now),
        lastSeenAt: now,
        tokenHash: hashToken(sessionToken)
      }
    });

    if (!result) {
      return json({ error: "invalid_invite_token" }, { status: 400 });
    }

    await Promise.all([
      ...(clientRateLimitKey ? [rateLimiter.reset(clientRateLimitKey)] : []),
      rateLimiter.reset(tokenRateLimitKey)
    ]);

    return json(
      {
        status: "active"
      },
      {
        headers: {
          "set-cookie": createSessionSetCookie(sessionToken, {
            secure: config.cookieSecure
          })
        }
      }
    );
  };
}

export function createRegisterHandler(deps: RegisterHandlerDeps) {
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
      prefix: "registration",
      request
    });

    if (clientIdentity.status === "unavailable") {
      return authAdmissionUnavailable();
    }

    const clientRateLimitKey = clientIdentity.status === "available"
      ? clientIdentity.key
      : null;
    const rateLimiter = resolveLoginRateLimiter(
      deps.registrationRateLimiter,
      defaultRegistrationRateLimiter
    );

    if (clientRateLimitKey) {
      const clientRateLimit = await rateLimiter.check(clientRateLimitKey);

      if (!clientRateLimit.allowed) {
        return rateLimitedResponse(clientRateLimit);
      }
    }

    const rawBody = await readJson(request);
    const bodyError = requestBodyErrorResponse(rawBody);
    if (bodyError) return bodyError;
    const body = registerBody(rawBody);

    if (!body || !body.email.trim()) {
      return json({ error: "registration_required" }, { status: 400 });
    }

    const normalizedEmail = normalizeAuthEmail(body.email);

    if (!isPlausibleEmail(normalizedEmail)) {
      return json({ error: "email_invalid" }, { status: 400 });
    }

    const rateLimitKey = credentialRateLimitKey({
      email: normalizedEmail,
      prefix: "registration"
    });
    const rateLimit = await rateLimiter.check(rateLimitKey);

    if (!rateLimit.allowed) {
      return rateLimitedResponse(rateLimit);
    }

    const clock = deps.clock ?? Date.now;
    const startedAtMs = clock();
    const now = deps.now?.() ?? new Date();
    const token = createSessionToken();
    const result = await deps.repository.registerPasswordUser({
      displayName: body.displayName,
      email: body.email.trim(),
      expiresAt: verificationExpiresAt(now),
      inviteTokenHash: body.inviteToken ? hashToken(body.inviteToken) : null,
      normalizedEmail,
      now,
      verificationTokenHash: hashToken(token)
    });

    if (!result.ok) {
      return json({ error: result.error }, { status: 400 });
    }

    if (result.sentToEmail) {
      void deliverAuthEmail(
        deps.mailer,
        verificationEmail({
          to: result.sentToEmail,
          verificationUrl: verificationUrl(config.appBaseUrl, token)
        }),
        "verification"
      )
        .then((delivery) => {
          if (delivery.kind === "failed") {
            console.error("verification_email_failed", delivery.error);
          }
        })
        .catch(() => undefined);
    }

    await waitForAuthResponseFloor({
      clock,
      floorMs: deps.responseFloorMs,
      sleep: deps.sleep,
      startedAtMs
    });

    return json({
      status: "request_received"
    });
  };
}

export function createEmailVerificationHandler(deps: EmailVerificationHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const contentTypeError = requireJsonContentType(request);

    if (contentTypeError) {
      return contentTypeError;
    }

    const config = deps.getConfig();
    const rateLimiter = resolveLoginRateLimiter(
      deps.verificationRateLimiter,
      defaultVerificationRateLimiter
    );
    const clientIdentity = config.configured
      ? credentialClientRateLimitKey({
          config,
          prefix: "email-verification",
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
    const body = verifyBody(rawBody);

    if (!body || !body.token.trim()) {
      return json({ error: "verification_token_required" }, { status: 400 });
    }

    if (!body.password) {
      return json({ error: "verification_token_password_required" }, { status: 400 });
    }

    const passwordError = validatePassword(body.password);

    if (passwordError) {
      return json({ error: passwordError }, { status: 400 });
    }

    if (!config.configured) {
      return json({ error: "auth_not_configured" }, { status: 503 });
    }

    const tokenRateLimitKey = verificationTokenRateLimitKey(body.token);

    const tokenRateLimit = await rateLimiter.check(tokenRateLimitKey);

    if (!tokenRateLimit.allowed) {
      return rateLimitedResponse(tokenRateLimit);
    }

    const result = await deps.repository.completeEmailVerification({
      now: deps.now?.() ?? new Date(),
      passwordHash: await (deps.passwordHasher ?? hashPasswordDefault)(body.password),
      tokenHash: hashToken(body.token)
    });

    if (!result) {
      return json({ error: "invalid_or_expired_verification_token" }, { status: 400 });
    }

    return json({
      status: result.status
    });
  };
}

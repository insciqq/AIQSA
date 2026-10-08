import type { TwoFactorAction, TwoFactorStatusWire } from "../../contracts/twoFactor";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { SecretEnvelopeError } from "../secrets/envelope";
import { resolveLoginRateLimitIdentity } from "./clientIdentity";
import type { AuthConfig } from "./config";
import { isJsonContentType } from "./handlers";
import {
  createFixedWindowLoginRateLimiter,
  resolveLoginRateLimiter,
  type LoginRateLimitDecision,
  type LoginRateLimiter
} from "./rateLimit";
import { prepareAuthSession, type RequestAuthResolver } from "./requestAuth";
import { refuseWhenPasswordSignInOff, type SignInPolicyReader } from "./signInPolicy";
import { observeSignInStep } from "./signInTelemetry";
import {
  clearSecondFactorChallengeCookie,
  readSecondFactorChallengeToken,
  secondFactorChallengeMatches,
  verifySecondFactorChallenge
} from "./secondFactorChallenge";
import { totpProvisioningUri } from "./totp";
import type { SecondFactorAttempt, TotpKeys } from "./totpFactor";
import type { SecondFactorSignInRepository, TotpEnrolmentRepository } from "./totpRepository";
import { hashToken } from "./token";

export type SecondFactorSignInHandlerDeps = {
  getConfig(): AuthConfig;
  getKeys(): TotpKeys;
  now?: () => Date;
  rateLimiter?: LoginRateLimiter;
  repository: SecondFactorSignInRepository;
  /** The password sign-in switch; absent means on. */
  signInPolicy?: SignInPolicyReader;
};

export type TwoFactorHandlerDeps = {
  getKeys(): TotpKeys;
  now?: () => Date;
  rateLimiter?: LoginRateLimiter;
  repository: TotpEnrolmentRepository;
  resolveAuth: RequestAuthResolver;
};

const defaultSecondFactorRateLimiter = createFixedWindowLoginRateLimiter();
const defaultEnrolmentRateLimiter = createFixedWindowLoginRateLimiter();

function noStoreJson(body: unknown, init: ResponseInit = {}): Response {
  const response = Response.json(body, init);
  response.headers.set("cache-control", "private, no-store, max-age=0");
  return response;
}

function rateLimited(decision: LoginRateLimitDecision): Response {
  return noStoreJson(
    { error: "rate_limited" },
    { headers: { "retry-after": String(decision.retryAfterSeconds) }, status: 429 }
  );
}

function unavailable(): Response {
  return noStoreJson({ error: "two_factor_unavailable" }, { status: 503 });
}

/** A missing key or an envelope this key cannot open: TOTP cannot work until the operator fixes it. */
function isKeyFailure(error: unknown): boolean {
  return error instanceof SecretEnvelopeError || (error instanceof Error && error.message === "totp_secret_invalid");
}

/** `{ code }` (TOTP) or `{ recoveryCode }`; exactly one of them. */
export function secondFactorAttemptFromBody(body: unknown): SecondFactorAttempt | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const code = "code" in body && typeof body.code === "string" && body.code.trim() ? body.code : null;
  const recoveryCode = "recoveryCode" in body && typeof body.recoveryCode === "string" && body.recoveryCode.trim()
    ? body.recoveryCode
    : null;

  if (Boolean(code) === Boolean(recoveryCode)) {
    return null;
  }

  return code ? { code, kind: "totp" } : { code: recoveryCode, kind: "recovery" };
}

function secondFactorAccountKey(userId: string): string {
  return `second-factor:account:${hashToken(userId).slice(0, 32)}`;
}

function twoFactorAccountKey(userId: string): string {
  return `two-factor:account:${hashToken(userId).slice(0, 32)}`;
}

/**
 * `POST /api/auth/second-factor`: redeems the challenge a password or LDAP sign-in left in its
 * cookie with a TOTP or recovery code. Per-source and per-account limits bound guesses; the
 * account limit is shared by every source, because only someone who already knows the first
 * factor can spend it.
 */
export function createSecondFactorSignInHandler(deps: SecondFactorSignInHandlerDeps) {
  // The method comes from the challenge; a step that ends before reading it records none.
  return observeSignInStep({ step: "second_factor" }, async (attempt, request: Request): Promise<Response> => {
    const config = deps.getConfig();

    if (!config.configured) {
      return attempt.end(noStoreJson({ error: "auth_not_configured" }, { status: 503 }), "failed", "auth_not_configured");
    }

    if (!isJsonContentType(request.headers.get("content-type"))) {
      return attempt.end(noStoreJson({ error: "json_required" }, { status: 415 }), "refused", "request_invalid");
    }

    const rateLimiter = resolveLoginRateLimiter(deps.rateLimiter, defaultSecondFactorRateLimiter);
    const clientIdentity = resolveLoginRateLimitIdentity(request, config);

    if (clientIdentity.status === "unavailable") {
      return attempt.end(
        noStoreJson({ error: "auth_admission_unavailable" }, { status: 503 }),
        "failed",
        "auth_admission_unavailable"
      );
    }

    const sourceKey = clientIdentity.status === "available" ? `second-factor:client:${clientIdentity.key}` : null;

    if (sourceKey) {
      const sourceLimit = await rateLimiter.check(sourceKey);

      if (!sourceLimit.allowed) {
        return attempt.end(rateLimited(sourceLimit), "refused", "rate_limited");
      }
    }

    const now = deps.now?.() ?? new Date();
    const token = readSecondFactorChallengeToken(request);
    const challenge = token
      ? await verifySecondFactorChallenge(token, { now, sessionSecret: config.sessionSecret })
      : null;
    const challengeExpired = () => noStoreJson(
      { error: "challenge_expired" },
      { headers: { "set-cookie": clearSecondFactorChallengeCookie(config.cookieSecure) }, status: 401 }
    );

    if (!challenge) {
      return attempt.end(challengeExpired(), "failed", "challenge_expired");
    }

    attempt.method = challenge.signInMethod;
    // A password challenge issued before password sign-in was switched off cannot finish it;
    // a directory (LDAP) challenge can.
    if (challenge.signInMethod === "password") {
      const passwordSignInOff = await refuseWhenPasswordSignInOff(deps.signInPolicy);
      if (passwordSignInOff) {
        passwordSignInOff.headers.set("cache-control", "private, no-store, max-age=0");
        passwordSignInOff.headers.append("set-cookie", clearSecondFactorChallengeCookie(config.cookieSecure));
        return attempt.end(passwordSignInOff, "refused", "sign_in_method_disabled");
      }
    }

    const accountKey = secondFactorAccountKey(challenge.userId);
    const accountLimit = await rateLimiter.check(accountKey);

    if (!accountLimit.allowed) {
      return attempt.end(rateLimited(accountLimit), "refused", "rate_limited");
    }

    const rawBody = await readJsonBodyOrNull(request, "auth");
    const bodyError = requestBodyErrorResponse(rawBody);
    if (bodyError) return attempt.end(bodyError, "refused", "request_invalid");
    const proof = secondFactorAttemptFromBody(rawBody);

    if (!proof) {
      return attempt.end(noStoreJson({ error: "code_required" }, { status: 400 }), "refused", "request_invalid");
    }

    const session = prepareAuthSession({ request, secureCookie: config.cookieSecure });
    let result: Awaited<ReturnType<SecondFactorSignInRepository["completeSecondFactorSignIn"]>>;

    try {
      result = await deps.repository.completeSecondFactorSignIn({
        attempt: proof,
        challenge,
        keys: deps.getKeys(),
        matchesChallenge: (current) => secondFactorChallengeMatches(challenge, current, config.sessionSecret),
        now,
        session: session.input
      });
    } catch (error) {
      if (isKeyFailure(error)) return attempt.end(unavailable(), "failed", "two_factor_unavailable", error);
      throw error;
    }

    if (result.kind === "challenge_expired") {
      return attempt.end(challengeExpired(), "failed", "challenge_expired");
    }

    if (result.kind === "invalid_code") {
      return attempt.end(noStoreJson({ error: "invalid_code" }, { status: 401 }), "failed", "invalid_code");
    }

    await Promise.all([
      rateLimiter.reset(accountKey),
      ...(sourceKey ? [rateLimiter.release(sourceKey)] : [])
    ]);

    const headers = new Headers();
    headers.append("set-cookie", session.cookie);
    headers.append("set-cookie", clearSecondFactorChallengeCookie(config.cookieSecure));

    return attempt.end(noStoreJson({ user: result.user }, { headers }), "succeeded", "accepted");
  });
}

export function createTwoFactorStatusHandler(deps: Pick<TwoFactorHandlerDeps, "repository" | "resolveAuth">) {
  return async function GET(request: Request): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) return noStoreJson({ error: "unauthorized" }, { status: 401 });
    const status = await deps.repository.getStatus(auth.userId);
    if (!status) return noStoreJson({ error: "unauthorized" }, { status: 401 });
    return noStoreJson({ twoFactor: status });
  };
}

const failureResponses = {
  code_required: { error: "two_factor_code_required", status: 400 },
  invalid_code: { error: "invalid_code", status: 400 },
  not_available: { error: "two_factor_not_available", status: 409 },
  not_enabled: { error: "two_factor_not_enabled", status: 409 },
  setup_required: { error: "two_factor_setup_required", status: 409 }
} as const;

type FailureKind = keyof typeof failureResponses;

/**
 * `POST /api/me/two-factor/<action>` for the signed-in user. Turning on starts with a pending
 * secret and ends when a code from it confirms; replacing an active secret, new recovery codes
 * and turning off all need a current TOTP or recovery code.
 */
export function createTwoFactorActionHandler(action: TwoFactorAction, deps: TwoFactorHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) return noStoreJson({ error: "unauthorized" }, { status: 401 });
    if (!isJsonContentType(request.headers.get("content-type"))) {
      return noStoreJson({ error: "json_required" }, { status: 415 });
    }
    const rawBody = await readJsonBodyOrNull(request, "auth");
    const bodyError = requestBodyErrorResponse(rawBody);
    if (bodyError) return bodyError;

    const rateLimiter = resolveLoginRateLimiter(deps.rateLimiter, defaultEnrolmentRateLimiter);
    const rateLimitKey = twoFactorAccountKey(auth.userId);
    const limit = await rateLimiter.check(rateLimitKey);
    if (!limit.allowed) return rateLimited(limit);

    const now = deps.now?.() ?? new Date();
    const proof = secondFactorAttemptFromBody(rawBody);
    let response: Response;

    try {
      const keys = deps.getKeys();
      const fail = (kind: FailureKind) => noStoreJson(
        { error: failureResponses[kind].error },
        { status: failureResponses[kind].status }
      );
      const withStatus = async (body: Record<string, unknown>) => {
        const twoFactor: TwoFactorStatusWire | null = await deps.repository.getStatus(auth.userId);
        return noStoreJson({ ...body, ...(twoFactor ? { twoFactor } : {}) });
      };

      if (action === "start") {
        const result = await deps.repository.start({ keys, now, proof, userId: auth.userId });
        response = result.kind === "started"
          ? noStoreJson({
              otpauthUri: totpProvisioningUri({ accountLabel: result.accountLabel, secret: result.secret }),
              secret: result.secret
            })
          : fail(result.kind);
      } else if (action === "confirm") {
        const code = proof?.kind === "totp" ? proof.code : null;
        const result = code === null
          ? { kind: "invalid_code" as const }
          : await deps.repository.confirm({ code, keys, now, userId: auth.userId });
        response = result.kind === "confirmed" ? await withStatus({ recoveryCodes: result.recoveryCodes }) : fail(result.kind);
      } else if (action === "regenerate-codes") {
        const result = await deps.repository.regenerateRecoveryCodes({ keys, now, proof, userId: auth.userId });
        response = result.kind === "regenerated" ? await withStatus({ recoveryCodes: result.recoveryCodes }) : fail(result.kind);
      } else {
        const result = await deps.repository.disable({ keys, now, proof, userId: auth.userId });
        response = result.kind === "disabled" ? await withStatus({}) : fail(result.kind);
      }
    } catch (error) {
      if (isKeyFailure(error)) return unavailable();
      throw error;
    }

    // A completed action gives its attempt back; failed codes keep counting.
    if (response.ok) {
      await rateLimiter.release(rateLimitKey);
    }

    return response;
  };
}

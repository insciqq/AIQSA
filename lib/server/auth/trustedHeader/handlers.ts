import { safeInternalPath } from "@/lib/auth/internalPath";
import type { TrustedHeaderLoginOutcome } from "@/lib/auth/trustedHeader";
import { trustedHeaderSignInConfigSchema } from "@/lib/contracts/authSignInMethods";
import type {
  AdminTrustedHeaderProbe,
  AdminTrustedHeaderProbeErrorCode
} from "@/lib/contracts/trustedHeaderSignIn";
import { resolveLoginRateLimitIdentity } from "../clientIdentity";
import type { AuthConfig } from "../config";
import {
  createFixedWindowLoginRateLimiter,
  resolveLoginRateLimiter,
  type LoginRateLimiter
} from "../rateLimit";
import {
  prepareAuthSession,
  resolveAuthToken,
  type AuthSessionStore,
  type RequestAuthResolver
} from "../requestAuth";
import { createSessionClearCookie, getSessionFromRequest } from "../session";
import type { SignInHealthRecorder } from "../signInSettings/health";
import type { ResolvedSignInMethod } from "../signInMethods";
import { observeSignInStep } from "../signInTelemetry";
import { hashToken } from "../token";
import {
  readTrustedHeaderEmail,
  readTrustedHeaderIdentity,
  trustedHeaderDomainHint
} from "./identityHeaders";
import type { TrustedHeaderSignInRepository } from "./repository";

type TrustedHeaderSignInDeps = {
  getConfig(): AuthConfig;
  loginRateLimiter?: LoginRateLimiter;
  now?: () => Date;
  recordOutcome?: SignInHealthRecorder;
  repository: TrustedHeaderSignInRepository;
  /** The active trusted-header configuration, or null while the method is off. */
  resolveMethod(): Promise<ResolvedSignInMethod<"trusted_header"> | null>;
  sessions: AuthSessionStore;
};

const defaultTestRateLimiter = createFixedWindowLoginRateLimiter();

function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    location,
    "referrer-policy": "no-referrer"
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { headers, status: 303 });
}

function outcomeUrl(appBaseUrl: string, nextPath: string, outcome: TrustedHeaderLoginOutcome): string {
  const url = new URL("/login", appBaseUrl);
  url.searchParams.set("trusted_header", outcome);
  if (nextPath !== "/") url.searchParams.set("next", nextPath);
  return url.toString();
}

/**
 * `GET /api/auth/trusted-header?next=…`: signs in the identity an authenticating reverse proxy
 * asserted in its headers, then returns to the safe `next` path. Only in trusted-proxy mode,
 * checked on every request; in any other mode the headers come from the client and are never
 * read. A session of another account than the header's is revoked first, whatever the
 * sign-in's outcome. A cross-site GET cannot sign anyone into an account the requester picks:
 * the proxy, not the request, sets the identity, so it can only sign its sender into their own.
 */
export function createTrustedHeaderSignInHandler(deps: TrustedHeaderSignInDeps) {
  return observeSignInStep({ method: "trusted_header", step: "callback" }, async (attempt, request: Request): Promise<Response> => {
    const config = deps.getConfig();
    const nextPath = safeInternalPath(new URL(request.url).searchParams.get("next"), config.appBaseUrl);
    const refuse = (outcome: TrustedHeaderLoginOutcome, cookies: readonly string[] = []) =>
      redirect(outcomeUrl(config.appBaseUrl, nextPath, outcome), cookies);

    if (!config.configured || config.clientIdentityMode !== "trusted_proxy") {
      return config.configured
        ? attempt.end(refuse("unavailable"), "refused", "environment_unsupported")
        : attempt.end(refuse("unavailable"), "failed", "auth_not_configured");
    }

    const method = await deps.resolveMethod();
    if (!method) return attempt.end(refuse("unavailable"), "refused", "sign_in_method_disabled");
    const record = async (code: string) => {
      await deps.recordOutcome?.(method, code);
    };

    const read = readTrustedHeaderIdentity(request.headers, method.config);
    if (read.status !== "identity") {
      const code = read.status === "missing" ? "header_missing" : "header_invalid";
      await record(code);
      return attempt.end(refuse(read.status), "failed", code);
    }

    const limiter = resolveLoginRateLimiter(deps.loginRateLimiter, defaultTestRateLimiter);
    const client = resolveLoginRateLimitIdentity(request, config);
    if (client.status === "unavailable") return attempt.end(refuse("failed"), "failed", "auth_admission_unavailable");
    const rateLimitKey = client.status === "available" ? `trusted-header:client:${client.key}` : null;
    if (rateLimitKey) {
      const decision = await limiter.check(rateLimitKey);
      if (!decision.allowed) {
        const response = refuse("failed");
        response.headers.set("retry-after", String(decision.retryAfterSeconds));
        return attempt.end(response, "refused", "rate_limited");
      }
    }
    const succeeded = async (cookies: readonly string[] = []) => {
      if (rateLimitKey) await limiter.release(rateLimitKey);
      return redirect(new URL(nextPath, config.appBaseUrl).toString(), cookies);
    };

    const now = deps.now?.() ?? new Date();
    const token = getSessionFromRequest(request);
    const current = token ? await resolveAuthToken(token, { now, sessions: deps.sessions }) : null;
    let replaced = false;

    if (token && current) {
      if ((await deps.repository.findLinkedUserId(read.identity.email)) === current.userId) {
        return attempt.end(await succeeded(), "succeeded", "accepted");
      }
      // The proxy now vouches for someone else in this browser.
      replaced = await deps.repository.revokeReplacedSession({ now, tokenHash: hashToken(token) });
    }

    const cleared = replaced ? [createSessionClearCookie({ secure: config.cookieSecure })] : [];
    const prepared = prepareAuthSession({ now, request, secureCookie: config.cookieSecure });

    try {
      const result = await deps.repository.signIn({
        config: method.config,
        identity: read.identity,
        now,
        session: prepared.input
      });

      if (result.status === "active") {
        await record("accepted");
        return attempt.end(await succeeded([prepared.cookie]), "succeeded", "accepted");
      }
      if (result.status === "second_factor_required") {
        // The completion seam asks only password and LDAP sign-ins for a second factor.
        throw new Error("trusted_header_second_factor_unexpected");
      }

      // A pending account is the method working as configured.
      await record(result.status === "pending" ? "accepted" : result.status);
      return attempt.end(
        refuse(result.status === "email_missing" ? "invalid" : result.status, cleared),
        "refused",
        result.status === "pending" ? "account_pending" : result.status
      );
    } catch (error) {
      await record("sign_in_failed");
      return attempt.end(refuse("failed", cleared), "failed", "sign_in_failed", error);
    }
  });
}

function probeError(error: AdminTrustedHeaderProbeErrorCode, status: number): Response {
  return Response.json({ error }, { headers: { "cache-control": "no-store" }, status });
}

/**
 * `GET /api/admin/sign-in/trusted-header?emailHeader=…`: the client identity mode and whether
 * the administrator's own request carries that header, its value reduced to a domain hint.
 */
export function createAdminTrustedHeaderProbeHandler(deps: {
  getConfig(): Pick<AuthConfig, "clientIdentityMode">;
  resolveAuth: RequestAuthResolver;
}) {
  return async function GET(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return probeError("unauthorized", 401);
    if (session.user.status !== "active" || session.user.role !== "admin") return probeError("forbidden", 403);

    const requested = new URL(request.url).searchParams.get("emailHeader");
    const headerName = requested ? trustedHeaderSignInConfigSchema.shape.emailHeader.safeParse(requested) : null;
    if (headerName && !headerName.success) return probeError("header_name_invalid", 400);

    const read = headerName?.success ? readTrustedHeaderEmail(request.headers, headerName.data) : null;
    const probe: AdminTrustedHeaderProbe = {
      clientIdentityMode: deps.getConfig().clientIdentityMode,
      emailHeader: read && {
        domainHint: read.status === "email" ? trustedHeaderDomainHint(read.email) : null,
        present: read.status !== "missing",
        usable: read.status === "email"
      }
    };
    return Response.json(probe, { headers: { "cache-control": "no-store" } });
  };
}

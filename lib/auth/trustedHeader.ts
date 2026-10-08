import { safeInternalPath } from "./internalPath";

export const TRUSTED_HEADER_SIGN_IN_PATH = "/api/auth/trusted-header";

/**
 * How a trusted-header sign-in that did not end in a session ends, as the login page's
 * `trusted_header` query value shows it. The parameter also stops the login page's automatic
 * redirect, so a refused sign-in never loops.
 */
export const TRUSTED_HEADER_LOGIN_OUTCOMES = [
  "account_conflict",
  "failed",
  "invalid",
  "missing",
  "not_allowed",
  "pending",
  "source_changed",
  "unavailable"
] as const;

export type TrustedHeaderLoginOutcome = (typeof TRUSTED_HEADER_LOGIN_OUTCOMES)[number];

export function isTrustedHeaderLoginOutcome(value: unknown): value is TrustedHeaderLoginOutcome {
  return typeof value === "string" && TRUSTED_HEADER_LOGIN_OUTCOMES.some((outcome) => outcome === value);
}

/** The sign-in route, returning to a safe internal `next` path. */
export function trustedHeaderSignInHref(nextPath: string | null | undefined): string {
  const next = safeInternalPath(nextPath);
  return next === "/" ? TRUSTED_HEADER_SIGN_IN_PATH : `${TRUSTED_HEADER_SIGN_IN_PATH}?${new URLSearchParams({ next })}`;
}

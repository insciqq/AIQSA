import type { AdminAuthErrorCode, ErrorResponse } from "./http";

/**
 * Control Center Users "Refused sign-ins" (Sign-in owns the rule): who was refused at sign-in
 * in the last 30 days, newest first and bounded. One entry per UTC day, method, reason and
 * subject, with its attempts. The subject is an email the sign-in method verified or trusts,
 * the existing account a password or second-factor refusal resolved to, or nobody; never a
 * typed email, password, code, token, IdP payload or IP address.
 */
export const SIGN_IN_REFUSAL_RETENTION_DAYS = 30;
export const ADMIN_SIGN_IN_REFUSAL_LIMIT = 500;

/** The methods whose refusals are recorded, as their identities name them. */
export const SIGN_IN_REFUSAL_METHODS = ["password", "google", "yandex", "oidc", "saml", "ldap", "trusted_header"] as const;

export type SignInRefusalMethod = (typeof SIGN_IN_REFUSAL_METHODS)[number];

/**
 * Why a sign-in was refused: an external method's settlement outcome, or the password form's and
 * the second step's outcome for an existing account.
 */
export const SIGN_IN_REFUSAL_CODES = [
  "account_conflict",
  "account_inactive",
  "account_pending",
  "email_missing",
  "email_unverified",
  "invalid_code",
  "invalid_credentials",
  "not_allowed",
  "source_changed"
] as const;

export type SignInRefusalCode = (typeof SIGN_IN_REFUSAL_CODES)[number];

export type AdminSignInRefusalAccount = {
  id: string;
  displayName: string;
  email: string | null;
  status: "active" | "denied" | "disabled" | "pending";
};

/**
 * `email`: the verified email, and the account that has it now (null when nobody does);
 * `account`: the account a password or second-factor refusal resolved to; `no_verified_email`:
 * the method named nobody it vouches for; `overflow`: attempts past the day's itemized limit.
 */
export type AdminSignInRefusalSubject =
  | { kind: "email"; email: string; account: AdminSignInRefusalAccount | null }
  | { kind: "account"; account: AdminSignInRefusalAccount }
  | { kind: "no_verified_email" }
  | { kind: "overflow" };

export type AdminSignInRefusal = {
  id: string;
  method: SignInRefusalMethod;
  code: SignInRefusalCode;
  /** Refused attempts that UTC day. */
  attempts: number;
  firstSeenAt: string;
  lastSeenAt: string;
  subject: AdminSignInRefusalSubject;
};

export type AdminSignInRefusals = {
  generatedAt: string;
  /** Entries in the retention window, of which the newest `refusals.length` are listed. */
  total: number;
  truncated: boolean;
  refusals: AdminSignInRefusal[];
};

export type AdminSignInRefusalsResponse = { signInRefusals: AdminSignInRefusals };
export type AdminSignInRefusalsErrorResponse = ErrorResponse<AdminAuthErrorCode | "sign_in_refusals_failed">;

const ACCOUNT_STATUSES = ["active", "denied", "disabled", "pending"] as const;

export function isSignInRefusalMethod(value: unknown): value is SignInRefusalMethod {
  return typeof value === "string" && (SIGN_IN_REFUSAL_METHODS as readonly string[]).includes(value);
}

export function isSignInRefusalCode(value: unknown): value is SignInRefusalCode {
  return typeof value === "string" && (SIGN_IN_REFUSAL_CODES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function decodeAccount(value: unknown): AdminSignInRefusalAccount | null {
  if (!isRecord(value) || !isText(value.id, 128) || typeof value.displayName !== "string" ||
    value.displayName.length > 300 || !(value.email === null || isText(value.email, 320)) ||
    !(ACCOUNT_STATUSES as readonly unknown[]).includes(value.status)) return null;
  return {
    displayName: value.displayName,
    email: value.email,
    id: value.id,
    status: value.status as AdminSignInRefusalAccount["status"]
  };
}

function decodeSubject(value: unknown): AdminSignInRefusalSubject | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "email": {
      if (!isText(value.email, 320)) return null;
      if (value.account === null) return { account: null, email: value.email, kind: "email" };
      const account = decodeAccount(value.account);
      return account ? { account, email: value.email, kind: "email" } : null;
    }
    case "account": {
      const account = decodeAccount(value.account);
      return account ? { account, kind: "account" } : null;
    }
    case "no_verified_email":
    case "overflow":
      return { kind: value.kind };
    default:
      return null;
  }
}

function decodeRefusal(value: unknown): AdminSignInRefusal | null {
  if (!isRecord(value) || !isText(value.id, 128) || !isSignInRefusalMethod(value.method) ||
    !isSignInRefusalCode(value.code) || typeof value.attempts !== "number" || !Number.isSafeInteger(value.attempts) ||
    value.attempts < 1 || !isTime(value.firstSeenAt) || !isTime(value.lastSeenAt)) return null;
  const subject = decodeSubject(value.subject);
  if (!subject) return null;
  return {
    attempts: value.attempts,
    code: value.code,
    firstSeenAt: value.firstSeenAt,
    id: value.id,
    lastSeenAt: value.lastSeenAt,
    method: value.method,
    subject
  };
}

/** The response, or null when any part of it is malformed. */
export function decodeAdminSignInRefusalsResponse(value: unknown): AdminSignInRefusalsResponse | null {
  if (!isRecord(value) || !isRecord(value.signInRefusals)) return null;
  const page = value.signInRefusals;
  if (!isTime(page.generatedAt) || typeof page.total !== "number" || !Number.isSafeInteger(page.total) ||
    page.total < 0 || typeof page.truncated !== "boolean" || !Array.isArray(page.refusals) ||
    page.refusals.length > ADMIN_SIGN_IN_REFUSAL_LIMIT) return null;
  const refusals: AdminSignInRefusal[] = [];
  for (const entry of page.refusals) {
    const refusal = decodeRefusal(entry);
    if (!refusal) return null;
    refusals.push(refusal);
  }
  return { signInRefusals: { generatedAt: page.generatedAt, refusals, total: page.total, truncated: page.truncated } };
}

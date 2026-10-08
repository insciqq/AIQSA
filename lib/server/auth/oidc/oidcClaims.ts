import { EXTERNAL_GROUP_NAME_MAX_LENGTH } from "@/lib/contracts/authSignInMethods";

/** More values than this means the claim is not a group list AIQSA can trust: it is missing. */
export const OIDC_GROUPS_MAX_VALUES = 1_000;

export type OidcClaims = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** The value at a dot path (`realm_access.roles`), reading only the claims' own properties. */
export function claimAtPath(claims: OidcClaims, path: string): unknown {
  let current: unknown = claims;
  for (const segment of path.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Entra replaces a groups claim that would exceed its limit with a pointer in `_claim_names`
 * (overage); resolving it needs Microsoft Graph, so the groups count as missing.
 */
export function hasOidcClaimOverage(claims: OidcClaims, path: string): boolean {
  const names = claims._claim_names;
  const root = path.split(".")[0] ?? "";
  return isRecord(names) && Object.hasOwn(names, root);
}

/**
 * The groups or roles at `path`: a string or an array of strings, other entries ignored.
 * Null (missing, so nothing changes and groups admission fails closed) when the claim is
 * absent or another type, an overage pointer, longer than 1 000 values, or any value is longer
 * than an external group name may be.
 */
export function extractOidcGroups(claims: OidcClaims, path: string): string[] | null {
  if (hasOidcClaimOverage(claims, path)) return null;
  const value = claimAtPath(claims, path);
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (!values || values.length > OIDC_GROUPS_MAX_VALUES) return null;
  const groups = values.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  if (groups.some((group) => group.length > EXTERNAL_GROUP_NAME_MAX_LENGTH)) return null;
  if (typeof value === "string" && !groups.length) return null;
  return [...new Set(groups)];
}

/** `email_verified` as a boolean `true` or the string `"true"` some IdPs send. */
export function oidcEmailVerified(claims: OidcClaims): boolean {
  return claims.email_verified === true || claims.email_verified === "true";
}

export function oidcEmail(claims: OidcClaims): string | null {
  const email = claims.email;
  return typeof email === "string" && email.trim() ? email.trim() : null;
}

/** `name`, then `preferred_username`; settlement falls back to the email's local part. */
export function oidcDisplayName(claims: OidcClaims): string {
  for (const key of ["name", "preferred_username"]) {
    const value = claims[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 160);
  }
  return "";
}

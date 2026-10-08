import type { AuthSignInMethodConfig } from "@/lib/contracts/authSignInMethods";
import { authEmailDomain, isPlausibleEmail, normalizeAuthEmail } from "../password";

export const TRUSTED_HEADER_EMAIL_MAX_LENGTH = 320;
export const TRUSTED_HEADER_NAME_MAX_LENGTH = 160;
export const TRUSTED_HEADER_GROUPS_MAX_BYTES = 4_096;
export const TRUSTED_HEADER_GROUPS_MAX_VALUES = 200;

/** UTF-8 needs at most four bytes per character; the raw bound applies before decoding. */
const NAME_MAX_BYTES = TRUSTED_HEADER_NAME_MAX_LENGTH * 4;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/gu;
const BEYOND_LATIN1 = /[^\u0000-ÿ]/u;

type TrustedHeaderConfig = Pick<
  AuthSignInMethodConfig<"trusted_header">,
  "emailHeader" | "groupsHeader" | "groupsSeparator" | "nameHeader"
>;

export type TrustedHeaderIdentity = {
  displayName: string;
  /** Normalized; also the identity's subject. */
  email: string;
  /** Null when no groups header is configured or the proxy sent none. */
  groups: string[] | null;
};

export type TrustedHeaderRead =
  | { identity: TrustedHeaderIdentity; status: "identity" }
  | { status: "invalid" | "missing" };

/** Node hands header values over as one code unit per byte; proxies send names and groups in UTF-8. */
function byteLength(value: string): number {
  return BEYOND_LATIN1.test(value) ? Buffer.byteLength(value, "utf8") : value.length;
}

function decodeUtf8(value: string): string {
  if (BEYOND_LATIN1.test(value)) return value;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "latin1"));
  } catch {
    return value;
  }
}

/** The email header alone, bounded and normalized; shared by the sign-in and the admin probe. */
export function readTrustedHeaderEmail(
  headers: Headers,
  emailHeader: string
): { email: string; status: "email" } | { status: "invalid" | "missing" } {
  const raw = headers.get(emailHeader);
  if (raw === null || !raw.trim()) return { status: "missing" };
  // A repeated header arrives joined with ", ", which is never one address.
  if (raw.length > TRUSTED_HEADER_EMAIL_MAX_LENGTH || CONTROL_CHARACTER.test(raw) || raw.includes(",")) {
    return { status: "invalid" };
  }
  const email = normalizeAuthEmail(raw);
  return isPlausibleEmail(email) ? { email, status: "email" } : { status: "invalid" };
}

/** `@example.com` for an admin's own header value; never the local part. */
export function trustedHeaderDomainHint(email: string): string | null {
  const domain = authEmailDomain(email);
  return domain ? `@${domain}` : null;
}

function readName(headers: Headers, nameHeader: string | null): string | null {
  const raw = nameHeader ? headers.get(nameHeader) : null;
  if (raw === null) return "";
  if (byteLength(raw) > NAME_MAX_BYTES) return null;
  const name = decodeUtf8(raw).replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  return name.length > TRUSTED_HEADER_NAME_MAX_LENGTH ? null : name;
}

/**
 * Group values as the proxy listed them: split on the configured separator, with the list's
 * surrounding whitespace removed and duplicates dropped. Values are otherwise exact, so one
 * carrying a control character refuses the whole header rather than being rewritten.
 */
function readGroups(
  headers: Headers,
  config: Pick<TrustedHeaderConfig, "groupsHeader" | "groupsSeparator">
): { groups: string[] | null } | null {
  const raw = config.groupsHeader ? headers.get(config.groupsHeader) : null;
  if (raw === null) return { groups: null };
  if (byteLength(raw) > TRUSTED_HEADER_GROUPS_MAX_BYTES) return null;
  const values = decodeUtf8(raw)
    .split(config.groupsSeparator)
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length > TRUSTED_HEADER_GROUPS_MAX_VALUES || values.some((value) => CONTROL_CHARACTER.test(value))) {
    return null;
  }
  return { groups: [...new Set(values)] };
}

/**
 * Reads the identity a trusted proxy asserted. Only call it in trusted-proxy mode: outside it
 * these headers come from the client. Every header is bounded before it is used; an oversized
 * or malformed one refuses the sign-in as `invalid`, and a missing email header is `missing`.
 */
export function readTrustedHeaderIdentity(headers: Headers, config: TrustedHeaderConfig): TrustedHeaderRead {
  const email = readTrustedHeaderEmail(headers, config.emailHeader);
  if (email.status !== "email") return email;
  const displayName = readName(headers, config.nameHeader);
  const groups = readGroups(headers, config);
  if (displayName === null || groups === null) return { status: "invalid" };
  return { identity: { displayName, email: email.email, groups: groups.groups }, status: "identity" };
}

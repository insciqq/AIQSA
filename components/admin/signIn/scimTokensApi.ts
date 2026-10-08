import {
  ADMIN_SCIM_ACTIVE_TOKEN_MAX,
  type AdminScimToken,
  type AdminScimTokenRequest
} from "@/lib/contracts/adminScim";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ScimTokensResult =
  | { ok: true; token: string | null; tokens: AdminScimToken[] }
  | { error: string; ok: false };

const TOKENS_URL = "/api/admin/sign-in/scim/tokens";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function decodeToken(value: unknown): AdminScimToken | null {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.displayPrefix === "string" &&
    typeof value.createdAt === "string" &&
    isNullableString(value.lastUsedAt) &&
    isNullableString(value.revokedAt)
    ? {
        createdAt: value.createdAt,
        displayPrefix: value.displayPrefix,
        id: value.id,
        lastUsedAt: value.lastUsedAt,
        revokedAt: value.revokedAt
      }
    : null;
}

/** The token list, plus the new token of a `create` or `rotate`; null when malformed. */
export function decodeScimTokensResponse(value: unknown): { token: string | null; tokens: AdminScimToken[] } | null {
  if (!isRecord(value) || !Array.isArray(value.tokens)) return null;
  const tokens = value.tokens.map(decodeToken);
  if (tokens.some((token) => token === null)) return null;
  if (value.token !== undefined && typeof value.token !== "string") return null;
  return { token: typeof value.token === "string" ? value.token : null, tokens: tokens as AdminScimToken[] };
}

async function request(init: RequestInit, fetcher: Fetcher): Promise<ScimTokensResult> {
  try {
    const response = await fetcher(TOKENS_URL, init);
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return { error: isRecord(value) && typeof value.error === "string" ? value.error : "scim_token_action_failed", ok: false };
    }
    const decoded = decodeScimTokensResponse(value);
    return decoded ? { ...decoded, ok: true } : { error: "scim_token_response_invalid", ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}

export function requestScimTokens(fetcher: Fetcher = fetch): Promise<ScimTokensResult> {
  return request({ cache: "no-store", method: "GET" }, fetcher);
}

export function changeScimTokens(body: AdminScimTokenRequest, fetcher: Fetcher = fetch): Promise<ScimTokensResult> {
  return request({ body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" }, fetcher);
}

export function scimTokenErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    forbidden: "Your account no longer has permission to manage sign-in.",
    invalid_origin: "The request was blocked by the same-origin security check. Reload AIQSA from its configured URL and try again.",
    network_error: "Could not reach the sign-in administration API.",
    scim_token_limit: `At most ${ADMIN_SCIM_ACTIVE_TOKEN_MAX} SCIM tokens can be active. Revoke one first.`,
    scim_token_not_found: "This token was already revoked. The list was refreshed.",
    unauthorized: "Your administrator session is no longer valid. Sign in again."
  };
  return messages[code] ?? "The SCIM token action could not be completed.";
}

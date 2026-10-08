import type { AdminAuthErrorCode, ErrorResponse, MutationOriginErrorCode } from "./http";

/** SCIM bearer tokens that can be active at once; rotating one keeps the count. */
export const ADMIN_SCIM_ACTIVE_TOKEN_MAX = 5;

/** A SCIM bearer token as administrators see it: never the token itself after it was issued. */
export type AdminScimToken = {
  createdAt: string;
  /** The token's first characters, enough to tell tokens apart. */
  displayPrefix: string;
  id: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/** Active tokens first, then the most recently revoked ones. */
export type AdminScimTokensResponse = { tokens: AdminScimToken[] };

export type AdminScimTokenRequest =
  | { action: "create" }
  | { action: "revoke"; tokenId: string }
  /** Issues a new token and revokes this one in one step. */
  | { action: "rotate"; tokenId: string };

/** `create` and `rotate`: the new token, shown once; only its hash is stored. */
export type AdminScimTokenIssuedResponse = AdminScimTokensResponse & { token: string };

export type AdminScimTokenErrorCode =
  | AdminAuthErrorCode
  | MutationOriginErrorCode
  | "json_required"
  | "scim_token_invalid_request"
  | "scim_token_limit"
  | "scim_token_not_found";

export type AdminScimTokenErrorResponse = ErrorResponse<AdminScimTokenErrorCode>;

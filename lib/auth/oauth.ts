export const OAUTH_PROVIDER_IDS = ["google", "yandex", "oidc"] as const;

export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];

/** Providers with a fixed OAuth client adapter; OIDC runs its own discovery-driven flow. */
export type OAuthClientProviderId = Exclude<OAuthProviderId, "oidc">;

export const OAUTH_LOGIN_OUTCOMES = [
  "account_conflict",
  "cancelled",
  "email_missing",
  "failed",
  "not_allowed",
  "pending",
  "source_changed"
] as const;

export type OAuthLoginOutcome = (typeof OAUTH_LOGIN_OUTCOMES)[number];

export function isOAuthProviderId(value: unknown): value is OAuthProviderId {
  return typeof value === "string" && OAUTH_PROVIDER_IDS.some((provider) => provider === value);
}

export function isOAuthLoginOutcome(value: unknown): value is OAuthLoginOutcome {
  return typeof value === "string" && OAUTH_LOGIN_OUTCOMES.some((outcome) => outcome === value);
}

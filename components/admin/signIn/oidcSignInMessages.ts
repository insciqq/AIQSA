/** OIDC tester verdicts in words, keyed by the tester's content-free codes. */
export const oidcTestMessages: Readonly<Record<string, string>> = {
  client_auth_unsupported: "The provider accepts neither client_secret_basic nor client_secret_post for this client.",
  client_rejected: "The provider rejected the client ID or secret.",
  discovery_invalid: "The provider's discovery document is incomplete or invalid.",
  discovery_unreachable: "The issuer's discovery document could not be fetched. Check the issuer URL and that AIQSA can reach it.",
  id_token_alg_unsupported: "The provider signs ID tokens only with algorithms AIQSA does not accept (RS256/384/512, PS256, ES256/384).",
  issuer_mismatch: "The discovery document names a different issuer. Enter the issuer exactly as the provider reports it, including any trailing slash.",
  jwks_invalid: "The provider's signing keys contain no usable RSA or EC key.",
  jwks_unreachable: "The provider's signing keys could not be fetched.",
  multi_tenant_issuer: "Multi-tenant issuers (common, organizations, consumers, {tenantid}) let any tenant sign in. Use your tenant's own issuer.",
  oidc_checked: "Discovery, issuer, signing keys, PKCE and the client credentials checked. The first real sign-in proves the redirect URI.",
  pkce_unsupported: "The provider does not support PKCE with S256.",
  response_type_unsupported: "The provider does not support the authorization code flow.",
  token_endpoint_unreachable: "The provider's token endpoint could not be reached.",
  userinfo_unsupported: "Groups are set to come from userinfo, but the provider has no userinfo endpoint."
};

/** OIDC sign-in failures for the health line ("Last sign-in failed …: <message>"). */
export const oidcFailureMessages: Readonly<Record<string, string>> = {
  discovery_invalid: "the provider's discovery document is invalid",
  discovery_unreachable: "the provider's discovery document could not be fetched",
  id_token_invalid: "the ID token failed validation",
  issuer_mismatch: "the provider reports a different issuer",
  jwks_unreachable: "the provider's signing keys could not be fetched",
  multi_tenant_issuer: "the issuer is multi-tenant",
  token_exchange_failed: "the provider rejected the code exchange or could not be reached",
  userinfo_failed: "the userinfo request failed",
  userinfo_subject_mismatch: "userinfo named a different subject than the ID token",
  userinfo_unsupported: "the provider has no userinfo endpoint"
};

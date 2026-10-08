import type { AuthSignInMethodConfig } from "@/lib/contracts/authSignInMethods";

export type SamlSignInConfig = AuthSignInMethodConfig<"saml">;

/** The clock difference tolerated against the IdP's `NotBefore` and `NotOnOrAfter`. */
export const SAML_CLOCK_SKEW_MS = 60_000;

/** The source a SAML identity is bound to: the IdP entity id. */
export function samlIdentitySource(config: Pick<SamlSignInConfig, "idpEntityId">): string {
  return config.idpEntityId;
}

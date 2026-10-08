import { ValidateInResponseTo, type CacheProvider, type SamlConfig } from "@node-saml/node-saml";
import type { SamlServiceProvider } from "@/lib/contracts/samlSignIn";
import { SAML_CLOCK_SKEW_MS, type SamlSignInConfig } from "./config";
import { SAML_REQUEST_TTL_MS } from "./state";

/**
 * node-saml's settings for one configuration. Requests are unsigned (HTTP-Redirect) and ask
 * for no authentication context, so the IdP's own MFA policy decides; `InResponseTo` is always
 * required, which refuses IdP-initiated responses.
 */
export function samlNodeOptions(input: {
  cacheProvider: CacheProvider;
  config: SamlSignInConfig;
  generateUniqueId?: () => string;
  serviceProvider: SamlServiceProvider;
}): SamlConfig {
  const { config, serviceProvider } = input;
  return {
    acceptedClockSkewMs: SAML_CLOCK_SKEW_MS,
    audience: serviceProvider.entityId,
    authnRequestBinding: "HTTP-Redirect",
    cacheProvider: input.cacheProvider,
    callbackUrl: serviceProvider.acsUrl,
    disableRequestedAuthnContext: true,
    entryPoint: config.idpSsoUrl,
    ...(input.generateUniqueId ? { generateUniqueId: input.generateUniqueId } : {}),
    identifierFormat: config.nameIdFormat,
    idpCert: [...config.idpCertificates],
    idpIssuer: config.idpEntityId,
    issuer: serviceProvider.entityId,
    requestIdExpirationPeriodMs: SAML_REQUEST_TTL_MS,
    validateInResponseTo: ValidateInResponseTo.always,
    wantAssertionsSigned: config.requireSignedAssertion,
    wantAuthnResponseSigned: config.requireSignedResponse
  };
}

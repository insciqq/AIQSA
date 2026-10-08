import type { AdminAuthErrorCode, ErrorResponse, MutationOriginErrorCode } from "./http";

// SAML 2.0 sign-in: the service provider's own addresses and the client-safe wire shapes.

/** Builds the AuthnRequest and redirects to the IdP (`?next=` keeps the destination). */
export const SAML_START_PATH = "/api/auth/saml/start";
/** Outside `/api`: the IdP's HTTP-POST binding is a cross-site form POST without `Lax` cookies. */
export const SAML_ACS_PATH = "/saml/acs";
/** Where the ACS sends the browser; the initiating browser's binding cookie arrives here. */
export const SAML_COMPLETE_PATH = "/api/auth/saml/complete";
export const SAML_METADATA_PATH = "/saml/metadata";

export const SAML_NAME_ID_FORMATS = {
  emailAddress: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  persistent: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  transient: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
  unspecified: "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"
} as const;

export type SamlServiceProvider = {
  /** Where the IdP posts its response (Reply URL, ACS URL). */
  acsUrl: string;
  /** The SP entity id: the audience every assertion must name. */
  entityId: string;
  metadataUrl: string;
};

function absoluteUrl(path: string, appBaseUrl: string): string {
  try {
    return new URL(path, appBaseUrl).toString();
  } catch {
    return path;
  }
}

/** The values an IdP needs; the entity id defaults to the metadata URL. */
export function samlServiceProvider(appBaseUrl: string, spEntityId: string | null): SamlServiceProvider {
  const metadataUrl = absoluteUrl(SAML_METADATA_PATH, appBaseUrl);
  return {
    acsUrl: absoluteUrl(SAML_ACS_PATH, appBaseUrl),
    entityId: spEntityId ?? metadataUrl,
    metadataUrl
  };
}

/** How a SAML sign-in ended for the person, as `/login?saml=<outcome>` shows it. */
export const SAML_LOGIN_OUTCOMES = [
  "account_conflict",
  "browser_mismatch",
  "email_missing",
  "failed",
  "not_allowed",
  "pending",
  "source_changed"
] as const;

export type SamlLoginOutcome = (typeof SAML_LOGIN_OUTCOMES)[number];

export function isSamlLoginOutcome(value: unknown): value is SamlLoginOutcome {
  return typeof value === "string" && SAML_LOGIN_OUTCOMES.some((outcome) => outcome === value);
}

// Administrator metadata import: the IdP values parsed from metadata for the administrator to
// review and save.

export const SAML_METADATA_XML_MAX_LENGTH = 512 * 1024;

export type AdminSamlMetadataRequest = { metadataUrl: string } | { metadataXml: string };

export type AdminSamlMetadataCertificate = {
  pem: string;
  /** End of the certificate's validity, ISO 8601. */
  validTo: string;
};

export type AdminSamlMetadata = {
  certificates: AdminSamlMetadataCertificate[];
  entityId: string;
  /** The IdP's HTTP-Redirect single sign-on location. */
  ssoUrl: string;
};

export type AdminSamlMetadataResponse = { metadata: AdminSamlMetadata };

/** Why metadata (or a configuration checked against it) is unusable; also tester codes. */
export type SamlMetadataProblem =
  | "certificate_invalid"
  | "metadata_invalid"
  | "metadata_unreachable"
  | "sso_url_invalid";

export type AdminSamlMetadataErrorCode =
  | AdminAuthErrorCode
  | MutationOriginErrorCode
  | SamlMetadataProblem
  | "json_required"
  | "metadata_request_invalid"
  | "request_body_too_large";

export type AdminSamlMetadataErrorResponse = ErrorResponse<AdminSamlMetadataErrorCode>;

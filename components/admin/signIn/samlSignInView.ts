import {
  AUTH_SIGN_IN_METHOD_SCHEMAS,
  type AuthSignInMethodConfig
} from "@/lib/contracts/authSignInMethods";
import { SAML_NAME_ID_FORMATS } from "@/lib/contracts/samlSignIn";

type SamlConfig = AuthSignInMethodConfig<"saml">;

/** The SAML tester's codes in words; `signInTestMessage` reads them. */
export const samlTestMessages: Record<string, string> = {
  certificate_expired: "A pinned IdP certificate has expired. Remove it or add the IdP's current certificate.",
  certificate_invalid: "A pinned IdP certificate cannot be read, or its key is not RSA of at least 2048 bits.",
  configuration_checked: "Certificates and settings checked. The first real sign-in proves the IdP accepts AIQSA.",
  groups_attribute_required: "Allowed groups, admin groups and group sync need the groups attribute.",
  metadata_invalid: "The metadata URL did not return SAML 2.0 metadata for exactly one IdP.",
  metadata_mismatch: "The IdP's metadata names another entity ID or none of the pinned certificates. Load it again.",
  metadata_unreachable: "The metadata URL could not be reached from AIQSA.",
  nameid_transient: "A transient NameID changes with every sign-in. Use persistent, or set a subject attribute.",
  sso_url_invalid: "The IdP sign-in URL is not usable, or the metadata does not list it for HTTP-Redirect."
};

/** Why the last SAML sign-in failed, completing "Last sign-in failed …: <reason>." */
export const samlFailureMessages: Record<string, string> = {
  assertion_expired: "the assertion was expired or not valid yet; check both clocks",
  assertion_replayed: "an assertion was used twice",
  audience_mismatch: "the assertion was issued for another SP entity ID",
  destination_mismatch: "the response was addressed to another ACS URL",
  groups_invalid: "the IdP sent more than 1000 group values",
  idp_status_error: "the IdP refused or cancelled the sign-in",
  in_response_to_mismatch: "the assertion answered another sign-in request",
  issuer_mismatch: "the response came from another IdP entity ID",
  recipient_mismatch: "the assertion was issued for another ACS URL",
  request_unknown: "the response answered an unknown or expired sign-in request",
  response_invalid: "the SAML response could not be read",
  response_too_large: "the SAML response was larger than 256 KiB",
  sha1_refused: "the IdP signed with SHA-1, which is not allowed",
  signature_invalid: "the signature was missing or did not match a pinned certificate",
  subject_missing: "the assertion carried no usable subject",
  subject_transient: "the IdP sent a transient NameID",
  unsolicited_response: "the response did not answer a sign-in AIQSA started; IdP-initiated sign-in is not supported"
};

const metadataImportMessages: Record<string, string> = {
  certificate_invalid: "The metadata carries no usable signing certificate.",
  forbidden: "Your account no longer has permission to manage sign-in.",
  metadata_invalid: "That is not SAML 2.0 metadata for exactly one identity provider.",
  metadata_request_invalid: "Enter a metadata URL or paste the metadata XML.",
  metadata_unreachable: "The metadata URL could not be reached from AIQSA.",
  network_error: "Could not reach the sign-in administration API.",
  request_body_too_large: "The metadata is too large.",
  sso_url_invalid: "The metadata lists no HTTP-Redirect sign-in URL.",
  unauthorized: "Your administrator session is no longer valid. Sign in again."
};

export function samlMetadataImportMessage(code: string): string {
  return metadataImportMessages[code] ?? "The metadata could not be loaded.";
}

export const SAML_NAME_ID_FORMAT_OPTIONS: readonly { label: string; value: string }[] = [
  { label: "Persistent (recommended)", value: SAML_NAME_ID_FORMATS.persistent },
  { label: "Email address", value: SAML_NAME_ID_FORMATS.emailAddress },
  { label: "Unspecified", value: SAML_NAME_ID_FORMATS.unspecified },
  { label: "Transient (needs a subject attribute)", value: SAML_NAME_ID_FORMATS.transient }
];

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/gu;

function pemFromBody(body: string): string | null {
  const base64 = body.replace(/\s+/gu, "");
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) return null;
  return `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/gu)!.join("\n")}\n-----END CERTIFICATE-----`;
}

/**
 * Certificates pasted as PEM blocks (one or more), or one bare base64 body as IdP consoles
 * show it; null when the text holds anything else.
 */
export function parseSamlCertificates(text: string): string[] | null {
  const blocks = [...text.matchAll(PEM_BLOCK)].map((match) => pemFromBody(match[1] ?? ""));
  const rest = text.replace(PEM_BLOCK, "").trim();
  if (!blocks.length) {
    const single = rest ? pemFromBody(rest) : null;
    return single ? [single] : null;
  }
  if (rest || blocks.some((pem) => pem === null)) return null;
  return blocks as string[];
}

/** One exact value per line: line breaks and blank lines go, nothing is trimmed. */
export function parseSamlGroupList(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/\r$/u, "")).filter((line) => line.length > 0);
}

export type SamlCardForm = {
  adminGroups: string;
  allowSha1: boolean;
  allowedGroups: string;
  autoCreateUsers: boolean;
  buttonLabel: string;
  displayNameAttribute: string;
  emailAttribute: string;
  groupsAttribute: string;
  idpCertificates: string;
  idpEntityId: string;
  idpMetadataUrl: string;
  idpSsoUrl: string;
  nameIdFormat: string;
  requireSignedAssertion: boolean;
  requireSignedResponse: boolean;
  spEntityId: string;
  subjectAttribute: string;
  syncGroups: boolean;
  trustUnverifiedEmail: boolean;
};

/** The card's fields for a saved configuration, or the contract's defaults before one exists. */
export function samlCardForm(config: SamlConfig | null): SamlCardForm {
  return {
    adminGroups: config?.adminGroups.join("\n") ?? "",
    allowSha1: config?.allowSha1 ?? false,
    allowedGroups: config?.allowedGroups.join("\n") ?? "",
    autoCreateUsers: config?.autoCreateUsers ?? true,
    buttonLabel: config?.buttonLabel ?? "SAML",
    displayNameAttribute: config?.displayNameAttribute ?? "",
    emailAttribute: config?.emailAttribute ?? "email",
    groupsAttribute: config?.groupsAttribute ?? "",
    idpCertificates: config?.idpCertificates.join("\n\n") ?? "",
    idpEntityId: config?.idpEntityId ?? "",
    idpMetadataUrl: config?.idpMetadataUrl ?? "",
    idpSsoUrl: config?.idpSsoUrl ?? "",
    nameIdFormat: config?.nameIdFormat ?? SAML_NAME_ID_FORMATS.persistent,
    requireSignedAssertion: config?.requireSignedAssertion ?? true,
    requireSignedResponse: config?.requireSignedResponse ?? false,
    spEntityId: config?.spEntityId ?? "",
    subjectAttribute: config?.subjectAttribute ?? "",
    syncGroups: config?.syncGroups ?? false,
    trustUnverifiedEmail: config?.trustUnverifiedEmail ?? false
  };
}

export type SamlCardField = keyof SamlCardForm;

/**
 * The configuration the card saves, validated by the method's contract, or the fields to fix.
 * Optional text left blank means "not set"; group values stay exact.
 */
export function samlConfigFromForm(form: SamlCardForm):
  | { config: SamlConfig; ok: true }
  | { errors: Partial<Record<SamlCardField, string>>; ok: false } {
  const errors: Partial<Record<SamlCardField, string>> = {};
  const certificates = parseSamlCertificates(form.idpCertificates);
  if (!form.idpEntityId.trim()) errors.idpEntityId = "Enter the IdP entity ID.";
  if (!form.idpSsoUrl.trim()) errors.idpSsoUrl = "Enter the IdP sign-in URL.";
  if (!certificates?.length) errors.idpCertificates = "Paste the IdP signing certificate as PEM.";
  if (!form.requireSignedAssertion && !form.requireSignedResponse) {
    errors.requireSignedAssertion = "Require signed assertions, signed responses or both.";
  }
  if (Object.keys(errors).length) return { errors, ok: false };

  const optional = (value: string) => value.trim() || null;
  const parsed = AUTH_SIGN_IN_METHOD_SCHEMAS.saml.config.safeParse({
    adminGroups: parseSamlGroupList(form.adminGroups),
    allowSha1: form.allowSha1,
    allowedGroups: parseSamlGroupList(form.allowedGroups),
    autoCreateUsers: form.autoCreateUsers,
    buttonLabel: form.buttonLabel.trim() || "SAML",
    displayNameAttribute: optional(form.displayNameAttribute),
    emailAttribute: form.emailAttribute.trim() || "email",
    groupsAttribute: optional(form.groupsAttribute),
    idpCertificates: certificates,
    idpEntityId: form.idpEntityId.trim(),
    idpMetadataUrl: optional(form.idpMetadataUrl),
    idpSsoUrl: form.idpSsoUrl.trim(),
    nameIdFormat: form.nameIdFormat,
    requireSignedAssertion: form.requireSignedAssertion,
    requireSignedResponse: form.requireSignedResponse,
    spEntityId: optional(form.spEntityId),
    subjectAttribute: optional(form.subjectAttribute),
    syncGroups: form.syncGroups,
    trustUnverifiedEmail: form.trustUnverifiedEmail
  });
  if (parsed.success) return { config: parsed.data, ok: true };

  const messages: Partial<Record<SamlCardField, string>> = {
    adminGroups: "Up to 100 values of at most 512 characters, without control characters.",
    allowedGroups: "Up to 100 values of at most 512 characters, without control characters.",
    idpCertificates: "Paste one to four distinct PEM certificates.",
    idpMetadataUrl: "Enter an http(s) URL without credentials or fragment.",
    idpSsoUrl: "Enter an http(s) URL without credentials or fragment."
  };
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && field in form) {
      errors[field as SamlCardField] ??= messages[field as SamlCardField] ?? "Check this value.";
    }
  }
  return { errors: Object.keys(errors).length ? errors : { idpEntityId: "Check the fields." }, ok: false };
}

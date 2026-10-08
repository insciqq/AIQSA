import { z } from "zod";

/** Methods an administrator configures; `AuthSignInMethodSetting` keeps one row each. */
export const AUTH_SIGN_IN_METHODS = [
  "google",
  "yandex",
  "oidc",
  "ldap",
  "saml",
  "trusted_header",
  "scim"
] as const;

export type AuthSignInMethod = (typeof AUTH_SIGN_IN_METHODS)[number];

/** How a session's sign-in was proven; `AuthSession.signInMethod` records one of these. */
export const AUTH_SESSION_SIGN_IN_METHODS = [
  "password",
  "ldap",
  "google",
  "yandex",
  "oidc",
  "saml",
  "trusted_header",
  "bootstrap",
  "invite"
] as const;

export type AuthSessionSignInMethod = (typeof AUTH_SESSION_SIGN_IN_METHODS)[number];

/** Methods whose group or role values map to AIQSA groups (`GroupExternalNameSource`). */
export const EXTERNAL_GROUP_SOURCES = ["oidc", "ldap", "saml", "trusted_header"] as const;

export type ExternalGroupSource = (typeof EXTERNAL_GROUP_SOURCES)[number];

/** Where an active method's configuration comes from. */
export type AuthSignInMethodConfigSource = "admin" | "environment";

export const EXTERNAL_GROUP_NAME_MAX_LENGTH = 512;
export const EXTERNAL_GROUP_LIST_MAX = 100;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

export function isAuthSessionSignInMethod(value: unknown): value is AuthSessionSignInMethod {
  return typeof value === "string" && AUTH_SESSION_SIGN_IN_METHODS.some((method) => method === value);
}

export function isExternalGroupSource(value: unknown): value is ExternalGroupSource {
  return typeof value === "string" && EXTERNAL_GROUP_SOURCES.some((source) => source === value);
}

function text(max: number) {
  return z.string().trim().min(1).max(max).refine((value) => !CONTROL_CHARACTERS.test(value));
}

function absoluteUrl(protocols: readonly string[]) {
  return z.string().trim().max(2_048).refine((value) => {
    try {
      const url = new URL(value);
      return protocols.includes(url.protocol) && !url.username && !url.password && !url.hash;
    } catch {
      return false;
    }
  });
}

const httpUrl = absoluteUrl(["https:", "http:"]);
const headerName = z.string().trim().min(1).max(128).regex(HTTP_HEADER_NAME);
const secretValue = z.string().trim().min(1).max(1_024);

/** An exact external group or role value: compared as sent, never trimmed or case-folded. */
export const externalGroupNameSchema = z
  .string()
  .min(1)
  .max(EXTERNAL_GROUP_NAME_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARACTERS.test(value));

const externalGroupList = z.array(externalGroupNameSchema).max(EXTERNAL_GROUP_LIST_MAX);

/**
 * Admission, admin role and group sync for a method whose source asserts groups. Empty
 * `allowedGroups` admits anyone the source authenticated.
 */
const externalGroupPolicy = {
  adminGroups: externalGroupList.default(() => []),
  allowedGroups: externalGroupList.default(() => []),
  autoCreateUsers: z.boolean().default(true),
  syncGroups: z.boolean().default(false)
};

/** Linking to an existing account by an email the source did not assert as verified. */
function emailTrust(trustUnverifiedEmail: boolean) {
  return { trustUnverifiedEmail: z.boolean().default(trustUnverifiedEmail) };
}

export type ExternalGroupPolicyConfig = {
  adminGroups: readonly string[];
  allowedGroups: readonly string[];
  autoCreateUsers: boolean;
  syncGroups: boolean;
  trustUnverifiedEmail?: boolean;
};

// Google and Yandex: OAuth clients; admission stays with the access rules.

const oauthClientConfig = z.strictObject({ clientId: text(512) });
const oauthClientSecrets = z.strictObject({ clientSecret: secretValue });

export const googleSignInConfigSchema = oauthClientConfig;
export const googleSignInSecretsSchema = oauthClientSecrets;
export const yandexSignInConfigSchema = oauthClientConfig;
export const yandexSignInSecretsSchema = oauthClientSecrets;

// OIDC. One connection per installation; `issuer` is the identity source.

export const OIDC_GROUPS_FROM = ["id_token", "userinfo", "id_token_then_userinfo"] as const;

/** A dot path into the claims (`groups`, `realm_access.roles`, `resource_access.aiqsa.roles`). */
const OIDC_CLAIM_PATH = /^[^.\s]+(?:\.[^.\s]+){0,7}$/u;
const OIDC_SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+$/u;

/**
 * Entra's multi-tenant issuers accept tokens from any tenant, so a subject or email from a
 * stranger's tenant could sign in; only a single-tenant issuer may be configured.
 */
export function isMultiTenantOidcIssuer(issuer: string): boolean {
  const value = issuer.toLowerCase();
  if (value.includes("{tenantid}") || value.includes("%7btenantid%7d")) return true;
  try {
    const firstSegment = new URL(issuer).pathname.split("/").filter(Boolean)[0] ?? "";
    return ["common", "consumers", "organizations"].includes(firstSegment.toLowerCase());
  } catch {
    return false;
  }
}

export const oidcSignInConfigSchema = z.strictObject({
  autoRedirect: z.boolean().default(false),
  buttonLabel: text(64).default("SSO"),
  clientId: text(512),
  groupsClaimPath: text(256).regex(OIDC_CLAIM_PATH).default("groups"),
  groupsFrom: z.enum(OIDC_GROUPS_FROM).default("id_token_then_userinfo"),
  idpLogout: z.boolean().default(false),
  issuer: httpUrl,
  scopes: text(512)
    .refine((value) => value.split(/\s+/u).every((scope) => OIDC_SCOPE.test(scope)) && value.split(/\s+/u).includes("openid"))
    .default("openid email profile"),
  ...externalGroupPolicy,
  // Sync changes only groups that carry an OIDC external name, so it is a no-op until an
  // administrator names one; the card offers it switched on.
  syncGroups: z.boolean().default(true),
  ...emailTrust(false)
});

export const oidcSignInSecretsSchema = z.strictObject({ clientSecret: secretValue });

// LDAP. The operator's directory owns its email addresses, so they link by default.

const ldapAttribute = text(256);

/** Where the escaped sign-in name goes in `userSearchFilter`. */
export const LDAP_USERNAME_PLACEHOLDER = "{{username}}";

/** One or more PEM certificates; the server parses each as X.509 before trusting it. */
const PEM_CERTIFICATES = /^(?:-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*)+$/u;

/** A directory server only: scheme, host and port, no path, query or credentials. */
const ldapServerUrl = absoluteUrl(["ldap:", "ldaps:"]).refine((value) => {
  try {
    const url = new URL(value);
    return Boolean(url.hostname) && (url.pathname === "" || url.pathname === "/") && !url.search;
  } catch {
    return false;
  }
});

export const ldapSignInConfigSchema = z
  .strictObject({
    attributes: z
      .strictObject({
        displayName: ldapAttribute.default("displayName"),
        email: ldapAttribute.default("mail"),
        groups: ldapAttribute.default("memberOf"),
        id: ldapAttribute.default("entryUUID")
      })
      .default(() => ({ displayName: "displayName", email: "mail", groups: "memberOf", id: "entryUUID" })),
    bindDn: text(1_024).nullable().default(null),
    caCertificatePem: z.string().trim().min(1).max(65_536).regex(PEM_CERTIFICATES).nullable().default(null),
    groupValueForm: z.enum(["cn", "dn"]).default("cn"),
    loginUsesUsername: z.boolean().default(false),
    startTls: z.boolean().default(false),
    /** A sample sign-in name the tester searches for; it never binds as that user. */
    testUsername: text(256).nullable().default(null),
    tlsRejectUnauthorized: z.boolean().default(true),
    url: ldapServerUrl,
    userSearchBase: text(1_024),
    userSearchFilter: text(1_024)
      .refine((value) => value.includes(LDAP_USERNAME_PLACEHOLDER))
      .default(`(mail=${LDAP_USERNAME_PLACEHOLDER})`),
    ...externalGroupPolicy,
    ...emailTrust(true)
  })
  // StartTLS upgrades a plain `ldap://` connection; `ldaps://` is TLS from the start.
  .refine((config) => !config.startTls || config.url.toLowerCase().startsWith("ldap:"), { path: ["startTls"] });

export const ldapSignInSecretsSchema = z.strictObject({ bindPassword: z.string().min(1).max(1_024).optional() });

// SAML. The IdP is pinned by its entity id and its signing certificates: one PEM block per
// entry, several while the IdP rotates its key.

const samlAttribute = text(1_024);
const SAML_PEM_CERTIFICATE = /^-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----$/u;
const samlCertificate = z.string().trim().min(1).max(16_384).regex(SAML_PEM_CERTIFICATE);

export const samlSignInConfigSchema = z
  .strictObject({
    allowSha1: z.boolean().default(false),
    buttonLabel: text(64).default("SAML"),
    displayNameAttribute: samlAttribute.nullable().default(null),
    emailAttribute: samlAttribute.default("email"),
    groupsAttribute: samlAttribute.nullable().default(null),
    idpCertificates: z
      .array(samlCertificate)
      .min(1)
      .max(4)
      .refine((certificates) => new Set(certificates).size === certificates.length),
    idpEntityId: text(1_024),
    idpMetadataUrl: httpUrl.nullable().default(null),
    idpSsoUrl: httpUrl,
    nameIdFormat: text(256).default("urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"),
    requireSignedAssertion: z.boolean().default(true),
    requireSignedResponse: z.boolean().default(false),
    spEntityId: text(1_024).nullable().default(null),
    subjectAttribute: samlAttribute.nullable().default(null),
    ...externalGroupPolicy,
    ...emailTrust(false)
  })
  .refine((config) => config.requireSignedAssertion || config.requireSignedResponse, {
    path: ["requireSignedAssertion"]
  });

export const samlSignInSecretsSchema = z.strictObject({});

// Trusted header (auth-trusted-header refines). The proxy owns the email, so there is no
// email trust switch.

export const trustedHeaderSignInConfigSchema = z.strictObject({
  emailHeader: headerName,
  groupsHeader: headerName.nullable().default(null),
  groupsSeparator: z.string().min(1).max(8).default(","),
  nameHeader: headerName.nullable().default(null),
  ...externalGroupPolicy
});

export const trustedHeaderSignInSecretsSchema = z.strictObject({});

// SCIM. Tokens live in `AuthScimToken`, not in the method secrets. `linkMethod` is the sign-in
// method whose first sign-in links a SCIM-provisioned account by email (Open WebUI's
// `SCIM_AUTH_PROVIDER`).

export const SCIM_LINK_METHODS = ["none", "oidc", "saml", "ldap"] as const;

export type ScimLinkMethod = (typeof SCIM_LINK_METHODS)[number];

export const scimConfigSchema = z.strictObject({ linkMethod: z.enum(SCIM_LINK_METHODS).default("none") });
export const scimSecretsSchema = z.strictObject({});

export const AUTH_SIGN_IN_METHOD_SCHEMAS = {
  google: { config: googleSignInConfigSchema, secrets: googleSignInSecretsSchema },
  ldap: { config: ldapSignInConfigSchema, secrets: ldapSignInSecretsSchema },
  oidc: { config: oidcSignInConfigSchema, secrets: oidcSignInSecretsSchema },
  saml: { config: samlSignInConfigSchema, secrets: samlSignInSecretsSchema },
  scim: { config: scimConfigSchema, secrets: scimSecretsSchema },
  trusted_header: { config: trustedHeaderSignInConfigSchema, secrets: trustedHeaderSignInSecretsSchema },
  yandex: { config: yandexSignInConfigSchema, secrets: yandexSignInSecretsSchema }
} as const satisfies Record<AuthSignInMethod, { config: z.ZodType; secrets: z.ZodType }>;

export type AuthSignInMethodConfig<M extends AuthSignInMethod = AuthSignInMethod> = z.output<
  (typeof AUTH_SIGN_IN_METHOD_SCHEMAS)[M]["config"]
>;

export type AuthSignInMethodSecrets<M extends AuthSignInMethod = AuthSignInMethod> = z.output<
  (typeof AUTH_SIGN_IN_METHOD_SCHEMAS)[M]["secrets"]
>;

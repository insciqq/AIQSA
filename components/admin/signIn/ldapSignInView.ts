import type { AuthSignInMethodConfig } from "@/lib/contracts/authSignInMethods";

type LdapConfig = AuthSignInMethodConfig<"ldap">;

const transports: Record<string, string> = {
  ldaps: "over LDAPS",
  plain: "without TLS",
  starttls: "over StartTLS"
};

const ldapTestMessages: Record<string, string> = {
  ambiguous: "The search found more than one entry for the sample name. Make the filter match one entry per user.",
  bind_failed: "The directory refused the bind DN and password.",
  bind_password_missing: "Enter the bind password, or clear the bind DN to search anonymously.",
  ca_certificate_invalid: "The CA certificate is not a valid PEM X.509 certificate.",
  connect_failed: "The directory server could not be reached.",
  destination_forbidden: "This address is not allowed: link-local, cloud metadata and AIQSA's own services are refused.",
  filter_invalid: "The user search filter is not a valid LDAP filter.",
  not_found: "No entry matches the sample name under the search base.",
  search_failed: "The search failed. Check the search base and the filter.",
  tls_failed: "The TLS connection failed: the certificate is not trusted or does not name this host."
};

/**
 * The LDAP tester's codes in words. A found entry's code carries the transport and attribute
 * presence (`entry_found_ldaps_id1_email1_groups3`); null for codes of other methods.
 */
export function ldapTestMessage(code: string): string | null {
  const base = /^base_found_(ldaps|starttls|plain)$/u.exec(code);
  if (base) return `Connected ${transports[base[1]!]} and found the search base. Enter a sample name to check a user entry.`;
  const entry = /^entry_found_(ldaps|starttls|plain)_id([01])_email([01])_groups(\d{1,3})$/u.exec(code);
  if (entry) {
    const [, transport, id, email, groups] = entry;
    const missing = [id === "0" ? "id" : null, email === "0" ? "email" : null].filter(Boolean);
    return [
      `Found the sample entry ${transports[transport!]}.`,
      missing.length ? `Missing attribute: ${missing.join(" and ")}.` : "Id and email attributes present.",
      `${groups} group value${groups === "1" ? "" : "s"}.`
    ].join(" ");
  }
  return ldapTestMessages[code] ?? null;
}

/** Health codes LDAP sign-ins record, completing the shared sentence "Last sign-in failed …: <message>". */
export const ldapFailureMessages: Record<string, string> = {
  bind_failed: "the directory refused the bind DN",
  connect_failed: "the directory server could not be reached",
  destination_forbidden: "the directory address is not allowed",
  id_attribute_missing: "the user's entry has no id attribute",
  search_failed: "the user search failed",
  tls_failed: "the TLS connection to the directory failed"
};

export type LdapPreset = "active_directory" | "openldap";

/** Starting values for a directory type; the administrator adjusts the rest. */
export const ldapPresets: Record<LdapPreset, Pick<LdapConfig, "attributes" | "groupValueForm" | "loginUsesUsername" | "userSearchFilter">> = {
  active_directory: {
    attributes: { displayName: "displayName", email: "mail", groups: "memberOf", id: "objectGUID" },
    groupValueForm: "cn",
    loginUsesUsername: true,
    userSearchFilter: "(sAMAccountName={{username}})"
  },
  openldap: {
    attributes: { displayName: "cn", email: "mail", groups: "memberOf", id: "entryUUID" },
    groupValueForm: "cn",
    loginUsesUsername: true,
    userSearchFilter: "(uid={{username}})"
  }
};

export const LDAP_EMAIL_FILTER = "(mail={{username}})";
const USERNAME_FILTERS = new Set([ldapPresets.active_directory.userSearchFilter, ldapPresets.openldap.userSearchFilter]);

/**
 * The filter after the "users sign in with a username" switch: a default filter follows the
 * switch (`(uid=…)`, or `(sAMAccountName=…)` for an AD id attribute, and back to `(mail=…)`);
 * an edited filter stays as the administrator wrote it.
 */
export function ldapFilterForUsernameSwitch(input: { filter: string; idAttribute: string; loginUsesUsername: boolean }): string {
  if (input.loginUsesUsername && input.filter === LDAP_EMAIL_FILTER) {
    return input.idAttribute.toLowerCase() === "objectguid"
      ? ldapPresets.active_directory.userSearchFilter
      : ldapPresets.openldap.userSearchFilter;
  }
  if (!input.loginUsesUsername && USERNAME_FILTERS.has(input.filter)) return LDAP_EMAIL_FILTER;
  return input.filter;
}

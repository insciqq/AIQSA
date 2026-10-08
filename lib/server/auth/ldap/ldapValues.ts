import {
  EXTERNAL_GROUP_NAME_MAX_LENGTH,
  LDAP_USERNAME_PLACEHOLDER,
  type AuthSignInMethodConfig
} from "@/lib/contracts/authSignInMethods";

type LdapConfig = AuthSignInMethodConfig<"ldap">;

export const LDAP_USERNAME_MAX_LENGTH = 256;
/** More group values than any real account carries; the rest are ignored. */
export const LDAP_GROUP_VALUES_MAX = 5_000;
const LDAP_SUBJECT_MAX_LENGTH = 1_024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
/** Attributes whose values are binary GUIDs (Active Directory `objectGUID`). */
const GUID_ATTRIBUTES: ReadonlySet<string> = new Set(["objectguid"]);
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** One directory entry, attribute names lowercased; binary attributes keep their bytes. */
export type LdapEntry = {
  attributes: Readonly<Record<string, readonly (string | Uint8Array)[]>>;
  dn: string;
};

/** What a directory entry says about its account; null fields were missing. */
export type LdapProfile = {
  displayName: string;
  email: string | null;
  /** Null when the groups attribute was missing: group sync and admin role stay unchanged. */
  groups: string[] | null;
  subject: string | null;
};

/** The sign-in name as typed, trimmed; null when empty, too long or carrying control characters. */
export function ldapUsername(raw: string): string | null {
  const username = raw.trim();
  return username && username.length <= LDAP_USERNAME_MAX_LENGTH && !CONTROL_CHARACTERS.test(username)
    ? username
    : null;
}

/**
 * An empty or whitespace password is never sent: many directories accept a simple bind with a
 * DN and no password as an unauthenticated bind that reports success.
 */
export function isBlankLdapPassword(password: string): boolean {
  return password.trim().length === 0;
}

/** RFC 4515 assertion value: `*`, `(`, `)`, `\` and NUL become `\XX`. */
export function escapeLdapFilterValue(value: string): string {
  return value.replace(/[*()\\\u0000]/gu, (character) => `\\${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** The configured filter with every placeholder replaced by the escaped sign-in name. */
export function ldapUserFilter(template: string, username: string): string {
  // split/join, not replace: a `$` in the name must stay literal.
  return template.split(LDAP_USERNAME_PLACEHOLDER).join(escapeLdapFilterValue(username));
}

/** An Active Directory `objectGUID` (16 bytes, the first three fields little-endian) as text. */
export function decodeObjectGuid(bytes: Uint8Array): string | null {
  if (bytes.length !== 16) return null;
  const hex = (indexes: readonly number[]) => indexes.map((index) => bytes[index]!.toString(16).padStart(2, "0")).join("");
  return [
    hex([3, 2, 1, 0]),
    hex([5, 4]),
    hex([7, 6]),
    hex([8, 9]),
    hex([10, 11, 12, 13, 14, 15])
  ].join("-");
}

export function isLdapGuidAttribute(name: string): boolean {
  return GUID_ATTRIBUTES.has(name.toLowerCase());
}

/**
 * The value of a DN's first RDN (`CN=ad-engineers,CN=Users,DC=…` → `ad-engineers`), with
 * RFC 4514 escapes decoded; null when the DN has none.
 */
export function firstRdnValue(dn: string): string | null {
  const characters = Array.from(dn);
  const equals = characters.indexOf("=");
  if (equals <= 0) return null;
  const bytes: number[] = [];

  for (let index = equals + 1; index < characters.length; index += 1) {
    const character = characters[index]!;
    if (character === "," || character === "+" || character === ";") break;
    if (character === "\\") {
      const pair = `${characters[index + 1] ?? ""}${characters[index + 2] ?? ""}`;
      if (/^[0-9A-Fa-f]{2}$/u.test(pair)) {
        bytes.push(Number.parseInt(pair, 16));
        index += 2;
        continue;
      }
      const escaped = characters[index + 1];
      if (escaped === undefined) return null;
      bytes.push(...Buffer.from(escaped, "utf8"));
      index += 1;
      continue;
    }
    bytes.push(...Buffer.from(character, "utf8"));
  }

  const value = Buffer.from(bytes).toString("utf8").trim();
  return value || null;
}

/**
 * Group values as AIQSA compares them with external group names: the full DN as sent, or its
 * first RDN value. Null (attribute missing) stays null.
 */
export function ldapGroupValues(values: readonly string[] | null, form: LdapConfig["groupValueForm"]): string[] | null {
  if (values === null) return null;
  const result = new Set<string>();
  for (const raw of values.slice(0, LDAP_GROUP_VALUES_MAX)) {
    const value = form === "dn" ? raw : firstRdnValue(raw);
    if (value && value.length <= EXTERNAL_GROUP_NAME_MAX_LENGTH && !CONTROL_CHARACTERS.test(value)) {
      result.add(value);
    }
  }
  return [...result];
}

/** A DN made comparable: lowercased, spaces around unescaped separators dropped. */
export function normalizeLdapDn(dn: string): string {
  const rdns: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of dn.toLowerCase()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      current += character;
      escaped = true;
    } else if (character === ",") {
      rdns.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  rdns.push(current);
  return rdns
    .map((rdn) => {
      const equals = rdn.indexOf("=");
      return equals < 0 ? rdn.trim() : `${rdn.slice(0, equals).trim()}=${rdn.slice(equals + 1).trim()}`;
    })
    .join(",");
}

/**
 * The source LDAP identities are bound to: the directory host and the user search base. The
 * scheme and port are left out, so moving the same directory to LDAPS or StartTLS keeps every
 * identity.
 */
export function ldapIdentitySource(config: Pick<LdapConfig, "url" | "userSearchBase">): string {
  const url = new URL(config.url);
  const host = url.hostname.toLowerCase();
  return `ldap://${host}/${normalizeLdapDn(config.userSearchBase)}`;
}

/** The attributes a sign-in reads, requested by name: operational ones such as `entryUUID` too. */
export function ldapRequestedAttributes(config: Pick<LdapConfig, "attributes">): string[] {
  const { displayName, email, groups, id } = config.attributes;
  return [...new Set([id, email, displayName, "cn", groups])];
}

/** Attributes to receive as bytes: the id attribute, so a binary GUID survives decoding. */
export function ldapBinaryAttributes(config: Pick<LdapConfig, "attributes">): string[] {
  const { id } = config.attributes;
  return [...new Set([id, id.toLowerCase(), ...(isLdapGuidAttribute(id) ? ["objectGUID"] : [])])];
}

function attributeValues(entry: LdapEntry, name: string): readonly (string | Uint8Array)[] | null {
  const values = entry.attributes[name.toLowerCase()];
  return values && values.length ? values : null;
}

function text(value: string | Uint8Array): string | null {
  if (typeof value === "string") return value;
  try {
    return strictUtf8.decode(value);
  } catch {
    return null;
  }
}

function firstText(entry: LdapEntry, name: string): string | null {
  const value = attributeValues(entry, name)?.[0];
  const decoded = value === undefined ? null : text(value)?.trim();
  return decoded || null;
}

function subjectOf(entry: LdapEntry, name: string): string | null {
  const value = attributeValues(entry, name)?.[0];
  if (value === undefined) return null;
  let subject: string | null;
  if (isLdapGuidAttribute(name)) {
    subject = typeof value === "string" ? null : decodeObjectGuid(value);
  } else {
    subject = typeof value === "string" ? value : text(value) ?? Buffer.from(value).toString("hex");
  }
  subject = subject?.trim() ?? null;
  return subject && subject.length <= LDAP_SUBJECT_MAX_LENGTH && !CONTROL_CHARACTERS.test(subject) ? subject : null;
}

export function ldapProfile(entry: LdapEntry, config: Pick<LdapConfig, "attributes" | "groupValueForm">): LdapProfile {
  const { attributes } = config;
  const groupValues = attributeValues(entry, attributes.groups);
  return {
    displayName: firstText(entry, attributes.displayName) ?? firstText(entry, "cn") ?? "",
    email: firstText(entry, attributes.email),
    groups: ldapGroupValues(
      groupValues === null ? null : groupValues.map(text).filter((value): value is string => value !== null),
      config.groupValueForm
    ),
    subject: subjectOf(entry, attributes.id)
  };
}

/** Fields the user's own read fills in where the service read left them missing. */
export function mergeLdapProfiles(service: LdapProfile, own: LdapProfile): LdapProfile {
  return {
    displayName: service.displayName || own.displayName,
    email: service.email ?? own.email,
    groups: service.groups ?? own.groups,
    subject: service.subject ?? own.subject
  };
}

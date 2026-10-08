import { describe, expect, it } from "vitest";
import { ldapSignInConfigSchema } from "@/lib/contracts/authSignInMethods";
import {
  decodeObjectGuid,
  escapeLdapFilterValue,
  firstRdnValue,
  isBlankLdapPassword,
  ldapBinaryAttributes,
  ldapGroupValues,
  ldapIdentitySource,
  ldapProfile,
  ldapRequestedAttributes,
  ldapUserFilter,
  ldapUsername,
  mergeLdapProfiles,
  normalizeLdapDn,
  type LdapEntry
} from "./ldapValues";

const openLdap = ldapSignInConfigSchema.parse({
  url: "ldaps://ldap.example.test",
  userSearchBase: "ou=people,dc=example,dc=test",
  userSearchFilter: "(uid={{username}})"
});
const activeDirectory = ldapSignInConfigSchema.parse({
  attributes: { displayName: "displayName", email: "mail", groups: "memberOf", id: "objectGUID" },
  url: "ldaps://dc1.corp.example.test",
  userSearchBase: "DC=corp,DC=example,DC=test",
  userSearchFilter: "(sAMAccountName={{username}})"
});

/** objectGUID bytes of {1d5e5f8b-2b4c-4a6e-9f10-0123456789ab} as AD stores them. */
const GUID_BYTES = Uint8Array.from([
  0x8b, 0x5f, 0x5e, 0x1d, 0x4c, 0x2b, 0x6e, 0x4a, 0x9f, 0x10, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab
]);

function entry(attributes: LdapEntry["attributes"], dn = "uid=jdoe,ou=people,dc=example,dc=test"): LdapEntry {
  return { attributes, dn };
}

describe("LDAP sign-in input", () => {
  it("escapes the RFC 4515 specials so an injection attempt stays one assertion value", () => {
    expect(escapeLdapFilterValue("*)(uid=*")).toBe("\\2a\\29\\28uid=\\2a");
    expect(escapeLdapFilterValue("back\\slash\u0000nul")).toBe("back\\5cslash\\00nul");
    expect(ldapUserFilter("(&(objectClass=person)(uid={{username}}))", "*)(uid=*"))
      .toBe("(&(objectClass=person)(uid=\\2a\\29\\28uid=\\2a))");
  });

  it("replaces every placeholder literally, with no replacement patterns", () => {
    expect(ldapUserFilter("(|(uid={{username}})(mail={{username}}))", "a$&b$1"))
      .toBe("(|(uid=a$&b$1)(mail=a$&b$1))");
  });

  it("accepts a trimmed name up to 256 characters without control characters", () => {
    expect(ldapUsername("  jdoe ")).toBe("jdoe");
    expect(ldapUsername("jdoe@example.test")).toBe("jdoe@example.test");
    expect(ldapUsername("j".repeat(256))).toBe("j".repeat(256));
    expect(ldapUsername("j".repeat(257))).toBeNull();
    expect(ldapUsername("   ")).toBeNull();
    expect(ldapUsername("jdoe\u0000")).toBeNull();
    expect(ldapUsername("jd\noe")).toBeNull();
  });

  it("treats empty and whitespace-only passwords as blank", () => {
    expect(isBlankLdapPassword("")).toBe(true);
    expect(isBlankLdapPassword(" \t\n")).toBe(true);
    expect(isBlankLdapPassword(" secret ")).toBe(false);
  });
});

describe("LDAP attribute values", () => {
  it("decodes an Active Directory objectGUID to its canonical text", () => {
    expect(decodeObjectGuid(GUID_BYTES)).toBe("1d5e5f8b-2b4c-4a6e-9f10-0123456789ab");
    expect(decodeObjectGuid(GUID_BYTES.slice(0, 15))).toBeNull();
  });

  it("reads the first RDN value of AD and OpenLDAP group DNs, escapes decoded", () => {
    expect(firstRdnValue("CN=ad-engineers,CN=Users,DC=corp,DC=example,DC=test")).toBe("ad-engineers");
    expect(firstRdnValue("cn=researchers,ou=groups,dc=example,dc=test")).toBe("researchers");
    expect(firstRdnValue("CN=Smith\\, John,OU=Teams,DC=example")).toBe("Smith, John");
    expect(firstRdnValue("cn=caf\\c3\\a9,ou=groups")).toBe("café");
    expect(firstRdnValue("not a dn")).toBeNull();
  });

  it("maps group values in dn and cn form, and keeps a missing attribute missing", () => {
    const values = ["CN=ad-engineers,CN=Users,DC=corp", "cn=researchers,ou=groups,dc=example,dc=test"];

    expect(ldapGroupValues(values, "cn")).toEqual(["ad-engineers", "researchers"]);
    expect(ldapGroupValues(values, "dn")).toEqual(values);
    expect(ldapGroupValues(null, "cn")).toBeNull();
    expect(ldapGroupValues([], "dn")).toEqual([]);
    expect(ldapGroupValues([`cn=${"g".repeat(513)},ou=groups`], "cn")).toEqual([]);
  });

  it("requests operational attributes by name and the id attribute as bytes", () => {
    expect(ldapRequestedAttributes(openLdap)).toEqual(["entryUUID", "mail", "displayName", "cn", "memberOf"]);
    expect(ldapBinaryAttributes(activeDirectory)).toEqual(["objectGUID", "objectguid"]);
  });

  it("reads an OpenLDAP entry, attribute names compared without case", () => {
    expect(ldapProfile(entry({
      cn: ["Jane Doe"],
      entryuuid: [new Uint8Array(Buffer.from("6f1d2c4e-0000-4000-8000-000000000001"))],
      mail: ["jane@example.test"],
      memberof: ["cn=researchers,ou=groups,dc=example,dc=test"]
    }), openLdap)).toEqual({
      displayName: "Jane Doe",
      email: "jane@example.test",
      groups: ["researchers"],
      subject: "6f1d2c4e-0000-4000-8000-000000000001"
    });
  });

  it("reads an Active Directory entry with a binary objectGUID", () => {
    expect(ldapProfile(entry({
      displayname: ["Jane Doe"],
      mail: ["jane@corp.example.test"],
      memberof: ["CN=ad-engineers,CN=Users,DC=corp,DC=example,DC=test"],
      objectguid: [GUID_BYTES]
    }), activeDirectory)).toEqual({
      displayName: "Jane Doe",
      email: "jane@corp.example.test",
      groups: ["ad-engineers"],
      subject: "1d5e5f8b-2b4c-4a6e-9f10-0123456789ab"
    });
  });

  it("reports missing id, email and groups as null and lets the user's own read fill them", () => {
    const service = ldapProfile(entry({ cn: ["Jane"] }), openLdap);
    const own = ldapProfile(entry({ entryuuid: ["uuid-1"], mail: ["jane@example.test"], memberof: [] }), openLdap);

    expect(service).toEqual({ displayName: "Jane", email: null, groups: null, subject: null });
    expect(mergeLdapProfiles(service, own)).toEqual({
      displayName: "Jane",
      email: "jane@example.test",
      groups: null,
      subject: "uuid-1"
    });
  });
});

describe("LDAP identity source", () => {
  it("binds identities to the host and the normalized base, not the scheme or port", () => {
    expect(normalizeLdapDn(" OU=People , DC=Example,DC=test ")).toBe("ou=people,dc=example,dc=test");
    expect(normalizeLdapDn("cn=Smith\\, John ,dc=x")).toBe("cn=smith\\, john,dc=x");
    const source = ldapIdentitySource({ url: "ldaps://LDAP.Example.test:636", userSearchBase: "OU=People, DC=Example,DC=test" });

    expect(source).toBe("ldap://ldap.example.test/ou=people,dc=example,dc=test");
    expect(ldapIdentitySource({ url: "ldap://ldap.example.test", userSearchBase: "ou=people,dc=example,dc=test" })).toBe(source);
    expect(ldapIdentitySource({ url: "ldap://ldap2.example.test", userSearchBase: "ou=people,dc=example,dc=test" })).not.toBe(source);
  });
});

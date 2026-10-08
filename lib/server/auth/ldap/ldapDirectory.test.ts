import { describe, expect, it } from "vitest";
import { ldapSignInConfigSchema, type AuthSignInMethodSecrets } from "@/lib/contracts/authSignInMethods";
import { createFakeLdapDirectory, type FakeLdapUser } from "@/tests/support/fakeLdapDirectory";
import { authenticateLdapUser, ldapFilterParses, testLdapDirectory } from "./ldapDirectory";

const SERVICE = { dn: "cn=aiqsa-bind,ou=service,dc=example,dc=test", password: "service-secret" };
const BASE = "ou=people,dc=example,dc=test";

const config = ldapSignInConfigSchema.parse({
  bindDn: SERVICE.dn,
  url: "ldaps://ldap.example.test",
  userSearchBase: BASE,
  userSearchFilter: "(|(uid={{username}})(mail={{username}}))"
});
const secrets = { bindPassword: SERVICE.password };

const jane: FakeLdapUser = {
  attributes: {
    cn: ["Jane Doe"],
    entryUUID: ["uuid-jane"],
    mail: ["jane@example.test"],
    memberOf: ["cn=researchers,ou=groups,dc=example,dc=test", "cn=aiqsa-admins,ou=groups,dc=example,dc=test"],
    uid: ["jdoe"]
  },
  dn: `uid=jdoe,${BASE}`,
  password: "correct horse"
};

function directory(overrides: Partial<Parameters<typeof createFakeLdapDirectory>[0]> = {}) {
  return createFakeLdapDirectory({ service: SERVICE, users: [jane], ...overrides });
}

function signIn(fake: ReturnType<typeof directory>, username: string, password: string, overrides: Partial<typeof config> = {}) {
  return authenticateLdapUser({ config: { ...config, ...overrides }, connect: fake.connect, password, secrets, username });
}

describe("LDAP sign-in against a directory", () => {
  it("signs in by username and by email: service bind, one entry, bind as its DN", async () => {
    for (const username of ["jdoe", "jane@example.test"]) {
      const fake = directory();

      await expect(signIn(fake, username, "correct horse")).resolves.toEqual({
        kind: "authenticated",
        profile: {
          displayName: "Jane Doe",
          email: "jane@example.test",
          groups: ["researchers", "aiqsa-admins"],
          subject: "uuid-jane"
        }
      });
      expect(fake.binds).toEqual([SERVICE, { dn: jane.dn, password: "correct horse" }]);
      expect(fake.searches[0]).toMatchObject({ base: BASE, request: { scope: "sub", sizeLimit: 2 } });
      expect(fake.searches[0]!.request.attributes).toContain("entryUUID");
      expect(fake.closed).toBe(1);
    }
  });

  it("maps groups in dn form when configured", async () => {
    const result = await signIn(directory(), "jdoe", "correct horse", { groupValueForm: "dn" });

    expect(result.kind === "authenticated" && result.profile.groups).toEqual(jane.attributes.memberOf);
  });

  it("gives an unknown name and a wrong password the same outcome", async () => {
    const unknown = directory();
    const wrong = directory();

    await expect(signIn(unknown, "nobody", "correct horse")).resolves.toEqual({ kind: "rejected" });
    await expect(signIn(wrong, "jdoe", "wrong password")).resolves.toEqual({ kind: "rejected" });
    expect(unknown.binds).toEqual([SERVICE]);
    expect(unknown.closed + wrong.closed).toBe(2);
  });

  it("never sends an empty or whitespace password", async () => {
    for (const password of ["", "   "]) {
      const fake = directory();

      await expect(signIn(fake, "jdoe", password)).resolves.toEqual({ kind: "rejected" });
      expect(fake.binds).toEqual([]);
      expect(fake.searches).toEqual([]);
    }
  });

  it("escapes an injection attempt into one literal value", async () => {
    const fake = directory();

    await expect(signIn(fake, "*)(uid=*", "correct horse")).resolves.toEqual({ kind: "rejected" });
    expect(fake.searches[0]!.request.filter).toBe("(|(uid=\\2a\\29\\28uid=\\2a)(mail=\\2a\\29\\28uid=\\2a))");
    expect(fake.binds).toEqual([SERVICE]);
  });

  it("fails an ambiguous search without binding as either entry", async () => {
    const twin: FakeLdapUser = { ...jane, dn: `uid=jdoe2,${BASE}` };
    const fake = directory({ users: [jane, twin] });

    await expect(signIn(fake, "jdoe", "correct horse")).resolves.toEqual({ kind: "rejected" });
    expect(fake.binds).toEqual([SERVICE]);
  });

  it("searches anonymously without a bind DN and refuses a bind DN without its password", async () => {
    const anonymous = directory();
    await expect(authenticateLdapUser({
      config: { ...config, bindDn: null },
      connect: anonymous.connect,
      password: "correct horse",
      secrets: {},
      username: "jdoe"
    })).resolves.toMatchObject({ kind: "authenticated" });
    expect(anonymous.binds).toEqual([{ dn: jane.dn, password: "correct horse" }]);

    const missing = directory();
    await expect(authenticateLdapUser({
      config,
      connect: missing.connect,
      password: "correct horse",
      secrets: {},
      username: "jdoe"
    })).resolves.toEqual({ code: "bind_failed", kind: "unavailable" });
    expect(missing.binds).toEqual([]);
  });

  it("reports an unreachable or refusing directory as unavailable, never as a wrong password", async () => {
    await expect(signIn(directory({ fail: { connect: "connect_failed" } }), "jdoe", "correct horse"))
      .resolves.toEqual({ code: "connect_failed", kind: "unavailable" });
    await expect(signIn(directory({ fail: { connect: "tls_failed" } }), "jdoe", "correct horse"))
      .resolves.toEqual({ code: "tls_failed", kind: "unavailable" });
    await expect(signIn(directory({ fail: { serviceBind: true } }), "jdoe", "correct horse"))
      .resolves.toEqual({ code: "bind_failed", kind: "unavailable" });
    await expect(signIn(directory({ fail: { search: true } }), "jdoe", "correct horse"))
      .resolves.toEqual({ code: "search_failed", kind: "unavailable" });
    await expect(signIn(directory({ fail: { userBind: true } }), "jdoe", "correct horse"))
      .resolves.toEqual({ code: "connect_failed", kind: "unavailable" });
  });

  it("reads what the service account cannot see as the user, and needs an id", async () => {
    const hidden = directory({ hiddenFromService: ["memberOf", "mail"] });
    const result = await signIn(hidden, "jdoe", "correct horse");

    expect(result).toMatchObject({ kind: "authenticated", profile: { email: "jane@example.test", groups: ["researchers", "aiqsa-admins"] } });
    expect(hidden.searches[1]).toMatchObject({ base: jane.dn, request: { scope: "base" } });

    const noId = directory({ users: [{ ...jane, attributes: { ...jane.attributes, entryUUID: [] } }] });
    await expect(signIn(noId, "jdoe", "correct horse")).resolves.toEqual({ code: "id_attribute_missing", kind: "unavailable" });
  });

  it("keeps a missing groups attribute missing", async () => {
    const { memberOf: _memberOf, ...attributes } = jane.attributes;
    const result = await signIn(directory({ users: [{ ...jane, attributes }] }), "jdoe", "correct horse");

    expect(result.kind === "authenticated" && result.profile.groups).toBeNull();
  });
});

describe("LDAP tester", () => {
  function test(fake: ReturnType<typeof directory>, overrides: Partial<typeof config> = {}, testSecrets: AuthSignInMethodSecrets<"ldap"> = secrets) {
    return testLdapDirectory({
      config: { ...config, ...overrides },
      connect: fake.connect,
      secrets: testSecrets,
      signal: new AbortController().signal
    });
  }

  it("finds the sample entry with the service account only and reports attribute presence", async () => {
    const fake = directory();

    await expect(test(fake, { testUsername: "jdoe" })).resolves.toEqual({
      code: "entry_found_ldaps_id1_email1_groups2",
      passed: true
    });
    expect(fake.binds).toEqual([SERVICE]);
  });

  it("checks the search base when no sample name is set", async () => {
    await expect(test(directory({ transport: "starttls" }))).resolves.toEqual({ code: "base_found_starttls", passed: true });
  });

  it("names not found, ambiguous and missing attributes", async () => {
    await expect(test(directory(), { testUsername: "nobody" })).resolves.toEqual({ code: "not_found", passed: false });
    await expect(test(directory({ users: [jane, { ...jane, dn: `uid=twin,${BASE}` }] }), { testUsername: "jdoe" }))
      .resolves.toEqual({ code: "ambiguous", passed: false });
    const { mail: _mail, ...attributes } = jane.attributes;
    await expect(test(directory({ users: [{ ...jane, attributes }] }), { testUsername: "jdoe" }))
      .resolves.toEqual({ code: "entry_found_ldaps_id1_email0_groups2", passed: false });
  });

  it("names connection, TLS, bind and search failures", async () => {
    await expect(test(directory({ fail: { connect: "connect_failed" } }))).resolves.toEqual({ code: "connect_failed", passed: false });
    await expect(test(directory({ fail: { connect: "tls_failed" } }))).resolves.toEqual({ code: "tls_failed", passed: false });
    await expect(test(directory({ fail: { connect: "destination_forbidden" } })))
      .resolves.toEqual({ code: "destination_forbidden", passed: false });
    await expect(test(directory({ fail: { serviceBind: true } }))).resolves.toEqual({ code: "bind_failed", passed: false });
    await expect(test(directory({ fail: { search: true } }), { testUsername: "jdoe" }))
      .resolves.toEqual({ code: "search_failed", passed: false });
  });

  it("refuses a draft it can judge without the network", async () => {
    const fake = directory();

    await expect(test(fake, {}, {})).resolves.toEqual({ code: "bind_password_missing", passed: false });
    await expect(test(fake, { userSearchFilter: "(uid={{username}}" })).resolves.toEqual({ code: "filter_invalid", passed: false });
    await expect(test(fake, {
      caCertificatePem: "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----"
    })).resolves.toEqual({ code: "ca_certificate_invalid", passed: false });
    expect(fake.binds).toEqual([]);
    expect(ldapFilterParses("(&(objectClass=person)(sAMAccountName={{username}}))")).toBe(true);
  });
});

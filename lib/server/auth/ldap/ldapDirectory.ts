import { FilterParser } from "ldapts";
import type { AuthSignInMethodConfig, AuthSignInMethodSecrets } from "@/lib/contracts/authSignInMethods";
import type { SignInMethodTestResult } from "../signInSettings/registry";
import {
  isLdapResultError,
  ldapConnectionFailure,
  parseLdapCaCertificates,
  type LdapConnect,
  type LdapConnectionFailure,
  type LdapSearchRequest,
  type LdapSession
} from "./ldapConnection";
import {
  isBlankLdapPassword,
  ldapBinaryAttributes,
  ldapProfile,
  ldapRequestedAttributes,
  ldapUserFilter,
  mergeLdapProfiles,
  type LdapProfile
} from "./ldapValues";

type LdapConfig = AuthSignInMethodConfig<"ldap">;
type LdapSecrets = AuthSignInMethodSecrets<"ldap">;

/** Why the directory could not decide a sign-in; never caused by the user's input alone. */
export type LdapUnavailableCode = LdapConnectionFailure | "bind_failed" | "id_attribute_missing" | "search_failed";

export type LdapAuthenticationResult =
  | { kind: "authenticated"; profile: LdapProfile & { subject: string } }
  /** No entry, more than one, or the password was refused: one outcome for all three. */
  | { kind: "rejected" }
  | { code: LdapUnavailableCode; kind: "unavailable" };

class LdapStepError extends Error {
  constructor(readonly code: LdapUnavailableCode) {
    super(code);
    this.name = "LdapStepError";
  }
}

function searchRequest(config: LdapConfig, filter: string, scope: LdapSearchRequest["scope"], sizeLimit: number): LdapSearchRequest {
  return {
    attributes: ldapRequestedAttributes(config),
    binaryAttributes: ldapBinaryAttributes(config),
    filter,
    scope,
    sizeLimit
  };
}

/**
 * Binds with the configured service account. Without a bind DN the search runs anonymously; a
 * bind DN without its password is refused rather than sent as an unauthenticated bind.
 */
async function serviceBind(session: LdapSession, config: LdapConfig, secrets: LdapSecrets): Promise<void> {
  if (!config.bindDn) return;
  if (!secrets.bindPassword || isBlankLdapPassword(secrets.bindPassword)) throw new LdapStepError("bind_failed");
  try {
    await session.bind(config.bindDn, secrets.bindPassword);
  } catch (error) {
    throw new LdapStepError(isLdapResultError(error) ? "bind_failed" : ldapConnectionFailure(error));
  }
}

async function searchEntries(session: LdapSession, base: string, request: LdapSearchRequest) {
  try {
    return await session.search(base, request);
  } catch (error) {
    throw new LdapStepError(isLdapResultError(error) ? "search_failed" : ldapConnectionFailure(error));
  }
}

async function openSession(connect: LdapConnect, config: LdapConfig, signal: AbortSignal | undefined): Promise<LdapSession> {
  try {
    return await connect({ config, ...(signal ? { signal } : {}) });
  } catch (error) {
    throw new LdapStepError(ldapConnectionFailure(error));
  }
}

/**
 * Verifies a sign-in against the directory: service bind (or anonymous search), a search under
 * the base with the escaped name that must find exactly one entry, then a bind as that entry's
 * DN with the given password. Attributes come from the service read; what it left missing is
 * read again as the user. The caller has already refused a blank password; it is checked here
 * again so no path can turn it into an unauthenticated bind.
 */
export async function authenticateLdapUser(input: {
  config: LdapConfig;
  connect: LdapConnect;
  password: string;
  secrets: LdapSecrets;
  signal?: AbortSignal;
  username: string;
}): Promise<LdapAuthenticationResult> {
  if (isBlankLdapPassword(input.password)) return { kind: "rejected" };
  const { config } = input;
  let session: LdapSession | null = null;

  try {
    session = await openSession(input.connect, config, input.signal);
    await serviceBind(session, config, input.secrets);
    const entries = await searchEntries(
      session,
      config.userSearchBase,
      searchRequest(config, ldapUserFilter(config.userSearchFilter, input.username), "sub", 2)
    );
    const entry = entries.length === 1 ? entries[0] : undefined;
    if (!entry?.dn) return { kind: "rejected" };

    try {
      await session.bind(entry.dn, input.password);
    } catch (error) {
      if (isLdapResultError(error)) return { kind: "rejected" };
      throw new LdapStepError(ldapConnectionFailure(error));
    }

    let profile = ldapProfile(entry, config);
    if (profile.email === null || profile.groups === null || profile.subject === null) {
      try {
        const [own] = await session.search(entry.dn, searchRequest(config, "(objectClass=*)", "base", 1));
        if (own) profile = mergeLdapProfiles(profile, ldapProfile(own, config));
      } catch {
        // The service read stands; what is still missing is decided below and by settlement.
      }
    }

    const { subject } = profile;
    if (subject === null) return { code: "id_attribute_missing", kind: "unavailable" };
    return { kind: "authenticated", profile: { ...profile, subject } };
  } catch (error) {
    return { code: error instanceof LdapStepError ? error.code : "connect_failed", kind: "unavailable" };
  } finally {
    await session?.close();
  }
}

/** Whether the configured filter is one the directory can be sent; the name is a sample. */
export function ldapFilterParses(template: string): boolean {
  try {
    FilterParser.parseString(ldapUserFilter(template, "aiqsa-filter-check"));
    return true;
  } catch {
    return false;
  }
}

/**
 * The tester: a service bind and, with a sample name, the sign-in search for it. It never binds
 * as a user. Its code is content-free; a found entry reports the transport, whether the id and
 * email attributes are present and how many group values the entry has:
 * `entry_found_<ldaps|starttls|plain>_id<0|1>_email<0|1>_groups<count>`. Without a sample it
 * checks that the search base exists (`base_found_<transport>`).
 */
export async function testLdapDirectory(input: {
  config: LdapConfig;
  connect: LdapConnect;
  secrets: LdapSecrets;
  signal?: AbortSignal;
}): Promise<SignInMethodTestResult> {
  const { config } = input;
  if (config.caCertificatePem && !parseLdapCaCertificates(config.caCertificatePem)) {
    return { code: "ca_certificate_invalid", passed: false };
  }
  if (config.bindDn && (!input.secrets.bindPassword || isBlankLdapPassword(input.secrets.bindPassword))) {
    return { code: "bind_password_missing", passed: false };
  }
  if (!ldapFilterParses(config.userSearchFilter)) return { code: "filter_invalid", passed: false };

  let session: LdapSession | null = null;
  try {
    session = await openSession(input.connect, config, input.signal);
    await serviceBind(session, config, input.secrets);

    if (!config.testUsername) {
      const base = await searchEntries(session, config.userSearchBase, searchRequest(config, "(objectClass=*)", "base", 1));
      return base.length
        ? { code: `base_found_${session.transport}`, passed: true }
        : { code: "search_failed", passed: false };
    }

    const entries = await searchEntries(
      session,
      config.userSearchBase,
      searchRequest(config, ldapUserFilter(config.userSearchFilter, config.testUsername), "sub", 2)
    );
    if (entries.length === 0) return { code: "not_found", passed: false };
    if (entries.length > 1) return { code: "ambiguous", passed: false };

    const profile = ldapProfile(entries[0]!, config);
    const groups = Math.min(profile.groups?.length ?? 0, 999);
    const id = profile.subject === null ? 0 : 1;
    const email = profile.email === null ? 0 : 1;
    return {
      code: `entry_found_${session.transport}_id${id}_email${email}_groups${groups}`,
      passed: id === 1 && email === 1
    };
  } catch (error) {
    return { code: error instanceof LdapStepError ? error.code : "connect_failed", passed: false };
  } finally {
    await session?.close();
  }
}

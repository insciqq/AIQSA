import { InvalidCredentialsError } from "ldapts";
import {
  LdapConnectionError,
  type LdapConnect,
  type LdapConnectionFailure,
  type LdapSearchRequest,
  type LdapTransport
} from "@/lib/server/auth/ldap/ldapConnection";
import type { LdapEntry } from "@/lib/server/auth/ldap/ldapValues";

export type FakeLdapUser = {
  /** Attribute values by name; names compare without case, as in a directory. */
  attributes: Record<string, (string | Uint8Array)[]>;
  dn: string;
  password: string;
};

export type FakeLdapDirectory = {
  binds: { dn: string; password: string }[];
  closed: number;
  connect: LdapConnect;
  searches: { base: string; request: LdapSearchRequest }[];
};

function unescapeFilterValue(value: string): string {
  return Buffer.from(
    value.replace(/\\([0-9a-fA-F]{2})/gu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))),
    "latin1"
  ).toString("utf8");
}

/** Equality assertions `(name=value)` of a filter; enough for the sign-in filters under test. */
function assertions(filter: string): { name: string; value: string }[] {
  return [...filter.matchAll(/\(([A-Za-z][A-Za-z0-9-]*)=((?:[^()\\]|\\[0-9a-fA-F]{2})*)\)/gu)].map((match) => ({
    name: match[1]!.toLowerCase(),
    value: unescapeFilterValue(match[2]!)
  }));
}

function matches(user: FakeLdapUser, filter: string): boolean {
  const attributes = new Map(Object.entries(user.attributes).map(([name, values]) => [name.toLowerCase(), values]));
  return assertions(filter).some(({ name, value }) =>
    name !== "objectclass" &&
    (attributes.get(name) ?? []).some((candidate) => typeof candidate === "string" && candidate.toLowerCase() === value.toLowerCase()));
}

function toEntry(user: FakeLdapUser, request: LdapSearchRequest, readable: (name: string) => boolean): LdapEntry {
  const wanted = new Set(request.attributes.map((name) => name.toLowerCase()));
  const attributes: Record<string, (string | Uint8Array)[]> = {};
  for (const [name, values] of Object.entries(user.attributes)) {
    const key = name.toLowerCase();
    if (wanted.has(key) && readable(key)) attributes[key] = values;
  }
  return { attributes, dn: user.dn };
}

/**
 * An in-memory directory behind the `LdapConnect` seam: a service account, users with
 * passwords, sign-in searches by equality filter, base reads, and failure switches. It records
 * every bind and search so tests can prove what was (never) sent.
 */
export function createFakeLdapDirectory(input: {
  /** Attributes the service account cannot read; the user's own read sees them. */
  hiddenFromService?: string[];
  service?: { dn: string; password: string };
  transport?: LdapTransport;
  users: FakeLdapUser[];
  fail?: {
    connect?: LdapConnectionFailure;
    search?: boolean;
    serviceBind?: boolean;
    /** The connection drops during the user bind. */
    userBind?: boolean;
  };
}): FakeLdapDirectory {
  const directory: FakeLdapDirectory = {
    binds: [],
    closed: 0,
    async connect() {
      if (input.fail?.connect) throw new LdapConnectionError(input.fail.connect);
      let boundAs: string | null = null;
      const hidden = new Set((input.hiddenFromService ?? []).map((name) => name.toLowerCase()));
      return {
        async bind(dn, password) {
          if (!password.trim()) throw new Error("blank password reached the directory");
          directory.binds.push({ dn, password });
          if (input.service && dn === input.service.dn) {
            if (input.fail?.serviceBind || password !== input.service.password) throw new InvalidCredentialsError();
            boundAs = dn;
            return;
          }
          if (input.fail?.userBind) throw new Error("Connection closed before message response was received.");
          const user = input.users.find((candidate) => candidate.dn === dn);
          if (!user || user.password !== password) throw new InvalidCredentialsError();
          boundAs = dn;
        },
        async close() {
          directory.closed += 1;
        },
        async search(base, request) {
          directory.searches.push({ base, request });
          if (input.fail?.search) throw new InvalidCredentialsError("search refused");
          const readable = (name: string) => boundAs !== input.service?.dn && boundAs !== null ? true : !hidden.has(name);
          if (request.scope === "base") {
            const own = input.users.find((user) => user.dn === base);
            if (own) return [toEntry(own, request, readable)];
            return [{ attributes: {}, dn: base }];
          }
          return input.users
            .filter((user) => user.dn.toLowerCase().endsWith(base.toLowerCase()) && matches(user, request.filter))
            .slice(0, request.sizeLimit)
            .map((user) => toEntry(user, request, readable));
        },
        transport: input.transport ?? "ldaps"
      };
    },
    searches: []
  };
  return directory;
}

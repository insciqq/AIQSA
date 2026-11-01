/**
 * Client-safe proxy contract: protocols, stable codes, route paths, what the
 * browser reads and writes, and the run plan an accepted run persists.
 *
 * No read shape and no plan entry has a password field. A password goes one
 * way, in `ProxyWriteInput`; the only reader is the server-only run-proxies
 * interface (`lib/server/proxies/runProxies.ts`).
 */
export const PROXY_PROTOCOLS = ["http", "https", "socks5"] as const;
export type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number];

export const PROXY_OWNERS = ["personal", "administrator"] as const;
export type ProxyOwner = (typeof PROXY_OWNERS)[number];

/** Input bounds. A login and a password fit SOCKS5 authentication, 255 bytes each. */
export const PROXY_LIMITS = Object.freeze({
  hintMaxLength: 253,
  hintsPerProxy: 50,
  hostMaxLength: 253,
  loginMaxLength: 255,
  nameMaxLength: 64,
  passwordMaxLength: 255,
  proxiesPerOwner: 50
});

/** Why a save was refused. */
export const PROXY_INPUT_FAILURE_CODES = [
  "proxy_country_invalid",
  "proxy_hint_invalid",
  "proxy_host_invalid",
  "proxy_input_invalid",
  "proxy_login_invalid",
  "proxy_name_invalid",
  "proxy_password_invalid",
  "proxy_port_invalid",
  "proxy_protocol_invalid"
] as const;
export type ProxyInputFailureCode = (typeof PROXY_INPUT_FAILURE_CODES)[number];

/** Why a valid save was still refused; nothing was written. */
export const PROXY_CHANGE_FAILURE_CODES = ["proxy_conflict", "proxy_limit", "proxy_name_taken"] as const;
export type ProxyChangeFailureCode = (typeof PROXY_CHANGE_FAILURE_CODES)[number];

/** Why a proxy's own address was refused (`lib/server/proxies/address.ts`). */
export const PROXY_ADDRESS_FAILURE_CODES = [
  "proxy_address_check_unavailable",
  "proxy_address_forbidden",
  "proxy_dns_failed",
  "proxy_host_invalid",
  "proxy_port_invalid"
] as const;
export type ProxyAddressFailureCode = (typeof PROXY_ADDRESS_FAILURE_CODES)[number];

/** Why talking to an allowed proxy failed. Every one moves on to the next proxy. */
export const PROXY_CONNECTION_FAILURE_CODES = [
  "proxy_auth_failed",
  "proxy_connect_failed",
  "proxy_protocol_error",
  "proxy_timeout",
  "proxy_tls_failed"
] as const;
export type ProxyConnectionFailureCode = (typeof PROXY_CONNECTION_FAILURE_CODES)[number];

/** Why selection opened nothing. None of them ever falls back to a direct connection. */
export const PROXY_SELECTION_FAILURE_CODES = ["proxy_all_failed", "proxy_inactive", "proxy_not_found"] as const;
export type ProxySelectionFailureCode = (typeof PROXY_SELECTION_FAILURE_CODES)[number];

/** A proxy of the run's plan that was deleted, switched off or moved since admission. */
export const PROXY_UNAVAILABLE_CODE = "proxy_unavailable";

/** The stable outcome of testing a proxy. */
export type ProxyCheckStatus = "ok" | ProxyAddressFailureCode | ProxyConnectionFailureCode;

export function isProxyCheckStatus(value: unknown): value is ProxyCheckStatus {
  return value === "ok" ||
    (PROXY_ADDRESS_FAILURE_CODES as readonly unknown[]).includes(value) ||
    (PROXY_CONNECTION_FAILURE_CODES as readonly unknown[]).includes(value);
}

/**
 * Site responses that read as a block, so a result names proxies to try
 * (`proxiesToTry` in `lib/domain/proxySelection.ts`). They do not move a
 * selection on: the site answered, so the agent decides.
 */
export const PROXY_BLOCKED_HTTP_STATUSES = [401, 403, 407, 451, 498] as const;

export function isProxyProtocol(value: unknown): value is ProxyProtocol {
  return (PROXY_PROTOCOLS as readonly unknown[]).includes(value);
}

export function isProxyOwner(value: unknown): value is ProxyOwner {
  return (PROXY_OWNERS as readonly unknown[]).includes(value);
}

export function isProxyPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

/** An ISO 3166-1 alpha-2 country, upper case. */
export function isProxyCountry(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{2}$/u.test(value);
}

export type ProxyCheckResult = Readonly<{
  checkedAt: string;
  /** The address sites see, known only when the check passed. */
  exitAddress: string | null;
  status: ProxyCheckStatus;
}>;

/** A proxy its owner, or an administrator for an administrator proxy, manages. */
export type ProxyWire = Readonly<{
  active: boolean;
  country: string | null;
  /** Canonical hints, see `normalizeProxyHint` in `lib/domain/proxySelection.ts`. */
  domainHints: readonly string[];
  hasPassword: boolean;
  host: string;
  id: string;
  lastCheck: ProxyCheckResult | null;
  login: string | null;
  name: string;
  owner: ProxyOwner;
  port: number;
  protocol: ProxyProtocol;
  /** The revision an update or a deletion is guarded by. A check leaves it as it was. */
  version: number;
}>;

/** What a member sees of an administrator proxy in settings: no address, login or password. */
export type ProxySharedWire = Pick<ProxyWire, "active" | "country" | "domainHints" | "id" | "name" | "protocol"> &
  Readonly<{ owner: "administrator" }>;

/** The write-only form. `password`: absent keeps the stored one, null removes it. */
export type ProxyWriteInput = Readonly<{
  active?: boolean;
  country?: string | null;
  domainHints?: readonly string[];
  host: string;
  login?: string | null;
  name: string;
  password?: string | null;
  port: number;
  protocol: ProxyProtocol;
}>;

/** An update: what is absent keeps its value, and `expectedVersion` guards the whole change. */
export type ProxyUpdateInput = Partial<ProxyWriteInput> & Readonly<{ expectedVersion: number }>;

export type ProxyDeleteInput = Readonly<{ expectedVersion: number }>;

const proxyItem = (base: string, id: string) => `${base}/${encodeURIComponent(id)}`;

export const PROXY_ROUTES = Object.freeze({
  administrator: "/api/admin/proxies",
  administratorCheck: (id: string) => `${proxyItem("/api/admin/proxies", id)}/check`,
  administratorItem: (id: string) => proxyItem("/api/admin/proxies", id),
  personal: "/api/me/proxies",
  personalCheck: (id: string) => `${proxyItem("/api/me/proxies", id)}/check`,
  personalItem: (id: string) => proxyItem("/api/me/proxies", id)
});

/**
 * One proxy as an accepted run bound it: ids and non-secret fields. The
 * endpoint is here so that credentials are never sent anywhere but the endpoint
 * admission saw (`lib/server/proxies/runProxies.ts`).
 */
export type ProxyRunPlanEntry = Readonly<{
  active: boolean;
  country: string | null;
  domainHints: readonly string[];
  host: string;
  id: string;
  name: string;
  owner: ProxyOwner;
  port: number;
  protocol: ProxyProtocol;
}>;

/** Persisted with the accepted run; a run without proxies has no plan at all. */
export type ProxyRunPlan = Readonly<{ entries: readonly ProxyRunPlanEntry[] }>;

/**
 * The plan of the given proxies, field by field, so a stored row that holds a
 * password cannot carry it into a persisted run. Null without proxies.
 */
export function toProxyRunPlan(proxies: readonly ProxyRunPlanEntry[]): ProxyRunPlan | null {
  if (proxies.length === 0) return null;
  return {
    entries: proxies.map(({ active, country, domainHints, host, id, name, owner, port, protocol }) => ({
      active,
      country,
      domainHints: [...domainHints],
      host,
      id,
      name,
      owner,
      port,
      protocol
    }))
  };
}

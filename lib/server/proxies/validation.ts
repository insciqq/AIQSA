import {
  PROXY_LIMITS,
  isProxyCountry,
  isProxyPort,
  isProxyProtocol,
  type PROXY_UNAVAILABLE_CODE,
  type ProxyAddressFailureCode,
  type ProxyChangeFailureCode,
  type ProxyInputFailureCode,
  type ProxyProtocol,
  type ProxySelectionFailureCode
} from "@/lib/contracts/proxies";
import { normalizeProxyHint } from "@/lib/domain/proxySelection";
import { canonicalProxyHost } from "./address";

export type ProxyErrorCode =
  | ProxyAddressFailureCode
  | ProxyChangeFailureCode
  | ProxyInputFailureCode
  | Extract<ProxySelectionFailureCode, "proxy_not_found">
  | typeof PROXY_UNAVAILABLE_CODE;

/** A refusal with a stable code; nothing was written. Its message is the code, so it can carry no input. */
export class ProxyError extends Error {
  constructor(readonly code: ProxyErrorCode) {
    super(code);
    this.name = "ProxyError";
  }
}

/** Every field of a save, canonical and bounded. */
export type ProxyFields = Readonly<{
  active: boolean;
  country: string | null;
  domainHints: readonly string[];
  host: string;
  login: string | null;
  name: string;
  password: string | null;
  port: number;
  protocol: ProxyProtocol;
}>;

/** An update: an absent field keeps its value, and a null login, password or country clears it. */
export type ProxyPatch = Partial<ProxyFields>;

const WRITE_KEYS = ["active", "country", "domainHints", "host", "login", "name", "password", "port", "protocol"] as const;
const CONTROL = /[\u0000-\u001f\u007f]/u;

const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Bounded before any I/O. The name is the one field that is trimmed, since it is typed to select a proxy. */
function nameField(value: unknown): string {
  if (typeof value !== "string") throw new ProxyError("proxy_name_invalid");
  const name = value.trim();
  if (!name || name.length > PROXY_LIMITS.nameMaxLength || CONTROL.test(name)) throw new ProxyError("proxy_name_invalid");
  return name;
}

function hostField(value: unknown): string {
  const host = canonicalProxyHost(value);
  if (host === null || host.length > PROXY_LIMITS.hostMaxLength) throw new ProxyError("proxy_host_invalid");
  return host;
}

/** A colon cannot stand in a Basic login, and a saved proxy may change protocol later. */
function loginField(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || bytes(value) > PROXY_LIMITS.loginMaxLength || CONTROL.test(value) || value.includes(":")) {
    throw new ProxyError("proxy_login_invalid");
  }
  return value;
}

function passwordField(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || bytes(value) > PROXY_LIMITS.passwordMaxLength || CONTROL.test(value)) {
    throw new ProxyError("proxy_password_invalid");
  }
  return value;
}

function countryField(value: unknown): string | null {
  if (value === null) return null;
  const country = typeof value === "string" ? value.trim().toUpperCase() : value;
  if (!isProxyCountry(country)) throw new ProxyError("proxy_country_invalid");
  return country;
}

/** Canonical, each once, in the given order. Refused rather than dropped: a lost hint sends its site direct. */
function hintsField(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > PROXY_LIMITS.hintsPerProxy) throw new ProxyError("proxy_hint_invalid");
  const hints = new Set<string>();
  for (const item of value) {
    const hint = normalizeProxyHint(item);
    if (hint === null || hint.length > PROXY_LIMITS.hintMaxLength) throw new ProxyError("proxy_hint_invalid");
    hints.add(hint);
  }
  return [...hints];
}

function patchOf(value: Record<string, unknown>): ProxyPatch {
  return {
    ...(value.active === undefined ? {} : { active: activeField(value.active) }),
    ...(value.country === undefined ? {} : { country: countryField(value.country) }),
    ...(value.domainHints === undefined ? {} : { domainHints: hintsField(value.domainHints) }),
    ...(value.host === undefined ? {} : { host: hostField(value.host) }),
    ...(value.login === undefined ? {} : { login: loginField(value.login) }),
    ...(value.name === undefined ? {} : { name: nameField(value.name) }),
    ...(value.password === undefined ? {} : { password: passwordField(value.password) }),
    ...(value.port === undefined ? {} : { port: portField(value.port) }),
    ...(value.protocol === undefined ? {} : { protocol: protocolField(value.protocol) })
  };
}

function activeField(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ProxyError("proxy_input_invalid");
  return value;
}

function portField(value: unknown): number {
  if (!isProxyPort(value)) throw new ProxyError("proxy_port_invalid");
  return value;
}

function protocolField(value: unknown): ProxyProtocol {
  if (!isProxyProtocol(value)) throw new ProxyError("proxy_protocol_invalid");
  return value;
}

function checkedKeys(value: unknown, extra: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !(WRITE_KEYS as readonly string[]).includes(key) && !extra.includes(key))) {
    throw new ProxyError("proxy_input_invalid");
  }
  return value;
}

/** A password goes with a login: every protocol sends the two together. */
export function assertProxyCredentials(fields: Readonly<{ hasLogin: boolean; hasPassword: boolean }>): void {
  if (fields.hasPassword && !fields.hasLogin) throw new ProxyError("proxy_login_invalid");
}

/** `ProxyWriteInput` as a new proxy needs it. */
export function parseProxyCreate(value: unknown): ProxyFields {
  const raw = checkedKeys(value, []);
  const patch = patchOf(raw);
  if (patch.name === undefined) throw new ProxyError("proxy_name_invalid");
  if (patch.protocol === undefined) throw new ProxyError("proxy_protocol_invalid");
  if (patch.host === undefined) throw new ProxyError("proxy_host_invalid");
  if (patch.port === undefined) throw new ProxyError("proxy_port_invalid");
  const fields: ProxyFields = { active: patch.active ?? true, country: patch.country ?? null, domainHints: patch.domainHints ?? [],
    host: patch.host, login: patch.login ?? null, name: patch.name, password: patch.password ?? null, port: patch.port, protocol: patch.protocol };
  assertProxyCredentials({ hasLogin: fields.login !== null, hasPassword: fields.password !== null });
  return fields;
}

/** The fields of an update; what is absent stays as it is. */
export function parseProxyPatch(value: unknown): ProxyPatch {
  return patchOf(checkedKeys(value, []));
}

export function parseProxyVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new ProxyError("proxy_input_invalid");
  return value as number;
}

/** `ProxyUpdateInput`, whose `expectedVersion` guards the whole change. */
export function parseProxyUpdate(value: unknown): Readonly<{ expectedVersion: number; patch: ProxyPatch }> {
  const raw = checkedKeys(value, ["expectedVersion"]);
  const { expectedVersion, ...fields } = raw;
  return { expectedVersion: parseProxyVersion(expectedVersion), patch: patchOf(fields) };
}

const PROXY_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** An id that cannot be one reads as a missing proxy. */
export function isProxyId(value: unknown): value is string {
  return typeof value === "string" && PROXY_ID.test(value);
}

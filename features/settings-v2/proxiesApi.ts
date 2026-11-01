import {
  PROXY_ROUTES,
  isProxyCheckStatus,
  isProxyOwner,
  isProxyPort,
  isProxyProtocol,
  type ProxyCheckResult,
  type ProxyDeleteInput,
  type ProxySharedWire,
  type ProxyUpdateInput,
  type ProxyWire,
  type ProxyWriteInput
} from "@/lib/contracts/proxies";

/** Whose list a panel shows: the caller's own, or the administrators' in the Control Center. */
export type ProxyAudience = "administrator" | "personal";

/** The stable code of a refused request; `proxyMessages.ts` owns its words. */
export class ProxyRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProxyRequestError";
  }
}

export const PROXY_NETWORK_FAILURE = "network_failed";
export const PROXY_MALFORMED_RESPONSE = "malformed_response";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

function decodeCheck(value: unknown): ProxyCheckResult | null {
  if (!isRecord(value) || typeof value.checkedAt !== "string" || !isStringOrNull(value.exitAddress) || !isProxyCheckStatus(value.status)) return null;
  return { checkedAt: value.checkedAt, exitAddress: value.exitAddress, status: value.status };
}

/** Field by field, so nothing a response adds reaches the view. */
function decodeProxy(value: unknown): ProxyWire | null {
  if (!isRecord(value) || typeof value.active !== "boolean" || !isStringOrNull(value.country) || !isStringList(value.domainHints) ||
    typeof value.hasPassword !== "boolean" || typeof value.host !== "string" || typeof value.id !== "string" || !isStringOrNull(value.login) ||
    typeof value.name !== "string" || !isProxyOwner(value.owner) || !isProxyPort(value.port) || !isProxyProtocol(value.protocol) ||
    !Number.isSafeInteger(value.version)) return null;
  const lastCheck = value.lastCheck === null ? null : decodeCheck(value.lastCheck);
  if (value.lastCheck !== null && lastCheck === null) return null;
  return { active: value.active, country: value.country, domainHints: value.domainHints, hasPassword: value.hasPassword, host: value.host,
    id: value.id, lastCheck, login: value.login, name: value.name, owner: value.owner, port: value.port, protocol: value.protocol,
    version: value.version as number };
}

function decodeShared(value: unknown): ProxySharedWire | null {
  if (!isRecord(value) || typeof value.active !== "boolean" || !isStringOrNull(value.country) || !isStringList(value.domainHints) ||
    typeof value.id !== "string" || typeof value.name !== "string" || !isProxyProtocol(value.protocol)) return null;
  return { active: value.active, country: value.country, domainHints: value.domainHints, id: value.id, name: value.name, owner: "administrator",
    protocol: value.protocol };
}

function decodeAll<Item>(value: unknown, decode: (item: unknown) => Item | null): readonly Item[] {
  if (!Array.isArray(value)) throw new ProxyRequestError(PROXY_MALFORMED_RESPONSE);
  return value.map((item) => {
    const decoded = decode(item);
    if (decoded === null) throw new ProxyRequestError(PROXY_MALFORMED_RESPONSE);
    return decoded;
  });
}

async function send(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ProxyRequestError(PROXY_NETWORK_FAILURE);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ProxyRequestError(isRecord(body) && typeof body.error === "string" ? body.error : PROXY_NETWORK_FAILURE);
  if (!isRecord(body)) throw new ProxyRequestError(PROXY_MALFORMED_RESPONSE);
  return body;
}

const json = (method: string, body: unknown): RequestInit => ({ body: JSON.stringify(body), headers: { "content-type": "application/json" }, method });

function proxyOf(body: Record<string, unknown>): ProxyWire {
  const proxy = decodeProxy(body.proxy);
  if (proxy === null) throw new ProxyRequestError(PROXY_MALFORMED_RESPONSE);
  return proxy;
}

const itemRoute = (audience: ProxyAudience, id: string) =>
  audience === "administrator" ? PROXY_ROUTES.administratorItem(id) : PROXY_ROUTES.personalItem(id);

export type ProxyLists = Readonly<{ proxies: readonly ProxyWire[]; shared: readonly ProxySharedWire[] }>;

/** The administrator list has no second part: an administrator manages those rows. */
export async function listProxies(audience: ProxyAudience, signal?: AbortSignal): Promise<ProxyLists> {
  const body = await send(audience === "administrator" ? PROXY_ROUTES.administrator : PROXY_ROUTES.personal, signal ? { signal } : {});
  return { proxies: decodeAll(body.proxies, decodeProxy), shared: audience === "administrator" ? [] : decodeAll(body.shared, decodeShared) };
}

export async function createProxy(audience: ProxyAudience, input: ProxyWriteInput): Promise<ProxyWire> {
  return proxyOf(await send(audience === "administrator" ? PROXY_ROUTES.administrator : PROXY_ROUTES.personal, json("POST", input)));
}

export async function updateProxy(audience: ProxyAudience, id: string, input: ProxyUpdateInput): Promise<ProxyWire> {
  return proxyOf(await send(itemRoute(audience, id), json("PATCH", input)));
}

export async function deleteProxy(audience: ProxyAudience, id: string, input: ProxyDeleteInput): Promise<void> {
  await send(itemRoute(audience, id), json("DELETE", input));
}

export async function checkProxy(audience: ProxyAudience, id: string, signal: AbortSignal): Promise<ProxyWire> {
  const route = audience === "administrator" ? PROXY_ROUTES.administratorCheck(id) : PROXY_ROUTES.personalCheck(id);
  const body = await send(route, { method: "POST", signal });
  if (decodeCheck(body.check) === null) throw new ProxyRequestError(PROXY_MALFORMED_RESPONSE);
  return proxyOf(body);
}

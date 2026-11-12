import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { Agent, WebSocket as UndiciWebSocket } from "undici";
import { DISCORD_BOT_TOKEN_PATTERN } from "../../contracts/discord";
import { isTestModeAllowedEnv } from "../auth/csrf";
import {
  addressesAllowed, createPinnedHttpsExchange, multipartBody, resolveHostAddresses, type PinnedAddress,
  type PinnedAddressScope, type PinnedBody, type PinnedExchangeResult, type PinnedHttpsFailureCategory,
  type PinnedRequestFactory, type PinnedResolve
} from "../connectors/pinnedHttps";
import { networkAddressScope } from "../mcp/safeFetch";
import {
  DISCORD_API_ORIGIN_INVALID_CODE, DISCORD_CONNECT_ADDRESS_INVALID_CODE, DISCORD_REQUEST_INVALID_CODE
} from "./codes";

/**
 * Discord's network edge: REST and CDN over the shared pinned HTTPS exchange,
 * and the gateway WebSocket through one undici dispatcher, all limited to the
 * Discord host allowlist, HTTPS/WSS only and no redirects. With
 * `AIQSA_DISCORD_CONNECT_ADDRESS` every allowlisted host connects to that one
 * public address while SNI, Host and certificate stay Discord's (PRD D-03).
 *
 * The bot token travels only in the `Authorization: Bot` header and CDN URLs
 * carry signatures, so no URL, path, query, header or Discord error text
 * leaves this module: failures are a closed kind, status and category.
 */

export const DISCORD_API_HOST = "discord.com";
export const DISCORD_API_PATH = "/api/v10";
export const DISCORD_GATEWAY_HOST = "gateway.discord.gg";
export const DISCORD_CDN_HOSTS = Object.freeze(["cdn.discordapp.com", "media.discordapp.net"]);
export const DISCORD_REST_TIMEOUT_MS = 15_000;
export const DISCORD_CDN_TIMEOUT_MS = 60_000;
export const DISCORD_JSON_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const DISCORD_JSON_REQUEST_MAX_BYTES = 1024 * 1024;
export const DISCORD_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const DISCORD_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const DISCORD_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const DISCORD_UPLOAD_FILES_MAX = 10;
/** Largest gateway frame AIQSA reads; a guild's GUILD_CREATE is the largest expected. */
export const DISCORD_GATEWAY_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const DISCORD_GATEWAY_CONNECT_TIMEOUT_MS = 15_000;
const USER_AGENT = "DiscordBot (https://github.com/insciqq/AIQSA, 1.0)";

export type DiscordTransportFailure = Readonly<{
  ok: false;
  kind: "network_before_send" | "network_after_send" | "timeout" | "too_large" | "redirect" | "forbidden_host" | "http";
  status?: number;
  category?: PinnedHttpsFailureCategory;
}>;

/** The rate-limit facts of one response (`X-RateLimit-*`, `Retry-After`). */
export type DiscordRateLimitHeaders = Readonly<{
  bucket?: string;
  limit?: number;
  remaining?: number;
  resetAfterMs?: number;
  scope?: "user" | "global" | "shared";
  global?: boolean;
  retryAfterMs?: number;
}>;

export type DiscordHttpResponse = Readonly<{
  ok: true;
  status: number;
  rateLimit: DiscordRateLimitHeaders;
  /** The parsed JSON body; `undefined` for an empty or non-JSON body. Never logged. */
  json: unknown;
}>;
export type DiscordHttpResult = DiscordHttpResponse | DiscordTransportFailure;
export type DiscordDownloadResult = Readonly<{ ok: true; body: Buffer; contentType?: string }> | DiscordTransportFailure;

export type DiscordUploadFile = Readonly<{ filename: string; contentType: string }>
  & (Readonly<{ data: Buffer }> | Readonly<{ stream: Readable; size: number }>);

export type DiscordRestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type DiscordTransport = Readonly<{
  /**
   * One REST call under `/api/v10` with the 15 s deadline and a 4 MiB
   * response. `files` sends multipart with `payload_json`; every HTTP status
   * comes back as a response for the REST client to judge, except redirects.
   */
  request(input: Readonly<{
    token: string;
    method: DiscordRestMethod;
    path: string;
    query?: Readonly<Record<string, string | number>>;
    json?: unknown;
    files?: readonly DiscordUploadFile[];
  }>): Promise<DiscordHttpResult>;
  /** Downloads a signed CDN URL (≤ 20 MiB unless lower), 60 s deadline, cut off above the cap; no token. */
  download(input: Readonly<{ url: string; maxBytes?: number }>): Promise<DiscordDownloadResult>;
}>;

export class DiscordTransportConfigError extends Error {
  constructor(readonly code:
    | typeof DISCORD_API_ORIGIN_INVALID_CODE | typeof DISCORD_REQUEST_INVALID_CODE | typeof DISCORD_CONNECT_ADDRESS_INVALID_CODE) {
    super(code);
    this.name = "DiscordTransportConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** Lower-case DNS labels of letters, digits and hyphens. */
const HOST_LABELS = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

/** `discord.com`, `gateway.discord.gg` and any `*.discord.gg`, the two CDN hosts; nothing else. */
export function isDiscordHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!HOST_LABELS.test(host)) return false;
  return host === DISCORD_API_HOST || host === DISCORD_GATEWAY_HOST || host.endsWith(".discord.gg")
    || DISCORD_CDN_HOSTS.includes(host);
}

/**
 * The optional egress address: one public IPv4 or IPv6 literal. Unset or
 * blank means system DNS; anything else invalid stops the connector at start.
 */
export function parseDiscordConnectAddress(value: string | undefined): PinnedAddress | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const literal = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const family = isIP(literal);
  if ((family !== 4 && family !== 6) || networkAddressScope(literal) !== "public") {
    throw new DiscordTransportConfigError(DISCORD_CONNECT_ADDRESS_INVALID_CODE);
  }
  return { address: literal, family };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export type DiscordNetwork = Readonly<{
  /** `AIQSA_TEST_MODE=1` outside production: loopback fakes are allowed. */
  testMode: boolean;
  /** Test mode only: every allowlisted host is served by this loopback origin. */
  apiOrigin: URL | null;
  /** Test mode only: the loopback gateway URL that replaces Discord's for IDENTIFY. */
  gatewayUrl: URL | null;
  egress: PinnedAddress | null;
}>;

function loopbackUrl(value: string, protocols: readonly string[]): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new DiscordTransportConfigError(DISCORD_API_ORIGIN_INVALID_CODE); }
  if (url.username || url.password || url.hash || !protocols.includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new DiscordTransportConfigError(DISCORD_API_ORIGIN_INVALID_CODE);
  }
  return url;
}

/**
 * The network settings: `AIQSA_DISCORD_CONNECT_ADDRESS` always, and the
 * loopback `AIQSA_DISCORD_API_ORIGIN` and `AIQSA_DISCORD_GATEWAY_URL` only in
 * test mode (PRD D-31); outside test mode they are ignored.
 */
export function resolveDiscordNetwork(env: Env = process.env): DiscordNetwork {
  const testMode = isTestModeAllowedEnv(env);
  const origin = testMode ? env.AIQSA_DISCORD_API_ORIGIN?.trim() : undefined;
  const gateway = testMode ? env.AIQSA_DISCORD_GATEWAY_URL?.trim() : undefined;
  const apiOrigin = origin ? loopbackUrl(origin, ["http:", "https:"]) : null;
  if (apiOrigin && (apiOrigin.pathname !== "/" || apiOrigin.search)) throw new DiscordTransportConfigError(DISCORD_API_ORIGIN_INVALID_CODE);
  return {
    testMode,
    apiOrigin,
    gatewayUrl: gateway ? loopbackUrl(gateway, ["ws:", "wss:"]) : null,
    egress: parseDiscordConnectAddress(env.AIQSA_DISCORD_CONNECT_ADDRESS)
  };
}

function bare(hostname: string): string {
  return hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
}

/** Where a connection to `hostname` goes: the test origin, the egress address or DNS, and the allowed scope. */
function routeFor(network: DiscordNetwork, hostname: string, resolve: PinnedResolve): Readonly<{
  hostname: string; port: number | string; secure: boolean; scope: PinnedAddressScope; resolve: PinnedResolve;
}> {
  if (network.apiOrigin) {
    const secure = network.apiOrigin.protocol === "https:";
    return {
      hostname: bare(network.apiOrigin.hostname), port: network.apiOrigin.port || (secure ? 443 : 80), secure,
      scope: "loopback", resolve
    };
  }
  const egress = network.egress;
  return { hostname, port: 443, secure: true, scope: "public", resolve: egress ? async () => [egress] : resolve };
}

/** Commands and interactions belong to the other service on a shared application (PRD D-06). */
const FORBIDDEN_ROUTE = /(?:^|\/)(?:commands|interactions)(?:\/|$)|^\/applications\/[^/]+\/(?:guilds\/[^/]+\/)?commands/u;
const PATH_PATTERN = /^\/(?:[A-Za-z0-9@._~%:-]+)(?:\/[A-Za-z0-9@._~%:-]+)*$/u;
const QUERY_KEY = /^[a-z_]{1,32}$/u;

/** A REST path AIQSA may call: safe characters, no dot segments, never commands or interactions. */
export function isDiscordRestPathAllowed(path: string): boolean {
  return path.length <= 512 && PATH_PATTERN.test(path) && !path.split("/").some((segment) => segment === "." || segment === "..")
    && !FORBIDDEN_ROUTE.test(path.toLowerCase());
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function seconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,6}(?:\.\d{1,6})?$/u.test(value)) return undefined;
  return Math.round(Number(value) * 1_000);
}

/** The rate-limit facts of a response's headers; malformed values are dropped. */
export function discordRateLimitHeaders(headers: Readonly<Record<string, string | string[] | undefined>>): DiscordRateLimitHeaders {
  const bucket = header(headers["x-ratelimit-bucket"]);
  const limit = header(headers["x-ratelimit-limit"]);
  const remaining = header(headers["x-ratelimit-remaining"]);
  const scope = header(headers["x-ratelimit-scope"]);
  return {
    ...(bucket && /^[A-Za-z0-9:_-]{1,128}$/u.test(bucket) ? { bucket } : {}),
    ...(limit && /^\d{1,6}$/u.test(limit) ? { limit: Number(limit) } : {}),
    ...(remaining && /^\d{1,6}$/u.test(remaining) ? { remaining: Number(remaining) } : {}),
    ...(seconds(header(headers["x-ratelimit-reset-after"])) !== undefined
      ? { resetAfterMs: seconds(header(headers["x-ratelimit-reset-after"])) } : {}),
    ...(scope === "user" || scope === "global" || scope === "shared" ? { scope } : {}),
    ...(header(headers["x-ratelimit-global"]) === "true" ? { global: true } : {}),
    ...(seconds(header(headers["retry-after"])) !== undefined ? { retryAfterMs: seconds(header(headers["retry-after"])) } : {})
  };
}

function parseJson(body: Buffer): unknown {
  if (body.length === 0) return undefined;
  try { return JSON.parse(body.toString("utf8")); } catch { return undefined; }
}

function fromExchange(result: PinnedExchangeResult): DiscordHttpResult {
  if (!result.ok) return result;
  if (result.status >= 300 && result.status < 400) return { ok: false, kind: "redirect", status: result.status };
  return { ok: true, status: result.status, rateLimit: discordRateLimitHeaders(result.headers), json: parseJson(result.body) };
}

export function createDiscordTransport(options: Readonly<{
  network?: DiscordNetwork;
  env?: Env;
  resolve?: PinnedResolve;
  request?: PinnedRequestFactory;
  now?: () => number;
}> = {}): DiscordTransport {
  const network = options.network ?? resolveDiscordNetwork(options.env);
  const resolve = options.resolve ?? resolveHostAddresses;

  function send(hostname: string, spec: Readonly<{
    method: DiscordRestMethod; path: string; headers: Readonly<Record<string, string>>; body?: PinnedBody;
    timeoutMs: number; maxResponseBytes: number;
  }>): Promise<PinnedExchangeResult> {
    const route = routeFor(network, hostname, resolve);
    return createPinnedHttpsExchange({ resolve: route.resolve, request: options.request, now: options.now })({
      ...spec, hostname: route.hostname, port: route.port, secure: route.secure, allowedScope: route.scope
    });
  }

  return Object.freeze({
    request: async ({ token, method, path, query, json, files }) => {
      if (!DISCORD_BOT_TOKEN_PATTERN.test(token) || !isDiscordRestPathAllowed(path)) {
        files?.forEach((file) => { if ("stream" in file) file.stream.destroy(); });
        throw new DiscordTransportConfigError(DISCORD_REQUEST_INVALID_CODE);
      }
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(query ?? {})) {
        if (!QUERY_KEY.test(key)) throw new DiscordTransportConfigError(DISCORD_REQUEST_INVALID_CODE);
        search.set(key, String(value));
      }
      const queryString = search.toString();
      const fullPath = `${DISCORD_API_PATH}${path}${queryString ? `?${queryString}` : ""}`;
      const headers: Record<string, string> = { authorization: `Bot ${token}`, "user-agent": USER_AGENT };
      let body: PinnedBody | undefined;
      if (files && files.length > 0) {
        const destroy = () => files.forEach((file) => { if ("stream" in file) file.stream.destroy(); });
        const sizes = files.map((file) => "data" in file ? file.data.length : file.size);
        if (files.length > DISCORD_UPLOAD_FILES_MAX || sizes.some((size) => !Number.isSafeInteger(size) || size < 0)) {
          destroy();
          throw new DiscordTransportConfigError(DISCORD_REQUEST_INVALID_CODE);
        }
        if (sizes.some((size) => size > DISCORD_FILE_MAX_BYTES) || sizes.reduce((sum, size) => sum + size, 0) > DISCORD_UPLOAD_MAX_BYTES) {
          destroy();
          return { ok: false, kind: "too_large" };
        }
        const payload = JSON.stringify(json ?? {});
        if (Buffer.byteLength(payload) > DISCORD_JSON_REQUEST_MAX_BYTES) { destroy(); return { ok: false, kind: "too_large" }; }
        const multipart = multipartBody({
          label: "discord", fields: [["payload_json", payload]],
          files: files.map((file, index) => ({ ...file, field: `files[${index}]` })),
          fieldName: /^(?:payload_json|files\[[0-9]\])$/u
        });
        if (!multipart) { destroy(); throw new DiscordTransportConfigError(DISCORD_REQUEST_INVALID_CODE); }
        if (multipart.body.length > DISCORD_UPLOAD_MAX_BYTES + DISCORD_JSON_REQUEST_MAX_BYTES) { destroy(); return { ok: false, kind: "too_large" }; }
        body = multipart.body;
        headers["content-type"] = multipart.contentType;
      } else if (json !== undefined) {
        const buffer = Buffer.from(JSON.stringify(json), "utf8");
        if (buffer.length > DISCORD_JSON_REQUEST_MAX_BYTES) return { ok: false, kind: "too_large" };
        body = { parts: [buffer], length: buffer.length };
        headers["content-type"] = "application/json";
      }
      return fromExchange(await send(DISCORD_API_HOST, {
        method, path: fullPath, headers, ...(body ? { body } : {}),
        timeoutMs: DISCORD_REST_TIMEOUT_MS, maxResponseBytes: DISCORD_JSON_RESPONSE_MAX_BYTES
      }));
    },
    download: async ({ url, maxBytes }) => {
      let parsed: URL;
      try { parsed = new URL(url); } catch { return { ok: false, kind: "forbidden_host" }; }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port
        || !DISCORD_CDN_HOSTS.includes(parsed.hostname) || url.length > 4096) {
        return { ok: false, kind: "forbidden_host" };
      }
      const cap = Math.min(maxBytes ?? DISCORD_DOWNLOAD_MAX_BYTES, DISCORD_DOWNLOAD_MAX_BYTES);
      const result = await send(parsed.hostname, {
        method: "GET", path: `${parsed.pathname}${parsed.search}`, headers: { "user-agent": USER_AGENT },
        timeoutMs: DISCORD_CDN_TIMEOUT_MS, maxResponseBytes: cap
      });
      if (!result.ok) return result;
      if (result.status >= 300 && result.status < 400) return { ok: false, kind: "redirect", status: result.status };
      if (result.status !== 200) return { ok: false, kind: "http", status: result.status };
      const contentType = header(result.headers["content-type"]);
      return { ok: true, body: result.body, ...(contentType && contentType.length <= 128 ? { contentType } : {}) };
    }
  });
}

// ---------------------------------------------------------------------------
// Gateway

/**
 * The gateway URL to connect to, `?v=10&encoding=json` with no compression:
 * `wss://` on `gateway.discord.gg` or a `*.discord.gg` session host, path and
 * query replaced. In test mode a loopback `ws:`/`wss:` URL with a port is
 * also accepted (the fake's resume host). `null` refuses the URL.
 */
export function discordGatewayUrl(raw: string, network: Pick<DiscordNetwork, "testMode">): URL | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password || url.hash) return null;
  const loopback = network.testMode && LOOPBACK_HOSTS.has(url.hostname) && (url.protocol === "ws:" || url.protocol === "wss:");
  if (!loopback) {
    if (url.protocol !== "wss:" || url.port || !isDiscordHostAllowed(url.hostname)) return null;
    const host = url.hostname.toLowerCase();
    if (host !== DISCORD_GATEWAY_HOST && !host.endsWith(".discord.gg")) return null;
  }
  const normalized = new URL(`${url.protocol}//${url.host}/`);
  normalized.searchParams.set("v", "10");
  normalized.searchParams.set("encoding", "json");
  return normalized;
}

/** A content-free connection refusal: the code names only the class. */
function lookupError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error("The Discord connection address was refused."), { code });
}

/**
 * The `lookup` for gateway connections: an allowlisted host resolves to the
 * egress address or to DNS addresses that are all public; in test mode a
 * loopback host resolves to loopback addresses only. Node then connects with
 * SNI and Host of the original host name.
 */
export function discordConnectLookup(network: DiscordNetwork, resolve: PinnedResolve = resolveHostAddresses): LookupFunction {
  return (hostname, options, callback) => {
    const host = bare(hostname).toLowerCase();
    const loopback = network.testMode && LOOPBACK_HOSTS.has(host === "::1" ? "[::1]" : host);
    const reply = (addresses: readonly PinnedAddress[]) => {
      if (options.all) callback(null, addresses.map((entry) => ({ address: entry.address, family: entry.family })));
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    };
    if (!loopback && !isDiscordHostAllowed(host)) {
      setImmediate(() => callback(lookupError("ERR_DISCORD_HOST_FORBIDDEN"), ""));
      return;
    }
    if (!loopback && network.egress) {
      const egress = network.egress;
      setImmediate(() => reply([egress]));
      return;
    }
    const scope: PinnedAddressScope = loopback ? "loopback" : "public";
    resolve(host).then((addresses) => {
      if (!addressesAllowed(addresses, scope)) callback(lookupError("ERR_DISCORD_ADDRESS_FORBIDDEN"), "");
      else reply(addresses);
    }, () => callback(lookupError("ENOTFOUND"), ""));
  };
}

/** The subset of the WHATWG WebSocket the gateway client uses; the fake implements it in memory. */
export type DiscordWebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
};
export type DiscordWebSocketFactory = (url: URL) => DiscordWebSocketLike;

/**
 * Opens a gateway WebSocket through its own undici dispatcher: the pinned
 * lookup above, a connect deadline, a bounded frame size and no redirects
 * (the WebSocket handshake never follows them). The dispatcher closes with
 * the socket.
 */
export function openDiscordWebSocket(
  url: URL,
  network: DiscordNetwork,
  deps: Readonly<{
    lookup?: LookupFunction;
    Agent?: new (options: Agent.Options) => Pick<Agent, "close">;
    WebSocket?: new (url: string, init: { dispatcher: never }) => DiscordWebSocketLike;
  }> = {}
): DiscordWebSocketLike {
  const AgentClass = deps.Agent ?? Agent;
  const SocketClass = deps.WebSocket ?? (UndiciWebSocket as unknown as new (url: string, init: { dispatcher: never }) => DiscordWebSocketLike);
  const dispatcher = new AgentClass({
    connect: { lookup: deps.lookup ?? discordConnectLookup(network), timeout: DISCORD_GATEWAY_CONNECT_TIMEOUT_MS },
    webSocket: { maxPayloadSize: DISCORD_GATEWAY_MAX_PAYLOAD_BYTES }
  } as Agent.Options);
  const socket = new SocketClass(url.href, { dispatcher: dispatcher as never });
  socket.addEventListener("close", () => { void dispatcher.close().catch(() => undefined); });
  return socket;
}

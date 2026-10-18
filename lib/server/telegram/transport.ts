import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { TELEGRAM_BOT_TOKEN_PATTERN } from "../../contracts/telegram";
import { isTestModeAllowedEnv } from "../auth/csrf";
import { networkAddressScope, pinnedAddressLookup } from "../mcp/safeFetch";
import { TELEGRAM_API_ORIGIN_INVALID_CODE, TELEGRAM_REQUEST_INVALID_CODE } from "./codes";

/**
 * The Bot API transport: HTTPS to one configured origin, addresses resolved
 * once per call and all proved public, every connection pinned to them, no
 * shared agent, one deadline per call and bounded bodies. The bot token is
 * part of every request path, so no URL, path, raw error or Telegram
 * description ever leaves this module except as the closed outcome below,
 * whose `description` callers may branch on but never log or show.
 */

export const TELEGRAM_DEFAULT_API_ORIGIN = "https://api.telegram.org";
export const TELEGRAM_JSON_TIMEOUT_MS = 15_000;
/** A long poll's deadline is its poll timeout plus this grace. */
export const TELEGRAM_LONG_POLL_GRACE_MS = 10_000;
export const TELEGRAM_LONG_POLL_MAX_SECONDS = 50;
export const TELEGRAM_FILE_TIMEOUT_MS = 60_000;
export const TELEGRAM_JSON_RESPONSE_MAX_BYTES = 1024 * 1024;
export const TELEGRAM_JSON_REQUEST_MAX_BYTES = 1024 * 1024;
export const TELEGRAM_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const DESCRIPTION_MAX_LENGTH = 512;
const RETRY_AFTER_MAX_SECONDS = 24 * 60 * 60;

export type TelegramFailureKind = "http" | "telegram" | "network_before_send" | "network_after_send" | "timeout" | "too_large";
/** Content-free detail of a failure; safe to log. */
export type TelegramFailureCategory =
  | "dns" | "connect" | "tls" | "timeout" | "reset" | "network_unreachable" | "forbidden_address"
  | "upload_source" | "invalid_response" | "unknown";

/**
 * A failed call. Only `network_before_send` is safe to repeat: no request byte
 * reached Telegram. `timeout` and `network_after_send` are ambiguous.
 * `too_large` without `status` is a request refused before sending; with a
 * status it is a response over its bound. `telegram` is Telegram's own
 * refusal (`errorCode`, and `retryAfter` seconds for 429).
 */
export type TelegramFailure = Readonly<{
  ok: false;
  kind: TelegramFailureKind;
  status?: number;
  errorCode?: number;
  retryAfter?: number;
  category?: TelegramFailureCategory;
  /** Telegram's own text, bounded; never logged, thrown or shown to users. */
  description?: string;
}>;
export type TelegramOutcome<T> = Readonly<{ ok: true; result: T }> | TelegramFailure;

export type TelegramUploadFile = Readonly<{
  /** The multipart field Telegram reads the file from (`document`, `photo`). */
  field: string;
  filename: string;
  contentType: string;
}> & (Readonly<{ data: Buffer }> | Readonly<{ stream: Readable; size: number }>);

export type TelegramTransport = Readonly<{
  /** One JSON method call with the 15 s deadline and a 1 MiB response. */
  call(input: Readonly<{ token: string; method: string; params?: Readonly<Record<string, unknown>> }>): Promise<TelegramOutcome<unknown>>;
  /** A long poll (`getUpdates`): its deadline is the poll timeout plus 10 s. */
  longPoll(input: Readonly<{
    token: string; method: string; params?: Readonly<Record<string, unknown>>; pollTimeoutSeconds: number;
  }>): Promise<TelegramOutcome<unknown>>;
  /** A multipart upload of one file (≤ 50 MiB) with string fields, 60 s deadline. */
  upload(input: Readonly<{
    token: string; method: string; fields: Readonly<Record<string, string>>; file: TelegramUploadFile;
  }>): Promise<TelegramOutcome<unknown>>;
  /** Downloads a `getFile` path (≤ 20 MiB unless lower), 60 s deadline, cut off above the cap. */
  download(input: Readonly<{ token: string; filePath: string; maxBytes?: number }>): Promise<TelegramOutcome<Buffer>>;
}>;

export class TelegramTransportConfigError extends Error {
  constructor(readonly code: typeof TELEGRAM_API_ORIGIN_INVALID_CODE | typeof TELEGRAM_REQUEST_INVALID_CODE) {
    super(code);
    this.name = "TelegramTransportConfigError";
  }
}

type ResolvedAddress = Readonly<{ address: string; family: 4 | 6 }>;
type RequestFactory = (options: RequestOptions, response: (incoming: IncomingMessage) => void) => ClientRequest;
type Env = Readonly<Record<string, string | undefined>>;

export type TelegramApiOrigin = Readonly<{ url: URL; loopback: boolean }>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

/**
 * The Bot API origin: the explicit one, else `AIQSA_TELEGRAM_API_ORIGIN` only
 * in test mode (a loopback fake), else Telegram. Plain HTTP and loopback
 * addresses exist only in test mode.
 */
export function resolveTelegramApiOrigin(input: Readonly<{ origin?: string; env?: Env }> = {}): TelegramApiOrigin {
  const env = input.env ?? process.env;
  const testMode = isTestModeAllowedEnv(env);
  const override = testMode ? env.AIQSA_TELEGRAM_API_ORIGIN?.trim() : undefined;
  const value = input.origin ?? (override || TELEGRAM_DEFAULT_API_ORIGIN);
  let url: URL;
  try { url = new URL(value); } catch { throw new TelegramTransportConfigError(TELEGRAM_API_ORIGIN_INVALID_CODE); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || value.replace(/\/$/u, "") !== url.origin) {
    throw new TelegramTransportConfigError(TELEGRAM_API_ORIGIN_INVALID_CODE);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (loopback ? !testMode : url.protocol !== "https:") throw new TelegramTransportConfigError(TELEGRAM_API_ORIGIN_INVALID_CODE);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TelegramTransportConfigError(TELEGRAM_API_ORIGIN_INVALID_CODE);
  return { url, loopback };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Maps one Bot API HTTP response to an outcome; shared with the test fake. */
export function telegramOutcomeFromResponse(status: number, body: Buffer | string): TelegramOutcome<unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(typeof body === "string" ? body : body.toString("utf8")); } catch { parsed = undefined; }
  const envelope = record(parsed);
  if (envelope?.ok === true && Object.hasOwn(envelope, "result") && status >= 200 && status < 300) {
    return { ok: true, result: envelope.result };
  }
  if (envelope?.ok === false && Number.isSafeInteger(envelope.error_code)) {
    const retryAfter = record(envelope.parameters)?.retry_after;
    return {
      ok: false, kind: "telegram", status, errorCode: envelope.error_code as number,
      ...(Number.isSafeInteger(retryAfter) && (retryAfter as number) >= 0
        ? { retryAfter: Math.min(retryAfter as number, RETRY_AFTER_MAX_SECONDS) } : {}),
      ...(typeof envelope.description === "string" ? { description: envelope.description.slice(0, DESCRIPTION_MAX_LENGTH) } : {})
    };
  }
  return { ok: false, kind: "http", status, ...(status >= 200 && status < 300 ? { category: "invalid_response" as const } : {}) };
}

function failureCategory(error: unknown): TelegramFailureCategory {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (typeof code !== "string") return "unknown";
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(code)) return "dns";
  if (["ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EHOSTDOWN"].includes(code)) return "network_unreachable";
  if (["ECONNREFUSED", "EADDRNOTAVAIL"].includes(code)) return "connect";
  if (code === "ETIMEDOUT") return "timeout";
  if (["ECONNRESET", "ECONNABORTED", "EPIPE"].includes(code)) return "reset";
  if (code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_") || code.startsWith("CERT_") || [
    "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
  ].includes(code)) return "tls";
  return "unknown";
}

async function defaultResolve(hostname: string): Promise<readonly ResolvedAddress[]> {
  const family = isIP(hostname);
  if (family === 4 || family === 6) return [{ address: hostname, family }];
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
}

type Body = Readonly<{ parts: readonly (Buffer | Readable)[]; length: number }>;
type Exchange = Readonly<{
  method: "GET" | "POST"; path: string; headers: Readonly<Record<string, string>>; body?: Body;
  timeoutMs: number; maxResponseBytes: number;
}>;
type ExchangeResult = Readonly<{ ok: true; status: number; body: Buffer }> | TelegramFailure;

const CONNECT_RETRY_CATEGORIES: readonly TelegramFailureCategory[] = ["connect", "network_unreachable", "timeout", "reset"];

function before(category: TelegramFailureCategory): TelegramFailure {
  return { ok: false, kind: "network_before_send", category };
}

function multipartSafe(value: string, max: number): string {
  return value.replace(/["\\\r\n\u0000-\u001f\u007f]/gu, "_").slice(0, max) || "file";
}

function multipartBody(
  fields: Readonly<Record<string, string>>, file: TelegramUploadFile
): Readonly<{ body: Body; contentType: string }> | undefined {
  const boundary = `----aiqsa-telegram-${randomBytes(16).toString("hex")}`;
  const head: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (!/^[a-z_]{1,64}$/u.test(name)) return undefined;
    head.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  if (!/^[a-z_]{1,64}$/u.test(file.field)) return undefined;
  const contentType = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/u.test(file.contentType)
    ? file.contentType : "application/octet-stream";
  head.push(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${multipartSafe(file.filename, 200)}"\r\n`
    + `Content-Type: ${contentType}\r\n\r\n`);
  const prefix = Buffer.from(head.join(""), "utf8");
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const size = "data" in file ? file.data.length : file.size;
  return {
    body: { parts: [prefix, "data" in file ? file.data : file.stream, suffix], length: prefix.length + size + suffix.length },
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

export function createTelegramTransport(options: Readonly<{
  resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  request?: RequestFactory;
  now?: () => number;
  origin?: string;
  env?: Env;
}> = {}): TelegramTransport {
  const origin = resolveTelegramApiOrigin({ origin: options.origin, env: options.env });
  const resolve = options.resolve ?? defaultResolve;
  const secure = origin.url.protocol === "https:";
  const request = options.request ?? (secure ? httpsRequest : httpRequest);
  const now = options.now ?? (() => performance.now());
  const hostname = origin.url.hostname.startsWith("[") ? origin.url.hostname.slice(1, -1) : origin.url.hostname;
  const port = origin.url.port || (secure ? 443 : 80);
  const allowedScope = origin.loopback ? "loopback" : "public";

  function exchange(spec: Exchange): Promise<ExchangeResult> {
    return new Promise((settle) => {
      const deadline = now() + spec.timeoutMs;
      let finished = false;
      let sent = false;
      let cancelAttempt = () => {};
      const timer = setTimeout(() => finish(sent ? { ok: false, kind: "timeout" } : before("timeout")), spec.timeoutMs);
      function finish(result: ExchangeResult): void {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        cancelAttempt();
        for (const part of spec.body?.parts ?? []) if (!Buffer.isBuffer(part) && result.ok === false) part.destroy();
        settle(result);
      }

      function attempt(addresses: readonly ResolvedAddress[], index: number): void {
        if (finished) return;
        const remaining = deadline - now();
        if (remaining <= 0) return finish(before("timeout"));
        const pinned = addresses[index]!;
        let phase: "connect" | "tls" | "sending" | "response" = "connect";
        let ended = false;
        let outgoing: ClientRequest | undefined;
        const connectTimer = setTimeout(() => fail("timeout"), Math.max(1, remaining / (addresses.length - index)));
        cancelAttempt = () => {
          if (ended) return;
          ended = true;
          clearTimeout(connectTimer);
          outgoing?.destroy();
        };
        function fail(category: TelegramFailureCategory): void {
          if (ended || finished) return;
          cancelAttempt();
          if (phase === "connect" && CONNECT_RETRY_CATEGORIES.includes(category) && index + 1 < addresses.length) {
            attempt(addresses, index + 1);
          } else if (phase === "sending" || phase === "response") {
            finish({ ok: false, kind: "network_after_send", category });
          } else {
            finish(before(category));
          }
        }
        async function writeBody(target: ClientRequest): Promise<void> {
          // Marked before the first write: even a synchronous failure is ambiguous.
          phase = "sending";
          sent = true;
          if (!spec.body) { target.end(); return; }
          let written = 0;
          for (const part of spec.body.parts) {
            if (Buffer.isBuffer(part)) {
              written += part.length;
              if (!target.write(part)) await drained(target);
              continue;
            }
            try {
              for await (const chunk of part) {
                if (ended || finished) return;
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
                written += buffer.length;
                if (written > spec.body.length) return finish({ ok: false, kind: "too_large" });
                if (!target.write(buffer)) await drained(target);
              }
            } catch {
              // An unfinished multipart body never reaches the Bot API method.
              return finish(before("upload_source"));
            }
            if (ended || finished) return;
          }
          if (written !== spec.body.length) return finish(before("upload_source"));
          target.end();
        }
        function drained(target: ClientRequest): Promise<void> {
          return new Promise((resolveDrain) => {
            const done = () => { target.off("drain", done); target.off("close", done); resolveDrain(); };
            target.once("drain", done);
            target.once("close", done);
          });
        }
        try {
          outgoing = request({
            agent: false,
            headers: { ...spec.headers, ...(spec.body ? { "content-length": String(spec.body.length) } : {}) },
            host: hostname,
            lookup: pinnedAddressLookup(pinned, () => ended || finished),
            method: spec.method,
            path: spec.path,
            port,
            ...(secure ? { servername: isIP(hostname) ? undefined : hostname } : {})
          }, (response) => {
            if (ended || finished) { response.destroy(); return; }
            phase = "response";
            const status = response.statusCode ?? 0;
            const declared = Number(response.headers?.["content-length"]);
            if (Number.isFinite(declared) && declared > spec.maxResponseBytes) {
              finish({ ok: false, kind: "too_large", status });
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              if (ended || finished) return;
              size += chunk.length;
              if (size > spec.maxResponseBytes) { finish({ ok: false, kind: "too_large", status }); return; }
              chunks.push(chunk);
            });
            response.once("end", () => { if (!ended) finish({ ok: true, status, body: Buffer.concat(chunks, size) }); });
            response.once("error", (error) => fail(failureCategory(error)));
            response.once("aborted", () => fail("reset"));
          });
          const target = outgoing;
          target.once("error", (error) => fail(failureCategory(error)));
          target.once("socket", (socket) => {
            if (ended || finished) { socket.destroy(); return; }
            socket.once("connect", () => {
              clearTimeout(connectTimer);
              if (secure) phase = "tls";
              else if (!ended && !finished) void writeBody(target).catch((error: unknown) => fail(failureCategory(error)));
            });
            if (secure) {
              socket.once("secureConnect", () => {
                if (ended || finished) return;
                clearTimeout(connectTimer);
                void writeBody(target).catch((error: unknown) => fail(failureCategory(error)));
              });
            }
          });
        } catch (error) {
          fail(failureCategory(error));
        }
      }

      Promise.resolve().then(() => resolve(hostname)).then((addresses) => {
        if (finished) return;
        if (addresses.length === 0 || addresses.some((entry) =>
          isIP(entry.address) !== entry.family || networkAddressScope(entry.address) !== allowedScope
        )) {
          finish(before("forbidden_address"));
          return;
        }
        attempt(addresses, 0);
      }, () => finish(before("dns")));
    });
  }

  function botPath(token: string, method: string): string {
    if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token) || !/^[A-Za-z]{1,64}$/u.test(method)) {
      throw new TelegramTransportConfigError(TELEGRAM_REQUEST_INVALID_CODE);
    }
    return `/bot${token}/${method}`;
  }

  async function json(
    token: string, method: string, params: Readonly<Record<string, unknown>> | undefined, timeoutMs: number
  ): Promise<TelegramOutcome<unknown>> {
    const path = botPath(token, method);
    const body = Buffer.from(JSON.stringify(params ?? {}), "utf8");
    if (body.length > TELEGRAM_JSON_REQUEST_MAX_BYTES) return { ok: false, kind: "too_large" };
    const result = await exchange({
      method: "POST", path, headers: { "content-type": "application/json" }, body: { parts: [body], length: body.length },
      timeoutMs, maxResponseBytes: TELEGRAM_JSON_RESPONSE_MAX_BYTES
    });
    return result.ok ? telegramOutcomeFromResponse(result.status, result.body) : result;
  }

  return Object.freeze({
    call: ({ token, method, params }) => json(token, method, params, TELEGRAM_JSON_TIMEOUT_MS),
    longPoll: ({ token, method, params, pollTimeoutSeconds }) => {
      const seconds = Number.isSafeInteger(pollTimeoutSeconds)
        ? Math.min(Math.max(pollTimeoutSeconds, 0), TELEGRAM_LONG_POLL_MAX_SECONDS) : 0;
      return json(token, method, params, seconds * 1_000 + TELEGRAM_LONG_POLL_GRACE_MS);
    },
    upload: async ({ token, method, fields, file }) => {
      const path = botPath(token, method);
      const size = "data" in file ? file.data.length : file.size;
      if (!Number.isSafeInteger(size) || size < 0) throw new TelegramTransportConfigError(TELEGRAM_REQUEST_INVALID_CODE);
      if (size > TELEGRAM_UPLOAD_MAX_BYTES) {
        if ("stream" in file) file.stream.destroy();
        return { ok: false, kind: "too_large" };
      }
      const multipart = multipartBody(fields, file);
      if (!multipart) {
        if ("stream" in file) file.stream.destroy();
        throw new TelegramTransportConfigError(TELEGRAM_REQUEST_INVALID_CODE);
      }
      const { body, contentType } = multipart;
      const result = await exchange({
        method: "POST", path, headers: { "content-type": contentType }, body,
        timeoutMs: TELEGRAM_FILE_TIMEOUT_MS, maxResponseBytes: TELEGRAM_JSON_RESPONSE_MAX_BYTES
      });
      return result.ok ? telegramOutcomeFromResponse(result.status, result.body) : result;
    },
    download: async ({ token, filePath, maxBytes }) => {
      if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token) || !validFilePath(filePath)) {
        throw new TelegramTransportConfigError(TELEGRAM_REQUEST_INVALID_CODE);
      }
      const cap = Math.min(maxBytes ?? TELEGRAM_DOWNLOAD_MAX_BYTES, TELEGRAM_DOWNLOAD_MAX_BYTES);
      const result = await exchange({
        method: "GET", path: `/file/bot${token}/${filePath}`, headers: {},
        timeoutMs: TELEGRAM_FILE_TIMEOUT_MS, maxResponseBytes: cap
      });
      if (!result.ok) return result;
      if (result.status === 200) return { ok: true, result: result.body };
      const failure = telegramOutcomeFromResponse(result.status, result.body);
      return failure.ok ? { ok: false, kind: "http", status: result.status } : failure;
    }
  });
}

/** A `getFile` path: relative segments of safe characters, never `.` or `..`. */
function validFilePath(value: string): boolean {
  return value.length > 0 && value.length <= 512 && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(value)
    && value.split("/").every((segment) => segment !== "." && segment !== "..");
}

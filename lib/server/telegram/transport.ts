import type { Readable } from "node:stream";
import { TELEGRAM_BOT_TOKEN_PATTERN } from "../../contracts/telegram";
import { isTestModeAllowedEnv } from "../auth/csrf";
import {
  createPinnedHttpsExchange, multipartBody as pinnedMultipartBody, type PinnedAddress, type PinnedBody,
  type PinnedHttpsFailureCategory, type PinnedRequestFactory
} from "../connectors/pinnedHttps";
import { TELEGRAM_API_ORIGIN_INVALID_CODE, TELEGRAM_REQUEST_INVALID_CODE } from "./codes";

/**
 * The Bot API transport: HTTPS to one configured origin over the shared
 * pinned exchange (`lib/server/connectors/pinnedHttps.ts`: addresses resolved
 * once per call and all proved public, every connection pinned to them, no
 * shared agent, one deadline per call and bounded bodies). The bot token is
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

export type TelegramFailureKind =
  | "http" | "telegram" | "network_before_send" | "network_after_send" | "timeout" | "too_large" | "unreachable";
/** Content-free detail of a failure; safe to log. */
export type TelegramFailureCategory = PinnedHttpsFailureCategory;

/**
 * A failed call. Only `network_before_send` is safe to repeat: no request byte
 * reached Telegram. `timeout` and `network_after_send` are ambiguous.
 * `too_large` without `status` is a request refused before sending; with a
 * status it is a response over its bound. `telegram` is Telegram's own
 * refusal (`errorCode`, and `retryAfter` seconds for 429). `unreachable` is a
 * send its own authority stopped before dispatch: nothing reached Telegram,
 * and the chat may no longer receive it.
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

type ResolvedAddress = PinnedAddress;
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

type Body = PinnedBody;

function multipartBody(
  fields: Readonly<Record<string, string>>, file: TelegramUploadFile
): Readonly<{ body: Body; contentType: string }> | undefined {
  return pinnedMultipartBody({ label: "telegram", fields: Object.entries(fields), files: [file], fieldName: /^[a-z_]{1,64}$/u });
}

export function createTelegramTransport(options: Readonly<{
  resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  request?: PinnedRequestFactory;
  now?: () => number;
  origin?: string;
  env?: Env;
}> = {}): TelegramTransport {
  const origin = resolveTelegramApiOrigin({ origin: options.origin, env: options.env });
  const secure = origin.url.protocol === "https:";
  const hostname = origin.url.hostname.startsWith("[") ? origin.url.hostname.slice(1, -1) : origin.url.hostname;
  const port = origin.url.port || (secure ? 443 : 80);
  const allowedScope = origin.loopback ? "loopback" : "public";
  const pinnedExchange = createPinnedHttpsExchange({ resolve: options.resolve, request: options.request, now: options.now });
  const exchange = (spec: Readonly<{
    method: "GET" | "POST"; path: string; headers: Readonly<Record<string, string>>; body?: Body;
    timeoutMs: number; maxResponseBytes: number;
  }>) => pinnedExchange({ ...spec, hostname, port, secure, allowedScope });

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

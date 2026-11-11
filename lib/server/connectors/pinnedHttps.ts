import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type RequestOptions
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { networkAddressScope, pinnedAddressLookup } from "../mcp/safeFetch";

/**
 * One HTTPS exchange for connector clients (Telegram, Discord): the host's
 * addresses resolved once per call and all proved to be in the allowed scope,
 * every connection pinned to them, no shared agent, one deadline per call and
 * a bounded response. Nothing here logs or throws request content: failures
 * are a closed kind and category, so a token in a path or header never leaves.
 */

export type PinnedAddress = Readonly<{ address: string; family: 4 | 6 }>;
export type PinnedHttpsFailureKind = "network_before_send" | "network_after_send" | "timeout" | "too_large";
/** Content-free detail of a failure; safe to log. */
export type PinnedHttpsFailureCategory =
  | "dns" | "connect" | "tls" | "timeout" | "reset" | "network_unreachable" | "forbidden_address"
  | "upload_source" | "invalid_response" | "unknown";

/**
 * A failed exchange. Only `network_before_send` is safe to repeat: no request
 * byte reached the server. `timeout` and `network_after_send` are ambiguous.
 * `too_large` without `status` is a request refused before sending; with a
 * status it is a response over its bound.
 */
export type PinnedHttpsFailure = Readonly<{
  ok: false;
  kind: PinnedHttpsFailureKind;
  status?: number;
  category?: PinnedHttpsFailureCategory;
}>;

export type PinnedBody = Readonly<{ parts: readonly (Buffer | Readable)[]; length: number }>;
export type PinnedRequestFactory = (options: RequestOptions, response: (incoming: IncomingMessage) => void) => ClientRequest;
export type PinnedResolve = (hostname: string) => Promise<readonly PinnedAddress[]>;
/** `public` for real services; `loopback` only for test-mode fakes. */
export type PinnedAddressScope = "public" | "loopback";

export type PinnedExchange = Readonly<{
  /** The host name without IPv6 brackets; it is also the TLS server name. */
  hostname: string;
  port: number | string;
  secure: boolean;
  allowedScope: PinnedAddressScope;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  headers: Readonly<Record<string, string>>;
  body?: PinnedBody;
  timeoutMs: number;
  maxResponseBytes: number;
}>;
export type PinnedExchangeResult =
  | Readonly<{ ok: true; status: number; headers: IncomingHttpHeaders; body: Buffer }>
  | PinnedHttpsFailure;

export function pinnedFailureCategory(error: unknown): PinnedHttpsFailureCategory {
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

/** System DNS (honours `/etc/hosts` and Compose `extra_hosts`), every address in order. */
export async function resolveHostAddresses(hostname: string): Promise<readonly PinnedAddress[]> {
  const family = isIP(hostname);
  if (family === 4 || family === 6) return [{ address: hostname, family }];
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
}

/** True when every address is well formed and in the allowed scope; an empty list is refused. */
export function addressesAllowed(addresses: readonly PinnedAddress[], scope: PinnedAddressScope): boolean {
  return addresses.length > 0 && addresses.every((entry) =>
    isIP(entry.address) === entry.family && networkAddressScope(entry.address) === scope);
}

export type MultipartFile = Readonly<{ field: string; filename: string; contentType: string }>
  & (Readonly<{ data: Buffer }> | Readonly<{ stream: Readable; size: number }>);

function multipartSafe(value: string, max: number): string {
  return value.replace(/["\\\r\n\u0000-\u001f\u007f]/gu, "_").slice(0, max) || "file";
}

const MULTIPART_CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/u;

/**
 * A multipart/form-data body of string fields followed by files, with its
 * exact length. Field names must match `fieldName`; file names lose quotes,
 * backslashes and control characters. `undefined` means a refused field name.
 */
export function multipartBody(input: Readonly<{
  label: string;
  fields: readonly (readonly [string, string])[];
  files: readonly MultipartFile[];
  fieldName: RegExp;
}>): Readonly<{ body: PinnedBody; contentType: string }> | undefined {
  const boundary = `----aiqsa-${input.label}-${randomBytes(16).toString("hex")}`;
  const parts: (Buffer | Readable)[] = [];
  let length = 0;
  const push = (part: Buffer | Readable, size: number) => { parts.push(part); length += size; };
  const head: string[] = [];
  for (const [name, value] of input.fields) {
    if (!input.fieldName.test(name)) return undefined;
    head.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  let text = head.join("");
  for (const file of input.files) {
    if (!input.fieldName.test(file.field)) return undefined;
    const contentType = MULTIPART_CONTENT_TYPE.test(file.contentType) ? file.contentType : "application/octet-stream";
    text += `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${multipartSafe(file.filename, 200)}"\r\n`
      + `Content-Type: ${contentType}\r\n\r\n`;
    const prefix = Buffer.from(text, "utf8");
    push(prefix, prefix.length);
    if ("data" in file) push(file.data, file.data.length);
    else push(file.stream, file.size);
    text = "\r\n";
  }
  const suffix = Buffer.from(`${text}--${boundary}--\r\n`, "utf8");
  push(suffix, suffix.length);
  return { body: { parts, length }, contentType: `multipart/form-data; boundary=${boundary}` };
}

const CONNECT_RETRY_CATEGORIES: readonly PinnedHttpsFailureCategory[] = ["connect", "network_unreachable", "timeout", "reset"];

function before(category: PinnedHttpsFailureCategory): PinnedHttpsFailure {
  return { ok: false, kind: "network_before_send", category };
}

/**
 * Builds the exchange function. `resolve` defaults to system DNS; `request`
 * defaults to `node:https` or `node:http` by the exchange's `secure` flag.
 * The next resolved address is tried only while connecting.
 */
export function createPinnedHttpsExchange(options: Readonly<{
  resolve?: PinnedResolve;
  request?: PinnedRequestFactory;
  now?: () => number;
}> = {}): (spec: PinnedExchange) => Promise<PinnedExchangeResult> {
  const resolve = options.resolve ?? resolveHostAddresses;
  const now = options.now ?? (() => performance.now());

  return (spec) => new Promise((settle) => {
    const request = options.request ?? (spec.secure ? httpsRequest : httpRequest);
    const deadline = now() + spec.timeoutMs;
    let finished = false;
    let sent = false;
    let cancelAttempt = () => {};
    const timer = setTimeout(() => finish(sent ? { ok: false, kind: "timeout" } : before("timeout")), spec.timeoutMs);
    function finish(result: PinnedExchangeResult): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cancelAttempt();
      for (const part of spec.body?.parts ?? []) if (!Buffer.isBuffer(part) && result.ok === false) part.destroy();
      settle(result);
    }

    function attempt(addresses: readonly PinnedAddress[], index: number): void {
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
      function fail(category: PinnedHttpsFailureCategory): void {
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
            // An unfinished multipart body never reaches the remote method.
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
          host: spec.hostname,
          lookup: pinnedAddressLookup(pinned, () => ended || finished),
          method: spec.method,
          path: spec.path,
          port: spec.port,
          ...(spec.secure ? { servername: isIP(spec.hostname) ? undefined : spec.hostname } : {})
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
          response.once("end", () => {
            if (!ended) finish({ ok: true, status, headers: response.headers ?? {}, body: Buffer.concat(chunks, size) });
          });
          response.once("error", (error) => fail(pinnedFailureCategory(error)));
          response.once("aborted", () => fail("reset"));
        });
        const target = outgoing;
        target.once("error", (error) => fail(pinnedFailureCategory(error)));
        target.once("socket", (socket) => {
          if (ended || finished) { socket.destroy(); return; }
          socket.once("connect", () => {
            clearTimeout(connectTimer);
            if (spec.secure) phase = "tls";
            else if (!ended && !finished) void writeBody(target).catch((error: unknown) => fail(pinnedFailureCategory(error)));
          });
          if (spec.secure) {
            socket.once("secureConnect", () => {
              if (ended || finished) return;
              clearTimeout(connectTimer);
              void writeBody(target).catch((error: unknown) => fail(pinnedFailureCategory(error)));
            });
          }
        });
      } catch (error) {
        fail(pinnedFailureCategory(error));
      }
    }

    Promise.resolve().then(() => resolve(spec.hostname)).then((addresses) => {
      if (finished) return;
      if (!addressesAllowed(addresses, spec.allowedScope)) {
        finish(before("forbidden_address"));
        return;
      }
      attempt(addresses, 0);
    }, () => finish(before("dns")));
  });
}

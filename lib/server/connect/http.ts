import { COMPUTER_ERROR_HTTP_STATUS, type ComputerErrorCode } from "@/lib/contracts/computer";
import {
  CONNECT_CLIENT_VERSION_HEADER,
  CONNECT_DEVICE_TOKEN_PATTERN,
  CONNECT_ID_PATTERN,
  CONNECT_PROTOCOL_HEADER,
  CONNECT_PROTOCOL_VERSION,
  CONNECT_REASON_HTTP_STATUS,
  CONNECT_VERSION_PATTERN,
  type ConnectReasonCode
} from "@/lib/contracts/connect";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "../http/requestBody";

export const CONNECT_BROWSER_HEADERS = Object.freeze({ "cache-control": "private, no-store" });
export const CONNECT_DEVICE_HEADERS = Object.freeze({ "cache-control": "no-store" });

/** Small JSON bodies: pairing requests and decisions. */
export const CONNECT_SMALL_BODY_BYTES = 16_384;
const AUTHORIZATION_MAX_LENGTH = 256;
const BEARER = /^Bearer\s+(\S+)\s*$/iu;

type HeaderMap = Readonly<Record<string, string>>;

/** A refusal: `{code}` with its contract status. */
export function connectRefusal(code: ConnectReasonCode, headers: HeaderMap, extra: HeaderMap = {}): Response {
  return Response.json({ code }, { headers: { ...headers, ...extra }, status: CONNECT_REASON_HTTP_STATUS[code] });
}

/** A refusal of the computer routes: `{code}` with the status `lib/contracts/computer.ts` gives it. */
export function computerRefusal(code: ComputerErrorCode, headers: HeaderMap): Response {
  return Response.json({ code }, { headers, status: COMPUTER_ERROR_HTTP_STATUS[code] });
}

/** A server-side failure (the store is unreachable): no code, the client retries. */
export function connectUnavailable(headers: HeaderMap): Response {
  return new Response(null, { headers: { ...headers, "retry-after": "5" }, status: 503 });
}

export function connectRateLimited(headers: HeaderMap, retryAfterSeconds: number): Response {
  return connectRefusal("connect_rate_limited", headers, {
    "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds)))
  });
}

export type ConnectJsonBody =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ code: "connect_input_too_large" | "connect_request_invalid"; ok: false }>;

/** Reads at most `maxBytes` of UTF-8 JSON. */
export async function readConnectJson(request: Request, maxBytes: number): Promise<ConnectJsonBody> {
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedRequestBody(request, { maxBytes });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return { code: "connect_input_too_large", ok: false };
    if (request.signal.aborted) throw error;
    return { code: "connect_request_invalid", ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { code: "connect_request_invalid", ok: false };
  }
}

/**
 * The device token of a device API request. A browser request (any `Origin`)
 * and anything but a well-formed Bearer token are refused before a lookup;
 * cookies are never read.
 */
export function connectDeviceToken(request: Request): string | null {
  if (request.headers.has("origin")) return null;
  const header = request.headers.get("authorization");
  if (!header || header.length > AUTHORIZATION_MAX_LENGTH) return null;
  const token = BEARER.exec(header)?.[1];
  return token && CONNECT_DEVICE_TOKEN_PATTERN.test(token) ? token : null;
}

/** Whether a device API request comes from a protocol 2 client; terminal clients never send the header (D-03). */
export function isConnectProtocol2(request: Request): boolean {
  return request.headers.get(CONNECT_PROTOCOL_HEADER)?.trim() === String(CONNECT_PROTOCOL_VERSION);
}

/** The client version the request names, or null when it is absent or malformed. */
export function connectClientVersion(request: Request): string | null {
  const value = request.headers.get(CONNECT_CLIENT_VERSION_HEADER)?.trim();
  return value && CONNECT_VERSION_PATTERN.test(value) ? value : null;
}

/** Path ids that are not ids name nothing: they answer like an unknown resource. */
export function isConnectId(value: string | undefined): value is string {
  return typeof value === "string" && CONNECT_ID_PATTERN.test(value);
}

import { isIP } from "node:net";
import { networkAddressScope } from "../mcp/safeFetch";
import { decodeBase64Url, isP256PublicKey } from "./webPushCrypto";

export const PUSH_ENDPOINT_MAX_LENGTH = 2048;

export type ValidatedPushSubscription = Readonly<{
  auth: string;
  endpoint: string;
  p256dh: string;
}>;

/** Names that never denote a public push service. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp", ".private"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A push service endpoint the server may post to: an absolute `https:` URL on
 * the default port, without credentials or fragment, whose host is a public
 * name or a public address literal. Delivery re-resolves the name and refuses
 * a non-public answer.
 */
export function validatePushEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > PUSH_ENDPOINT_MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || value.includes("#") ||
    (url.port !== "" && url.port !== "443")) return null;
  const hostname = url.hostname.toLowerCase();
  const literal = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (isIP(literal)) return networkAddressScope(literal) === "public" ? url.toString() : null;
  if (!hostname.includes(".") || hostname.endsWith(".") ||
    PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return null;
  return url.toString();
}

/** The browser's `PushSubscription.toJSON()`, validated; null when anything is malformed. */
export function decodePushSubscriptionRequest(value: unknown): ValidatedPushSubscription | null {
  if (!isRecord(value) || !isRecord(value.keys)) return null;
  if (Object.keys(value).some((key) => key !== "endpoint" && key !== "keys" && key !== "expirationTime")) return null;
  if (value.expirationTime !== undefined && value.expirationTime !== null && typeof value.expirationTime !== "number") return null;
  const endpoint = validatePushEndpoint(value.endpoint);
  const { auth, p256dh } = value.keys;
  if (!endpoint || typeof auth !== "string" || typeof p256dh !== "string") return null;
  const authBytes = decodeBase64Url(auth);
  const publicKey = decodeBase64Url(p256dh);
  if (authBytes?.length !== 16 || !publicKey || !isP256PublicKey(publicKey)) return null;
  return { auth, endpoint, p256dh };
}

/** DELETE names only the endpoint. */
export function decodePushUnsubscribeRequest(value: unknown): string | null {
  if (!isRecord(value) || typeof value.endpoint !== "string") return null;
  return validatePushEndpoint(value.endpoint);
}

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const RELAY_STATE_DOMAIN = "aiqsa:saml-relay-state:v1\0";
/** 128 bits of the HMAC, base64url. */
const MAC_LENGTH = 22;
const REQUEST_ID = /^_[0-9a-f]{32}$/u;
const EXPIRY = /^[1-9][0-9]{0,11}$/u;

/** An AuthnRequest id: an XML NCName with 128 random bits. */
export function createSamlRequestId(): string {
  return `_${randomBytes(16).toString("hex")}`;
}

export function isSamlRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value);
}

function relayStateMac(secret: string, requestId: string, expiresAtSeconds: string): string {
  return createHmac("sha256", secret)
    .update(RELAY_STATE_DOMAIN, "utf8")
    .update(requestId, "utf8")
    .update("\0", "utf8")
    .update(expiresAtSeconds, "utf8")
    .digest("base64url")
    .slice(0, MAC_LENGTH);
}

/**
 * `RelayState` for one AuthnRequest: its id and expiry under an HMAC of the session secret,
 * 67 characters, inside the SAML bindings' 80-byte limit. The destination stays in the
 * server-side request, so the IdP never carries it.
 */
export function signSamlRelayState(input: { expiresAt: number; requestId: string; secret: string }): string {
  const expiresAtSeconds = String(Math.ceil(input.expiresAt / 1000));
  return `${input.requestId}.${expiresAtSeconds}.${relayStateMac(input.secret, input.requestId, expiresAtSeconds)}`;
}

/** The request a RelayState names, or null when it is missing, forged, altered or expired. */
export function readSamlRelayState(
  value: string | null,
  input: { now: number; secret: string }
): { requestId: string } | null {
  if (!value || value.length > 128 || !input.secret) return null;
  const [requestId, expiresAtSeconds, mac, ...rest] = value.split(".");
  if (rest.length || !isSamlRequestId(requestId) || !expiresAtSeconds || !EXPIRY.test(expiresAtSeconds) || !mac) {
    return null;
  }
  const expected = Buffer.from(relayStateMac(input.secret, requestId, expiresAtSeconds));
  const actual = Buffer.from(mac);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return Number(expiresAtSeconds) * 1000 > input.now ? { requestId } : null;
}

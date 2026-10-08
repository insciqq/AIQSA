import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readCookie } from "../session";
import { isSamlRequestId } from "./relayState";

export const SAML_BINDING_COOKIE_NAME = "aiqsa_saml_binding";
/** Sent only to the start and completion routes, never to the ACS. */
const SAML_BINDING_COOKIE_PATH = "/api/auth/saml";
const BINDING_DOMAIN = "aiqsa:saml-browser-binding:v1\0";
const BASE64URL_256_BITS = /^[A-Za-z0-9_-]{43}$/u;

function bindingHash(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

function bindingMac(secret: string, requestId: string, nonce: string): string {
  return createHmac("sha256", secret)
    .update(BINDING_DOMAIN, "utf8")
    .update(requestId, "utf8")
    .update("\0", "utf8")
    .update(nonce, "utf8")
    .digest("base64url");
}

function bindingCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${SAML_BINDING_COOKIE_NAME}=${value}`,
    `Path=${SAML_BINDING_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : [])
  ].join("; ");
}

/**
 * Binds one AuthnRequest to the browser that starts it: a `Lax` cookie names the request and
 * carries a random nonce under an HMAC of the session secret; the server keeps only the
 * nonce's hash. The IdP's cross-site POST does not carry the cookie, but the top-level GET it
 * is redirected to does, so only that browser can turn the validated response into a session.
 */
export function createSamlBrowserBinding(input: {
  maxAgeSeconds: number;
  requestId: string;
  secret: string;
  secure: boolean;
}): { cookie: string; hash: string } {
  const nonce = randomBytes(32).toString("base64url");
  const value = `${input.requestId}.${nonce}.${bindingMac(input.secret, input.requestId, nonce)}`;
  return { cookie: bindingCookie(value, input.maxAgeSeconds, input.secure), hash: bindingHash(nonce) };
}

export function clearSamlBrowserBindingCookie(secure: boolean): string {
  return bindingCookie("", 0, secure);
}

/** The request a browser's binding cookie names and its nonce, when the HMAC holds; null otherwise. */
export function readSamlBrowserBinding(
  cookieHeader: string | null,
  secret: string
): { nonce: string; requestId: string } | null {
  const value = readCookie(cookieHeader, SAML_BINDING_COOKIE_NAME);
  if (!value || value.length > 256 || !secret) return null;
  const [requestId, nonce, mac, ...rest] = value.split(".");
  if (rest.length || !isSamlRequestId(requestId) || !nonce || !BASE64URL_256_BITS.test(nonce) || !mac) return null;
  const expected = Buffer.from(bindingMac(secret, requestId, nonce));
  const actual = Buffer.from(mac);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? { nonce, requestId } : null;
}

/** Whether a cookie's nonce is the one whose hash the request kept. */
export function samlBindingMatches(nonce: string, hash: string): boolean {
  const actual = Buffer.from(bindingHash(nonce), "hex");
  const expected = Buffer.from(hash, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

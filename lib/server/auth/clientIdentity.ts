import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { AuthConfig } from "./config";

export const DIRECT_PEER_HEADER = "x-aiqsa-runtime-peer";
const DIRECT_PEER_MAC_DOMAIN = "aiqsa:runtime-peer-stamp:v1\0";
const DIRECT_PEER_VERSION = "v1";
const RUNTIME_PEER_SECRET_SYMBOL = Symbol.for("aiqsa.runtime-peer-secret.v1");
const MAX_DIRECT_PEER_STAMP_LENGTH = 192;
const MAX_FORWARDED_FOR_LENGTH = 512;

export type LoginRateLimitIdentity =
  | { key: string; status: "available" }
  | { status: "not_required" }
  | { status: "unavailable" };

export function getRuntimePeerSecret(): string {
  const value = (globalThis as typeof globalThis & Record<symbol, unknown>)[
    RUNTIME_PEER_SECRET_SYMBOL
  ];

  return typeof value === "string" ? value : "";
}

function mappedIpv4(canonicalIpv6: string): string | null {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonicalIpv6);

  if (!match) return null;

  const high = Number.parseInt(match[1], 16);
  const low = Number.parseInt(match[2], 16);

  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

export function canonicalIp(value: string): string | null {
  if (value !== value.trim() || value.includes("%")) {
    return null;
  }

  const family = isIP(value);

  if (family === 4) {
    return value;
  }

  if (family === 6) {
    try {
      const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase();

      return mappedIpv4(canonical) ?? canonical;
    } catch {
      return null;
    }
  }

  return null;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }

  const canonical = canonicalIp(normalized);

  return canonical === "::1" || canonical?.startsWith("127.") === true;
}

function forwardedIdentity(
  request: Request,
  trustedProxyCount: number
): LoginRateLimitIdentity {
  if (trustedProxyCount < 1) {
    return { status: "unavailable" };
  }

  const value = request.headers.get("x-forwarded-for");

  if (!value || value.length > MAX_FORWARDED_FOR_LENGTH) {
    return { status: "unavailable" };
  }

  const entries = value.split(",");

  if (entries.length !== trustedProxyCount) {
    return { status: "unavailable" };
  }

  const chain = entries.map((entry) => canonicalIp(entry.trim()));

  if (chain.some((entry) => !entry)) {
    return { status: "unavailable" };
  }

  return { key: `ip:${chain[0]}`, status: "available" };
}

function decodeCanonicalPeer(encodedPeer: string): string | null {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(encodedPeer)) {
    return null;
  }

  const decoded = Buffer.from(encodedPeer, "base64url");

  if (decoded.toString("base64url") !== encodedPeer) {
    return null;
  }

  const peer = decoded.toString("utf8");

  return canonicalIp(peer) === peer ? peer : null;
}

export function directPeerIdentity(
  request: Request,
  sessionSecret: string
): LoginRateLimitIdentity {
  const value = request.headers.get(DIRECT_PEER_HEADER);

  if (!value || value.length > MAX_DIRECT_PEER_STAMP_LENGTH || value.includes(",")) {
    return { status: "unavailable" };
  }

  const parts = value.split(".");

  if (parts.length !== 3 || parts[0] !== DIRECT_PEER_VERSION || !sessionSecret) {
    return { status: "unavailable" };
  }

  const peer = decodeCanonicalPeer(parts[1]);

  if (!peer || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) {
    return { status: "unavailable" };
  }

  const providedMac = Buffer.from(parts[2], "base64url");
  const expectedMac = createHmac("sha256", sessionSecret)
    .update(DIRECT_PEER_MAC_DOMAIN, "utf8")
    .update(parts[1], "ascii")
    .digest();

  if (
    providedMac.toString("base64url") !== parts[2] ||
    providedMac.length !== expectedMac.length ||
    !timingSafeEqual(providedMac, expectedMac)
  ) {
    return { status: "unavailable" };
  }

  return { key: `ip:${peer}`, status: "available" };
}

export function resolveLoginRateLimitIdentity(
  request: Request,
  config: Pick<
    AuthConfig,
    | "clientIdentityMode"
    | "runtimePeerSecret"
    | "trustedProxyCount"
  >
): LoginRateLimitIdentity {
  if (config.clientIdentityMode === "invalid") {
    return { status: "unavailable" };
  }

  if (config.clientIdentityMode === "trusted_proxy") {
    const identity = forwardedIdentity(request, config.trustedProxyCount);

    return identity.status === "available" ? identity : { status: "not_required" };
  }

  if (config.clientIdentityMode === "direct_peer") {
    return directPeerIdentity(request, config.runtimePeerSecret);
  }

  return { status: "not_required" };
}

export function getLoginRateLimitKey(
  request: Request,
  trustForwardedFor: boolean,
  trustedProxyCount = trustForwardedFor ? 1 : 0
): string | null {
  if (!trustForwardedFor) {
    return null;
  }

  const identity = forwardedIdentity(request, trustedProxyCount);

  return identity.status === "available" ? identity.key : null;
}

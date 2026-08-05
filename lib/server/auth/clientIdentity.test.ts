// @vitest-environment node

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { getAuthConfig } from "./config";
import {
  DIRECT_PEER_HEADER,
  canonicalIp,
  directPeerIdentity,
  resolveLoginRateLimitIdentity
} from "./clientIdentity";

type Launcher = {
  createCurrentPeerStamp(peerAddress: string): string | null;
  createPeerStamp(peerAddress: string, sessionSecret: string): string | null;
};

const require = createRequire(import.meta.url);
const launcher = require("../../../scripts/runtime-launcher.cjs") as Launcher;
const sessionSecret = "direct-peer-identity-test-secret";

function directConfig() {
  return getAuthConfig({
    AIQSA_APP_BASE_URL: "http://192.168.10.4:3000",
    AIQSA_AUTH_SESSION_SECRET: sessionSecret,
    AIQSA_BIND_ADDRESS: "0.0.0.0",
    AIQSA_COOKIE_SECURE: "0"
  });
}

function stampedRequest(peer: string, headers: HeadersInit = {}): Request {
  const stamp = launcher.createCurrentPeerStamp(peer);

  if (!stamp) throw new Error("direct_peer_test_stamp_unavailable");

  return new Request("http://app.local/api/auth/login", {
    headers: {
      ...Object.fromEntries(new Headers(headers)),
      [DIRECT_PEER_HEADER]: stamp
    }
  });
}

describe("client identity", () => {
  it("accepts only a correctly authenticated direct socket peer", () => {
    expect(resolveLoginRateLimitIdentity(stampedRequest("192.168.10.25"), directConfig())).toEqual({
      key: "ip:192.168.10.25",
      status: "available"
    });

    const forged = new Request("http://app.local", {
      headers: {
        [DIRECT_PEER_HEADER]: "v1.MTkyLjE2OC4xMC45OQ.invalid",
        "x-forwarded-for": "198.51.100.9"
      }
    });

    expect(resolveLoginRateLimitIdentity(forged, directConfig())).toEqual({
      status: "unavailable"
    });
  });

  it("ignores forwarding headers in direct mode", () => {
    const request = stampedRequest("192.168.10.25", {
      "x-forwarded-for": "198.51.100.9, 203.0.113.10",
      "x-real-ip": "198.51.100.10"
    });

    expect(resolveLoginRateLimitIdentity(request, directConfig())).toEqual({
      key: "ip:192.168.10.25",
      status: "available"
    });
  });

  it("rejects joined, oversized, malformed, and wrongly signed stamps", () => {
    const validStamp = launcher.createPeerStamp("192.168.10.25", sessionSecret)!;
    const base64url = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const canonicalMacTail = base64url.indexOf(validStamp.at(-1)!);
    const nonCanonicalMac = `${validStamp.slice(0, -1)}${base64url[canonicalMacTail + 1]}`;
    const cases = [
      `${validStamp}, ${validStamp}`,
      `v2.${validStamp.slice(3)}`,
      `${validStamp.slice(0, -1)}A`,
      nonCanonicalMac,
      `v1.${"a".repeat(65)}.${"b".repeat(43)}`,
      "x".repeat(193)
    ];

    expect(
      directPeerIdentity(
        new Request("http://app.local", {
          headers: { [DIRECT_PEER_HEADER]: validStamp }
        }),
        sessionSecret
      )
    ).toEqual({ key: "ip:192.168.10.25", status: "available" });

    for (const value of cases) {
      const request = new Request("http://app.local", {
        headers: { [DIRECT_PEER_HEADER]: value }
      });

      expect(directPeerIdentity(request, sessionSecret)).toEqual({ status: "unavailable" });
    }
  });

  it("normalizes IPv4-mapped IPv6 to the same durable bucket", () => {
    const dotted = resolveLoginRateLimitIdentity(stampedRequest("192.168.10.4"), directConfig());
    const mapped = resolveLoginRateLimitIdentity(
      stampedRequest("::ffff:192.168.10.4"),
      directConfig()
    );

    expect(mapped).toEqual(dotted);
    expect(canonicalIp("::ffff:c0a8:a04")).toBe("192.168.10.4");
  });

  it("keeps exact trusted-proxy identity authoritative in proxy mode", () => {
    const config = getAuthConfig({
      AIQSA_AUTH_SESSION_SECRET: sessionSecret,
      AIQSA_TRUSTED_PROXY_COUNT: "2",
      AIQSA_TRUST_PROXY_HEADERS: "1"
    });
    const request = stampedRequest("192.168.10.25", {
      "x-forwarded-for": "198.51.100.9, 203.0.113.10"
    });

    expect(resolveLoginRateLimitIdentity(request, config)).toEqual({
      key: "ip:198.51.100.9",
      status: "available"
    });
    expect(
      resolveLoginRateLimitIdentity(new Request("http://app.local"), config)
    ).toEqual({ status: "not_required" });
  });

  it("fails closed for contradictory proxy and direct HTTPS topologies", () => {
    const exposedProxy = getAuthConfig({
      AIQSA_APP_BASE_URL: "https://aiqsa.example",
      AIQSA_AUTH_SESSION_SECRET: sessionSecret,
      AIQSA_BIND_ADDRESS: "0.0.0.0",
      AIQSA_TRUST_PROXY_HEADERS: "1"
    });
    const directHttps = getAuthConfig({
      AIQSA_APP_BASE_URL: "https://aiqsa.example",
      AIQSA_AUTH_SESSION_SECRET: sessionSecret,
      AIQSA_BIND_ADDRESS: "0.0.0.0"
    });
    const forwarded = new Request("http://app.local", {
      headers: { "x-forwarded-for": "198.51.100.9" }
    });

    expect(resolveLoginRateLimitIdentity(forwarded, exposedProxy)).toEqual({
      status: "unavailable"
    });
    expect(resolveLoginRateLimitIdentity(stampedRequest("192.168.10.25"), directHttps)).toEqual({
      status: "unavailable"
    });
  });

  it("keeps an unstamped loopback request optional", () => {
    const config = getAuthConfig({
      AIQSA_AUTH_SESSION_SECRET: sessionSecret
    });

    expect(
      resolveLoginRateLimitIdentity(new Request("http://app.local"), config)
    ).toEqual({ status: "not_required" });
  });
});

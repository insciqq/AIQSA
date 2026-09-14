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

function proxyConfig(trustedProxyCount = 1) {
  return getAuthConfig({
    AIQSA_AUTH_SESSION_SECRET: sessionSecret,
    AIQSA_TRUSTED_PROXY_COUNT: String(trustedProxyCount),
    AIQSA_TRUST_PROXY_HEADERS: "1"
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

  it("keeps trusted-proxy identity authoritative over the socket peer in proxy mode", () => {
    const config = proxyConfig(2);
    const request = stampedRequest("192.168.10.25", {
      "x-forwarded-for": "198.51.100.9, 203.0.113.10"
    });

    expect(resolveLoginRateLimitIdentity(request, config)).toEqual({
      key: "ip:198.51.100.9",
      status: "available"
    });
    expect(
      resolveLoginRateLimitIdentity(new Request("http://app.local"), config)
    ).toEqual({ status: "unavailable" });
  });

  it.each([1, 2, 8])("uses the trusted suffix behind %i proxies regardless of client prefixes", (count) => {
    const suffix = ["203.0.113.20", ...Array.from({ length: count - 1 }, (_, index) => `192.0.2.${index + 1}`)];
    for (const prefix of [[], ["198.51.100.7"], ["not-an-ip"], ["", "", "unknown", "198.51.100.8"]]) {
      const request = new Request("http://app.local", {
        headers: { "x-forwarded-for": [...prefix, ...suffix].join(", ") }
      });
      expect(resolveLoginRateLimitIdentity(request, proxyConfig(count))).toEqual({
        key: "ip:203.0.113.20", status: "available"
      });
    }
  });

  it.each([
    ["203.0.113.20", "203.0.113.20"],
    ["::ffff:203.0.113.20", "203.0.113.20"],
    ["::ffff:cb00:7114", "203.0.113.20"],
    ["2001:0DB8:0000:0000:0000:0000:0000:0001", "2001:db8::1"]
  ])("canonicalizes the trusted client address %s", (address, canonical) => {
    const request = new Request("http://app.local", {
      headers: { "x-forwarded-for": `unknown, ${address}, 2001:db8::2` }
    });
    expect(resolveLoginRateLimitIdentity(request, proxyConfig(2))).toEqual({
      key: `ip:${canonical}`, status: "available"
    });
  });

  it.each([
    { name: "missing", value: null, count: 1 },
    { name: "empty", value: "", count: 1 },
    { name: "short", value: "203.0.113.20", count: 2 },
    { name: "invalid client", value: "unknown, 192.0.2.1", count: 2 },
    { name: "invalid proxy", value: "203.0.113.20, unknown", count: 2 },
    { name: "empty proxy", value: "203.0.113.20, ", count: 2 },
    { name: "client port", value: "203.0.113.20:1234", count: 1 },
    { name: "IPv6 zone", value: "fe80::1%eth0", count: 1 },
    { name: "oversized", value: `${"x".repeat(513)}, 203.0.113.20`, count: 1 }
  ])("fails closed for a $name forwarded chain without using other identity headers", ({ value, count }) => {
    const request = stampedRequest("192.168.10.25", {
      "x-real-ip": "198.51.100.9",
      forwarded: "for=198.51.100.9"
    });
    if (value !== null) request.headers.set("x-forwarded-for", value);
    expect(resolveLoginRateLimitIdentity(request, proxyConfig(count))).toEqual({ status: "unavailable" });
  });

  it("bounds the whole header even when only the trusted suffix supplies identity", () => {
    const suffix = ", 203.0.113.20";
    const request = new Request("http://app.local", {
      headers: { "x-forwarded-for": "x".repeat(512 - suffix.length) + suffix }
    });
    expect(resolveLoginRateLimitIdentity(request, proxyConfig())).toEqual({
      key: "ip:203.0.113.20", status: "available"
    });
    request.headers.set("x-forwarded-for", "x" + request.headers.get("x-forwarded-for"));
    expect(resolveLoginRateLimitIdentity(request, proxyConfig())).toEqual({ status: "unavailable" });
  });

  it.each([0, -1, 1.5, NaN, Infinity])("fails closed for invalid proxy count %s", (count) => {
    const request = new Request("http://app.local", { headers: { "x-forwarded-for": "203.0.113.20" } });
    expect(resolveLoginRateLimitIdentity(request, {
      ...proxyConfig(), trustedProxyCount: count
    })).toEqual({ status: "unavailable" });
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

import { createECDH, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodePushSubscriptionRequest, decodePushUnsubscribeRequest, decodeShownRunRequest, validatePushEndpoint } from "./subscriptionRequest";

function browserKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { auth: randomBytes(16).toString("base64url"), p256dh: ecdh.getPublicKey().toString("base64url") };
}

describe("push endpoint validation", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/opaque-token",
    "https://updates.push.services.mozilla.com/wpush/v2/opaque",
    "https://web.push.apple.com/QGuQyavXutnMH",
    "https://push.example:443/path?query=1",
    "https://[2606:4700::1111]/push",
    "https://1.1.1.1/push"
  ])("accepts the public HTTPS endpoint %s", (endpoint) => {
    expect(validatePushEndpoint(endpoint)).toBe(new URL(endpoint).toString());
  });

  it.each([
    ["plain HTTP", "http://push.example/endpoint"],
    ["another scheme", "ftp://push.example/endpoint"],
    ["credentials", "https://user:secret@push.example/endpoint"],
    ["a fragment", "https://push.example/endpoint#fragment"],
    ["an empty fragment", "https://push.example/endpoint#"],
    ["a non-default port", "https://push.example:8443/endpoint"],
    ["localhost", "https://localhost/endpoint"],
    ["a single-label host", "https://push/endpoint"],
    ["a local suffix", "https://printer.local/endpoint"],
    ["an internal suffix", "https://metadata.google.internal/computeMetadata"],
    ["a loopback literal", "https://127.0.0.1/endpoint"],
    ["a private literal", "https://10.0.0.5/endpoint"],
    ["a link-local literal", "https://169.254.169.254/latest"],
    ["an IPv6 loopback literal", "https://[::1]/endpoint"],
    ["an IPv6 unique-local literal", "https://[fd00::1]/endpoint"],
    ["an oversized URL", `https://push.example/${"a".repeat(2048)}`],
    ["a relative URL", "/c/chat"],
    ["a non-string", 42]
  ])("refuses %s", (_label, endpoint) => {
    expect(validatePushEndpoint(endpoint)).toBeNull();
  });
});

describe("push subscription requests", () => {
  it("accepts the browser's PushSubscription JSON and keeps only endpoint and keys", () => {
    const keys = browserKeys();
    expect(decodePushSubscriptionRequest({ endpoint: "https://push.example/e", expirationTime: null, keys }))
      .toEqual({ auth: keys.auth, endpoint: "https://push.example/e", p256dh: keys.p256dh });
  });

  it("refuses malformed keys, extra fields and unsafe endpoints", () => {
    const keys = browserKeys();
    const valid = { endpoint: "https://push.example/e", keys };
    const offCurve = Buffer.from(keys.p256dh, "base64url");
    offCurve[64] ^= 0x01;
    for (const value of [
      null,
      [],
      { ...valid, userId: "someone-else" },
      { ...valid, expirationTime: "soon" },
      { ...valid, endpoint: "https://10.0.0.1/e" },
      { ...valid, keys: { ...keys, auth: randomBytes(8).toString("base64url") } },
      { ...valid, keys: { ...keys, auth: `${keys.auth}=` } },
      { ...valid, keys: { ...keys, p256dh: offCurve.toString("base64url") } },
      { ...valid, keys: { ...keys, p256dh: randomBytes(65).toString("base64url") } },
      { ...valid, keys: { auth: keys.auth } },
      { endpoint: valid.endpoint }
    ]) expect(decodePushSubscriptionRequest(value)).toBeNull();
  });

  it("reads only a valid endpoint for unsubscribe", () => {
    expect(decodePushUnsubscribeRequest({ endpoint: "https://push.example/e" })).toBe("https://push.example/e");
    expect(decodePushUnsubscribeRequest({ endpoint: "http://push.example/e" })).toBeNull();
    expect(decodePushUnsubscribeRequest({})).toBeNull();
  });
});

describe("shown-run report", () => {
  it("accepts exactly one run id in UUID form", () => {
    expect(decodeShownRunRequest({ runId: "0B7C3A4E-5D6F-4A8B-9C0D-1E2F3A4B5C6D" })).toBe("0b7c3a4e-5d6f-4a8b-9c0d-1e2f3a4b5c6d");
    for (const value of [null, "0b7c3a4e-5d6f-4a8b-9c0d-1e2f3a4b5c6d", {}, { runId: "run-1" }, { runId: 1 },
      { runId: "0b7c3a4e-5d6f-4a8b-9c0d-1e2f3a4b5c6d", extra: true }]) {
      expect(decodeShownRunRequest(value)).toBeNull();
    }
  });
});

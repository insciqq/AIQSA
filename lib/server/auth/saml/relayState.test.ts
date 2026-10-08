// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSamlRequestId, isSamlRequestId, readSamlRelayState, signSamlRelayState } from "./relayState";

const secret = "relay-state-test-secret";
const now = Date.parse("2026-10-08T12:00:00.000Z");

describe("SAML RelayState", () => {
  it("names the request under an HMAC within the bindings' 80-byte limit", () => {
    const requestId = createSamlRequestId();
    const relayState = signSamlRelayState({ expiresAt: now + 600_000, requestId, secret });

    expect(isSamlRequestId(requestId)).toBe(true);
    expect(relayState.length).toBeLessThanOrEqual(80);
    expect(relayState).not.toContain("/");
    expect(readSamlRelayState(relayState, { now, secret })).toEqual({ requestId });
  });

  it("refuses a missing, altered, re-signed, expired or foreign RelayState", () => {
    const requestId = createSamlRequestId();
    const relayState = signSamlRelayState({ expiresAt: now + 600_000, requestId, secret });
    const [id, expiry, mac] = relayState.split(".");
    const otherRequest = createSamlRequestId();

    for (const value of [
      null,
      "",
      `${otherRequest}.${expiry}.${mac}`,
      `${id}.${Number(expiry) + 3600}.${mac}`,
      `${id}.${expiry}.${mac!.slice(0, -1)}${mac!.endsWith("A") ? "B" : "A"}`,
      `${relayState}.extra`,
      signSamlRelayState({ expiresAt: now + 600_000, requestId, secret: "another-installation" }),
      signSamlRelayState({ expiresAt: now + 600_000, requestId: "_not-a-request-id", secret })
    ]) {
      expect(readSamlRelayState(value, { now, secret }), String(value)).toBeNull();
    }
    expect(readSamlRelayState(relayState, { now: now + 601_000, secret })).toBeNull();
    expect(readSamlRelayState(relayState, { now, secret: "" })).toBeNull();
  });
});

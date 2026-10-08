// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createSamlCompletionStore,
  createSamlReplayCache,
  createSamlRequestStore,
  SAML_COMPLETION_TTL_MS,
  SAML_REQUEST_TTL_MS,
  samlSignInState,
  type SamlCompletedResponse,
  type SamlPendingRequest
} from "./state";

function pending(at: number, nextPath = "/"): SamlPendingRequest {
  return {
    activeVersion: 1,
    bindingHash: "0".repeat(64),
    expiresAt: at + SAML_REQUEST_TTL_MS,
    issuedAt: new Date(at).toISOString(),
    nextPath
  };
}

function completed(at: number): SamlCompletedResponse {
  return {
    activeVersion: 1,
    bindingHash: "0".repeat(64),
    expiresAt: at + SAML_COMPLETION_TTL_MS,
    identity: { displayName: "", email: null, groups: null, subject: "subject" },
    nextPath: "/",
    source: "https://idp.example.test"
  };
}

describe("SAML request store", () => {
  it("hands a pending request out exactly once and never after it expired", () => {
    let now = 1_000_000;
    const store = createSamlRequestStore({ now: () => now });
    store.issue("_a", pending(now, "/c/one"));
    store.issue("_b", pending(now));

    expect(store.take("_a")).toMatchObject({ nextPath: "/c/one" });
    expect(store.take("_a")).toBeNull();
    now += SAML_REQUEST_TTL_MS;
    expect(store.take("_b")).toBeNull();
    expect(store.take("_unknown")).toBeNull();
  });

  it("drops the oldest pending request past its capacity", () => {
    const now = 1_000_000;
    const store = createSamlRequestStore({ capacity: 2, now: () => now });
    store.issue("_first", pending(now));
    store.issue("_second", pending(now));
    store.issue("_third", pending(now));

    expect(store.take("_first")).toBeNull();
    expect(store.take("_second")).not.toBeNull();
    expect(store.take("_third")).not.toBeNull();
  });

  it("keeps a validated response for one completion, briefly", () => {
    let now = 1_000_000;
    const store = createSamlCompletionStore({ now: () => now });
    store.put("_a", completed(now));
    store.put("_b", completed(now));

    expect(store.take("_a")).toMatchObject({ identity: { subject: "subject" } });
    expect(store.take("_a")).toBeNull();
    now += SAML_COMPLETION_TTL_MS;
    expect(store.take("_b")).toBeNull();
  });

  it("is shared by every module instance of the process", () => {
    expect(samlSignInState()).toBe(samlSignInState());
  });
});

describe("SAML replay cache", () => {
  it("refuses an assertion it remembers until that assertion expires", () => {
    let now = 1_000;
    const cache = createSamlReplayCache({ now: () => now });

    expect(cache.remember("idp\0_assertion", 5_000)).toBe(true);
    expect(cache.remember("idp\0_assertion", 5_000)).toBe(false);
    now = 5_000;
    expect(cache.remember("idp\0_assertion", 9_000)).toBe(true);
  });

  it("stays bounded, dropping expired entries before the oldest live one", () => {
    let now = 1_000;
    const cache = createSamlReplayCache({ capacity: 2, now: () => now });
    cache.remember("expiring", 2_000);
    cache.remember("live", 10_000);
    now = 3_000;
    cache.remember("newest", 10_000);

    expect(cache.remember("live", 10_000)).toBe(false);
    expect(cache.remember("newest", 10_000)).toBe(false);
    cache.remember("overflow", 10_000);
    expect(cache.remember("live", 10_000)).toBe(true);
  });
});

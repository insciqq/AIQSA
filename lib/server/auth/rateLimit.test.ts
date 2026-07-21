import { describe, expect, it } from "vitest";
import { createFixedWindowLoginRateLimiter, type LoginRateLimitBucket } from "./rateLimit";

describe("login rate limiter", () => {
  it("sweeps expired windows while checking new keys", () => {
    let now = 0;
    const store = new Map<string, LoginRateLimitBucket>();
    const limiter = createFixedWindowLoginRateLimiter({
      clock: () => now,
      store,
      sweepIntervalMs: 1,
      windowMs: 100
    });

    expect(limiter.check("ip:203.0.113.1").allowed).toBe(true);
    expect(store.has("ip:203.0.113.1")).toBe(true);

    now = 101;
    expect(limiter.check("ip:203.0.113.2").allowed).toBe(true);

    expect(store.has("ip:203.0.113.1")).toBe(false);
    expect(store.has("ip:203.0.113.2")).toBe(true);
  });

  it("evicts a bucket when unique-key load reaches the max bucket count", () => {
    const store = new Map<string, LoginRateLimitBucket>();
    const limiter = createFixedWindowLoginRateLimiter({
      clock: () => 0,
      maxBuckets: 2,
      store
    });

    expect(limiter.check("ip:203.0.113.1").allowed).toBe(true);
    expect(limiter.check("ip:203.0.113.2").allowed).toBe(true);
    expect(limiter.check("ip:203.0.113.3").allowed).toBe(true);

    expect(store.size).toBe(2);
    expect(store.has("ip:203.0.113.1")).toBe(false);
    expect(store.has("ip:203.0.113.2")).toBe(true);
    expect(store.has("ip:203.0.113.3")).toBe(true);
  });
});

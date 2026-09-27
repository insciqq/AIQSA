import { describe, expect, it } from "vitest";
import { createFixedWindowLoginRateLimiter, type LoginRateLimitBucket } from "./rateLimit";

describe("login rate limiter", () => {
  it("sweeps expired windows while checking new keys", async () => {
    let now = 0;
    const store = new Map<string, LoginRateLimitBucket>();
    const limiter = createFixedWindowLoginRateLimiter({
      clock: () => now,
      store,
      sweepIntervalMs: 1,
      windowMs: 100
    });

    expect((await limiter.check("ip:203.0.113.1")).allowed).toBe(true);
    expect(store.has("ip:203.0.113.1")).toBe(true);

    now = 101;
    expect((await limiter.check("ip:203.0.113.2")).allowed).toBe(true);

    expect(store.has("ip:203.0.113.1")).toBe(false);
    expect(store.has("ip:203.0.113.2")).toBe(true);
  });

  it("evicts a bucket when unique-key load reaches the max bucket count", async () => {
    const store = new Map<string, LoginRateLimitBucket>();
    const limiter = createFixedWindowLoginRateLimiter({
      clock: () => 0,
      maxBuckets: 2,
      store
    });

    expect((await limiter.check("ip:203.0.113.1")).allowed).toBe(true);
    expect((await limiter.check("ip:203.0.113.2")).allowed).toBe(true);
    expect((await limiter.check("ip:203.0.113.3")).allowed).toBe(true);

    expect(store.size).toBe(2);
    expect(store.has("ip:203.0.113.1")).toBe(false);
    expect(store.has("ip:203.0.113.2")).toBe(true);
    expect(store.has("ip:203.0.113.3")).toBe(true);
  });

  it("applies a per-check ceiling to the shared count without rewriting it", async () => {
    const store = new Map<string, LoginRateLimitBucket>();
    const limiter = createFixedWindowLoginRateLimiter({ clock: () => 0, maxAttempts: 3, store });

    expect((await limiter.check("pair")).allowed).toBe(true);
    expect((await limiter.check("pair", { maxAttempts: 1 })).allowed).toBe(false);
    expect(store.get("pair")?.count).toBe(1);
    expect((await limiter.check("pair")).allowed).toBe(true);
    expect((await limiter.check("pair", { maxAttempts: 4 })).allowed).toBe(true);
    expect((await limiter.check("pair", { maxAttempts: 4 })).allowed).toBe(true);
    expect((await limiter.check("pair", { maxAttempts: 4 })).allowed).toBe(false);
    expect((await limiter.check("pair")).allowed).toBe(false);
    expect(store.get("pair")?.count).toBe(4);
  });

  it("releases one admitted attempt only while its window is open", async () => {
    let now = 0;
    const store = new Map<string, LoginRateLimitBucket>();
    const limiter = createFixedWindowLoginRateLimiter({ clock: () => now, maxAttempts: 2, store, windowMs: 100 });

    await limiter.check("source");
    await limiter.check("source");
    expect((await limiter.check("source")).allowed).toBe(false);

    await limiter.release("source");
    expect(store.get("source")?.count).toBe(1);
    expect((await limiter.check("source")).allowed).toBe(true);
    expect((await limiter.check("source")).allowed).toBe(false);

    await limiter.release("missing");
    expect(store.has("missing")).toBe(false);

    now = 100;
    await limiter.release("source");
    expect(store.get("source")?.count).toBe(2);
  });

  it("closes the window when a window's only attempt is released", async () => {
    let now = 0;
    const store = new Map<string, LoginRateLimitBucket>();
    const limiter = createFixedWindowLoginRateLimiter({ clock: () => now, maxAttempts: 2, store, windowMs: 100 });

    await limiter.check("source");
    now = 40;
    await limiter.release("source");
    await limiter.release("source");
    expect(store.has("source")).toBe(false);

    expect(await limiter.check("source")).toEqual({ allowed: true, retryAfterSeconds: 1 });
    expect(store.get("source")).toEqual({ count: 1, resetAtMs: 140 });
  });
});

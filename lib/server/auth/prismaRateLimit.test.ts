import { describe, expect, it } from "vitest";
import {
  createDurableLoginRateLimiter,
  hashAuthRateLimitKey,
  type DurableLoginRateLimitStore
} from "./prismaRateLimit";

function createMemoryDurableStore(): DurableLoginRateLimitStore & {
  buckets: Map<string, { attemptCount: number; resetAt: Date }>;
} {
  const buckets = new Map<string, { attemptCount: number; resetAt: Date }>();

  return {
    buckets,
    async consume(input) {
      const existing = buckets.get(input.keyHash);
      const bucket =
        existing && existing.resetAt > input.now
          ? {
              attemptCount: existing.attemptCount > input.maxAttempts
                ? existing.attemptCount
                : existing.attemptCount + 1,
              resetAt: existing.resetAt
            }
          : {
              attemptCount: 1,
              resetAt: input.resetAt
            };

      buckets.set(input.keyHash, bucket);
      return bucket;
    },
    async delete(keyHash) {
      buckets.delete(keyHash);
    },
    async pruneExpired(now) {
      for (const [keyHash, bucket] of buckets) {
        if (bucket.resetAt <= now) {
          buckets.delete(keyHash);
        }
      }
    },
    async release(input) {
      const bucket = buckets.get(input.keyHash);

      if (bucket && bucket.resetAt > input.now) {
        bucket.attemptCount = Math.max(bucket.attemptCount - 1, 0);
      }
    }
  };
}

describe("durable auth rate limiter", () => {
  it("stores only an installation-keyed digest", async () => {
    const store = createMemoryDurableStore();
    const limiter = createDurableLoginRateLimiter({
      clock: () => 0,
      keySecret: () => "installation-secret",
      store
    });

    await limiter.check("password-login:account:user@example.test");

    const [storedKey] = store.buckets.keys();
    expect(storedKey).toMatch(/^[a-f0-9]{64}$/);
    expect(storedKey).not.toContain("user@example.test");
    expect(storedKey).toBe(
      hashAuthRateLimitKey(
        "password-login:account:user@example.test",
        "installation-secret"
      )
    );
    expect(storedKey).not.toBe(
      hashAuthRateLimitKey(
        "password-login:account:user@example.test",
        "different-installation-secret"
      )
    );
  });

  it("shares a fixed window across independently constructed limiter instances and restarts", async () => {
    let now = 0;
    const store = createMemoryDurableStore();
    const options = {
      clock: () => now,
      keySecret: () => "installation-secret",
      maxAttempts: 2,
      store,
      windowMs: 1_000
    };
    const firstProcess = createDurableLoginRateLimiter(options);
    const secondProcess = createDurableLoginRateLimiter(options);

    expect((await firstProcess.check("account-key")).allowed).toBe(true);
    expect((await secondProcess.check("account-key")).allowed).toBe(true);

    const restartedProcess = createDurableLoginRateLimiter(options);
    expect((await restartedProcess.check("account-key")).allowed).toBe(false);

    now = 1_001;
    expect((await restartedProcess.check("account-key")).allowed).toBe(true);
  });

  it("checks one shared count under per-check ceilings and releases only open windows", async () => {
    let now = 0;
    const store = createMemoryDurableStore();
    const limiter = createDurableLoginRateLimiter({
      clock: () => now,
      keySecret: () => "installation-secret",
      maxAttempts: 3,
      store,
      windowMs: 1_000
    });
    const count = () => [...store.buckets.values()][0]?.attemptCount;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await limiter.check("pair")).allowed).toBe(true);
    }
    expect(await limiter.check("pair", { maxAttempts: 1 })).toEqual({ allowed: false, retryAfterSeconds: 1 });
    // A refusal under a lower ceiling never lowers the count kept for the normal ceiling.
    expect(count()).toBe(3);
    expect((await limiter.check("pair")).allowed).toBe(false);
    expect(count()).toBe(4);

    await limiter.release("pair");
    await limiter.release("pair");
    expect((await limiter.check("pair")).allowed).toBe(true);

    now = 1_000;
    await limiter.release("pair");
    expect(count()).toBe(3);
    expect((await limiter.check("pair")).allowed).toBe(true);
    expect(count()).toBe(1);
  });
});

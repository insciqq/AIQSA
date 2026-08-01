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
              attemptCount: Math.min(existing.attemptCount + 1, input.maxAttempts + 1),
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
});

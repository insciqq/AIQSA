import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createPrismaLoginRateLimiter, hashAuthRateLimitKey } from "./prismaRateLimit";

// A fixed clock in the past keeps the limiter's expiry sweep away from live buckets.
const windowStartMs = Date.parse("2026-01-01T00:00:00.000Z");
const windowMs = 60_000;

describe("Prisma auth rate-limit buckets", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps one count under per-check ceilings and releases only an open window", async () => {
    let now = windowStartMs;
    const secret = `prisma-rate-limit-test-${randomUUID()}`;
    const key = `rate-limit-test:${randomUUID()}`;
    const limiter = createPrismaLoginRateLimiter({
      clock: () => now,
      keySecret: () => secret,
      maxAttempts: 3,
      prisma,
      windowMs
    });
    const count = async () => (await prisma.authRateLimitBucket.findUnique({
      where: { keyHash: hashAuthRateLimitKey(key, secret) }
    }))?.attemptCount;

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await limiter.check(key)).allowed).toBe(true);
      }
      await expect(limiter.check(key, { maxAttempts: 1 })).resolves.toEqual({
        allowed: false,
        retryAfterSeconds: windowMs / 1000
      });
      await expect(count()).resolves.toBe(3);
      expect((await limiter.check(key)).allowed).toBe(false);
      await expect(count()).resolves.toBe(4);

      await limiter.release(key);
      await limiter.release(key);
      await expect(count()).resolves.toBe(2);
      expect((await limiter.check(key)).allowed).toBe(true);

      now = windowStartMs + windowMs;
      await limiter.release(key);
      await expect(count()).resolves.toBe(3);
      expect((await limiter.check(key)).allowed).toBe(true);
      await expect(count()).resolves.toBe(1);
    } finally {
      await limiter.reset(key);
    }
  });
});

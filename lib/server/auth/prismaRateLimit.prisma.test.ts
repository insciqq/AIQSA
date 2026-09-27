import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createMemoryPasswordAuthRepository, createTestPasswordIdentity } from "@/tests/support/auth";
import { prisma } from "../prisma";
import { getAuthConfig } from "./config";
import { createPasswordLoginHandler } from "./handlers";
import { createPrismaLoginRateLimiter, hashAuthRateLimitKey } from "./prismaRateLimit";

// A fixed clock in the past keeps the limiter's expiry sweep away from live buckets.
const windowStartMs = Date.parse("2026-01-01T00:00:00.000Z");
const windowMs = 60_000;

function testLimiter(input: { clock: () => number; maxAttempts?: number }) {
  const secret = `prisma-rate-limit-test-${randomUUID()}`;
  const limiter = createPrismaLoginRateLimiter({
    clock: input.clock,
    keySecret: () => secret,
    maxAttempts: input.maxAttempts,
    prisma,
    windowMs
  });
  const bucket = (key: string) => prisma.authRateLimitBucket.findUnique({
    where: { keyHash: hashAuthRateLimitKey(key, secret) }
  });

  return { bucket, limiter };
}

describe("Prisma auth rate-limit buckets", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps one count under per-check ceilings and releases only an open window", async () => {
    let now = windowStartMs;
    const key = `rate-limit-test:${randomUUID()}`;
    const { bucket, limiter } = testLimiter({ clock: () => now, maxAttempts: 3 });
    const count = async () => (await bucket(key))?.attemptCount;

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

  it("closes the window instead of storing zero when a window's only attempt is released", async () => {
    let now = windowStartMs;
    const key = `rate-limit-test:${randomUUID()}`;
    const { bucket, limiter } = testLimiter({ clock: () => now, maxAttempts: 2 });

    try {
      expect((await limiter.check(key)).allowed).toBe(true);
      now = windowStartMs + 1_000;
      // The table requires attemptCount >= 1; releasing the last attempt must not violate it.
      await expect(limiter.release(key)).resolves.toBeUndefined();
      await expect(limiter.release(key)).resolves.toBeUndefined();
      await expect(bucket(key)).resolves.toMatchObject({ attemptCount: 1, resetAt: new Date(now) });

      // The next check in the released window counts 1, not 2.
      await expect(limiter.check(key)).resolves.toEqual({ allowed: true, retryAfterSeconds: windowMs / 1000 });
      await expect(bucket(key)).resolves.toMatchObject({ attemptCount: 1, resetAt: new Date(now + windowMs) });
      expect((await limiter.check(key)).allowed).toBe(true);
      expect((await limiter.check(key)).allowed).toBe(false);
    } finally {
      await limiter.reset(key);
    }
  });

  it("answers the first successful login of a window with a session", async () => {
    const source = "203.0.113.200";
    const { limiter } = testLimiter({ clock: () => windowStartMs });
    const POST = createPasswordLoginHandler({
      getConfig: () => getAuthConfig({
        AIQSA_AUTH_SESSION_SECRET: "prisma-rate-limit-login-test-secret",
        AIQSA_TRUST_PROXY_HEADERS: "1",
        AIQSA_TRUSTED_PROXY_COUNT: "1"
      }),
      loginRateLimiter: limiter,
      repository: createMemoryPasswordAuthRepository({
        identity: createTestPasswordIdentity({ passwordHash: "synthetic:correct-password" })
      }),
      verifyPassword: async (password, passwordHash) => passwordHash === `synthetic:${password}`
    });
    const login = () => POST(new Request("http://app.local/api/auth/login", {
      body: JSON.stringify({ email: "operator@aiqsa.local", password: "correct-password" }),
      headers: { "content-type": "application/json", "x-forwarded-for": source },
      method: "POST"
    }));

    try {
      // Each success releases the source's only attempt of its window.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await login();

        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toContain("aiqsa_session=");
      }
    } finally {
      await limiter.reset(`password-login:client:ip:${source}`);
    }
  });
});

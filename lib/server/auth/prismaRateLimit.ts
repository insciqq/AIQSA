import { createHmac } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
  LOGIN_RATE_LIMIT_WINDOW_MS,
  type LoginRateLimiter
} from "./rateLimit";

const AUTH_RATE_LIMIT_KEY_DOMAIN = "aiqsa:auth-rate-limit-key:v1\0";

export type DurableLoginRateLimitStore = {
  consume(input: {
    keyHash: string;
    maxAttempts: number;
    now: Date;
    resetAt: Date;
  }): Promise<{ attemptCount: number; resetAt: Date }>;
  delete(keyHash: string): Promise<void>;
  pruneExpired(now: Date): Promise<void>;
};

type DurableLoginRateLimiterOptions = {
  clock?: () => number;
  keySecret: () => string;
  maxAttempts?: number;
  store: DurableLoginRateLimitStore;
  sweepIntervalMs?: number;
  windowMs?: number;
};

type PrismaRateLimitClient = Pick<PrismaClient, "$executeRaw" | "$queryRaw">;

export function hashAuthRateLimitKey(key: string, secret: string): string {
  if (!secret) {
    throw new Error("auth_rate_limit_secret_unavailable");
  }

  return createHmac("sha256", secret)
    .update(AUTH_RATE_LIMIT_KEY_DOMAIN, "utf8")
    .update(key, "utf8")
    .digest("hex");
}

export function createDurableLoginRateLimiter(
  options: DurableLoginRateLimiterOptions
): LoginRateLimiter {
  const clock = options.clock ?? Date.now;
  const maxAttempts = Math.max(1, options.maxAttempts ?? LOGIN_RATE_LIMIT_MAX_ATTEMPTS);
  const windowMs = Math.max(1, options.windowMs ?? LOGIN_RATE_LIMIT_WINDOW_MS);
  const sweepIntervalMs = Math.max(
    1,
    options.sweepIntervalMs ?? Math.min(windowMs, 60 * 1000)
  );
  let nextSweepAtMs = 0;

  async function maybePruneExpired(nowMs: number): Promise<void> {
    if (nowMs < nextSweepAtMs) {
      return;
    }

    await options.store.pruneExpired(new Date(nowMs));
    nextSweepAtMs = nowMs + sweepIntervalMs;
  }

  function keyHash(key: string): string {
    return hashAuthRateLimitKey(key, options.keySecret());
  }

  return {
    async check(key) {
      const nowMs = clock();
      const now = new Date(nowMs);
      const hashedKey = keyHash(key);

      await maybePruneExpired(nowMs);
      const bucket = await options.store.consume({
        keyHash: hashedKey,
        maxAttempts,
        now,
        resetAt: new Date(nowMs + windowMs)
      });

      return {
        allowed: bucket.attemptCount <= maxAttempts,
        retryAfterSeconds: Math.max(
          bucket.attemptCount <= maxAttempts ? 0 : 1,
          Math.ceil((bucket.resetAt.getTime() - nowMs) / 1000)
        )
      };
    },
    async reset(key) {
      await options.store.delete(keyHash(key));
    }
  };
}

export function createPrismaLoginRateLimitStore(
  prisma: PrismaRateLimitClient
): DurableLoginRateLimitStore {
  return {
    async consume(input) {
      const rows = await prisma.$queryRaw<Array<{ attemptCount: number; resetAt: Date }>>(
        Prisma.sql`
          INSERT INTO "AuthRateLimitBucket" (
            "keyHash",
            "attemptCount",
            "resetAt",
            "updatedAt"
          )
          VALUES (
            ${input.keyHash},
            1,
            ${input.resetAt},
            ${input.now}
          )
          ON CONFLICT ("keyHash") DO UPDATE
          SET
            "attemptCount" = CASE
              WHEN "AuthRateLimitBucket"."resetAt" <= ${input.now} THEN 1
              ELSE LEAST(
                "AuthRateLimitBucket"."attemptCount" + 1,
                CAST(${input.maxAttempts + 1} AS INTEGER)
              )
            END,
            "resetAt" = CASE
              WHEN "AuthRateLimitBucket"."resetAt" <= ${input.now} THEN ${input.resetAt}
              ELSE "AuthRateLimitBucket"."resetAt"
            END,
            "updatedAt" = ${input.now}
          RETURNING "attemptCount", "resetAt"
        `
      );
      const bucket = rows[0];

      if (!bucket) {
        throw new Error("auth_rate_limit_bucket_missing");
      }

      return bucket;
    },
    async delete(keyHash) {
      await prisma.$executeRaw(
        Prisma.sql`DELETE FROM "AuthRateLimitBucket" WHERE "keyHash" = ${keyHash}`
      );
    },
    async pruneExpired(now) {
      await prisma.$executeRaw(
        Prisma.sql`DELETE FROM "AuthRateLimitBucket" WHERE "resetAt" <= ${now}`
      );
    }
  };
}

export function createPrismaLoginRateLimiter(input: {
  clock?: () => number;
  keySecret: () => string;
  maxAttempts?: number;
  prisma: PrismaRateLimitClient;
  sweepIntervalMs?: number;
  windowMs?: number;
}): LoginRateLimiter {
  return createDurableLoginRateLimiter({
    clock: input.clock,
    keySecret: input.keySecret,
    maxAttempts: input.maxAttempts,
    store: createPrismaLoginRateLimitStore(input.prisma),
    sweepIntervalMs: input.sweepIntervalMs,
    windowMs: input.windowMs
  });
}

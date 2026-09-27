import type { DurableLoginRateLimitStore } from "@/lib/server/auth/prismaRateLimit";

export type MemoryDurableLoginRateLimitStore = DurableLoginRateLimitStore & {
  buckets: Map<string, { attemptCount: number; resetAt: Date }>;
};

/**
 * In-memory mirror of the Prisma rate-limit statements. It also enforces the table's
 * `AuthRateLimitBucket_attemptCount_check` (attemptCount >= 1), so handler tests fail
 * where PostgreSQL would reject a write.
 */
export function createMemoryDurableLoginRateLimitStore(): MemoryDurableLoginRateLimitStore {
  const buckets = new Map<string, { attemptCount: number; resetAt: Date }>();

  function store(keyHash: string, bucket: { attemptCount: number; resetAt: Date }) {
    if (!Number.isInteger(bucket.attemptCount) || bucket.attemptCount < 1) {
      throw new Error("AuthRateLimitBucket_attemptCount_check");
    }

    buckets.set(keyHash, bucket);
    return bucket;
  }

  return {
    buckets,
    async consume(input) {
      const existing = buckets.get(input.keyHash);

      return store(input.keyHash, existing && existing.resetAt > input.now
        ? {
            attemptCount: existing.attemptCount > input.maxAttempts
              ? existing.attemptCount
              : existing.attemptCount + 1,
            resetAt: existing.resetAt
          }
        : {
            attemptCount: 1,
            resetAt: input.resetAt
          });
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
        store(input.keyHash, {
          attemptCount: Math.max(bucket.attemptCount - 1, 1),
          resetAt: bucket.attemptCount <= 1 ? input.now : bucket.resetAt
        });
      }
    }
  };
}

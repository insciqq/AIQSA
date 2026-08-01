export const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 10;
export const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export type LoginRateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export type LoginRateLimiter = {
  check(key: string): Promise<LoginRateLimitDecision>;
  reset(key: string): Promise<void>;
};

export type LoginRateLimiterOptions = {
  clock?: () => number;
  maxBuckets?: number;
  maxAttempts?: number;
  sweepIntervalMs?: number;
  store?: Map<string, LoginRateLimitBucket>;
  windowMs?: number;
};

export type LoginRateLimitBucket = {
  count: number;
  resetAtMs: number;
};

export function resolveLoginRateLimiter(
  configured: LoginRateLimiter | undefined,
  testFallback: LoginRateLimiter
): LoginRateLimiter {
  if (configured) {
    return configured;
  }

  if (process.env.NODE_ENV === "test") {
    return testFallback;
  }

  throw new Error("auth_rate_limiter_not_configured");
}

export function createFixedWindowLoginRateLimiter(
  options: LoginRateLimiterOptions = {}
): LoginRateLimiter {
  const clock = options.clock ?? Date.now;
  const maxBuckets = Math.max(1, options.maxBuckets ?? 4096);
  const maxAttempts = options.maxAttempts ?? LOGIN_RATE_LIMIT_MAX_ATTEMPTS;
  const store = options.store ?? new Map<string, LoginRateLimitBucket>();
  const windowMs = options.windowMs ?? LOGIN_RATE_LIMIT_WINDOW_MS;
  const sweepIntervalMs = Math.max(1, options.sweepIntervalMs ?? Math.min(windowMs, 60 * 1000));
  let nextSweepAtMs = 0;

  function sweepExpired(now: number) {
    if (now < nextSweepAtMs) {
      return;
    }

    for (const [key, bucket] of store) {
      if (bucket.resetAtMs <= now) {
        store.delete(key);
      }
    }

    nextSweepAtMs = now + sweepIntervalMs;
  }

  function evictOneBucket() {
    let evictKey: string | null = null;
    let oldestResetAt = Number.POSITIVE_INFINITY;

    for (const [key, bucket] of store) {
      if (bucket.resetAtMs < oldestResetAt) {
        evictKey = key;
        oldestResetAt = bucket.resetAtMs;
      }
    }

    if (evictKey) {
      store.delete(evictKey);
    }
  }

  function makeSpaceFor(key: string, now: number) {
    if (store.has(key) || store.size < maxBuckets) {
      return;
    }

    sweepExpired(now);

    if (!store.has(key) && store.size >= maxBuckets) {
      evictOneBucket();
    }
  }

  return {
    async check(key: string) {
      const now = clock();
      sweepExpired(now);
      const existing = store.get(key);
      const bucket =
        existing && existing.resetAtMs > now
          ? existing
          : {
              count: 0,
              resetAtMs: now + windowMs
            };

      if (bucket.count >= maxAttempts) {
        makeSpaceFor(key, now);
        store.set(key, bucket);

        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAtMs - now) / 1000))
        };
      }

      bucket.count += 1;
      makeSpaceFor(key, now);
      store.set(key, bucket);

      return {
        allowed: true,
        retryAfterSeconds: Math.max(0, Math.ceil((bucket.resetAtMs - now) / 1000))
      };
    },
    async reset(key: string) {
      store.delete(key);
    }
  };
}

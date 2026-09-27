import { describe, expect, it } from "vitest";
import { createMemoryDurableLoginRateLimitStore } from "@/tests/support/authRateLimit";
import {
  createDurableLoginRateLimiter,
  hashAuthRateLimitKey
} from "./prismaRateLimit";

describe("durable auth rate limiter", () => {
  it("stores only an installation-keyed digest", async () => {
    const store = createMemoryDurableLoginRateLimitStore();
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
    const store = createMemoryDurableLoginRateLimitStore();
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
    const store = createMemoryDurableLoginRateLimitStore();
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

  it("closes the window when a window's only attempt is released", async () => {
    let now = 0;
    const store = createMemoryDurableLoginRateLimitStore();
    const limiter = createDurableLoginRateLimiter({
      clock: () => now,
      keySecret: () => "installation-secret",
      maxAttempts: 2,
      store,
      windowMs: 1_000
    });
    const bucket = () => [...store.buckets.values()][0];

    expect((await limiter.check("source")).allowed).toBe(true);
    now = 400;
    await expect(limiter.release("source")).resolves.toBeUndefined();
    await expect(limiter.release("source")).resolves.toBeUndefined();
    expect(bucket()).toEqual({ attemptCount: 1, resetAt: new Date(400) });

    // The next check counts from 1 in a fresh window, not 2 in the released one.
    expect(await limiter.check("source")).toEqual({ allowed: true, retryAfterSeconds: 1 });
    expect(bucket()).toEqual({ attemptCount: 1, resetAt: new Date(1_400) });
    expect((await limiter.check("source")).allowed).toBe(true);
    expect((await limiter.check("source")).allowed).toBe(false);
  });
});

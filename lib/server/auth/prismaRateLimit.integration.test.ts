import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { createPrismaLoginRateLimiter } from "./prismaRateLimit";

const integrationEnabled = process.env.AIQSA_AUTH_RATE_LIMIT_INTEGRATION_TEST === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("PostgreSQL auth rate limiter", () => {
  it("atomically shares admission across clients and a reconstructed limiter", async () => {
    const firstClient = new PrismaClient();
    const secondClient = new PrismaClient();
    const logicalKey = `integration:${randomUUID()}`;
    const options = {
      keySecret: () => "auth-rate-limit-integration-secret",
      maxAttempts: 10,
      sweepIntervalMs: 60_000,
      windowMs: 60_000
    };
    const firstProcess = createPrismaLoginRateLimiter({
      ...options,
      prisma: firstClient
    });
    const secondProcess = createPrismaLoginRateLimiter({
      ...options,
      prisma: secondClient
    });

    try {
      const decisions = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          (index % 2 === 0 ? firstProcess : secondProcess).check(logicalKey)
        )
      );

      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(10);
      await firstClient.$disconnect();

      const restartedClient = new PrismaClient();
      try {
        const restartedProcess = createPrismaLoginRateLimiter({
          ...options,
          prisma: restartedClient
        });
        expect((await restartedProcess.check(logicalKey)).allowed).toBe(false);
        await restartedProcess.reset(logicalKey);
        expect((await restartedProcess.check(logicalKey)).allowed).toBe(true);
        await restartedProcess.reset(logicalKey);
      } finally {
        await restartedClient.$disconnect();
      }
    } finally {
      await Promise.allSettled([
        firstProcess.reset(logicalKey),
        secondProcess.reset(logicalKey)
      ]);
      await Promise.allSettled([
        firstClient.$disconnect(),
        secondClient.$disconnect()
      ]);
    }
  });
});

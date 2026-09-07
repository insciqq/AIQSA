import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createTestPasswordIdentity } from "@/tests/support/auth";
import { createMemoryAuthMailer } from "@/tests/support/authMailers";
import { getAuthConfig } from "./config";
import { createPasswordResetRequestHandler } from "./handlers";
import { createPrismaPasswordAuthRepository } from "./passwordRepository";
import { hashToken } from "./token";

describe("password reset token admission", () => {
  it.each([
    "unchanged", "deleted", "email_changed", "owner_changed", "disabled", "unverified", "provider_changed"
  ])("dispatches only a committed token when identity is %s at the lock", async (change) => {
    const identity = { ...createTestPasswordIdentity(), provider: "password" };
    const lockedIdentity = change === "deleted" ? null : {
      ...identity,
      ...(change === "email_changed" ? { normalizedEmail: "changed@example.invalid" } : {}),
      ...(change === "owner_changed" ? { userId: "different-user" } : {}),
      ...(change === "unverified" ? { emailVerifiedAt: null } : {}),
      ...(change === "provider_changed" ? { provider: "google" } : {}),
      user: { ...identity.user, ...(change === "disabled" ? { status: "disabled" } : {}) }
    };
    const createToken = vi.fn(async () => ({}));
    const mailer = createMemoryAuthMailer();
    const tx = {
      $queryRaw: vi.fn(async () => []),
      authIdentity: { findUnique: vi.fn(async () => lockedIdentity) },
      authFlowToken: { create: createToken }
    };
    const client = {
      // The request reads a valid identity; a competing update wins before
      // token creation re-reads it under the existing transaction lock.
      authIdentity: { findUnique: vi.fn(async () => identity) },
      $transaction: async (work: (transaction: typeof tx) => Promise<unknown>) => {
        const result = await work(tx);
        expect(mailer.sent).toHaveLength(0);
        return result;
      }
    } as unknown as PrismaClient;
    const sleep = vi.fn(async () => undefined);
    const POST = createPasswordResetRequestHandler({
      clock: () => 1_000,
      getConfig: () => getAuthConfig({ AIQSA_AUTH_SESSION_SECRET: "test-secret" }),
      mailer,
      repository: createPrismaPasswordAuthRepository(client),
      responseFloorMs: 75,
      sleep
    });

    const response = await POST(new Request("http://app.local/api/auth/password-reset/request", {
      body: JSON.stringify({ email: identity.normalizedEmail }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(75);
    if (change === "unchanged") {
      expect(mailer.sent).toHaveLength(1);
      const token = mailer.sent[0].text.match(/\?reset=([^\s]+)/)?.[1];
      expect(token).toBeTruthy();
      expect(createToken).toHaveBeenCalledWith({
        data: expect.objectContaining({
          identityId: identity.id,
          normalizedEmail: identity.normalizedEmail,
          purpose: "password_reset",
          tokenHash: hashToken(token!),
          userId: identity.userId
        })
      });
    } else {
      expect(createToken).not.toHaveBeenCalled();
      expect(mailer.sent).toHaveLength(0);
    }
  });
});

import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createPrismaSecondFactorSignInRepository, createPrismaTotpEnrolmentRepository } from "./totpRepository";

const keys = { encryptionKey: "unused" } as never;
const now = new Date("2026-11-12T00:00:00.000Z");

/** A transaction whose account is a service account with a planted, usable password identity. */
function serviceAccountClient() {
  const factorAccess = vi.fn(() => {
    throw new Error("read or wrote the factor of a service account");
  });
  const tx = {
    $queryRaw: vi.fn(async () => []),
    authIdentity: {
      findUnique: vi.fn(async () => ({
        emailVerifiedAt: now,
        id: "identity-1",
        passwordHash: "stored-hash",
        provider: "password",
        user: { id: "service-1", kind: "service", status: "active" },
        userId: "service-1"
      }))
    },
    authTotpFactor: { create: factorAccess, findUnique: factorAccess, update: factorAccess, upsert: factorAccess },
    user: {
      findUnique: vi.fn(async () => ({
        authIdentities: [{ id: "identity-1" }],
        displayName: "Discord",
        email: null,
        kind: "service",
        status: "active"
      }))
    }
  };
  const client = {
    $transaction: async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx)
  } as unknown as PrismaClient;
  return { client, factorAccess };
}

describe("two-factor sign-in of a service account", () => {
  it("never starts or confirms enrolment", async () => {
    const { client, factorAccess } = serviceAccountClient();
    const repository = createPrismaTotpEnrolmentRepository(client);

    await expect(repository.start({ keys, now, proof: null, userId: "service-1" })).resolves.toEqual({ kind: "not_available" });
    await expect(repository.confirm({ code: "123456", keys, now, userId: "service-1" } as never))
      .resolves.toEqual({ kind: "not_available" });
    expect(factorAccess).not.toHaveBeenCalled();
  });

  it("never completes a second-factor sign-in", async () => {
    const { client, factorAccess } = serviceAccountClient();

    await expect(createPrismaSecondFactorSignInRepository(client).completeSecondFactorSignIn({
      attempt: { code: "123456" } as never,
      challenge: { identityId: "identity-1", signInMethod: "password", userId: "service-1" },
      keys,
      matchesChallenge: () => true,
      now,
      session: { expiresAt: now, tokenHash: "session-hash" }
    })).resolves.toEqual({ kind: "challenge_expired" });
    expect(factorAccess).not.toHaveBeenCalled();
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../../prisma";
import { memoryPropositionCanonicalKey } from "./normalization";
import {
  memoryLegacyIdentityIsUnambiguous,
  registerMemoryIdentityCompatibility
} from "./compatibility";
import { createPrismaMemoryIdentityCutoverRepository } from "./cutover";

describe("Memory identity compatibility ledger", () => {
  afterAll(async () => prisma.$disconnect());

  it("detects a legacy collision using aggregate content-free evidence", async () => {
    const userId = `memory-identity-${randomUUID()}`;
    await prisma.user.create({
      data: {
        displayName: "Identity compatibility fixture",
        email: `${userId}@example.test`,
        id: userId,
        status: "active"
      }
    });
    try {
      const scope = await prisma.memoryScope.create({
        data: { scopeType: "GLOBAL_USER", userId }
      });
      const legacyCanonicalKey = memoryPropositionCanonicalKey(
        "Ёлка",
        "LEGACY_V1"
      )!;
      const firstUnicodeKey = memoryPropositionCanonicalKey(
        "Ёлка",
        "UNICODE_V2"
      )!;
      const secondUnicodeKey = memoryPropositionCanonicalKey(
        "Елка",
        "UNICODE_V2"
      )!;
      await prisma.memoryFact.create({
        data: {
          canonicalKey: legacyCanonicalKey,
          category: "other",
          id: randomUUID(),
          identityKind: "PROPOSITION",
          identityVersion: "proposition-v1",
          scopeId: scope.id,
          state: "ORPHANED",
          userId
        }
      });
      await prisma.memoryFact.create({
        data: {
          canonicalKey: memoryPropositionCanonicalKey(
            "Derived source-set pattern",
            "LEGACY_V1"
          )!,
          category: "patterns",
          id: randomUUID(),
          identityKind: "PROPOSITION",
          identityVersion: "proposition-v1",
          scopeId: scope.id,
          state: "ORPHANED",
          userId
        }
      });
      const observedAt = new Date("2026-08-31T00:00:00.000Z");
      await prisma.$transaction(async (tx) => {
        await registerMemoryIdentityCompatibility(tx, {
          containerId: scope.id,
          legacyCanonicalKey,
          namespace: "FACT",
          now: observedAt,
          unicodeCanonicalKey: firstUnicodeKey,
          userId
        });
        await expect(memoryLegacyIdentityIsUnambiguous(tx, {
          containerId: scope.id,
          legacyCanonicalKey,
          namespace: "FACT",
          unicodeCanonicalKey: firstUnicodeKey,
          userId
        })).resolves.toBe(true);
      });
      const cutover = createPrismaMemoryIdentityCutoverRepository(prisma);
      await expect(cutover.inventory(userId)).resolves.toMatchObject({
        collidingLegacyFactKeys: 0,
        legacyFactCount: 1,
        mappedLegacyFactCount: 1,
        readyForUnicodeWrites: true,
        unmappedLegacyFactCount: 0
      });

      await prisma.$transaction(async (tx) => {
        await registerMemoryIdentityCompatibility(tx, {
          containerId: scope.id,
          legacyCanonicalKey,
          namespace: "FACT",
          now: new Date(observedAt.getTime() + 1_000),
          unicodeCanonicalKey: secondUnicodeKey,
          userId
        });
        await expect(memoryLegacyIdentityIsUnambiguous(tx, {
          containerId: scope.id,
          legacyCanonicalKey,
          namespace: "FACT",
          unicodeCanonicalKey: firstUnicodeKey,
          userId
        })).resolves.toBe(false);
      });
      const inventory = await cutover.inventory(userId);
      expect(inventory).toMatchObject({
        collidingLegacyFactKeys: 1,
        readyForUnicodeWrites: false
      });
      expect(JSON.stringify(inventory)).not.toContain(userId);
      expect(JSON.stringify(inventory)).not.toContain(legacyCanonicalKey);
      expect(JSON.stringify(inventory)).not.toContain(firstUnicodeKey);
      await expect(cutover.assertActivationReady(userId))
        .rejects.toThrow("memory_identity_activation_not_ready");
    } finally {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});

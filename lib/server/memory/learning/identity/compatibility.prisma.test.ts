import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../../prisma";
import { memoryPropositionCanonicalKey } from "./normalization";
import { memoryGroundedEntityCanonicalKey } from "../entities/normalization";
import {
  memoryLegacyIdentityIsUnambiguous,
  memoryRecordedLegacyIdentityKeys,
  registerMemoryIdentityCompatibility
} from "./compatibility";
import { createPrismaMemoryIdentityCutoverRepository } from "./cutover";

describe("Memory identity compatibility ledger", () => {
  afterAll(async () => prisma.$disconnect());

  it("resolves recorded entity keys within their namespace and fences collisions", async () => {
    const userId = `memory-entity-identity-${randomUUID()}`;
    await prisma.user.create({ data: {
      displayName: "Entity identity fixture", email: `${userId}@example.test`,
      id: userId, status: "active"
    } });
    try {
      const legacyCanonicalKey = "entity:v3:product-device:caf";
      const unicodeCanonicalKey = memoryGroundedEntityCanonicalKey({
        entityType: "PRODUCT", mention: "cafè", mentionKind: "NAMED"
      })!;
      await prisma.memoryEntity.create({ data: {
        canonicalKey: legacyCanonicalKey, displayName: "cafè", entityType: "PRODUCT",
        id: randomUUID(), userId
      } });
      const lookup = { containerId: "ENTITY", namespace: "GROUNDED_ENTITY" as const,
        unicodeCanonicalKey, userId };
      await prisma.$transaction(async (tx) => {
        await expect(memoryRecordedLegacyIdentityKeys(tx, lookup)).resolves.toEqual([]);
        await registerMemoryIdentityCompatibility(tx, {
          ...lookup, legacyCanonicalKey, now: new Date()
        });
        await expect(memoryRecordedLegacyIdentityKeys(tx, lookup))
          .resolves.toEqual([{ canonicalKey: legacyCanonicalKey, unambiguous: true }]);
        for (const invalid of [{ ...lookup, namespace: "LABEL_ENTITY" as const },
          { ...lookup, userId: randomUUID() }, { ...lookup, containerId: randomUUID() }]) {
          await expect(memoryRecordedLegacyIdentityKeys(tx, invalid)).resolves.toEqual([]);
        }
        await registerMemoryIdentityCompatibility(tx, {
          ...lookup, legacyCanonicalKey, now: new Date(),
          unicodeCanonicalKey: memoryGroundedEntityCanonicalKey({
            entityType: "PRODUCT", mention: "caf", mentionKind: "NAMED"
          })!
        });
        await expect(memoryRecordedLegacyIdentityKeys(tx, lookup))
          .resolves.toEqual([{ canonicalKey: legacyCanonicalKey, unambiguous: false }]);
      });
      await expect(prisma.memoryEntity.findFirstOrThrow({
        select: { canonicalKey: true, displayName: true }, where: { userId }
      })).resolves.toEqual({ canonicalKey: legacyCanonicalKey, displayName: "cafè" });
    } finally { await prisma.user.deleteMany({ where: { id: userId } }); }
  });

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
      const legacyCanonicalKey = `prop:v1:${"a".repeat(64)}`;
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
          canonicalKey: `prop:v1:${"b".repeat(64)}`,
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
      const lookup = { containerId: scope.id, namespace: "FACT" as const,
        unicodeCanonicalKey: firstUnicodeKey, userId };
      await expect(prisma.$transaction((tx) => memoryRecordedLegacyIdentityKeys(tx, lookup)))
        .resolves.toEqual([{ canonicalKey: legacyCanonicalKey, unambiguous: true }]);
      for (const invalid of [{ ...lookup, containerId: randomUUID() },
        { ...lookup, userId: randomUUID() }, { ...lookup, namespace: "LABEL_ENTITY" as const }]) {
        await expect(prisma.$transaction((tx) => memoryRecordedLegacyIdentityKeys(tx, invalid)))
          .resolves.toEqual([]);
      }
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
      await expect(prisma.$transaction((tx) => memoryRecordedLegacyIdentityKeys(tx, lookup)))
        .resolves.toEqual([{ canonicalKey: legacyCanonicalKey, unambiguous: false }]);
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

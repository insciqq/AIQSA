import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { prisma } from "../../prisma";
import { createPrismaRetentionRepository, runObjectDeletionPass } from "../../retention/prune";
import { createAdminKnowledgeOperationsService } from "./operationsService";

const DAY_SECONDS = 24 * 60 * 60;

describe("administrator Knowledge operations projection", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("reads aggregate operational evidence without projecting private content", async () => {
    const result = await createAdminKnowledgeOperationsService(prisma).read();

    expect(result.checkedAt).toSatisfy((value: string) => Number.isFinite(Date.parse(value)));
    expect(result.ingestion.pendingArtifacts).toBeGreaterThanOrEqual(0);
    expect(result.retrieval.operations24h).toBeGreaterThanOrEqual(0);
    expect(result.migration.discrepancies).toBeGreaterThanOrEqual(0);
    expect(result.deletion.unclaimedObjects).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result)).not.toMatch(
      /"(?:fileName|sourceName|baseName|query|excerpt|storageKey|providerText)"/u
    );
  });

  it("ages only due object deletions and clears once the background pass drains them", async () => {
    const user = await prisma.user.create({
      data: {
        displayName: "Operations Test",
        email: `operations-${randomUUID()}@example.test`,
        status: "active"
      }
    });
    const dueAt = new Date("1998-01-01T00:00:00.000Z");
    const dueKey = `operations/due-${randomUUID()}`;
    const referencedKey = `operations/referenced-${randomUUID()}`;
    const claimedKey = `operations/claimed-${randomUUID()}`;
    await prisma.attachment.create({
      data: {
        byteSize: 4,
        fileName: "kept.txt",
        kind: "document",
        metadata: {},
        mimeType: "text/plain",
        storageKey: referencedKey,
        userId: user.id
      }
    });
    // Older referenced and live-claimed jobs must not count as stalled work.
    await prisma.attachmentDeletionJob.createMany({
      data: [
        { createdAt: dueAt, storageKey: dueKey },
        { createdAt: new Date("1990-01-01T00:00:00.000Z"), storageKey: referencedKey },
        {
          claimToken: randomUUID(),
          claimedAt: new Date(),
          createdAt: new Date("1994-01-01T00:00:00.000Z"),
          storageKey: claimedKey
        }
      ]
    });
    const ageOf = (checkedAt: string, createdAt: Date) =>
      (Date.parse(checkedAt) - createdAt.getTime()) / 1000;

    try {
      const stalled = await createAdminKnowledgeOperationsService(prisma).read();
      const dueAge = ageOf(stalled.checkedAt, dueAt);
      expect(stalled.deletion.unclaimedObjects).toBeGreaterThanOrEqual(1);
      // A day of tolerance absorbs a session time zone; the excluded jobs are years older.
      expect(stalled.deletion.oldestUnclaimedObjectSeconds).toBeGreaterThan(dueAge - DAY_SECONDS);
      expect(stalled.deletion.oldestUnclaimedObjectSeconds).toBeLessThan(dueAge + DAY_SECONDS);
      expect(stalled.alerts).toContainEqual({ code: "knowledge_object_deletion_stalled", severity: "critical" });

      await runObjectDeletionPass({
        repository: createPrismaRetentionRepository(prisma),
        storage: createMemoryStorageAdapter()
      });
      await expect(prisma.attachmentDeletionJob.count({ where: { storageKey: dueKey } })).resolves.toBe(0);
      await expect(prisma.attachmentDeletionJob.count({
        where: { storageKey: { in: [claimedKey, referencedKey] } }
      })).resolves.toBe(2);

      const drained = await createAdminKnowledgeOperationsService(prisma).read();
      if (drained.deletion.oldestUnclaimedObjectSeconds !== null) {
        expect(drained.deletion.oldestUnclaimedObjectSeconds)
          .toBeLessThan(ageOf(drained.checkedAt, dueAt) - DAY_SECONDS);
      }
    } finally {
      await prisma.attachmentDeletionJob.deleteMany({
        where: { storageKey: { in: [dueKey, referencedKey, claimedKey] } }
      });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });
});

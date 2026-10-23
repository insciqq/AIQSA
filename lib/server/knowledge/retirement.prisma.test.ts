// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../prisma";
import { drainKnowledgeDeletionJobs } from "./deletionProcessor";
import { createKnowledgeRetirement } from "./retirement";

async function owned(ownerUserId: string) {
  const [bases, sources, jobs] = await Promise.all([
    prisma.knowledgeBase.count({ where: { ownerUserId } }),
    prisma.knowledgeSource.count({ where: { ownerUserId } }),
    prisma.knowledgeDeletionJob.count({ where: { ownerUserId } })
  ]);
  return { bases, jobs, sources };
}

describe("Knowledge retirement over PostgreSQL", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("deletes an owner's remaining bases and documents through the deletion path and clears its obligations", async () => {
    const ownerUserId = `knowledge-retirement-${randomUUID()}`;
    await prisma.user.create({ data: { displayName: "Retirement fixture", id: ownerUserId, status: "active" } });
    try {
      const base = await prisma.knowledgeBase.create({ data: { name: "PRIVATE_BASE", ownerUserId } });
      const source = await prisma.knowledgeSource.create({ data: { name: "PRIVATE_SOURCE", ownerUserId } });
      await prisma.knowledgeBaseSource.create({ data: { knowledgeBaseId: base.id, ownerUserId, sourceId: source.id } });
      const searchDeletion = vi.fn(async () => undefined);
      const dropSearchIndex = vi.fn(async () => undefined);
      const retire = createKnowledgeRetirement({
        client: prisma,
        drain: () => drainKnowledgeDeletionJobs({ client: prisma, limit: 100, searchDeletion }),
        dropSearchIndex,
        ownerBatch: 100
      });

      // The first pass stages and drains; later passes clear settled obligations.
      for (let pass = 0; pass < 10; pass += 1) {
        const counts = await owned(ownerUserId);
        if (counts.bases + counts.sources + counts.jobs === 0) break;
        await retire();
      }

      expect(await owned(ownerUserId)).toEqual({ bases: 0, jobs: 0, sources: 0 });
      expect(await prisma.knowledgeBaseSource.count({ where: { knowledgeBaseId: base.id } })).toBe(0);
      // Retirement removes Knowledge, never the account that owned it.
      expect(await prisma.user.count({ where: { id: ownerUserId } })).toBe(1);
    } finally {
      await prisma.knowledgeDeletionJob.deleteMany({ where: { ownerUserId } });
      await prisma.knowledgeBaseSource.deleteMany({ where: { ownerUserId } });
      await prisma.knowledgeSource.deleteMany({ where: { ownerUserId } });
      await prisma.knowledgeBase.deleteMany({ where: { ownerUserId } });
      await prisma.user.deleteMany({ where: { id: ownerUserId } });
    }
  });
});

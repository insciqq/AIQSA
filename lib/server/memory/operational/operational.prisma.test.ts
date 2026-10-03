import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { createAutomaticMaintenanceFact, createMaintenanceMessage } from "@/tests/support/memoryMaintenance";
import { prisma } from "../../prisma";
import { MEMORY_MAINTENANCE_POLICY_VERSION } from "../maintenance/policy";
import { memorySha256 } from "../persistence/lexical";
import { MEMORY_OPERATIONAL_COUNTER_KEYS } from "./counters";
import { loadMemorySemanticCutoverInventory } from "./cutover";
import { loadMemoryOperationalSnapshot } from "./snapshot";

const from = new Date("2099-01-01T00:00:00.000Z");
const completedAt = new Date("2099-01-01T00:00:03.000Z");
const to = new Date("2099-01-01T00:01:00.000Z");

afterAll(async () => {
  await prisma.$disconnect();
});

async function createOwner(): Promise<string> {
  const marker = `memory-operational-private-${randomUUID()}`;
  await prisma.user.create({
    data: {
      displayName: marker,
      email: `${marker}@example.test`,
      id: marker,
      status: "active"
    }
  });
  return marker;
}

async function cleanupOwner(userId: string): Promise<void> {
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

describe("Memory operational PostgreSQL contracts", () => {
  it("commits every current operational counter with the completed job", async () => {
    const userId = await createOwner();
    const jobId = randomUUID();
    const counters = Object.fromEntries(
      MEMORY_OPERATIONAL_COUNTER_KEYS.map((key) => [key, 1])
    );
    try {
      await prisma.memoryJob.create({
        data: {
          id: jobId,
          idempotencyFingerprint: memorySha256({ jobId, userId }),
          kind: "CONSOLIDATE_CANDIDATE",
          memoryGenerationSnapshot: 0,
          memoryRevisionSnapshot: 0,
          pipelineVersion: "memory-operational-test-v1",
          state: "QUEUED",
          userId
        }
      });
      await prisma.memoryJob.update({
        data: {
          completedAt: new Date(),
          operationalCounters: counters,
          state: "SUCCEEDED"
        },
        where: { id: jobId }
      });
      const persisted = await prisma.memoryJob.findUniqueOrThrow({
        select: { operationalCounters: true, state: true },
        where: { id: jobId }
      });
      expect(persisted).toEqual({
        operationalCounters: counters,
        state: "SUCCEEDED"
      });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("reports only aggregate counters and inventories retired work", async () => {
    const userId = await createOwner();
    const jobId = randomUUID();
    try {
      const beforeInventory = await loadMemorySemanticCutoverInventory(prisma);
      await prisma.memoryJob.create({
        data: {
          createdAt: new Date("2099-01-01T00:00:01.000Z"),
          id: jobId,
          idempotencyFingerprint: memorySha256({ jobId, userId }),
          kind: "CONSOLIDATE_CANDIDATE",
          memoryGenerationSnapshot: 0,
          memoryRevisionSnapshot: 0,
          pipelineVersion: "memory-operational-private-pipeline-v1",
          state: "QUEUED",
          userId
        }
      });

      const queuedInventory = await loadMemorySemanticCutoverInventory(prisma);
      expect(queuedInventory.legacyNonterminalJobs)
        .toBe(beforeInventory.legacyNonterminalJobs + 1);
      expect(queuedInventory.total).toBe(beforeInventory.total + 1);

      await prisma.memoryJob.update({
        data: {
          completedAt,
          operationalCounters: {
            digestIncremental: 1,
            digestNoop: 2,
            contextualProviderRequests: 1,
            contextualFallbackDeclared: 2,
            contextualFallbackUnsupportedNumber: 2,
            contextualGeneratedDeclared: 4,
            contextualGeneratedMixed: 6,
            contextualRoundsFallback: 2,
            contextualRoundsGenerated: 6,
            embeddingBatchItems: 16,
            embeddingFailedItems: 1,
            embeddingProviderRequests: 1,
            embeddingSettledItems: 14,
            embeddingStaleItems: 1,
            historyChunksBuilt: 3,
            historyChunksReplaced: 4,
            historyChunksReused: 5,
            historyMessagesProjected: 5,
            historyRoundSegmentsBuilt: 12,
            historyRoundSegmentsReplaced: 3,
            historyRoundSegmentsReused: 7,
            historyRoundsBuilt: 6,
            historyRoundsReplaced: 7,
            historyRoundsReused: 8
          },
          state: "SUCCEEDED"
        },
        where: { id: jobId }
      });

      const snapshot = await loadMemoryOperationalSnapshot(prisma, { from, to });
      expect(snapshot.history).toEqual({
        chunksBuilt: 3,
        chunksReplaced: 4,
        chunksReused: 5,
        contextualProviderRequests: 1,
        contextualFallbackReasons: [{
          code: "contextualFallbackUnsupportedNumber",
          count: 2
        }],
        contextualLanguageCounts: [{
          code: "contextualFallbackDeclared",
          count: 2
        }, {
          code: "contextualGeneratedDeclared",
          count: 4
        }, {
          code: "contextualGeneratedMixed",
          count: 6
        }],
        contextualRoundsFallback: 2,
        contextualRoundsGenerated: 6,
        digestFullRebuild: 0,
        digestIncremental: 1,
        digestNoop: 2,
        messagesProjected: 5,
        recallRoundLongCount: 0,
        recallRoundMaxSegmentCount: 0,
        recallRoundSegmentCount: 0,
        roundSegmentsBuilt: 12,
        roundSegmentsReplaced: 3,
        roundSegmentsReused: 7,
        roundsBuilt: 6,
        roundsReplaced: 7,
        roundsReused: 8
      });
      expect(snapshot).not.toHaveProperty("patterns");
      expect(snapshot.embeddings).toEqual({
        batchItems: 16,
        failedItems: 1,
        providerRequests: 1,
        settledItems: 14,
        staleItems: 1
      });
      expect(snapshot.latencies).toContainEqual({
        p50Ms: 2_000,
        p95Ms: 2_000,
        samples: 1,
        stage: "job.CONSOLIDATE_CANDIDATE"
      });
      const serialized = JSON.stringify({ queuedInventory, snapshot });
      expect(serialized).not.toContain(userId);
      expect(serialized).not.toContain("memory-operational-private-pipeline-v1");
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("reports content-free current-policy maintenance outcomes by reason", async () => {
    const active = await createOwner();
    const paused = await createOwner();
    try {
      const before = await loadMemoryOperationalSnapshot(prisma, { from, to });
      const versions = new Map<string, string>();
      const jobs = new Map<string, string>();
      for (const userId of [active, paused]) {
        await prisma.memoryScope.create({ data: { scopeType: "GLOBAL_USER", userId } });
        const source = await createMaintenanceMessage(userId, "A synthetic maintenance source.");
        versions.set(userId, (await createAutomaticMaintenanceFact(userId, [{ statement: source.text, source }])).currentVersionId);
        jobs.set(userId, (await prisma.memoryJob.create({ data: { userId, kind: "SYNTHESIZE_MEMORIES",
          pipelineVersion: "memory-maintenance-v1", idempotencyFingerprint: memorySha256({ userId, operational: true }),
          memoryGenerationSnapshot: 0, memoryRevisionSnapshot: 0 } })).id);
      }
      await prisma.userMemorySettings.update({ where: { userId: paused }, data: { learnAutomatically: false } });
      const reviewedAt = new Date("2099-01-01T00:00:10.000Z");
      let ordinal = 0;
      const review = (userId: string, data: Readonly<{ disposition?: string; usefulness?: string; reasonCode?: string;
        withJob?: boolean; policyVersion?: string; settled?: boolean }>) => prisma.memoryMaintenanceReview.create({ data: {
        userId, factVersionId: versions.get(userId)!, memoryJobId: data.withJob === false ? null : jobs.get(userId)!,
        policyVersion: data.policyVersion ?? MEMORY_MAINTENANCE_POLICY_VERSION, evidenceThrough: reviewedAt,
        sourceSnapshotHash: (++ordinal).toString(16).padStart(64, "0"), disposition: data.disposition ?? "PENDING",
        usefulness: data.usefulness ?? null, reasonCode: data.reasonCode ?? null,
        reviewedAt: data.settled === false ? null : reviewedAt } });
      await review(active, { disposition: "KEEP", usefulness: "DURABLE" });
      await review(active, { disposition: "REMOVED" });
      await review(active, { disposition: "REJECTED" });
      await review(active, { disposition: "BLOCKED", reasonCode: "pending_relation", withJob: false });
      await review(active, { disposition: "BLOCKED", reasonCode: "source_changed" });
      await review(active, { disposition: "UNREVIEWABLE", reasonCode: "statement_too_long", withJob: false });
      await review(active, { disposition: "STALE" });
      await review(active, { disposition: "UNKNOWN" });
      await review(active, { disposition: "KEEP", usefulness: "ONGOING", policyVersion: "memory-maintenance-policy-v2" });
      await review(active, { settled: false });
      await review(paused, { settled: false });
      const snapshot = await loadMemoryOperationalSnapshot(prisma, { from, to });
      expect(snapshot.version).toBe("memory-operational-snapshot-v7");
      expect(snapshot.maintenance).toEqual({
        blocked: before.maintenance.blocked + 2,
        blockedReasons: [{ code: "pending_relation", count: 1 }, { code: "source_changed", count: 1 }],
        kept: before.maintenance.kept + 1,
        paused: before.maintenance.paused + 1,
        pending: before.maintenance.pending + 1,
        rejected: before.maintenance.rejected + 1,
        removed: before.maintenance.removed + 1,
        reviewed: before.maintenance.reviewed + 3,
        stale: before.maintenance.stale + 1,
        unknown: before.maintenance.unknown + 1,
        unreviewable: before.maintenance.unreviewable + 1,
        unreviewableReasons: [{ code: "statement_too_long", count: 1 }]
      });
      const serialized = JSON.stringify(snapshot.maintenance);
      for (const value of [active, paused, ...versions.values(), ...jobs.values()]) expect(serialized).not.toContain(value);
    } finally {
      await cleanupOwner(active);
      await cleanupOwner(paused);
    }
  });

  it("rejects unknown or invalid durable operational values at the DB boundary", async () => {
    const userId = await createOwner();
    try {
      for (const operationalCounters of [{
        privateContent: "must-not-persist"
      }, {
        contextualGeneratedEn: 1
      }, {
        contextualFallbackGroundingInvalid: -1
      }, {
        contextualFallbackGroundingInvalid: 0.5
      }, {
        contextualFallbackSemanticallyUnsupported: 2_147_483_648
      }, {
        contextualFallbackSemanticallyUnsupported: "1"
      }]) {
        const jobId = randomUUID();
        await expect(prisma.memoryJob.create({
          data: {
            id: jobId,
            idempotencyFingerprint: memorySha256({ jobId, userId }),
            kind: "INDEX_HISTORY",
            memoryGenerationSnapshot: 0,
            memoryRevisionSnapshot: 0,
            operationalCounters: operationalCounters as Prisma.InputJsonObject,
            pipelineVersion: "memory-operational-test-v1",
            state: "SUCCEEDED",
            userId
          }
        })).rejects.toThrow(/MemoryJob_operational_counters_check/u);
      }
    } finally {
      await cleanupOwner(userId);
    }
  });
});

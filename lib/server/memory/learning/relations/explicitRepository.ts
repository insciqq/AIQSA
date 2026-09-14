import { Prisma, type PrismaClient } from "@prisma/client";
import { MemoryCoordinatorError } from "../../coordinator/errors";
import type { MemoryJobClaim, MemoryJobDescriptor, MemoryJobGateDecision } from "../../coordinator/types";
import type { MemoryExecutionAuthorityDependencies } from "../../execution";
import { memoryExecutionSha256 } from "../../execution/canonical";
import { authorizeMemoryExecutionResultsForCommit } from "../../execution/lifecycle";
import { ensureClassifiedSearchEntry } from "../../persistence/factSearchEntry";
import {
  advanceMemoryMutation,
  lockMemorySettings,
  type MemoryTransaction
} from "../../persistence/transaction";
import {
  createPrismaMemoryExplicitRelationAuxiliaryStore,
  type MemoryExplicitRelationRetainedResult
} from "./explicitAuxiliary";
import { createPrismaMemoryExplicitRelationCandidateSearch } from "./explicitCandidates";
import {
  isMemoryExplicitRelationJob,
  MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
  MEMORY_EXPLICIT_RELATION_POLICY_VERSION,
  selectMemoryExplicitRelationMerge,
  type MemoryExplicitRelationSnapshot
} from "./explicitPolicy";
import { assertMemoryExplicitRelationRecoverySnapshot } from "./explicitRecovery";
import {
  loadCurrentMemoryExplicitRelationFacts,
  loadMemoryExplicitRelationSnapshot
} from "./explicitSnapshot";

function stale(): never {
  throw new MemoryCoordinatorError("memory_explicit_relation_snapshot_stale", false);
}

export function createPrismaMemoryExplicitRelationRepository(
  client: PrismaClient,
  authority: MemoryExecutionAuthorityDependencies
) {
  const auxiliary = createPrismaMemoryExplicitRelationAuxiliaryStore(client);
  const candidates = createPrismaMemoryExplicitRelationCandidateSearch(client, authority);
  return Object.freeze({
    loadResult: auxiliary.load,
    persistResult: auxiliary.persist,
    reserve: auxiliary.reserve,

    async preflight(job: MemoryJobDescriptor): Promise<MemoryJobGateDecision> {
      if (!isMemoryExplicitRelationJob(job)) {
        return { status: "CANCELLED", errorCode: "memory_explicit_relation_job_invalid" };
      }
      const source = await loadMemoryExplicitRelationSnapshot(client, job, []);
      return source ? { status: "READY" } : {
        status: "CANCELLED", errorCode: "memory_explicit_relation_source_unavailable"
      };
    },

    async prepare(
      job: MemoryJobClaim,
      now: Date,
      signal: AbortSignal
    ): Promise<MemoryExplicitRelationSnapshot | null> {
      const source = await loadMemoryExplicitRelationSnapshot(client, job, []);
      if (!source) return null;
      const ids = await candidates({ job, now, signal, source: source.snapshot.source });
      signal.throwIfAborted();
      const current = await loadCurrentMemoryExplicitRelationFacts(client, job.userId,
        [job.targetFactVersionId!, ...ids]);
      const currentSource = current.get(job.targetFactVersionId!);
      if (!currentSource || currentSource.memoryGeneration !== job.memoryGenerationSnapshot) return null;
      const selectedFacts = new Set([currentSource.fact.factId]);
      const eligible = ids.flatMap((id) => {
        const fact = current.get(id);
        if (!fact || fact.memoryGeneration !== job.memoryGenerationSnapshot ||
          fact.fact.scopeId !== currentSource.fact.scopeId || selectedFacts.has(fact.fact.factId)) return [];
        selectedFacts.add(fact.fact.factId);
        return [fact.fact];
      });
      return Object.freeze({
        candidates: Object.freeze(eligible),
        memoryGeneration: job.memoryGenerationSnapshot,
        source: currentSource.fact,
        userId: job.userId
      });
    },

    async apply(
      tx: MemoryTransaction,
      claim: MemoryJobClaim,
      result: MemoryExplicitRelationRetainedResult,
      now: Date
    ): Promise<void> {
      if (!isMemoryExplicitRelationJob(claim) || !Number.isFinite(now.getTime()) ||
        result.packet.sourceVersionId !== claim.targetFactVersionId) return stale();
      const settings = await lockMemorySettings(tx, claim.userId, true);
      if (!settings.useMemoryFacts || settings.memoryGeneration !== claim.memoryGenerationSnapshot) return stale();
      const lease = await tx.memoryJob.findFirst({
        select: { id: true },
        where: {
          attemptCount: claim.attemptCount, id: claim.id, kind: "RESOLVE_FACT_RELATIONS",
          leaseExpiresAt: { gt: now }, leaseToken: claim.claimToken,
          memoryGenerationSnapshot: claim.memoryGenerationSnapshot,
          pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
          state: "CLAIMED", targetFactVersionId: claim.targetFactVersionId, userId: claim.userId
        }
      });
      if (!lease) return stale();
      const versionIds = [claim.targetFactVersionId!, ...result.packet.candidateVersionIds];
      const initial = await loadMemoryExplicitRelationSnapshot(tx, claim, result.packet.candidateVersionIds);
      if (!initial) return stale();
      const factIds = [...initial.facts.values()].map(({ fact }) => fact.factId).sort();
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "MemoryFact"
        WHERE "userId" = ${claim.userId} AND "id" IN (${Prisma.join(factIds)})
        ORDER BY "id" FOR UPDATE
      `);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "MemoryFactVersion"
        WHERE "userId" = ${claim.userId} AND "id" IN (${Prisma.join([...versionIds].sort())})
        ORDER BY "id" FOR UPDATE
      `);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "MemoryEvidence"
        WHERE "userId" = ${claim.userId} AND "factVersionId" IN (${Prisma.join(versionIds)})
        ORDER BY "id" FOR SHARE
      `);
      const current = await loadMemoryExplicitRelationSnapshot(tx, claim, result.packet.candidateVersionIds);
      if (!current) return stale();
      assertMemoryExplicitRelationRecoverySnapshot(result.packet, current.snapshot);
      const stored = await tx.memoryAuxiliarySemanticCall.findFirst({
        select: { result: true },
        where: {
          acceptedOutputHash: result.packet.outputHash, completedAt: { not: null },
          executionId: result.bindingId, inputHash: result.packet.inputHash,
          ownerJobId: claim.id, purpose: "EXPLICIT_FACT_EQUIVALENCE",
          targetFactVersionId: claim.targetFactVersionId, userId: claim.userId
        }
      });
      if (!stored || memoryExecutionSha256(stored.result) !== memoryExecutionSha256(result.packet)) return stale();
      await authorizeMemoryExecutionResultsForCommit(authority, tx, settings, claim.userId,
        { memoryJobId: claim.id, role: "MEMORY_CONSOLIDATE" }, [{
          acceptedOutputHash: result.packet.outputHash, bindingId: result.bindingId,
          inputHash: result.packet.inputHash
        }]);
      const merge = selectMemoryExplicitRelationMerge(current.snapshot, result.packet.decisions);
      if (!merge) return;
      const canonical = merge.canonical;
      const sources = [canonical, ...merge.redundant].flatMap(({ versionId }) => current.facts.get(versionId)!.evidence);
      const supportedEvents = new Set(current.facts.get(canonical.versionId)!.evidence.map(({ memoryEventId }) => memoryEventId));
      for (const support of sources) {
        if (supportedEvents.has(support.memoryEventId)) continue;
        supportedEvents.add(support.memoryEventId);
        await tx.memoryEvidence.create({
          data: {
            factVersionId: canonical.versionId,
            id: memoryExecutionSha256({
              domain: "aiqsa.memory.explicit-equivalent-support",
              eventId: support.memoryEventId, userId: claim.userId,
              versionId: canonical.versionId, version: 1
            }),
            memoryEventId: support.memoryEventId,
            observedAt: support.observedAt,
            safeExcerpt: support.safeExcerpt,
            safeSourceHash: support.safeSourceHash,
            safetyClass: support.safetyClass,
            sourceProjectionVersion: support.sourceProjectionVersion,
            sourceType: "EXPLICIT_ACTION", stance: "SUPPORTS", userId: claim.userId
          }
        });
      }
      for (const redundant of merge.redundant) {
        const version = await tx.memoryFactVersion.updateMany({
          data: {
            mergedIntoVersionId: canonical.versionId,
            relationResolvedAt: now,
            relationResolutionVersion: MEMORY_EXPLICIT_RELATION_POLICY_VERSION,
            relationSnapshotHash: result.packet.snapshotHash,
            state: "MERGED",
            systemTo: new Date(Math.max(now.getTime(), Date.parse(redundant.systemFrom) + 1))
          },
          where: {
            factId: redundant.factId, id: redundant.versionId, sourceMode: "EXPLICIT",
            state: "ACTIVE", systemTo: null, userId: claim.userId
          }
        });
        const fact = await tx.memoryFact.updateMany({
          data: { currentVersionId: null, movedToFactId: canonical.factId, state: "RETRACTED" },
          where: {
            currentVersionId: redundant.versionId, id: redundant.factId,
            state: "ACTIVE", userId: claim.userId
          }
        });
        if (version.count !== 1 || fact.count !== 1) return stale();
        const identity = {
          sourceVersionId: redundant.versionId, targetVersionId: canonical.versionId,
          userId: claim.userId, version: 1
        };
        await tx.memoryFactVersionRelation.create({
          data: {
            confidence: 1, executionId: result.bindingId,
            id: memoryExecutionSha256({ domain: "aiqsa.memory.explicit-equivalence", ...identity }),
            kind: "MERGED_INTO", pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
            reasonCode: "explicit_semantic_equivalence",
            sourceVersionId: redundant.versionId, targetVersionId: canonical.versionId,
            userId: claim.userId
          }
        });
        await tx.memoryEvent.create({
          data: {
            actorType: "JOB", factId: redundant.factId, factVersionId: redundant.versionId,
            id: memoryExecutionSha256({ domain: "aiqsa.memory.explicit-equivalence-event", ...identity }),
            metadata: {
              executionId: result.bindingId, pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
              relationSnapshotHash: result.packet.snapshotHash,
              schemaVersion: "memory-explicit-relation-event-v1", targetVersionId: canonical.versionId
            },
            operation: "MERGE", userId: claim.userId
          }
        });
        await tx.memorySearchEntry.deleteMany({
          where: { factVersionId: redundant.versionId, userId: claim.userId }
        });
      }
      const confirmedAt = new Date(sources.reduce((latest, { observedAt }) =>
        Math.max(latest, observedAt.getTime()), sources[0]!.observedAt.getTime()));
      const updated = await tx.$executeRaw(Prisma.sql`
        UPDATE "MemoryFact" SET "pinned" = ${[canonical, ...merge.redundant].some(({ pinned }) => pinned)},
          "lastConfirmedAt" = GREATEST("lastConfirmedAt", ${confirmedAt}), "updatedAt" = ${now}
        WHERE "userId" = ${claim.userId} AND "id" = ${canonical.factId}
          AND "currentVersionId" = ${canonical.versionId} AND "state" = 'ACTIVE'::"MemoryFactState"
      `);
      if (updated !== 1) return stale();
      await advanceMemoryMutation(tx, settings, "AUTOMATIC_VERSION_TRANSITION");
      await ensureClassifiedSearchEntry(tx, settings, canonical.versionId, result.packet.outputHash, now);
    }
  });
}

export type MemoryExplicitRelationRepository = ReturnType<typeof createPrismaMemoryExplicitRelationRepository>;

import type { Prisma, PrismaClient } from "@prisma/client";
import type { MemoryJobClaim, MemoryJobDescriptor } from "../../coordinator/types";
import { memoryExecutionSha256 } from "../../execution/canonical";
import type { MemoryExecutionDurableResultEvidence } from "../../execution/lifecycle";
import { isValidMemoryExecutionIdentifier } from "../../execution/owner";
import {
  withLockedMemoryTransaction,
  type MemoryTransaction
} from "../../persistence/transaction";
import {
  isMemoryExplicitRelationJob,
  MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
  type MemoryExplicitRelationDecision,
  type MemoryExplicitRelationSnapshot
} from "./explicitPolicy";
import {
  createMemoryExplicitRelationRecovery,
  decodeMemoryExplicitRelationRecovery,
  type MemoryExplicitRelationRecoveryPacket
} from "./explicitRecovery";

const purpose = "EXPLICIT_FACT_EQUIVALENCE";
const sha256 = /^[a-f0-9]{64}$/u;
export const MEMORY_EXPLICIT_RELATION_EXECUTION_ORDINAL = 0;

export type MemoryExplicitRelationRetainedResult = Readonly<{
  bindingId: string;
  packet: MemoryExplicitRelationRecoveryPacket;
}>;

export type MemoryExplicitRelationReservation =
  | Readonly<{ status: "ACQUIRED" }>
  | Readonly<{ status: "UNAVAILABLE" }>
  | Readonly<{ status: "RECOVERED"; result: MemoryExplicitRelationRetainedResult }>;

const reservationSelect = {
  acceptedOutputHash: true,
  completedAt: true,
  createdAt: true,
  executionId: true,
  inputHash: true,
  ownerJobId: true,
  purpose: true,
  result: true,
  sourceMessageId: true,
  targetFactVersionId: true,
  userId: true
} as const;

type ReservationRow = Prisma.MemoryAuxiliarySemanticCallGetPayload<{
  select: typeof reservationSelect;
}>;

function owned(row: ReservationRow, job: MemoryJobDescriptor): boolean {
  return row.userId === job.userId && row.ownerJobId === job.id &&
    row.purpose === purpose && row.sourceMessageId === null &&
    row.targetFactVersionId === job.targetFactVersionId;
}

function retained(
  row: ReservationRow,
  job: MemoryJobDescriptor
): MemoryExplicitRelationRetainedResult | null {
  if (!owned(row, job)) throw new Error("memory_explicit_relation_owner_invalid");
  if (row.completedAt === null) return null;
  if (!row.inputHash || !row.acceptedOutputHash ||
    !isValidMemoryExecutionIdentifier(row.executionId) || !job.targetFactVersionId) {
    throw new Error("memory_explicit_relation_recovery_invalid");
  }
  return Object.freeze({
    bindingId: row.executionId,
    packet: decodeMemoryExplicitRelationRecovery(row.result, {
      acceptedOutputHash: row.acceptedOutputHash,
      inputHash: row.inputHash,
      sourceVersionId: job.targetFactVersionId
    })
  });
}

export function createPrismaMemoryExplicitRelationAuxiliaryStore(client: PrismaClient) {
  return Object.freeze({
    async load(job: MemoryJobDescriptor): Promise<MemoryExplicitRelationRetainedResult | null> {
      if (!isMemoryExplicitRelationJob(job)) throw new Error("memory_explicit_relation_job_invalid");
      const row = await client.memoryAuxiliarySemanticCall.findUnique({
        select: reservationSelect,
        where: { userId_targetFactVersionId: {
          targetFactVersionId: job.targetFactVersionId!, userId: job.userId
        } }
      });
      return row ? retained(row, job) : null;
    },

    async reserve(
      claim: MemoryJobClaim,
      inputHash: string,
      now: Date
    ): Promise<MemoryExplicitRelationReservation> {
      if (!isMemoryExplicitRelationJob(claim) || !sha256.test(inputHash) ||
        !isValidMemoryExecutionIdentifier(claim.claimToken) || !Number.isFinite(now.getTime())) {
        throw new Error("memory_explicit_relation_reservation_invalid");
      }
      return withLockedMemoryTransaction(client, claim.userId, async (tx, settings) => {
        if (!settings.useMemoryFacts || settings.memoryGeneration !== claim.memoryGenerationSnapshot) {
          return { status: "UNAVAILABLE" as const };
        }
        const lease = await tx.memoryJob.findFirst({
          select: { id: true },
          where: {
            attemptCount: claim.attemptCount,
            id: claim.id,
            kind: "RESOLVE_FACT_RELATIONS",
            leaseExpiresAt: { gt: now },
            leaseToken: claim.claimToken,
            memoryGenerationSnapshot: settings.memoryGeneration,
            pipelineVersion: MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION,
            state: "CLAIMED",
            targetFactVersionId: claim.targetFactVersionId,
            userId: claim.userId
          }
        });
        if (!lease) return { status: "UNAVAILABLE" as const };
        const row = await tx.memoryAuxiliarySemanticCall.findUnique({
          select: reservationSelect,
          where: { userId_targetFactVersionId: {
            targetFactVersionId: claim.targetFactVersionId!, userId: claim.userId
          } }
        });
        if (row) {
          const result = retained(row, claim);
          if (result) return { result, status: "RECOVERED" as const };
        }
        const executions = await tx.memoryExecutionBinding.findMany({
          select: { inputHash: true, ordinal: true, pipelineVersion: true, state: true },
          take: 2,
          where: {
            logicalRole: "MEMORY_CONSOLIDATE", memoryJobId: claim.id,
            ownerType: "JOB", userId: claim.userId
          }
        });
        // An unstarted identical binding is safe to resume. RUNNING or any
        // settled/ambiguous dispatch must never buy another semantic attempt.
        if (executions.length > 1 || executions.some((execution) =>
          !row || execution.state !== "PENDING" || execution.inputHash !== inputHash ||
          execution.ordinal !== MEMORY_EXPLICIT_RELATION_EXECUTION_ORDINAL ||
          execution.pipelineVersion !== MEMORY_EXPLICIT_RELATION_PIPELINE_VERSION)) {
          return { status: "UNAVAILABLE" as const };
        }
        if (!row) await tx.memoryAuxiliarySemanticCall.create({
          data: {
            createdAt: now,
            id: memoryExecutionSha256({
              domain: "aiqsa.memory.explicit-relation-call", userId: claim.userId,
              versionId: claim.targetFactVersionId, version: 1
            }),
            ownerJobId: claim.id,
            purpose,
            targetFactVersionId: claim.targetFactVersionId!,
            userId: claim.userId
          }
        });
        return { status: "ACQUIRED" as const };
      });
    },

    async persist(
      tx: MemoryTransaction,
      job: MemoryJobDescriptor,
      snapshot: MemoryExplicitRelationSnapshot,
      result: MemoryExecutionDurableResultEvidence & Readonly<{
        acceptedOutputHash: string;
        inputHash: string;
        value: readonly MemoryExplicitRelationDecision[];
      }>
    ): Promise<void> {
      if (!isMemoryExplicitRelationJob(job) || snapshot.userId !== job.userId ||
        snapshot.source.versionId !== job.targetFactVersionId ||
        snapshot.memoryGeneration !== job.memoryGenerationSnapshot ||
        !isValidMemoryExecutionIdentifier(result.bindingId) ||
        !Number.isFinite(result.completedAt.getTime())) {
        throw new Error("memory_explicit_relation_result_invalid");
      }
      const packet = createMemoryExplicitRelationRecovery(snapshot, result.value, result.acceptedOutputHash);
      if (packet.inputHash !== result.inputHash) throw new Error("memory_explicit_relation_result_invalid");
      const row = await tx.memoryAuxiliarySemanticCall.findUnique({
        select: reservationSelect,
        where: { userId_targetFactVersionId: {
          targetFactVersionId: job.targetFactVersionId!, userId: job.userId
        } }
      });
      if (!row || !owned(row, job)) throw new Error("memory_explicit_relation_reservation_missing");
      const previous = retained(row, job);
      if (previous) {
        if (previous.bindingId !== result.bindingId ||
          memoryExecutionSha256(previous.packet) !== memoryExecutionSha256(packet)) {
          throw new Error("memory_explicit_relation_result_conflict");
        }
        return;
      }
      if (result.replayed) throw new Error("memory_explicit_relation_recovery_missing");
      const changed = await tx.memoryAuxiliarySemanticCall.updateMany({
        data: {
          acceptedOutputHash: packet.outputHash,
          completedAt: new Date(Math.max(result.completedAt.getTime(), row.createdAt.getTime())),
          executionId: result.bindingId,
          inputHash: packet.inputHash,
          result: packet as Prisma.InputJsonValue
        },
        where: {
          completedAt: null, ownerJobId: job.id, purpose,
          targetFactVersionId: job.targetFactVersionId!, userId: job.userId
        }
      });
      if (changed.count !== 1) throw new Error("memory_explicit_relation_result_conflict");
    }
  });
}

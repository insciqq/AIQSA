import {
  Prisma,
  type MemoryExecutionState,
  type PrismaClient
} from "@prisma/client";
import { prisma } from "../../../prisma";
import type {
  MemoryJobClaim,
  MemoryJobDescriptor,
  MemoryJobGateDecision
} from "../../coordinator/types";
import { enqueueMemoryJob } from "../../persistence/jobs";
import type { MemoryTransaction } from "../../persistence/transaction";
import { withLockedMemoryTransaction } from "../../persistence/transaction";
import {
  loadMemorySuppressionKeyring,
  type MemorySuppressionKeyring
} from "../../suppressionKeyring";
import {
  applyMemoryFactConsolidation,
  applyMemoryFactVerification,
  deferMemoryFactConsolidationResult,
  staleMemoryFactVerification
} from "./apply";
import {
  MEMORY_FACT_CONSOLIDATION_PIPELINE_VERSION,
  memoryFactConsolidationJobFingerprint,
  type MemoryFactConsolidationInput,
  type MemoryFactConsolidationPlan,
  type MemoryFactVerificationInput,
  type MemoryFactVerificationPlan
} from "./contract";
import {
  prepareMemoryFactConsolidation,
  prepareMemoryFactVerification,
  probeMemoryFactConsolidation,
  probeMemoryFactVerification,
  type MemoryFactConsolidationPrepareResult,
  type MemoryFactVerificationPrepareResult
} from "./source";

export type MemoryFactDecisionExecutionBinding = Readonly<{
  acceptedOutputHash: string | null;
  errorCode: string | null;
  id: string;
  inputHash: string;
  ordinal: number;
  state: MemoryExecutionState;
}>;

type PendingCandidateRow = Readonly<{
  activeLeafMessageId: string;
  branchGeneration: number;
  candidateId: string;
  chatId: string;
  sourceHash: string;
  sourceRevision: number;
  userId: string;
}>;

function configuredKeyring(): MemorySuppressionKeyring {
  const configured = loadMemorySuppressionKeyring();
  if (configured.status !== "ready") {
    throw new Error("memory_suppression_keyring_unavailable");
  }
  return configured.keyring;
}

export async function reconcileMemoryFactCandidateJobs(
  client: PrismaClient = prisma,
  options: Readonly<{ limit?: number }> = {}
): Promise<number> {
  const limit = Math.max(1, Math.min(options.limit ?? 64, 256));
  const rows = await client.$queryRaw<PendingCandidateRow[]>(Prisma.sql`
    SELECT
      candidate."id" AS "candidateId", candidate."userId", candidate."chatId",
      candidate."branchGeneration", candidate."sourceRevision",
      candidate."sourceHash", source_job."activeLeafMessageId"
    FROM "MemoryCandidate" AS candidate
    INNER JOIN "MemoryJob" AS source_job
      ON source_job."userId" = candidate."userId"
      AND source_job."id" = candidate."jobId"
      AND source_job."kind" = 'EXTRACT_FACTS'::"MemoryJobKind"
      AND source_job."state" = 'SUCCEEDED'::"MemoryJobState"
    LEFT JOIN "MemoryCandidateDecision" AS decision
      ON decision."userId" = candidate."userId"
      AND decision."candidateId" = candidate."id"
    WHERE candidate."state" = 'PENDING'::"MemoryCandidateState"
      AND candidate."contentPurgedAt" IS NULL
      AND decision."id" IS NULL
      AND source_job."activeLeafMessageId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "MemoryJob" AS consolidation_job
        WHERE consolidation_job."userId" = candidate."userId"
          AND consolidation_job."kind" = 'CONSOLIDATE_CANDIDATE'::"MemoryJobKind"
          AND consolidation_job."idempotencyFingerprint" LIKE
            ('consolidate-candidate:' || candidate."id" || ':%')
      )
    ORDER BY candidate."createdAt", candidate."id"
    LIMIT ${limit}
  `);
  let created = 0;
  for (const row of rows) {
    const result = await withLockedMemoryTransaction(
      client,
      row.userId,
      async (tx, settings) => {
        if (!settings.useMemoryFacts || !settings.learnAutomatically) return null;
        const [candidate, decision] = await Promise.all([
          tx.memoryCandidate.findFirst({
            select: { id: true, state: true },
            where: {
              contentPurgedAt: null,
              id: row.candidateId,
              state: "PENDING",
              userId: row.userId
            }
          }),
          tx.memoryCandidateDecision.findFirst({
            select: { id: true },
            where: { candidateId: row.candidateId, userId: row.userId }
          })
        ]);
        if (!candidate || decision) return null;
        return enqueueMemoryJob(tx, settings, {
          idempotencyFingerprint: memoryFactConsolidationJobFingerprint({
            candidateId: row.candidateId,
            sourceHash: row.sourceHash,
            sourceRevision: row.sourceRevision
          }),
          kind: "CONSOLIDATE_CANDIDATE",
          pipelineVersion: MEMORY_FACT_CONSOLIDATION_PIPELINE_VERSION,
          source: {
            activeLeafMessageId: row.activeLeafMessageId,
            branchGeneration: row.branchGeneration,
            chatId: row.chatId,
            sourceHash: row.sourceHash,
            sourceRevision: row.sourceRevision
          }
        });
      }
    );
    if (result?.created) created += 1;
  }
  return created;
}

export function createPrismaMemoryFactConsolidationRepository(
  client: PrismaClient = prisma,
  options: Readonly<{ keyring?: () => MemorySuppressionKeyring }> = {}
) {
  const keyring = options.keyring ?? configuredKeyring;

  function bindings(
    userId: string,
    jobId: string,
    role: "MEMORY_CONSOLIDATE" | "MEMORY_VERIFY"
  ): Promise<MemoryFactDecisionExecutionBinding[]> {
    return client.memoryExecutionBinding.findMany({
      orderBy: [{ ordinal: "asc" }, { id: "asc" }],
      select: {
        acceptedOutputHash: true,
        errorCode: true,
        id: true,
        inputHash: true,
        ordinal: true,
        state: true
      },
      where: {
        logicalRole: role,
        memoryJobId: jobId,
        ownerType: "JOB",
        userId
      }
    });
  }

  return Object.freeze({
    applyConsolidation(
      tx: MemoryTransaction,
      claim: MemoryJobClaim,
      input: MemoryFactConsolidationInput,
      plan: MemoryFactConsolidationPlan,
      executionId: string,
      now: Date
    ): Promise<void> {
      return applyMemoryFactConsolidation(
        tx,
        claim,
        input,
        plan,
        executionId,
        keyring(),
        now
      );
    },
    applyVerification(
      tx: MemoryTransaction,
      claim: MemoryJobClaim,
      input: MemoryFactVerificationInput,
      plan: MemoryFactVerificationPlan,
      executionId: string,
      now: Date
    ): Promise<void> {
      return applyMemoryFactVerification(
        tx,
        claim,
        input,
        plan,
        executionId,
        keyring(),
        now
      );
    },
    consolidationBindings(userId: string, jobId: string) {
      return bindings(userId, jobId, "MEMORY_CONSOLIDATE");
    },
    deferConsolidation(
      tx: MemoryTransaction,
      claim: MemoryJobClaim,
      candidateId: string,
      reasonCode: string
    ): Promise<void> {
      return deferMemoryFactConsolidationResult(
        tx,
        claim,
        candidateId,
        reasonCode
      );
    },
    prepareConsolidation(
      job: MemoryJobDescriptor,
      relatedVersionIds: readonly string[] | null = null
    ): Promise<MemoryFactConsolidationPrepareResult> {
      return withLockedMemoryTransaction(client, job.userId, (tx, settings) =>
        prepareMemoryFactConsolidation(
          tx,
          settings,
          job,
          keyring(),
          new Date(),
          relatedVersionIds
        ));
    },
    prepareVerification(
      job: MemoryJobDescriptor
    ): Promise<MemoryFactVerificationPrepareResult> {
      return withLockedMemoryTransaction(client, job.userId, (tx, settings) =>
        prepareMemoryFactVerification(tx, settings, job, keyring(), new Date()));
    },
    preflightConsolidation(job: MemoryJobDescriptor): Promise<MemoryJobGateDecision> {
      return withLockedMemoryTransaction(client, job.userId, (tx, settings) =>
        probeMemoryFactConsolidation(tx, settings, job));
    },
    preflightVerification(job: MemoryJobDescriptor): Promise<MemoryJobGateDecision> {
      return withLockedMemoryTransaction(client, job.userId, (tx, settings) =>
        probeMemoryFactVerification(tx, settings, job));
    },
    staleVerification(
      tx: MemoryTransaction,
      claim: MemoryJobClaim,
      decisionId: string,
      executionId: string | null,
      outputHash: string | null,
      now: Date
    ): Promise<void> {
      return staleMemoryFactVerification(
        tx,
        claim,
        decisionId,
        executionId,
        outputHash,
        now
      );
    },
    verificationBindings(userId: string, jobId: string) {
      return bindings(userId, jobId, "MEMORY_VERIFY");
    }
  });
}

export type MemoryFactConsolidationRepository = ReturnType<
  typeof createPrismaMemoryFactConsolidationRepository
>;

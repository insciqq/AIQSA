import {
  type MemoryExecutionState,
  type PrismaClient
} from "@prisma/client";
import { prisma } from "../../../prisma";
import type {
  MemoryJobClaim,
  MemoryJobDescriptor,
  MemoryJobGateDecision
} from "../../coordinator/types";
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

function configuredKeyring(): MemorySuppressionKeyring {
  const configured = loadMemorySuppressionKeyring();
  if (configured.status !== "ready") {
    throw new Error("memory_suppression_keyring_unavailable");
  }
  return configured.keyring;
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

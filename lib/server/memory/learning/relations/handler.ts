import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../../../prisma";
import { MemoryCoordinatorError } from "../../coordinator/errors";
import type {
  MemoryJobDescriptor,
  MemoryJobExecutionResult,
  MemoryJobHandler
} from "../../coordinator/types";
import {
  authorizeMemoryExecutionResultsForCommit,
  MemoryExecutionError,
  probeMemoryStructuredOutputAuthority,
  type MemoryExecutionAuthorityDependencies,
  type MemoryStructuredOutputProvider
} from "../../execution";
import { memoryExecutionSha256 } from "../../execution/canonical";
import { defaultMemoryExecutionAuthority } from "../../execution/defaultAuthority";
import { lockMemorySettings, type LockedMemorySettings } from "../../persistence/transaction";
import {
  decideMemoryFactRelation,
  MEMORY_FACT_RELATION_PIPELINE_VERSION,
  type MemoryRelationDecision,
  type MemoryRelationSnapshot
} from "./policy";
import {
  createPrismaMemoryRelationRepository,
  type MemoryRelationRepository
} from "./repository";
import {
  createPrismaMemoryRelationProvider,
  memoryRelationAcceptedOutputHash,
  memoryRelationResolverInputHash,
  MEMORY_FACT_RELATION_VERSIONS,
  type MemoryRelationProvider,
  type MemoryRelationProviderResult
} from "./resolver";

type AuthorizedRelationResult = Readonly<{
  acceptedOutputHash: string;
  bindingId: string;
  inputHash: string;
  modelId: string;
  policyVersion: string;
  providerId: string;
}>;

const terminalConflictReasons = new Set([
  "relation_correction_target_stale",
  "relation_current_ineligible",
  "relation_current_missing",
  "relation_current_stale"
]);

export type MemoryRelationHandlerDependencies = Readonly<{
  authorizeResult?: (
    tx: Prisma.TransactionClient,
    settings: LockedMemorySettings,
    userId: string,
    jobId: string,
    result: AuthorizedRelationResult
  ) => Promise<void>;
  clock?: () => Date;
  probeAuthority?: (userId: string) => Promise<void>;
  provider: MemoryRelationProvider;
  repository: MemoryRelationRepository;
}>;

function terminalResult(
  job: MemoryJobDescriptor,
  reason: string,
  snapshotHash: string | null = null
): MemoryJobExecutionResult {
  return {
    acceptedResultHash: memoryExecutionSha256({
      domain: "aiqsa.memory.fact-relation-terminal",
      jobId: job.id,
      reason,
      snapshotHash,
      version: 2
    }),
    stage: reason
  };
}

function authorityGate(error: unknown) {
  if (error instanceof MemoryExecutionError) {
    if (
      error.code === "memory_execution_egress_consent_required" ||
      error.code === "memory_execution_target_unavailable" ||
      error.code === "memory_execution_capability_unavailable" ||
      error.code === "memory_execution_policy_unavailable"
    ) {
      return { errorCode: error.code, status: "WAITING_FOR_EGRESS_CONSENT" as const };
    }
    return { errorCode: error.code, status: "CANCELLED" as const };
  }
  throw error;
}

function admittedProviderDecision(
  snapshot: MemoryRelationSnapshot,
  deterministic: MemoryRelationDecision,
  result: MemoryRelationProviderResult
): MemoryRelationDecision {
  const target = snapshot.related.find(({ ref }) => ref === result.decision.targetRef);
  if (result.decision.confidenceBand !== "HIGH" || !target ||
    target.versionId !== snapshot.current.versionId) {
    return {
      confidence: 0,
      operation: "CONFLICT",
      reasonCode: "provider_relation_ambiguous",
      targetVersionId: snapshot.current.versionId
    };
  }
  // Code-owned transition registries cannot be overridden by a semantic
  // resolver. The auxiliary model can only settle a representation ambiguity
  // after identity/currentness were already proven locally.
  if (deterministic.reasonCode !== "unsupported_structured_value" ||
    (result.decision.operation !== "MERGE_NEW_INTO_TARGET" &&
      result.decision.operation !== "MERGE_TARGET_INTO_NEW")) {
    return {
      confidence: 0,
      operation: "CONFLICT",
      reasonCode: "provider_transition_not_admissible",
      targetVersionId: snapshot.current.versionId
    };
  }
  return {
    confidence: 1,
    operation: result.decision.operation,
    reasonCode: result.decision.reasonCode,
    targetVersionId: target.versionId
  };
}

export function createMemoryRelationHandler(
  deps: MemoryRelationHandlerDependencies
): MemoryJobHandler {
  const clock = deps.clock ?? (() => new Date());
  return Object.freeze({
    kind: "RESOLVE_FACT_RELATIONS" as const,

    async preflight(job) {
      const gate = await deps.repository.preflight(job);
      if (gate.status !== "READY" || !deps.probeAuthority) return gate;
      const prepared = await deps.repository.prepare(job, clock());
      if (prepared.status !== "READY") return gate;
      const deterministic = decideMemoryFactRelation(prepared.prepared.snapshot, clock());
      if (deterministic.operation !== "AMBIGUOUS" ||
        !await deps.repository.auxiliaryCallAvailable(job)) {
        return gate;
      }
      try {
        await deps.probeAuthority(job.userId);
        return gate;
      } catch (error) {
        return authorityGate(error);
      }
    },

    async execute(job, context) {
      if (job.kind !== "RESOLVE_FACT_RELATIONS" ||
        job.pipelineVersion !== MEMORY_FACT_RELATION_PIPELINE_VERSION ||
        job.targetFactVersionId === null) {
        return terminalResult(job, "relation_job_invalid");
      }
      await context.setStage("relation_snapshot");
      const prepared = await deps.repository.prepare(job, context.now());
      if (prepared.status !== "READY") {
        const result = terminalResult(job, prepared.reason);
        return terminalConflictReasons.has(prepared.reason)
          ? {
              ...result,
              apply: (tx, claim) => deps.repository.settleTerminal(
                tx,
                claim,
                prepared.reason,
                context.now()
              )
            }
          : result;
      }
      const { snapshot, snapshotHash } = prepared.prepared;
      let decision = decideMemoryFactRelation(snapshot, context.now());
      let providerResult: MemoryRelationProviderResult | null = null;
      if (decision.operation === "AMBIGUOUS") {
        const reservation = await deps.repository.reserveAuxiliaryCall(job);
        if (reservation.status === "UNAVAILABLE") {
          decision = {
            confidence: 0,
            operation: "CONFLICT",
            reasonCode: "auxiliary_budget_exhausted",
            targetVersionId: snapshot.current.versionId
          };
        } else {
          await context.setStage(reservation.status === "RECOVERED"
            ? "relation_provider_recovery"
            : "relation_provider_call");
          try {
            providerResult = reservation.status === "RECOVERED"
              ? reservation.result
              : await deps.provider.resolve(snapshot, context.signal, {
                  jobId: job.id,
                  userId: job.userId
                });
            const inputHash = memoryRelationResolverInputHash(snapshot);
            if (providerResult.inputHash !== inputHash ||
              providerResult.acceptedOutputHash !== memoryRelationAcceptedOutputHash(
                inputHash,
                providerResult.decision
              )) {
              throw new Error("memory_fact_relation_output_invalid");
            }
            if (reservation.status === "ACQUIRED") {
              await deps.repository.recordAuxiliaryResult(
                job,
                providerResult,
                context.now()
              );
            }
            decision = admittedProviderDecision(snapshot, decision, providerResult);
          } catch (error) {
            if (error instanceof MemoryExecutionError) {
              throw new MemoryCoordinatorError(error.code, false);
            }
            if (error instanceof MemoryCoordinatorError) throw error;
            if (error instanceof Error &&
              error.message === "memory_fact_relation_output_invalid") {
              providerResult = null;
              decision = {
                confidence: 0,
                operation: "CONFLICT",
                reasonCode: "provider_output_invalid",
                targetVersionId: snapshot.current.versionId
              };
            } else if (job.attemptCount >= 2) {
              decision = {
                confidence: 0,
                operation: "CONFLICT",
                reasonCode: "provider_retry_exhausted",
                targetVersionId: snapshot.current.versionId
              };
            } else {
              throw new MemoryCoordinatorError(
                "memory_fact_relation_provider_unavailable",
                true
              );
            }
          }
        }
      }
      const acceptedResultHash = memoryExecutionSha256({
        decision,
        domain: "aiqsa.memory.fact-relation",
        executionId: providerResult?.executionId ?? null,
        jobId: job.id,
        pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION,
        snapshotHash
      });
      await context.setStage("relation_authorized_apply");
      return {
        acceptedResultHash,
        apply: async (tx, claim) => {
          if (providerResult) {
            if (!deps.authorizeResult) {
              throw new Error("memory_fact_relation_authority_missing");
            }
            const settings = await lockMemorySettings(tx, claim.userId, true);
            await deps.authorizeResult(tx, settings, claim.userId, claim.id, {
              acceptedOutputHash: providerResult.acceptedOutputHash,
              bindingId: providerResult.executionId,
              inputHash: providerResult.inputHash,
              modelId: providerResult.modelId,
              policyVersion: providerResult.policyVersion,
              providerId: providerResult.providerId
            });
          }
          await deps.repository.apply(tx, claim, {
            decision,
            executionId: providerResult?.executionId ?? null,
            expectedSnapshotHash: snapshotHash
          }, context.now());
        },
        stage: `relation_${decision.operation.toLocaleLowerCase("en-US")}`
      };
    }
  });
}

export function createPrismaMemoryRelationHandler(
  client: PrismaClient = prisma,
  options: Readonly<{
    authority?: MemoryExecutionAuthorityDependencies;
    provider?: MemoryRelationProvider;
    repository?: MemoryRelationRepository;
    structuredProvider?: MemoryStructuredOutputProvider;
  }> = {}
): MemoryJobHandler {
  const authority = options.authority ?? defaultMemoryExecutionAuthority;
  return createMemoryRelationHandler({
    authorizeResult: async (tx, settings, userId, jobId, result) => {
      const evidence = await authorizeMemoryExecutionResultsForCommit(
        authority,
        tx,
        settings,
        userId,
        { memoryJobId: jobId, role: "MEMORY_CONSOLIDATE" },
        [{
          acceptedOutputHash: result.acceptedOutputHash,
          bindingId: result.bindingId,
          inputHash: result.inputHash
        }]
      );
      const authorized = evidence[0];
      if (evidence.length !== 1 || !authorized ||
        authorized.bindingId !== result.bindingId ||
        authorized.modelId !== result.modelId ||
        authorized.policyVersion !== result.policyVersion ||
        authorized.providerId !== result.providerId) {
        throw new Error("memory_fact_relation_authority_mismatch");
      }
    },
    probeAuthority: (userId) => probeMemoryStructuredOutputAuthority({
      authority,
      client,
      role: "MEMORY_CONSOLIDATE",
      userId,
      versions: MEMORY_FACT_RELATION_VERSIONS
    }),
    provider: options.provider ?? createPrismaMemoryRelationProvider(client, {
      authority,
      provider: options.structuredProvider
    }),
    repository: options.repository ?? createPrismaMemoryRelationRepository(client)
  });
}

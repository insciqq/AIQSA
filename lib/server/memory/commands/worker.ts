import { Prisma, type PrismaClient, type MemoryCommandStatus } from "@prisma/client";
import { decodeMemoryActionIntent, type MemoryActionIntent } from "../../../contracts/memoryActionIntent";
import { prisma } from "../../prisma";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import { memoryAttempt } from "../coordinator/observability";
import { memoryPersistenceFailureCode } from "../persistence/errors";
import { ExplicitMemoryServiceError } from "../explicit/service";
import { MemoryLifecycleServiceError } from "../lifecycle/service";
import { createPrismaMemoryControlService, type MemoryControlService } from "../actions/controlRuntime";
import { createMemoryIntentActionExecutor } from "../actions/intentExecutor";
import { createMemoryActionTargetSearchService, createPrismaMemoryActionTargetRepository, type MemoryActionTarget, type MemoryActionTargetSearchResult } from "../actions/targetSearch";
import { createPrismaMemoryTargetSelector, memoryTargetCandidateMapHash } from "../actions/targetSelector";
import type { MemoryJobClaim, MemoryJobExecutionResult, MemoryJobHandler } from "../coordinator/types";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import { createPrismaMemoryMutationAuthorizationRepository } from "../persistence/authorizations";
import { memorySha256 } from "../persistence/lexical";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { createPrismaMemoryRunUtilityService } from "../retrieval/runUtilities";
import { createPrismaMemoryVectorRepository } from "../retrieval/vector";
import { MEMORY_COMMAND_PIPELINE_VERSION } from "./repository";
import { decodeMemoryCommandTargetCheckpoint, memoryCommandTargetCheckpoint } from "./targetCheckpoint";
import { createMemoryCommandServices } from "./services";
import { requireMemoryCommandSource } from "./sourceAuthority";

export function decodeMemoryCommandIntent(value: unknown): Readonly<{ bindingId: string; intent: MemoryActionIntent }> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const decoded = decodeMemoryActionIntent(row.intent);
  return Object.keys(row).length === 2 && typeof row.bindingId === "string" && row.bindingId.length > 0 &&
    row.bindingId.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(row.bindingId) && decoded.ok &&
    memorySha256(decoded.value) === memorySha256(row.intent)
    ? { bindingId: row.bindingId, intent: decoded.value } : null;
}

/** Exception messages, causes, stacks and Prisma meta may carry source text.
 * Only class-owned codes and the database boundary's retained code are read. */
function commandMutationFailure(error: unknown): Readonly<{ code: string; prisma_code: string }> {
  const directPrismaCode = error instanceof Prisma.PrismaClientKnownRequestError ? error.code :
    error instanceof Prisma.PrismaClientInitializationError ? error.errorCode : undefined;
  const prismaCode = typeof directPrismaCode === "string" && /^P\d{4}$/u.test(directPrismaCode)
    ? directPrismaCode : databaseFailureCode(error);
  const domainCode = memoryPersistenceFailureCode(error) ??
    (error instanceof ExplicitMemoryServiceError || error instanceof MemoryLifecycleServiceError ? error.code : null);
  return { code: domainCode ?? (prismaCode !== "unknown" ? "memory_command_database_failed" : "memory_command_failed"),
    prisma_code: prismaCode };
}

/** Classifier failures that may buy the reserved ordinal-2 call: a
 * replay-safe transient failure before any response, or an answer that
 * failed validation after its FAILED settlement accounted usage. Statement
 * overflow, unknown outcomes and unavailable providers stay terminal. */
const retryableClassifierFailures: ReadonlySet<string> = new Set([
  "memory_action_intent_invalid",
  "memory_action_intent_transient"
]);

function retryableClassifierFailure(code: string | null | undefined): code is string {
  return typeof code === "string" && retryableClassifierFailures.has(code);
}

function logClassifierRetry(job: MemoryJobClaim, code: string): void {
  logEvent("service_operation", {
    action: "retry", attempt: 2, code, job_id: job.id, outcome: "failed",
    stage: code === "memory_action_intent_invalid" ? "validate" : "dispatch", subsystem: "memory"
  });
}

function result(job: MemoryJobClaim, status: MemoryCommandStatus): MemoryJobExecutionResult {
  return { acceptedResultHash: memorySha256({ command: job.id, status, version: 1 }),
    stage: `command_${status.toLowerCase()}` };
}

/** Mutation receipts are committed with the mutation itself. The worker may
 * die before queue settlement; a replacement worker only publishes that receipt. */
export function createPrismaMemoryCommandHandler(
  client: PrismaClient = prisma,
  options: Readonly<{
    control?: MemoryControlService;
    services?: ReturnType<typeof createMemoryCommandServices>;
    targetSelector?: ReturnType<typeof createPrismaMemoryTargetSelector>;
  }> = {}
): MemoryJobHandler {
  const { explicitService, lifecycleService } = options.services ?? createMemoryCommandServices(client);
  const control = options.control ?? createPrismaMemoryControlService(defaultMemoryExecutionAuthority, client);
  const authorization = createPrismaMemoryMutationAuthorizationRepository(client);
  const targetSelector = options.targetSelector ?? createPrismaMemoryTargetSelector(defaultMemoryExecutionAuthority, client);
  const targetSearch = createMemoryActionTargetSearchService({
    explicitService,
    repository: createPrismaMemoryActionTargetRepository(client),
    utilities: createPrismaMemoryRunUtilityService(defaultMemoryExecutionAuthority, client),
    vectorRepository: createPrismaMemoryVectorRepository(client)
  });
  async function terminal(job: MemoryJobClaim, status: MemoryCommandStatus, noCommand = false) {
    await client.memoryJob.updateMany({ where: {
      id: job.id, userId: job.userId, state: "CLAIMED", leaseToken: job.claimToken, leaseExpiresAt: { gt: new Date() },
      commandStatus: { not: "COMMITTED" }
    }, data: { commandStatus: status, commandIntent: Prisma.DbNull,
      commandResult: noCommand ? { classification: "NONE" } : Prisma.DbNull } });
    await client.memoryJob.updateMany({ where: {
      id: job.id, userId: job.userId, state: "CLAIMED", leaseToken: job.claimToken, leaseExpiresAt: { gt: new Date() },
      commandStatus: { notIn: ["PENDING", "RUNNING"] }
    }, data: { commandIntent: Prisma.DbNull, commandResult: noCommand ? { classification: "NONE" } : Prisma.DbNull } });
    return result(job, status);
  }
  return Object.freeze({
    kind: "MEMORY_COMMAND",
    async preflight(job) {
      return job.pipelineVersion === MEMORY_COMMAND_PIPELINE_VERSION && job.sourceMessageId && job.chatId
        ? { status: "READY" } : { status: "CANCELLED", errorCode: "memory_command_invalid" };
    },
    async execute(job, context) {
      const existing = await client.memoryJob.findFirst({ where: { id: job.id, userId: job.userId } });
      if (!existing) return result(job, "STALE");
      if (existing.commandStatus && existing.commandStatus !== "PENDING" && existing.commandStatus !== "RUNNING") {
        const marker = existing.commandResult;
        const noCommand = existing.commandStatus === "REJECTED" && existing.commandOperation === "UNKNOWN" &&
          marker !== null && typeof marker === "object" && !Array.isArray(marker) &&
          Object.keys(marker).length === 1 && marker.classification === "NONE";
        return terminal(job, existing.commandStatus, noCommand);
      }
      const source = await withLockedMemoryTransaction(client, job.userId,
        async (tx, settings) => ({ ...(await requireMemoryCommandSource(tx, job.userId, job.id, job.claimToken, context.now(), true)), settings }))
        .catch(() => null);
      if (!source) return terminal(job, "STALE");
      let checkpoint = decodeMemoryCommandIntent(existing.commandIntent);
      if (!checkpoint && existing.commandIntent !== null && existing.commandIntent !== undefined) {
        return terminal(job, "FAILED");
      }
      if (!checkpoint) {
        const previous = await client.memoryExecutionBinding.findFirst({ where: {
          userId: job.userId, memoryJobId: job.id, ownerType: "JOB", logicalRole: "MEMORY_CONTROL", ordinal: { in: [0, 2] }
        }, orderBy: { ordinal: "desc" } });
        // A dispatched classifier with no durable decoded result cannot be bought
        // again, even if the provider outcome was accepted before process loss.
        // Only a settled FAILED first call that never reached the provider, or
        // whose answer was settled invalid with its usage, earns slot 2.
        const safeRetry = previous?.ordinal === 0 && previous.state === "FAILED" &&
          retryableClassifierFailure(previous.errorCode);
        if (previous && !safeRetry && (previous.state !== "PENDING" || previous.startedAt !== null)) {
          return terminal(job, "UNKNOWN");
        }
        await context.setStage("command_classify");
        const request = {
          attemptId: job.id, owner: { type: "JOB" as const, memoryJobId: job.id },
          context: {
            capabilities: { memoryEnabled: source.settings.useMemoryFacts,
              automaticLearning: source.settings.learnAutomatically,
              historyRecall: source.settings.referenceChatHistory },
            currentUserMessage: source.safeText, recentMessages: source.recentMessages
          }, signal: context.signal, userId: job.userId
        };
        const ordinal = safeRetry || previous?.ordinal === 2 ? 2 as const : 0 as const;
        if (safeRetry && previous?.errorCode) logClassifierRetry(job, previous.errorCode);
        let classified = await control.decide({ ...request, ordinal });
        // Slot 2 is the single reserved retry for both causes: an in-process
        // retry follows only slot 0, and slot 2 itself never retries.
        if (ordinal === 0 && classified.status === "UNAVAILABLE" &&
          retryableClassifierFailure(classified.reason) && !context.signal.aborted) {
          logClassifierRetry(job, classified.reason);
          classified = await control.decide({ ...request, ordinal: 2 });
        }
        if (classified.status !== "READY") {
          return terminal(job, classified.reason.includes("unknown") ? "UNKNOWN" : "FAILED");
        }
        const accepted = classified;
        checkpoint = { bindingId: accepted.bindingId, intent: accepted.intent };
        const saved = await withLockedMemoryTransaction(client, job.userId, async (tx) => {
          await requireMemoryCommandSource(tx, job.userId, job.id, job.claimToken, context.now());
          const action = accepted.intent.action;
          await tx.memoryJob.update({ where: { id: job.id }, data: {
            commandIntent: checkpoint as unknown as Prisma.InputJsonValue,
            commandOperation: action === "SAVE" || action === "UPDATE" || action === "FORGET" ? action : "UNKNOWN"
          } });
          return true;
        }).catch(() => false);
        if (!saved) return terminal(job, "STALE");
      }
      const { intent, bindingId } = checkpoint;
      if (intent.action !== "SAVE" && intent.action !== "UPDATE" && intent.action !== "FORGET") {
        // `patternExclusionRequested` stays in the accepted intent schema one
        // release so stored checkpoints decode; synthesized patterns are
        // retired, so it no longer marks a Memory request.
        return terminal(job, "REJECTED", intent.action === "NONE" && !intent.thisChatOnly &&
          ["none", "no_memory_request", "past_chats_request", "response_preference"].includes(intent.reasonCode));
      }
      let targetCheckpoint = decodeMemoryCommandTargetCheckpoint(existing.commandResult);
      if (intent.action !== "SAVE") {
        const priorSelection = await client.memoryExecutionBinding.findFirst({ where: {
          userId: job.userId, memoryJobId: job.id, ownerType: "JOB", logicalRole: "MEMORY_CONTROL", ordinal: { in: [1, 4] }
        } });
        if (priorSelection && (priorSelection.state !== "PENDING" || priorSelection.startedAt !== null) && !targetCheckpoint) {
          return terminal(job, "UNKNOWN");
        }
      }
      async function replayTargets(): Promise<MemoryActionTargetSearchResult> {
        if (!targetCheckpoint) return { status: "UNAVAILABLE", reason: "memory_target_selector_unavailable" };
        const targets: MemoryActionTarget[] = [];
        for (const candidate of targetCheckpoint.candidates) {
          const detail = await explicitService.get(job.userId, candidate.factId);
          const summary = detail.memory;
          if (summary.scope.type !== "GLOBAL_USER" || summary.factState !== "ACTIVE" ||
            summary.currentVersionId !== candidate.versionId || !summary.displayText) {
            return { status: "UNAVAILABLE", reason: "memory_fact_version_stale" };
          }
          targets.push({ factId: candidate.factId, versionId: candidate.versionId, statement: summary.displayText, summary });
        }
        return memoryTargetCandidateMapHash(targets.map((target, index) => ({ handle: `c${index}`, target }))) === targetCheckpoint.result.candidateMapHash
          ? { status: "READY", targets } : { status: "UNAVAILABLE", reason: "memory_fact_version_stale" };
      }
      const commandTargetSearch = {
        exact: (request: Parameters<typeof targetSearch.exact>[0]) => targetCheckpoint ? replayTargets() : targetSearch.exact(request),
        semantic: (request: Parameters<typeof targetSearch.semantic>[0]) => targetCheckpoint ? replayTargets() : targetSearch.semantic(request)
      };
      const commandTargetSelector = { ...targetSelector,
        async select(request: Parameters<typeof targetSelector.select>[0]) {
          if (targetCheckpoint) {
            return memoryTargetCandidateMapHash(request.candidates) === targetCheckpoint.result.candidateMapHash
              ? targetCheckpoint.result : { status: "UNAVAILABLE" as const, reason: "memory_fact_version_stale" };
          }
          const selected = await targetSelector.select({ ...request, ordinal: 4 });
          if (selected.status === "READY") {
            const checkpoint = memoryCommandTargetCheckpoint(request.candidates, selected);
            if (!checkpoint) return { status: "UNAVAILABLE" as const, reason: "memory_target_selector_unavailable" };
            await withLockedMemoryTransaction(client, job.userId, async (tx) => {
              const current = await requireMemoryCommandSource(tx, job.userId, job.id, job.claimToken, context.now());
              await tx.memoryJob.update({ where: { id: job.id }, data: { commandResult: {
                ...(current.job.commandResult && typeof current.job.commandResult === "object" && !Array.isArray(current.job.commandResult)
                  ? current.job.commandResult : {}), targetSelection: checkpoint
              } as Prisma.InputJsonValue } });
            });
            targetCheckpoint = checkpoint;
          }
          return selected;
        }
      };
      await context.setStage("command_apply");
      const executor = createMemoryIntentActionExecutor({
        authorizationRepository: { mintForControl: (userId, input, now) =>
          authorization.mintForCommand(userId, { ...input, memoryJobId: job.id, claimToken: job.claimToken }, now) },
        explicitService, lifecycleService,
        targetSearch: commandTargetSearch, targetSelector: commandTargetSelector
      });
      try {
        const feedback = await executor.execute({
          admissionDeadlineAtMs: context.now().getTime() + 120_000,
          attemptId: job.id, owner: { type: "JOB", memoryJobId: job.id },
          bindingId, chatId: source.job.chatId!, currentUserText: source.safeText, intent,
          modelRunId: source.modelRunId, now: context.now(), signal: context.signal, userId: job.userId
        });
        return terminal(job, feedback?.status === "COMMITTED" ? "COMMITTED" :
          feedback?.status === "AMBIGUOUS" ? "AMBIGUOUS" : "REJECTED");
      } catch (error) {
        const receipt = await client.memoryJob.findFirst({ where: { id: job.id, userId: job.userId }, select: { commandStatus: true } });
        const committed = receipt?.commandStatus === "COMMITTED";
        memoryAttempt(job, { ...commandMutationFailure(error), stage: "publish",
          work_stage: intent.action === "FORGET" ? "delete" : "write",
          outcome: committed ? "degraded" : "failed", action: committed ? "complete" : "fail" });
        return terminal(job, committed ? "COMMITTED" : "FAILED");
      }
    }
  });
}

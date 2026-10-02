// Opt-in PAID qualification of long-term automatic Memory extraction on a
// disposable stand. It seeds one synthetic owner per scenario with Russian and
// English messages, queues the ordinary EXTRACT_FACTS jobs and executes
// extraction, semantic adjudication and deterministic relation resolution
// in-process through the production handlers. The command path is not run.
//
// Usage (one qualification run; repeat with a fresh run id for the second):
//   AIQSA_TEST_MODE=1 AIQSA_LOCAL_DEV_PROFILE_DISABLED=1 \
//   AIQSA_MEMORY_EXTRACTION_COORDINATOR_STOPPED=1 \
//   AIQSA_MEMORY_EXTRACTION_DATABASE_URL='postgresql://aiqsa:<password>@127.0.0.1:<port>/aiqsa_memory_qualification_<runId>?schema=public' \
//   npx tsx scripts/qualify-memory-extraction.ts \
//     --ack DISPOSABLE_PAID_MEMORY_EXTRACTION --run-id <runId> --output /private/dir/report.json
//
// Guards (fail closed before any server module loads): the exact --ack, a
// 12-hex run id, the loopback disposable database named for that run (the
// memory cleanup qualification guard), DATABASE_URL unset or identical, a
// stopped Memory coordinator with no recent worker heartbeat and no active
// extraction, command or relation job, and a private non-existing output file
// in an owner-only directory. Run it with the stand's ordinary server
// environment (credential encryption key) after migrate deploy and seed, with
// the stand's own Memory worker stopped. The Memory utility binding must
// already be configured through Admin; credentials stay in the database.
//
// Output: the parent prints, and the report file holds, only content-free
// aggregates per scenario group (saved/not saved, false saves, misses, receipt
// outcome or rejection codes, job stages, degraded codes, provider calls by
// role and state, tokens and cost). Like the coordinator, a retryable job
// failure is retried within its attempt budget; a settled transient call whose
// job then succeeded is reported as RETRIED, any other failure as degraded. status=passed requires zero false saves,
// every strict group (MIXED, PROTECTED, CHANGE and all "no" groups) passing,
// at most one miss in DURABLE and in ONGOING, and zero degradation. The miss
// budget of the acceptance criteria spans both runs and is summed by hand.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import type { MemoryJobClaim, MemoryJobHandler } from "../lib/server/memory/coordinator/types";
import {
  cleanupQualificationFailureDiagnostic,
  withCleanupQualificationOutputFiles
} from "./memory-cleanup-qualification-support";
import {
  extractionQualificationDatabase,
  extractionQualificationOptions,
  judgeExtractionScenario,
  MEMORY_EXTRACTION_QUALIFICATION_SCENARIOS,
  sanitizeExtractionQualificationMessage,
  summarizeExtractionQualification,
  type ExtractionQualificationResult,
  type ExtractionQualificationScenario
} from "./memory-extraction-qualification-support";

const TIMEOUT_MS = 100 * 60 * 1_000;
const JOB_TIMEOUT_MS = 4 * 60 * 1_000;
const MAX_JOBS_PER_MESSAGE = 16;
const WORKER_ENV = "AIQSA_MEMORY_EXTRACTION_WORKER";
const learningKinds = ["EXTRACT_FACTS", "MEMORY_COMMAND", "RESOLVE_FACT_RELATIONS"] as const;
const activeStates = [
  "QUEUED", "CLAIMED", "RETRYABLE_FAILED", "WAITING_FOR_CONFIGURATION",
  "WAITING_FOR_EGRESS_CONSENT"
] as const;
const healthyExtractionStages = new Set(["fact_observations_committed", "fact_observations_empty"]);
let currentPhase = "arguments";

async function worker(): Promise<Record<string, unknown>> {
  const options = extractionQualificationOptions(process.argv.slice(2));
  currentPhase = "target_guard";
  const database = extractionQualificationDatabase(process.env, options.runId);
  if (process.env.AIQSA_MEMORY_EXTRACTION_COORDINATOR_STOPPED !== "1") {
    throw new Error("memory_extraction_stopped_coordinator_required");
  }
  currentPhase = "reserve_output";
  return withCleanupQualificationOutputFiles({ report: options.output }, async (files) => {
    try {
      // No environment autoload: an ordinary .env cannot change the target.
      process.env.DATABASE_URL = database.toString();
      currentPhase = "import_modules";
      const [{ Prisma }, { prisma }, { textMessageContent }, { provisionActiveUser },
        { lockMemorySourceChat, applyMemorySourceMutations }, { defaultMemorySourceMutationHooks },
        { createPrismaMemoryCoordinatorRepository }, { MemoryCoordinatorError },
        { defaultMemoryExecutionAuthority }, { createPrismaMemoryFactExtractionHandler },
        { createPrismaMemoryRelationHandler }, { reconcileMemoryFactRelationJobs },
        { loadMemoryCoordinatorPolicy, memoryRetryDelay }, { memoryCoordinatorJobMaxAttempts }] = await Promise.all([
        import("@prisma/client"), import("../lib/server/prisma"), import("../lib/domain/content"),
        import("../lib/server/auth/provisioning"), import("../lib/server/memory/sourceState"),
        import("../lib/server/memory/sourceHooks"),
        import("../lib/server/memory/coordinator/prismaRepository"),
        import("../lib/server/memory/coordinator/errors"),
        import("../lib/server/memory/execution/defaultAuthority"),
        import("../lib/server/memory/learning/extraction/handler"),
        import("../lib/server/memory/learning/relations/handler"),
        import("../lib/server/memory/learning/relations/reconcile"),
        import("../lib/server/memory/coordinator/policy"),
        import("../lib/server/memory/coordinator/registry")
      ]);
      try {
        currentPhase = "database_identity";
        const identity = await prisma.$queryRaw<Array<{ database: string; role: string }>>(Prisma.sql`
          SELECT current_database() AS database, current_user AS role
        `);
        if (identity.length !== 1 || identity[0]?.database !== database.pathname.slice(1) ||
          identity[0].role !== database.username) {
          throw new Error("memory_extraction_database_identity_mismatch");
        }
        currentPhase = "coordinator_guard";
        await assertStoppedCoordinator(prisma);
        const group = await prisma.group.findUnique({ where: { systemRole: "full_access" }, select: { id: true } });
        if (!group) throw new Error("memory_extraction_synthetic_group_missing");
        const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
        const handlers: Readonly<Record<string, MemoryJobHandler>> = {
          EXTRACT_FACTS: createPrismaMemoryFactExtractionHandler(defaultMemoryExecutionAuthority, prisma),
          RESOLVE_FACT_RELATIONS: createPrismaMemoryRelationHandler(prisma)
        };
        const policy = loadMemoryCoordinatorPolicy();
        const degradedCodes: string[] = [];
        const jobRetries: string[] = [];
        const jobStages: string[] = [];
        const ownerIds: string[] = [];

        /** Runs queued learning jobs like one coordinator worker, including the
         * coordinator's relation reconciliation that enqueues RESOLVE_FACT_RELATIONS
         * for versions an extraction staged as PENDING_RELATION. */
        const drain = async (): Promise<void> => {
          // A pending version resolves in one relation job; two passes cover a
          // relation job that itself leaves another version pending.
          let reconciles = 0;
          for (let index = 0; index < MAX_JOBS_PER_MESSAGE; index++) {
            const now = new Date();
            const claim: MemoryJobClaim | null = await coordinator.claimJob({
              claimToken: randomUUID(), kinds: ["EXTRACT_FACTS", "RESOLVE_FACT_RELATIONS"],
              leaseExpiresAt: new Date(now.getTime() + JOB_TIMEOUT_MS), now
            });
            if (!claim) {
              // A retryable failure waits for its due time like the coordinator's
              // requeue pass, then runs again within the job's attempt budget.
              const retry = await prisma.memoryJob.findFirst({
                orderBy: { nextAttemptAt: "asc" }, select: { nextAttemptAt: true },
                where: { kind: { in: ["EXTRACT_FACTS", "RESOLVE_FACT_RELATIONS"] }, state: "RETRYABLE_FAILED" }
              });
              if (retry) {
                const wait = Math.min(60_000, Math.max(0, (retry.nextAttemptAt?.getTime() ?? 0) - Date.now()));
                await new Promise((resolve) => setTimeout(resolve, wait));
                await coordinator.requeueDueJobs({
                  kinds: ["EXTRACT_FACTS", "RESOLVE_FACT_RELATIONS"], limit: 8, now: new Date()
                });
                continue;
              }
              if (reconciles >= 2) return;
              currentPhase = "relation_reconcile";
              if (await reconcileMemoryFactRelationJobs(prisma) === 0) return;
              reconciles++;
              continue;
            }
            const handler = handlers[claim.kind]!;
            currentPhase = claim.kind === "EXTRACT_FACTS" ? "extraction_job" : "relation_job";
            try {
              const gate = await handler.preflight(claim);
              if (gate.status === "WAITING_FOR_CONFIGURATION") {
                throw new Error("memory_extraction_utility_binding_unavailable");
              }
              if (gate.status !== "READY") {
                await coordinator.settleJobGate({ claim, decision: gate, now: new Date() });
                degradedCodes.push(gate.errorCode);
                continue;
              }
              const result = await handler.execute(claim, {
                now: () => new Date(),
                setStage: async (stage) => {
                  if (!await coordinator.setJobStage({ claim, now: new Date(), stage })) {
                    throw new Error("memory_extraction_lease_lost");
                  }
                },
                signal: AbortSignal.timeout(JOB_TIMEOUT_MS - 10_000)
              });
              const commitGate = await handler.preflight(claim);
              if (commitGate.status !== "READY") {
                await coordinator.settleJobGate({ claim, decision: commitGate, now: new Date() });
                degradedCodes.push(commitGate.status === "WAITING_FOR_CONFIGURATION"
                  ? "memory_extraction_utility_binding_unavailable" : commitGate.errorCode);
                continue;
              }
              if (!await coordinator.commitJobSuccess({
                acceptedResultHash: result.acceptedResultHash, apply: result.apply, claim,
                now: new Date(), operationalCounters: result.operationalCounters,
                stage: result.stage ?? null
              })) throw new Error("memory_extraction_commit_rejected");
              const stage = result.stage ?? "unknown";
              jobStages.push(stage);
              const healthy = claim.kind === "EXTRACT_FACTS"
                ? healthyExtractionStages.has(stage)
                : stage.startsWith("relation_") && stage !== "relation_job_invalid";
              if (!healthy) degradedCodes.push(stage);
            } catch (error) {
              if (error instanceof Error && error.message === "memory_extraction_utility_binding_unavailable") {
                throw error;
              }
              const failure = error instanceof MemoryCoordinatorError
                ? error : new MemoryCoordinatorError("memory_job_failed", true);
              if (failure.retryable && claim.attemptCount <
                memoryCoordinatorJobMaxAttempts(claim.kind, policy.maxJobAttempts)) {
                const now = new Date();
                if (await coordinator.retryJob({
                  claim, errorCode: failure.code, now,
                  nextAttemptAt: new Date(now.getTime() +
                    memoryRetryDelay(policy.jobRetryDelaysMs, claim.attemptCount))
                })) {
                  jobRetries.push(failure.code);
                  continue;
                }
              }
              await coordinator.terminalJob({ claim, errorCode: failure.code, now: new Date() }).catch(() => false);
              degradedCodes.push(failure.code);
            }
          }
          throw new Error("memory_extraction_job_budget_exhausted");
        };

        /** One accepted direct user turn and its ordinary memory settlement. */
        const turn = async (userId: string, chatId: string, text: string, parentMessageId: string | null) => {
          const createdAt = new Date();
          const userMessage = await prisma.message.create({ data: {
            chatId, content: textMessageContent(text), createdAt, parentMessageId,
            role: "user", status: "complete", updatedAt: createdAt
          } });
          const assistantAt = new Date(createdAt.getTime() + 1);
          const assistantMessage = await prisma.message.create({ data: {
            chatId, content: textMessageContent("Noted."), createdAt: assistantAt,
            modelId: "synthetic-qualification", parentMessageId: userMessage.id,
            provider: "synthetic-qualification", role: "assistant", status: "complete",
            updatedAt: assistantAt
          } });
          const run = await prisma.modelRun.create({ data: {
            assistantMessageId: assistantMessage.id, chatId, modelId: "synthetic-qualification",
            normalizedRequest: { prompt: { baseline: { source: "standard_chat", timeZone: "UTC",
              timeZoneSource: "client" } }, qualificationFixture: true },
            provider: "synthetic-qualification", status: "complete", userId,
            userMessageId: userMessage.id
          } });
          for (const mutations of [["NORMAL_APPEND"], ["TERMINAL_SETTLEMENT"]] as const) {
            await prisma.$transaction(async (tx) => {
              const chat = await lockMemorySourceChat(tx, { chatId, lock: "UPDATE", userId });
              if (!chat) throw new Error("memory_extraction_chat_missing");
              await applyMemorySourceMutations(tx, mutations[0] === "NORMAL_APPEND"
                ? { chat, hooks: defaultMemorySourceMutationHooks, mutations,
                  patch: { activeLeafMessageId: assistantMessage.id } }
                : { chat, hooks: defaultMemorySourceMutationHooks, mutations,
                  terminalSettlement: { assistantMessageId: assistantMessage.id, runId: run.id, status: "complete" } });
            });
          }
          await drain();
          return { assistantMessageId: assistantMessage.id, userMessageId: userMessage.id };
        };

        const savedFrom = async (userId: string, messageId: string) => {
          const evidence = await prisma.memoryEvidence.findMany({
            select: { factVersionId: true, sourceEndOffset: true, sourceStartOffset: true },
            where: { messageId, stance: "SUPPORTS", userId }
          });
          const versions = await prisma.memoryFactVersion.findMany({
            select: { factId: true, id: true, semanticFrame: true, sourceMode: true, state: true },
            where: { id: { in: evidence.map(({ factVersionId }) => factVersionId) }, userId }
          });
          const byId = new Map(versions.map((version) => [version.id, version]));
          return evidence.flatMap((row) => {
            const version = byId.get(row.factVersionId);
            if (!version || version.sourceMode !== "AUTOMATIC" ||
              row.sourceStartOffset === null || row.sourceEndOffset === null) return [];
            const frame = version.semanticFrame as Record<string, unknown> | null;
            return [{
              end: row.sourceEndOffset, explicitRemember: frame?.memoryDirective === "EXPLICIT_REMEMBER",
              factId: version.factId, start: row.sourceStartOffset, versionId: version.id
            }];
          });
        };
        const currentVersionIds = async (userId: string, versionIds: readonly string[]) =>
          new Set((await prisma.memoryFact.findMany({
            select: { currentVersionId: true },
            where: { currentVersionId: { in: [...versionIds] }, state: "ACTIVE", userId }
          })).flatMap(({ currentVersionId }) => currentVersionId ? [currentVersionId] : []));
        const receiptsFor = async (userId: string, jobIds: readonly string[]) => {
          const executions = await prisma.memoryFactExtractionExecution.findMany({
            select: { id: true }, where: { memoryJobId: { in: [...jobIds] }, userId }
          });
          return (await prisma.memoryFactExtractionCandidateReceipt.findMany({
            select: { outcome: true, reasonCode: true },
            where: { extractionExecutionId: { in: executions.map(({ id }) => id) }, userId }
          })).map(({ outcome, reasonCode }) => reasonCode ?? outcome);
        };

        const runScenario = async (
          scenario: ExtractionQualificationScenario
        ): Promise<ExtractionQualificationResult> => {
          currentPhase = "seed_owner";
          const userId = `memory-extraction-synthetic-${options.runId}-${randomUUID()}`;
          ownerIds.push(userId);
          await prisma.$transaction(async (tx) => {
            await tx.user.create({ data: { displayName: "Synthetic extraction qualification",
              email: `${userId}@example.invalid`, id: userId, role: "user", status: "active" } });
            await provisionActiveUser(tx, { groups: [{ groupId: group.id, role: "member" }], userId });
            await tx.userMemorySettings.update({ data: {
              learnAutomatically: true, referenceChatHistory: false, synthesisEnabled: false,
              useMemoryFacts: true
            }, where: { userId } });
          });
          const chat = await prisma.chat.create({ data: { title: "Synthetic extraction qualification", userId } });
          let parent: string | null = null;
          let priorVersionIds: readonly string[] = [];
          if (scenario.prior !== null) {
            currentPhase = "prior_turn";
            const prior = await turn(userId, chat.id, scenario.prior, parent);
            parent = prior.assistantMessageId;
            const saved = await savedFrom(userId, prior.userMessageId);
            const current = await currentVersionIds(userId, saved.map(({ versionId }) => versionId));
            priorVersionIds = [...current];
          }
          currentPhase = "target_turn";
          const target = await turn(userId, chat.id, scenario.text, parent);
          currentPhase = "judge";
          const saved = await savedFrom(userId, target.userMessageId);
          const stillCurrent = await currentVersionIds(userId, priorVersionIds);
          const priorVersions = new Set(priorVersionIds);
          const jobs = await prisma.memoryJob.findMany({
            select: { id: true }, where: { kind: "EXTRACT_FACTS", sourceMessageId: target.userMessageId, userId }
          });
          const verdict = judgeExtractionScenario(scenario, {
            // A change applied to the prior fact is not a separate save.
            saved: saved.filter(({ versionId }) => !priorVersions.has(versionId)),
            ...(scenario.prior === null ? {} : {
              priorReplaced: priorVersionIds.length > 0 &&
                priorVersionIds.some((id) => !stillCurrent.has(id)),
              priorSaved: priorVersionIds.length > 0
            })
          });
          return {
            receipts: await receiptsFor(userId, jobs.map(({ id }) => id)),
            scenario,
            verdict
          };
        };

        const results: ExtractionQualificationResult[] = [];
        for (const scenario of MEMORY_EXTRACTION_QUALIFICATION_SCENARIOS) {
          results.push(await runScenario(scenario));
        }
        currentPhase = "usage";
        const bindings = await prisma.memoryExecutionBinding.findMany({
          select: { errorCode: true, estimatedCostMicros: true, inputTokens: true, logicalRole: true,
            memoryJobId: true, outputTokens: true, state: true, totalTokens: true },
          where: { userId: { in: ownerIds } }
        });
        const succeededJobs = new Set((await prisma.memoryJob.findMany({
          select: { id: true },
          where: { id: { in: bindings.flatMap(({ memoryJobId }) => memoryJobId ? [memoryJobId] : []) },
            state: "SUCCEEDED" }
        })).map(({ id }) => id));
        const usage = bindings.map((row) => ({
          estimatedCostMicros: row.estimatedCostMicros === null ? null : Number(row.estimatedCostMicros),
          inputTokens: row.inputTokens, outputTokens: row.outputTokens, role: row.logicalRole,
          // A settled replay-safe transient call whose job then succeeded on
          // the coordinator's retry is reported, not degraded.
          state: row.state === "FAILED" && /_transient$/u.test(row.errorCode ?? "") &&
            row.memoryJobId !== null && succeededJobs.has(row.memoryJobId) ? "RETRIED" : row.state,
          totalTokens: row.totalTokens
        }));
        const report = summarizeExtractionQualification({ degradedCodes, jobRetries, jobStages, results, usage });
        currentPhase = "write_report";
        await files.report.write(report);
        return report;
      } finally {
        await prisma.$disconnect();
      }
    } catch (error) {
      await files.report.write({ status: "failed", ...cleanupQualificationFailureDiagnostic(error, currentPhase),
        sanitizedAggregatesOnly: true }).catch(() => undefined);
      throw error;
    }
  });
}

async function assertStoppedCoordinator(client: PrismaClient): Promise<void> {
  const [workers, jobs] = await Promise.all([
    client.memoryWorkerHeartbeat.count({ where: { lastSeenAt: { gt: new Date(Date.now() - 60_000) }, ready: true } }),
    client.memoryJob.count({ where: { kind: { in: [...learningKinds] }, state: { in: [...activeStates] } } })
  ]);
  if (workers || jobs) throw new Error("memory_extraction_disposable_target_busy");
}

/** Library logging stays in the child; the parent prints one sanitized line. */
async function main(): Promise<void> {
  extractionQualificationOptions(process.argv.slice(2));
  if (process.send && process.env[WORKER_ENV] === "1") {
    try {
      const report = await worker();
      process.send(report);
      process.exitCode = report.status === "passed" ? 0 : 2;
    } catch (error) {
      process.send({ status: "failed", ...cleanupQualificationFailureDiagnostic(error, currentPhase) });
      process.exitCode = 1;
    }
    process.disconnect();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      env: { ...process.env, [WORKER_ENV]: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    let received = false;
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS + 30_000);
    child.on("message", (message: unknown) => {
      const safe = sanitizeExtractionQualificationMessage(message);
      if (!safe) return;
      received = true;
      process.stdout.write(`${JSON.stringify(safe)}\n`);
    });
    child.once("error", () => { clearTimeout(timer); reject(new Error("memory_extraction_worker_failed")); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!received) { reject(new Error("memory_extraction_worker_no_report")); return; }
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

void main().catch((error: unknown) => {
  const code = error instanceof Error && /^memory_[a-z0-9_]{1,88}$/u.test(error.message)
    ? error.message : "memory_extraction_qualification_failed";
  process.stdout.write(`${JSON.stringify({ code, sanitizedAggregatesOnly: true, status: "failed" })}\n`);
  process.exitCode = 1;
});

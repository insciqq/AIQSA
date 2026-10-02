// Opt-in qualification of imported, owner-scoped disposable fixtures.
// Run with --ack DISPOSABLE_PAID_MEMORY_CLEANUP --mode preview|apply
// --fixture /private/fixture.json --plan /private/plan.json --output /private/report.json.
// Preview stages real governed decisions without changing facts. Apply recovers
// that exact staged job, proves that recovery makes no further provider call and
// runs the owner's resulting fact purges. Verify reports the whole corpus.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import type { MemoryJobClaim } from "../lib/server/memory/coordinator/types";
import {
  MEMORY_CLEANUP_QUALIFICATION_REASONS,
  assertCleanupQualificationOwnership,
  assertCleanupQualificationContinuation,
  assertCleanupQualificationPlan,
  cleanupQualificationDatabase,
  cleanupQualificationFailureCode,
  cleanupQualificationFailureDiagnostic,
  cleanupQualificationFixtureSchema,
  cleanupQualificationHash,
  cleanupQualificationOptions,
  cleanupQualificationPlanSchema,
  evaluateCleanupQualification,
  readCleanupQualificationFile,
  reserveCleanupQualificationFile,
  summarizeCleanupQualificationReviews,
  withCleanupQualificationOutputFiles,
  type CleanupQualificationFactState,
  type CleanupQualificationPlan
} from "./memory-cleanup-qualification-support";

const TIMEOUT_MS = 12 * 60 * 1_000;
let currentPhase = "arguments";
const activeStates = ["QUEUED", "CLAIMED", "RETRYABLE_FAILED", "WAITING_FOR_CONFIGURATION", "WAITING_FOR_EGRESS_CONSENT"] as const;
type ReasonCounts = Readonly<{
  blockedPendingRelation: number;
  blockedEvidenceWithoutOffsets: number;
  blockedSourceChanged: number;
  unreviewableContext: number;
  unreviewableStatementTooLong: number;
  unreviewableEvidenceNotCurrent: number;
}>;
type Report = Readonly<{
  status: "passed" | "failed";
  mode: "seed" | "preview" | "apply" | "verify";
  reviewed: number;
  removed: number;
  kept: number;
  rejected: number;
  blocked: number;
  unreviewable: number;
  erroneousRemovals: number;
  remainingShortTerm: number;
  datedRemoved: number;
  datedPurged: number;
  purgePending: number;
  durationMs: number;
  protected: number;
  checked: number;
  passed: number;
  providerCalls: number;
  replayProviderCalls: number;
  previewUnchanged: boolean;
  repeatedCommitUnchanged: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostMicros: number;
  reportedCostCalls: number;
  reportedTokenCalls: number;
  sanitizedAggregatesOnly: true;
  paidExtraction: false;
  sourceMessagesUnchanged: boolean;
  scope: "FIXTURE_SETUP" | "BATCH" | "CORPUS";
  corpusComplete: boolean;
  remaining: number;
}> & ReasonCounts;
const REPORT_REASON_KEYS = {
  pending_relation: "blockedPendingRelation",
  evidence_without_offsets: "blockedEvidenceWithoutOffsets",
  source_changed: "blockedSourceChanged",
  unreviewable_context: "unreviewableContext",
  statement_too_long: "unreviewableStatementTooLong",
  evidence_not_current: "unreviewableEvidenceNotCurrent"
} as const satisfies Record<(typeof MEMORY_CLEANUP_QUALIFICATION_REASONS)[number], keyof ReasonCounts>;
const startedAt = Date.now();
function reasonCounts(reasons?: Readonly<Record<string, number>>): ReasonCounts {
  return Object.fromEntries(MEMORY_CLEANUP_QUALIFICATION_REASONS.map((reason) =>
    [REPORT_REASON_KEYS[reason], reasons?.[reason] ?? 0])) as ReasonCounts;
}
const noOutcomes = { kept: 0, rejected: 0, blocked: 0, unreviewable: 0, erroneousRemovals: 0, remainingShortTerm: 0,
  datedRemoved: 0, datedPurged: 0, purgePending: 0, ...reasonCounts() };

async function inventory(client: PrismaClient, userId: string): Promise<readonly CleanupQualificationFactState[]> {
  const [facts, versions, ownerEvents] = await Promise.all([
    client.memoryFact.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    client.memoryFactVersion.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    client.memoryEvent.findMany({ where: { userId, actorType: "USER", factId: { not: null } }, select: { factId: true } })
  ]);
  const byId = new Map(versions.map((version) => [version.id, version]));
  return facts.map((fact) => {
    const current = fact.currentVersionId ? byId.get(fact.currentVersionId) : undefined;
    return {
      factId: fact.id,
      currentVersionId: fact.currentVersionId,
      active: fact.state === "ACTIVE" && current?.state === "ACTIVE" && current.contentPurgedAt === null,
      protected: fact.pinned || versions.some((version) => version.factId === fact.id && (version.sourceMode === "EXPLICIT" ||
        (version.semanticFrame as { memoryDirective?: unknown } | null)?.memoryDirective === "EXPLICIT_REMEMBER")) ||
        ownerEvents.some((event) => event.factId === fact.id),
      snapshotHash: cleanupQualificationHash({ fact, versions: versions.filter((version) => version.factId === fact.id) })
    };
  });
}

async function providerEvidence(client: PrismaClient, userId: string, jobId: string) {
  const rows = await client.memoryExecutionBinding.findMany({
    where: { userId, memoryJobId: jobId }, orderBy: { ordinal: "asc" },
    select: { state: true, logicalRole: true, inputHash: true, acceptedOutputHash: true,
      inputTokens: true, outputTokens: true, totalTokens: true, estimatedCostMicros: true }
  });
  if (!rows.length || rows.some((row) => row.state !== "SUCCEEDED" || row.logicalRole !== "MEMORY_SYNTHESIZE")) {
    throw new Error("memory_cleanup_provider_execution_unhealthy");
  }
  return {
    count: rows.length,
    inputHash: rows[0]!.inputHash,
    usage: {
      inputTokens: rows.reduce((total, row) => total + (row.inputTokens ?? 0), 0),
      outputTokens: rows.reduce((total, row) => total + (row.outputTokens ?? 0), 0),
      totalTokens: rows.reduce((total, row) => total + (row.totalTokens ?? 0), 0),
      estimatedCostMicros: rows.reduce((total, row) => total + Number(row.estimatedCostMicros ?? 0), 0),
      reportedCostCalls: rows.filter((row) => row.estimatedCostMicros !== null).length,
      reportedTokenCalls: rows.filter((row) => row.totalTokens !== null).length
    }
  };
}

async function sourceDocumentsHash(client: PrismaClient, userId: string): Promise<string> {
  const [chats, messages] = await Promise.all([
    client.chat.findMany({ where: { userId }, orderBy: { id: "asc" },
      select: { id: true, activeLeafMessageId: true, memoryMode: true, memorySourceRevision: true,
        memoryBranchGeneration: true, permanentDeletionAt: true } }),
    client.message.findMany({ where: { chat: { userId } }, orderBy: { id: "asc" },
      select: { id: true, chatId: true, parentMessageId: true, role: true, status: true,
        content: true, createdAt: true, updatedAt: true } })
  ]);
  return cleanupQualificationHash({ chats, messages });
}

/** Only governed jobs with provider receipts count as paid decisions; an
 * imported historical checkpoint without receipts is baseline state. */
async function committedReviews(client: PrismaClient, userId: string, current: readonly CleanupQualificationFactState[]) {
  const { MEMORY_MAINTENANCE_POLICY_VERSION, MEMORY_MAINTENANCE_PIPELINE_VERSION,
    MEMORY_MAINTENANCE_SUPPORTED_POLICY_VERSIONS } =
    await import("../lib/server/memory/maintenance/policy");
  const [reviews, jobs, paid, versions] = await Promise.all([
    client.memoryMaintenanceReview.findMany({ where: { userId,
      policyVersion: { in: [...MEMORY_MAINTENANCE_SUPPORTED_POLICY_VERSIONS] },
      disposition: { in: ["KEEP", "REMOVED", "REJECTED", "BLOCKED", "UNREVIEWABLE"] } },
    select: { factVersionId: true, memoryJobId: true, policyVersion: true, disposition: true, reasonCode: true } }),
    client.memoryJob.findMany({ where: { userId, state: "SUCCEEDED", pipelineVersion: MEMORY_MAINTENANCE_PIPELINE_VERSION },
      select: { id: true } }),
    client.memoryExecutionBinding.findMany({ where: { userId, logicalRole: "MEMORY_SYNTHESIZE" }, select: { memoryJobId: true } }),
    client.memoryFactVersion.findMany({ where: { userId }, select: { id: true, factId: true } })
  ]);
  const receipts = new Set(paid.map(({ memoryJobId }) => memoryJobId));
  return summarizeCleanupQualificationReviews({ currentPolicy: MEMORY_MAINTENANCE_POLICY_VERSION,
    supportedPolicies: MEMORY_MAINTENANCE_SUPPORTED_POLICY_VERSIONS,
    activeFactIds: current.filter((item) => item.active).map((item) => item.factId),
    succeededJobIds: jobs.map(({ id }) => id).filter((id) => receipts.has(id)), versions, reviews });
}

/** The owner's fact purges, run as the stopped coordinator would. No provider. */
async function drainOwnedForgetPurges(client: PrismaClient, userId: string): Promise<number> {
  const [{ createPrismaMemoryCoordinatorRepository }, { MEMORY_PURGE_REQUIRED_CONTRIBUTORS },
    { registerMemoryDeletionContributors }, { MemoryDeletionContributorRegistry }] = await Promise.all([
    import("../lib/server/memory/coordinator/prismaRepository"), import("../lib/server/memory/purge/contract"),
    import("../lib/server/memory/purge/leaves"), import("../lib/server/memory/purge/registry")
  ]);
  const registry = new MemoryDeletionContributorRegistry({ operation: "FORGET_PURGE", requirements: MEMORY_PURGE_REQUIRED_CONTRIBUTORS });
  registerMemoryDeletionContributors(registry);
  const coordinator = createPrismaMemoryCoordinatorRepository(client);
  const pending = await client.memoryDeletionOutbox.findMany({ where: { userId, operation: "FORGET_PURGE",
    state: { in: ["PENDING", "RETRY_WAIT"] } }, select: { id: true }, orderBy: { id: "asc" } });
  let purged = 0;
  for (const { id } of pending) {
    const now = new Date();
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + 60_000);
    const claimed = await client.memoryDeletionOutbox.updateMany({ where: { id, userId, state: { in: ["PENDING", "RETRY_WAIT"] } },
      data: { attemptCount: { increment: 1 }, errorCode: null, leaseExpiresAt, leaseToken: claimToken,
        nextAttemptAt: null, state: "RUNNING", updatedAt: now } });
    if (claimed.count !== 1) continue;
    const row = await client.memoryDeletionOutbox.findUniqueOrThrow({ where: { id } });
    const claim = { admissionAuthorizationId: row.admissionAuthorizationId, admittedActiveLeafMessageId: row.admittedActiveLeafMessageId,
      admittedChatSourceRevision: row.admittedChatSourceRevision, alsoForgetOriginMemories: row.alsoForgetOriginMemories,
      attemptCount: row.attemptCount, claimToken, id, leaseExpiresAt, memoryGeneration: row.memoryGeneration,
      operation: row.operation, recoveredLease: false, resumedFromBlocked: false, targetId: row.targetId,
      targetType: row.targetType, userId };
    const execution = await registry.handler().execute(claim, { now: () => now, signal: AbortSignal.timeout(60_000) });
    if (!await coordinator.commitDeletionSuccess({ apply: execution.apply, claim, now })) {
      throw new Error("memory_cleanup_purge_commit_rejected");
    }
    purged++;
  }
  return purged;
}

/** Removed dated fixture facts and their purge obligations. */
async function datedPurgeStates(client: PrismaClient, userId: string, fixture: Readonly<{ assertions: readonly Readonly<{
  factIds: readonly string[]; dated?: boolean }>[] }>, current: readonly CleanupQualificationFactState[]) {
  const dated = new Set(fixture.assertions.filter(({ dated }) => dated).flatMap(({ factIds }) => factIds));
  const removed = current.filter(({ factId, active }) => dated.has(factId) && !active).map(({ factId }) => factId);
  const [succeeded, pending] = await Promise.all([
    client.memoryDeletionOutbox.count({ where: { userId, operation: "FORGET_PURGE", state: "SUCCEEDED", targetId: { in: removed } } }),
    client.memoryDeletionOutbox.count({ where: { userId, operation: "FORGET_PURGE", state: { not: "SUCCEEDED" } } })
  ]);
  return { datedRemoved: removed.length, datedPurged: succeeded, purgePending: pending };
}

async function assertStoppedCoordinator(client: PrismaClient, allowedJobId: string | null): Promise<void> {
  if (process.env.AIQSA_MEMORY_CLEANUP_COORDINATOR_STOPPED !== "1") {
    throw new Error("memory_cleanup_stopped_coordinator_required");
  }
  const [workers, jobs] = await Promise.all([
    client.memoryWorkerHeartbeat.count({ where: { ready: true,
      lastSeenAt: { gt: new Date(Date.now() - 60_000) } } }),
    client.memoryJob.count({ where: { state: { in: [...activeStates] },
      ...(allowedJobId ? { id: { not: allowedJobId } } : {}) } })
  ]);
  if (workers || jobs) throw new Error("memory_cleanup_disposable_target_busy");
}

async function worker(): Promise<Report> {
  const options = cleanupQualificationOptions(process.argv.slice(2));
  if (options.mode === "seed") {
    currentPhase = "seed_target_guard";
    const database = cleanupQualificationDatabase(process.env, options.runId);
    process.env.DATABASE_URL = database.toString();
    currentPhase = "seed_reserve_files";
    const fixtureFile = await reserveCleanupQualificationFile(options.fixture);
    let reportFile: Awaited<ReturnType<typeof reserveCleanupQualificationFile>> | undefined;
    try {
      reportFile = await reserveCleanupQualificationFile(options.output);
      currentPhase = "seed_import_modules";
      const [{ prisma }, { materializeMemoryCleanupSyntheticFixture }] = await Promise.all([
        import("../lib/server/prisma"), import("./memory-cleanup-qualification-seed")
      ]);
      try {
        currentPhase = "seed_coordinator_guard";
        await assertStoppedCoordinator(prisma, null);
        currentPhase = "seed_materialize";
        const fixture = await materializeMemoryCleanupSyntheticFixture(prisma, options.runId);
        currentPhase = "seed_write_fixture";
        await fixtureFile.write(fixture);
        const report: Report = { status: "passed", mode: "seed", reviewed: 0, removed: 0, ...noOutcomes,
          durationMs: Date.now() - startedAt,
          protected: fixture.assertions.filter((item) => item.protected).length,
          checked: fixture.assertions.length, passed: fixture.assertions.length,
          providerCalls: 0, replayProviderCalls: 0, previewUnchanged: false, repeatedCommitUnchanged: false,
          inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostMicros: 0,
          reportedCostCalls: 0, reportedTokenCalls: 0,
          sanitizedAggregatesOnly: true, paidExtraction: false, sourceMessagesUnchanged: true,
          scope: "FIXTURE_SETUP", corpusComplete: false, remaining: 0 };
        currentPhase = "seed_write_report";
        await reportFile.write(report);
        return report;
      } finally { await prisma.$disconnect(); }
    } finally { await fixtureFile.close(); await reportFile?.close(); }
  }
  currentPhase = "read_fixture";
  const fixture = cleanupQualificationFixtureSchema.parse(await readCleanupQualificationFile(options.fixture));
  const database = cleanupQualificationDatabase(process.env, fixture.runId);
  const previous = options.mode === "apply"
    ? cleanupQualificationPlanSchema.parse(await readCleanupQualificationFile(options.plan)) : null;
  if (previous) assertCleanupQualificationPlan(previous, fixture, database);
  const baseline = options.baselinePlan
    ? cleanupQualificationPlanSchema.parse(await readCleanupQualificationFile(options.baselinePlan)) : previous;
  if (baseline) assertCleanupQualificationPlan(baseline, fixture, database);
  if (previous && baseline && cleanupQualificationHash(previous.before) !== cleanupQualificationHash(baseline.before)) {
    throw new Error("memory_cleanup_baseline_mismatch");
  }
  currentPhase = "reserve_output_files";
  return withCleanupQualificationOutputFiles({ report: options.output,
    ...(options.mode === "preview" ? { plan: options.plan } : {}) }, async (files) => {
    try {
      // No environment autoload: a workspace's ordinary .env cannot change the target.
      process.env.DATABASE_URL = database.toString();
      currentPhase = "import_modules";
      const [{ Prisma }, { prisma }, { createPrismaMemoryCoordinatorRepository },
        { createPrismaMemoryMaintenanceRepository }, { createPrismaMemoryMaintenanceHandler },
        { scheduleOwnerMemoryMaintenance }, { MEMORY_MAINTENANCE_PIPELINE_VERSION }, { scanMemoryMaintenanceSources }] = await Promise.all([
        import("@prisma/client"), import("../lib/server/prisma"),
        import("../lib/server/memory/coordinator/prismaRepository"),
        import("../lib/server/memory/maintenance/repository"),
        import("../lib/server/memory/maintenance/handler"),
        import("../lib/server/memory/maintenance/reconcile"),
        import("../lib/server/memory/maintenance/policy"), import("../lib/server/memory/maintenance/source")
      ]);
      let claim: MemoryJobClaim | null = null;
      try {
        currentPhase = "database_identity";
        const identity = await prisma.$queryRaw<Array<{ database: string; role: string }>>(Prisma.sql`
          SELECT current_database() AS database, current_user AS role
        `);
        if (identity.length !== 1 || identity[0]?.database !== database.pathname.slice(1) || identity[0].role !== database.username) {
          throw new Error("memory_cleanup_database_identity_mismatch");
        }
        const owner = await prisma.user.findFirst({ where: { id: fixture.userId, status: "active" }, select: { id: true } });
        if (!owner) throw new Error("memory_cleanup_fixture_owner_missing");
        currentPhase = "coordinator_guard";
        await assertStoppedCoordinator(prisma, previous?.jobId ?? null);
        currentPhase = "snapshot_inventory";
        const current = await inventory(prisma, fixture.userId);
        if (!baseline) assertCleanupQualificationOwnership(fixture, current);
        const before = baseline?.before ?? current;
        const priorReviews = await committedReviews(prisma, fixture.userId, current);
        if (!baseline && priorReviews.jobs.length) throw new Error("memory_cleanup_original_baseline_required");
        if (baseline) {
          assertCleanupQualificationOwnership(fixture, before);
          assertCleanupQualificationContinuation(before, current, priorReviews.removed);
        }
        const sourceHash = await sourceDocumentsHash(prisma, fixture.userId);
        if (baseline && baseline.sourceDocumentsHash !== sourceHash) {
          throw new Error("memory_cleanup_source_documents_changed");
        }
        const protectedSnapshotHash = cleanupQualificationHash(current.filter((item) => item.protected));
        if (baseline && protectedSnapshotHash !== baseline.protectedSnapshotHash) {
          throw new Error("memory_cleanup_protected_snapshot_changed");
        }
        const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
        const repository = createPrismaMemoryMaintenanceRepository(prisma);
        const handler = createPrismaMemoryMaintenanceHandler(prisma);
        if (options.mode === "verify") {
          currentPhase = "verify_corpus";
          const failedJobs = await prisma.memoryJob.count({ where: { userId: fixture.userId,
            pipelineVersion: MEMORY_MAINTENANCE_PIPELINE_VERSION, state: { not: "SUCCEEDED" } } });
          let cursor: string | null = null;
          let pendingEligible = 0;
          for (let page = 0; page <= Math.ceil(current.length / 16); page++) {
            const scan = await scanMemoryMaintenanceSources(prisma, fixture.userId, new Date(), cursor);
            pendingEligible += (scan.plan?.sources.length ?? 0) + scan.blockers.length;
            if (scan.cursor === null) break;
            cursor = scan.cursor;
          }
          const remaining = before.filter((item) => item.active && !item.protected && !priorReviews.reviewed.has(item.factId) &&
            !priorReviews.settled.has(item.factId)).length;
          const quality = evaluateCleanupQualification(fixture, before, current);
          const purges = await datedPurgeStates(prisma, fixture.userId, fixture, current);
          const receipts = await Promise.all(priorReviews.jobs.map((id) => providerEvidence(prisma, fixture.userId, id)));
          const usage = receipts.reduce((total, item) => ({
            inputTokens: total.inputTokens + item.usage.inputTokens,
            outputTokens: total.outputTokens + item.usage.outputTokens,
            totalTokens: total.totalTokens + item.usage.totalTokens,
            estimatedCostMicros: total.estimatedCostMicros + item.usage.estimatedCostMicros,
            reportedCostCalls: total.reportedCostCalls + item.usage.reportedCostCalls,
            reportedTokenCalls: total.reportedTokenCalls + item.usage.reportedTokenCalls
          }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostMicros: 0, reportedCostCalls: 0, reportedTokenCalls: 0 });
          const report: Report = { status: remaining === 0 && pendingEligible === 0 && failedJobs === 0 &&
              quality.erroneousRemovals === 0 && purges.purgePending === 0 ? "passed" : "failed",
            mode: "verify", reviewed: priorReviews.reviewed.size, removed: quality.retired,
            kept: priorReviews.outcomes.kept, rejected: priorReviews.outcomes.rejected,
            blocked: priorReviews.outcomes.blocked, unreviewable: priorReviews.outcomes.unreviewable,
            erroneousRemovals: quality.erroneousRemovals, remainingShortTerm: quality.remainingRetire, ...purges,
            ...reasonCounts(priorReviews.reasons), durationMs: Date.now() - startedAt,
            protected: quality.protected, checked: quality.checked, passed: quality.passed,
            providerCalls: receipts.reduce((total, receipt) => total + receipt.count, 0), replayProviderCalls: 0,
            previewUnchanged: false, repeatedCommitUnchanged: false, ...usage, sanitizedAggregatesOnly: true,
            paidExtraction: false, sourceMessagesUnchanged: true, scope: "CORPUS",
            corpusComplete: remaining === 0 && pendingEligible === 0, remaining: Math.max(remaining, pendingEligible) };
          await files.report.write(report);
          return report;
        }
        if (!previous) {
          currentPhase = "schedule_batch";
          // Ordinary scheduler cursor may need to finish a scan and wrap after the
          // preceding batch reached its character budget. No production bound changes.
          let scheduled = 0;
          for (let page = 0; page <= Math.ceil(current.length / 16) + 1 && !scheduled; page++) {
            scheduled = await scheduleOwnerMemoryMaintenance(prisma, fixture.userId, new Date());
          }
        }
        const jobs = await prisma.memoryJob.findMany({ where: {
          userId: fixture.userId, pipelineVersion: MEMORY_MAINTENANCE_PIPELINE_VERSION,
          ...(previous ? { id: previous.jobId } : { state: { in: [...activeStates] } })
        }, select: { id: true, state: true, acceptedResultHash: true } });
        // Remaining sources may all be settled as blocked or unreviewable.
        if (!previous && jobs.length === 0) throw new Error("memory_cleanup_no_reviewable_batch");
        if (jobs.length !== 1) throw new Error("memory_cleanup_job_missing_or_ambiguous");
        const job = jobs[0]!;
        if (previous && job.state === "SUCCEEDED") {
          // Repeating the command only checks the already committed receipt and state.
          if (job.acceptedResultHash !== previous.acceptedOutputHash) throw new Error("memory_cleanup_plan_receipt_mismatch");
          const evidence = await providerEvidence(prisma, fixture.userId, job.id);
          const quality = evaluateCleanupQualification(fixture, before, current, new Set(previous.reviewedFactIds));
          if (evidence.count !== previous.providerCalls || quality.erroneousRemovals !== 0) {
            throw new Error("memory_cleanup_repeat_verification_failed");
          }
          const purges = await datedPurgeStates(prisma, fixture.userId, fixture, current);
          const report: Report = { status: "passed", mode: "apply", reviewed: 0,
            removed: quality.retired, ...noOutcomes, erroneousRemovals: quality.erroneousRemovals,
            remainingShortTerm: quality.remainingRetire, ...purges, durationMs: Date.now() - startedAt,
            protected: quality.protected, checked: quality.checked,
            passed: quality.passed, providerCalls: evidence.count, replayProviderCalls: 0,
            previewUnchanged: true, repeatedCommitUnchanged: true, ...evidence.usage,
            sanitizedAggregatesOnly: true, paidExtraction: false, sourceMessagesUnchanged: true,
            scope: "BATCH", corpusComplete: false,
            remaining: before.filter((item) => item.active && !item.protected && !priorReviews.reviewed.has(item.factId) &&
              !priorReviews.settled.has(item.factId)).length };
          await files.report.write(report);
          return report;
        }
        const now = new Date();
        currentPhase = "claim_job";
        claim = await coordinator.claimJob({ claimToken: randomUUID(), kinds: ["SYNTHESIZE_MEMORIES"],
          now, leaseExpiresAt: new Date(now.getTime() + TIMEOUT_MS) });
        if (!claim || claim.id !== job.id || claim.userId !== fixture.userId ||
          claim.pipelineVersion !== MEMORY_MAINTENANCE_PIPELINE_VERSION) throw new Error("memory_cleanup_claim_mismatch");
        currentPhase = "handler_preflight";
        const gate = await handler.preflight(claim);
        if (gate.status !== "READY") throw new Error("memory_cleanup_source_not_ready");
        currentPhase = "source_snapshot";
        const sourceSnapshot = await repository.snapshot(claim);
        const sourcePlan = sourceSnapshot?.plan;
        if (!sourceSnapshot || !sourcePlan || !sourcePlan.sources.length) throw new Error("memory_cleanup_source_plan_missing");
        if (previous && (sourcePlan.sourceSnapshotHash !== previous.sourceSnapshotHash || !claim.recoveredLease)) {
          throw new Error("memory_cleanup_source_snapshot_changed");
        }
        const reviewedFactIds = sourcePlan.sources.map(({ factId }) => factId);
        if (previous && cleanupQualificationHash(reviewedFactIds) !== cleanupQualificationHash(previous.reviewedFactIds)) {
          throw new Error("memory_cleanup_batch_sources_changed");
        }
        const callsBefore = previous ? await providerEvidence(prisma, fixture.userId, claim.id) : null;
        const currentClaim = claim;
        currentPhase = "handler_execute";
        const result = await handler.execute(claim, {
          signal: AbortSignal.timeout(TIMEOUT_MS - 10_000), now: () => new Date(),
          setStage: async (stage) => {
            currentPhase = /^[a-z][a-z0-9_]{0,47}$/u.test(stage) ? stage : "handler_execute";
            if (!await coordinator.setJobStage({ claim: currentClaim, now: new Date(), stage })) {
              throw new Error("memory_cleanup_lease_lost");
            }
          }
        });
        if (!result.apply) throw new Error("memory_cleanup_apply_missing");
        const evidence = await providerEvidence(prisma, fixture.userId, claim.id);
        if (previous && (evidence.count !== callsBefore?.count || evidence.count !== previous.providerCalls ||
          evidence.inputHash !== previous.inputHash || result.acceptedResultHash !== previous.acceptedOutputHash)) {
          throw new Error("memory_cleanup_staged_replay_mismatch");
        }
        let after = await inventory(prisma, fixture.userId);
        let repeatedCommitUnchanged = false;
        if (options.mode === "preview") {
          currentPhase = "preview_verify_and_persist";
          if (cleanupQualificationHash(after) !== cleanupQualificationHash(current)) throw new Error("memory_cleanup_preview_mutated_facts");
          if (!evidence.inputHash) throw new Error("memory_cleanup_input_hash_missing");
          const plan: CleanupQualificationPlan = {
            version: 1, runId: fixture.runId, userId: fixture.userId, jobId: claim.id,
            fixtureHash: cleanupQualificationHash(fixture), databaseHash: cleanupQualificationHash({
              host: database.hostname, port: database.port, name: database.pathname, role: database.username
            }), inputHash: evidence.inputHash, acceptedOutputHash: result.acceptedResultHash,
            sourceSnapshotHash: sourcePlan.sourceSnapshotHash, protectedSnapshotHash,
            sourceDocumentsHash: sourceHash,
            reviewedFactIds,
            before: [...before], providerCalls: evidence.count
          };
          if (!files.plan) throw new Error("memory_cleanup_preview_plan_file_missing");
          await files.plan.write(cleanupQualificationPlanSchema.parse(plan));
          // A deliberate interrupted-before-commit scenario: the next process must
          // recover these durable decisions, never issue a second review call.
          const releaseAt = new Date();
          if (!await coordinator.heartbeatJob({ claim, now: releaseAt, leaseExpiresAt: releaseAt })) {
            throw new Error("memory_cleanup_preview_lease_release_failed");
          }
        } else {
          currentPhase = "authorized_commit";
          const commit = { acceptedResultHash: result.acceptedResultHash, apply: result.apply, claim,
            now: new Date(), operationalCounters: result.operationalCounters, stage: result.stage ?? null };
          if (!await coordinator.commitJobSuccess(commit)) throw new Error("memory_cleanup_commit_rejected");
          const committed = await prisma.memoryJob.findUnique({ where: { id: claim.id }, select: { state: true } });
          if (committed?.state !== "SUCCEEDED") throw new Error("memory_cleanup_commit_not_succeeded");
          after = await inventory(prisma, fixture.userId);
          currentPhase = "repeat_commit";
          const repeated = await coordinator.commitJobSuccess({ ...commit, now: new Date() });
          repeatedCommitUnchanged = !repeated && cleanupQualificationHash(after) ===
            cleanupQualificationHash(await inventory(prisma, fixture.userId));
          if (!repeatedCommitUnchanged) throw new Error("memory_cleanup_commit_not_idempotent");
          currentPhase = "purge_removed_facts";
          await drainOwnedForgetPurges(prisma, fixture.userId);
          after = await inventory(prisma, fixture.userId);
        }
        currentPhase = "evaluate_batch";
        const quality = evaluateCleanupQualification(fixture, before, after, new Set(reviewedFactIds));
        if (sourceHash !== await sourceDocumentsHash(prisma, fixture.userId)) {
          throw new Error("memory_cleanup_source_documents_changed");
        }
        const batchOutcomes = options.mode === "apply" ? await prisma.memoryMaintenanceReview.findMany({ where: { userId: fixture.userId,
          memoryJobId: claim.id }, select: { disposition: true, reasonCode: true } }) : [];
        const purges = options.mode === "apply" ? await datedPurgeStates(prisma, fixture.userId, fixture, after)
          : { datedRemoved: 0, datedPurged: 0, purgePending: 0 };
        const report: Report = { status: options.mode === "preview" || quality.erroneousRemovals === 0 ? "passed" : "failed",
          mode: options.mode, reviewed: sourcePlan.sources.length, removed: quality.retired,
          kept: batchOutcomes.filter(({ disposition }) => disposition === "KEEP").length,
          rejected: batchOutcomes.filter(({ disposition }) => disposition === "REJECTED").length,
          blocked: batchOutcomes.filter(({ disposition }) => disposition === "BLOCKED").length,
          unreviewable: 0, erroneousRemovals: quality.erroneousRemovals, remainingShortTerm: quality.remainingRetire,
          ...purges, ...reasonCounts(Object.fromEntries(MEMORY_CLEANUP_QUALIFICATION_REASONS.map((reason) =>
            [reason, batchOutcomes.filter(({ reasonCode }) => reasonCode === reason).length]))),
          durationMs: Date.now() - startedAt,
          protected: quality.protected, checked: options.mode === "preview" ? 0 : quality.checked,
          passed: options.mode === "preview" ? 0 : quality.passed,
          providerCalls: evidence.count, replayProviderCalls: callsBefore ? evidence.count - callsBefore.count : 0,
          previewUnchanged: options.mode === "preview", repeatedCommitUnchanged,
          ...evidence.usage, sanitizedAggregatesOnly: true, paidExtraction: false, sourceMessagesUnchanged: true,
          scope: "BATCH", corpusComplete: false,
          remaining: before.filter((item) => item.active && !item.protected && !priorReviews.reviewed.has(item.factId) &&
            !priorReviews.settled.has(item.factId) &&
            (options.mode === "preview" || !reviewedFactIds.includes(item.factId))).length };
        await files.report.write(report);
        return report;
      } finally {
        await prisma.$disconnect();
      }
    } catch (error) {
      await files.report.write({ status: "failed", ...cleanupQualificationFailureDiagnostic(error, currentPhase),
        sanitizedAggregatesOnly: true, paidExtraction: false }).catch(() => undefined);
      throw error;
    }
  });
}

/** Isolate library logging: the parent accepts only a fixed aggregate IPC result.
 * Provider/Prisma diagnostics cannot leak private fixture data to the terminal. */
async function main(): Promise<void> {
  cleanupQualificationOptions(process.argv.slice(2));
  if (process.send && process.env.AIQSA_MEMORY_CLEANUP_WORKER === "1") {
    try {
      const report = await worker();
      process.send(report);
      process.exitCode = report.status === "passed" ? 0 : 2;
    } catch (error) {
      process.send({ status: "failed", ...cleanupQualificationFailureDiagnostic(error, currentPhase), sanitizedAggregatesOnly: true });
      process.exitCode = 1;
    }
    process.disconnect();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      env: { ...process.env, AIQSA_MEMORY_CLEANUP_WORKER: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    let received = false;
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS + 30_000);
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const raw = message as Record<string, unknown>;
      if (raw.status !== "passed" && raw.status !== "failed") return;
      const safe: Record<string, string | number | boolean> = {
        status: raw.status, sanitizedAggregatesOnly: true
      };
      for (const key of ["reviewed", "removed", "protected", "checked", "passed", "providerCalls", "replayProviderCalls",
        "inputTokens", "outputTokens", "totalTokens", "estimatedCostMicros", "reportedCostCalls", "reportedTokenCalls", "remaining",
        "kept", "rejected", "blocked", "unreviewable", "erroneousRemovals", "remainingShortTerm", "datedRemoved", "datedPurged",
        "purgePending", "durationMs", ...Object.values(REPORT_REASON_KEYS)]) {
        if (typeof raw[key] === "number" && Number.isFinite(raw[key]) && raw[key] >= 0) safe[key] = raw[key];
      }
      for (const key of ["previewUnchanged", "repeatedCommitUnchanged", "sourceMessagesUnchanged", "corpusComplete"]) {
        if (typeof raw[key] === "boolean") safe[key] = raw[key];
      }
      if (["preview", "apply", "seed", "verify"].includes(String(raw.mode))) safe.mode = String(raw.mode);
      if (["FIXTURE_SETUP", "BATCH", "CORPUS"].includes(String(raw.scope))) safe.scope = String(raw.scope);
      safe.paidExtraction = false;
      if (typeof raw.code === "string") safe.code = cleanupQualificationFailureCode(new Error(raw.code));
      if (typeof raw.phase === "string" && /^[a-z][a-z0-9_]{0,47}$/u.test(raw.phase)) safe.phase = raw.phase;
      if (typeof raw.prismaCode === "string" && /^P\d{4}$/u.test(raw.prismaCode)) safe.prismaCode = raw.prismaCode;
      if (typeof raw.databaseCode === "string" && /^[0-9A-Z]{5}$/u.test(raw.databaseCode)) safe.databaseCode = raw.databaseCode;
      received = true;
      process.stdout.write(`${JSON.stringify(safe)}\n`);
    });
    child.once("error", () => { clearTimeout(timer); reject(new Error("memory_cleanup_worker_failed")); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!received) { reject(new Error("memory_cleanup_worker_no_report")); return; }
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

void main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify({ status: "failed", code: cleanupQualificationFailureCode(error), sanitizedAggregatesOnly: true })}\n`);
  process.exitCode = 1;
});

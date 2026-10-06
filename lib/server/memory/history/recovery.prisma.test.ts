import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestProviderExecutionAuthority, deleteTestProviderExecutionAuthority,
  type TestProviderExecutionAuthority } from "@/tests/support/providerExecutionAuthority";
import { textMessageContent } from "../../../domain/content";
import { fuseMemoryRetrievalCandidates, planMemoryRetrieval } from "../../../domain/memory/retrieval";
import { prisma } from "../../prisma";
import { structuredOutputVerificationEvidence } from "../../providers/structuredOutputEvidence";
import { forcedToolCallVerificationEvidence } from "../../providers/forcedToolCallEvidence";
import { readAdminMemoryProcessing } from "../../admin/memory/processingRepository";
import { MemoryCoordinator } from "../coordinator/coordinator";
import { MemoryCoordinatorError } from "../coordinator/errors";
import { createPrismaMemoryCoordinatorRepository, type MemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import { MemoryCoordinatorRegistry } from "../coordinator/registry";
import { readMemoryRecoveryStatus } from "../coordinator/recoveryStatus";
import { MEMORY_RECOVERY_DELAYS_MS } from "../coordinator/recoveryPolicy";
import type { MemoryJobHandler } from "../coordinator/types";
import { resolveMemoryExecutionCompatibility } from "../execution/compatibility";
import { MEMORY_EXECUTION_RECOVERY_HORIZON_MS } from "../execution/lifecycle";
import { resolveCurrentMemoryUtilityPolicy } from "../execution/policy";
import { createMemoryExecutionSnapshot, storedMemoryExecutionSnapshot } from "../execution/snapshot";
import { createPrismaLocalMemoryRetrievalRepository } from "../retrieval/localRepository";
import { advanceMemoryMutation, withLockedMemoryTransaction } from "../persistence/transaction";
import { readMemoryHistoryIndexingProgress, seedMemoryHistoryBackfill } from "./backfill";
import { repairFencedMemoryHistoryJobs } from "./fenceRepair";
import { createPrismaMemoryHistoryIndexHandler } from "./handler";
import { MEMORY_HISTORY_INDEX_PIPELINE_VERSION, MEMORY_HISTORY_QUIET_WINDOW_MS,
  MEMORY_HISTORY_RECOVERED_UNCERTAIN_CODE } from "./contract";
import { applyMemorySourceMutations, lockMemorySourceChat } from "../sourceState";
import { defaultMemorySourceMutationHooks } from "../sourceHooks";

let providerAuthority: TestProviderExecutionAuthority;
let priorPolicy: { assignmentSource: import("@prisma/client").MemoryUtilityAssignmentSource; providerModelId: string | null; reasoningEffort: string | null; updatedAt: Date; version: number } | null;
const owners = new Set<string>();

// The Memory model resolves the destination that earlier releases recorded in
// history classification calls; current indexing never dispatches one.
beforeAll(async () => {
  providerAuthority = await createTestProviderExecutionAuthority(prisma, "history-recovery");
  const model = await prisma.providerModel.findUniqueOrThrow({ where: { id: providerAuthority.providerModelId } });
  const original = model.activeConfig as Prisma.JsonObject;
  const capabilities = { ...(original.capabilities as Prisma.JsonObject), toolCalling: true };
  const config = { ...original, capabilities, adapterKind: "openai_responses_compatible" };
  await prisma.providerModel.update({ where: { id: model.id }, data: { activeConfig: config, capabilities, draftConfig: config } });
  await prisma.providerModelCredentialCheck.create({ data: {
    checkedAt: new Date(), connectionId: providerAuthority.connectionId, connectionVersion: 1,
    credentialId: providerAuthority.credentialId, credentialVersionId: providerAuthority.credentialVersionId,
    evidence: {
      structuredOutput: structuredOutputVerificationEvidence("openai_responses_compatible", model.modelId),
      forcedToolCall: forcedToolCallVerificationEvidence("openai_responses_compatible", model.modelId)
    },
    modelVersion: 1, providerModelId: model.id, status: "available"
  } });
  priorPolicy = await prisma.memoryUtilityModelPolicy.findUnique({
    select: { assignmentSource: true, providerModelId: true, reasoningEffort: true, updatedAt: true, version: true }, where: { id: "installation" }
  });
  await prisma.memoryUtilityModelPolicy.upsert({
    create: { id: "installation", providerModelId: model.id, assignmentSource: "OPERATOR" },
    update: { providerModelId: model.id, reasoningEffort: null, assignmentSource: "OPERATOR", version: { increment: 1 } }, where: { id: "installation" }
  });
});

afterEach(async () => {
  for (const userId of owners) await prisma.$transaction(async (tx) => {
    await tx.usageEvent.deleteMany({ where: { userId } });
    await tx.memoryExecutionBinding.deleteMany({ where: { userId } });
    await tx.memoryDeletionOutbox.deleteMany({ where: { userId } });
    await tx.user.deleteMany({ where: { id: userId } });
  });
  owners.clear();
});

afterAll(async () => {
  if (priorPolicy) await prisma.memoryUtilityModelPolicy.update({ data: priorPolicy, where: { id: "installation" } });
  else await prisma.memoryUtilityModelPolicy.deleteMany({ where: { id: "installation", providerModelId: providerAuthority.providerModelId } });
  await prisma.providerModelCredentialCheck.deleteMany({ where: { connectionId: providerAuthority.connectionId } });
  await deleteTestProviderExecutionAuthority(prisma, providerAuthority);
  await prisma.$disconnect();
});

async function fixture() {
  const userId = randomUUID();
  owners.add(userId);
  await prisma.user.create({ data: { id: userId, displayName: "History recovery fixture", status: "active" } });
  await prisma.userMemorySettings.update({ data: { learnAutomatically: false }, where: { userId } });
  const chat = await prisma.chat.create({ data: { userId, title: "Synthetic pottery discussion" } });
  const message = await prisma.message.create({ data: {
    chatId: chat.id, role: "user", status: "complete",
    content: textMessageContent("I take pottery classes every Saturday at Pine studio.")
  } });
  const answer = await prisma.message.create({ data: {
    chatId: chat.id, parentMessageId: message.id, role: "assistant", status: "complete",
    createdAt: message.createdAt,
    content: textMessageContent("Your pottery class is on Saturday.")
  } });
  await prisma.modelRun.create({ data: {
    assistantMessageId: answer.id, chatId: chat.id, modelId: "history-fixture-model",
    provider: "history-fixture-provider", status: "complete", userId, userMessageId: message.id,
    normalizedRequest: { prompt: { baseline: {
      source: "standard_chat", timeZone: "UTC", timeZoneSource: "client"
    } } }
  } });
  await prisma.chat.update({ data: { activeLeafMessageId: answer.id, memorySourceRevision: 2 }, where: { id: chat.id } });
  await withLockedMemoryTransaction(prisma, userId, (tx, settings) => seedMemoryHistoryBackfill(tx, settings));
  const job = await prisma.memoryJob.findFirstOrThrow({ where: { userId, kind: "INDEX_HISTORY" } });
  await prisma.memoryJob.update({ data: { attemptCount: 2 }, where: { id: job.id } });
  let clock = new Date(Date.now() + 1_000);
  const now = () => new Date(clock);
  const handler = () => createPrismaMemoryHistoryIndexHandler(prisma);
  const repository = createPrismaMemoryCoordinatorRepository(prisma);
  const drive = async (selected: MemoryJobHandler = handler(), repo: MemoryCoordinatorRepository = repository) => {
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob(selected);
    const worker = new MemoryCoordinator({ now, registry, repository: repo,
      policy: { maxJobParallel: 1, maxJobParallelPerUser: 1, maxDeletionParallel: 1 } });
    try { await worker.reconcileNow(); } finally { await worker.stop(); }
  };
  const failCommit = async (code: string) => {
    await drive(handler(), { ...repository, commitJobSuccess: (input) => repository.commitJobSuccess({
      ...input, apply: async (tx, claim) => {
        await input.apply?.(tx, claim);
        throw new MemoryCoordinatorError(code, true);
      }
    }) });
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      state: "TERMINAL_FAILED", attemptCount: 3, stage: "lexical_apply", errorCode: code
    });
    expect(await prisma.memoryRecallRound.count({ where: { userId } })).toBe(0);
  };
  return { chat, job, message, userId, now, handler, drive, failCommit, repository,
    advance: (ms = MEMORY_RECOVERY_DELAYS_MS[0]!) => { clock = new Date(clock.getTime() + ms); } };
}

type HistoryRecoveryFixture = Awaited<ReturnType<typeof fixture>>;

async function assertRecall(f: HistoryRecoveryFixture) {
  const now = f.now();
  const plan = planMemoryRetrieval({ currentUserText: "Pine studio pottery Saturday",
    filters: { sourceKinds: ["HISTORY"] }, mode: "PAST_CHAT_SEARCH", now, temporalIntent: "ANY" });
  const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
  const result = await repository.retrieve({ assistantId: null, chatId: f.chat.id, now, plan, userId: f.userId });
  expect(result.lexicalState).toBe("READY");
  const selected = fuseMemoryRetrievalCandidates(plan, result.laneResults, now)
    .find(({ itemType }) => itemType === "RECALL_ROUND" || itemType === "RECALL_CHUNK");
  expect(selected, JSON.stringify({ lexicalEvidence: result.lexicalEvidence,
    lanes: result.laneResults.map(lane => ({
      lane: lane.lane, candidates: lane.candidates.length
    })) })).toBeDefined();
  const [expanded] = await repository.expand(result.snapshot, plan, [selected!]);
  expect(expanded?.safeText).toContain("I take pottery classes every Saturday at Pine studio.");
}

const noHistoryCalls = async (f: HistoryRecoveryFixture) => {
  expect(await prisma.memoryExecutionBinding.count({ where: { userId: f.userId } })).toBe(0);
  expect(await prisma.usageEvent.count({ where: { userId: f.userId } })).toBe(0);
};

describe("history recovery without model calls", () => {
  it("recovers a chunk-limit snapshot failure through the worker", async () => {
    const f = await fixture();
    const errorCode = "memory_history_chunk_limit_exceeded";
    await f.drive({
      ...f.handler(),
      async execute(_claim, context) {
        await context.setStage("source_snapshot");
        throw new MemoryCoordinatorError(errorCode, false);
      }
    });
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({
      state: "TERMINAL_FAILED", stage: "source_snapshot", errorCode
    });
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues).toContainEqual(
      expect.objectContaining({ stage: "HISTORY", reason: "PROCESSING_FAILED" })
    );
    f.advance();
    expect(await readMemoryRecoveryStatus(prisma, f.now())).toMatchObject({ eligible: 1 });
    await f.drive();
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({
      state: "SUCCEEDED", recoveryCount: 1, recoveryErrorCode: errorCode, lastRecoveryAt: f.now()
    });
    await noHistoryCalls(f);
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues).not.toContainEqual(
      expect.objectContaining({ stage: "HISTORY", reason: "PROCESSING_FAILED" })
    );
    await assertRecall(f);
  });

  it.each(["memory_job_commit_database_p2002", "memory_execution_policy_drift", "memory_execution_input_invalid"])(
    "recovers %s locally", async (code) => {
      const f = await fixture();
      await f.failCommit(code);
      f.advance();
      await Promise.all([f.drive(), f.drive()]);
      await f.drive();
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } }))
        .toMatchObject({ state: "SUCCEEDED", recoveryCount: 1, recoveryErrorCode: code });
      await noHistoryCalls(f);
      expect((await readAdminMemoryProcessing(prisma, f.now())).issues.filter(({ stage }) => stage === "HISTORY")).toEqual([]);
      await assertRecall(f);
    }
  );

  it.each(["recovery", "backfill"])("rebuilds a failed v9 source through a current %s successor", async (entry) => {
    const f = await fixture();
    await f.failCommit("memory_job_commit_database_p2002");
    await prisma.memoryJob.update({ where: { id: f.job.id }, data: {
      pipelineVersion: "memory-history-incremental-v9", idempotencyFingerprint: `legacy-history:${f.job.id}`
    } });
    const original = await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } });
    f.advance();
    if (entry === "backfill") await withLockedMemoryTransaction(prisma, f.userId,
      (tx, settings) => seedMemoryHistoryBackfill(tx, settings, { now: f.now() }));
    await f.drive();
    await f.drive();
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toEqual(original);
    expect(await prisma.memoryJob.findFirstOrThrow({ where: { userId: f.userId, id: { not: f.job.id }, kind: "INDEX_HISTORY" } }))
      .toMatchObject({ state: "SUCCEEDED", pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION });
    await noHistoryCalls(f);
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues.filter(({ stage }) => stage === "HISTORY")).toEqual([]);
    await assertRecall(f);
  });
});

async function mutateFixtureSource(
  f: HistoryRecoveryFixture,
  input: Omit<Parameters<typeof applyMemorySourceMutations>[1], "chat" | "hooks">
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const chat = await lockMemorySourceChat(tx, { userId: f.userId, chatId: f.chat.id, lock: "UPDATE" });
    if (!chat) throw new Error("missing fixture source");
    await applyMemorySourceMutations(tx, { ...input, chat, hooks: defaultMemorySourceMutationHooks });
  });
}

type SourceFence = "append" | "settlement" | "branch" | "forget" | "exclusion";

/** Commits one source or Forget fence through its product mutation. */
async function landFence(f: HistoryRecoveryFixture, fence: SourceFence): Promise<void> {
  if (fence === "branch") return mutateFixtureSource(f, { mutations: ["BRANCH_PATH_CHANGE"] });
  if (fence === "exclusion") {
    return mutateFixtureSource(f, { mutations: ["SOURCE_EXCLUDE"], patch: { memoryMode: "EXCLUDED" } });
  }
  if (fence === "forget") {
    await withLockedMemoryTransaction(prisma, f.userId, async (tx, settings) => {
      await advanceMemoryMutation(tx, settings, "FORGET_OR_BULK_CLEAR");
      await tx.memorySuppression.create({ data: {
        userId: f.userId, scope: "SOURCE_MESSAGE", sourceChatId: f.chat.id,
        sourceMessageId: f.message.id, sourceBranchGeneration: 0,
        deletionGeneration: settings.memoryGeneration, fingerprintKeyVersion: "history-test-v1",
        normalizationVersion: "memory-search-normalization-v1"
      } });
    });
    return;
  }
  const { activeLeafMessageId } = await prisma.chat.findUniqueOrThrow({ where: { id: f.chat.id } });
  const question = await prisma.message.create({ data: {
    chatId: f.chat.id, parentMessageId: activeLeafMessageId, role: "user", status: "complete",
    content: textMessageContent("Which studio hosts the Sunday class?")
  } });
  await mutateFixtureSource(f, { mutations: ["NORMAL_APPEND"], patch: { activeLeafMessageId: question.id } });
  if (fence === "append") return;
  const answer = await prisma.message.create({ data: {
    chatId: f.chat.id, parentMessageId: question.id, role: "assistant", status: "complete",
    content: textMessageContent("Sunday classes meet at Cedar studio.")
  } });
  const run = await prisma.modelRun.create({ data: {
    assistantMessageId: answer.id, chatId: f.chat.id, modelId: "history-fixture-model",
    provider: "history-fixture-provider", status: "complete", userId: f.userId, userMessageId: question.id,
    normalizedRequest: { prompt: { baseline: { source: "standard_chat", timeZone: "UTC", timeZoneSource: "client" } } }
  } });
  await mutateFixtureSource(f, { mutations: ["NORMAL_APPEND"], patch: { activeLeafMessageId: answer.id } });
  // Like a real run settlement, this enqueues the successor for the new source.
  await mutateFixtureSource(f, { mutations: ["TERMINAL_SETTLEMENT"],
    terminalSettlement: { assistantMessageId: answer.id, runId: run.id, status: "complete" } });
}

/** Moves the fixed worker clock to the end of a settled turn's quiet window,
 * which also makes work created by the database clock current for it. */
function untilQuiet(f: HistoryRecoveryFixture, job: Readonly<{ nextAttemptAt: Date | null }>): void {
  f.advance(Math.max(0, job.nextAttemptAt!.getTime() - f.now().getTime()));
}

describe("history indexing quiet window", () => {
  const historyJobs = (f: HistoryRecoveryFixture) => prisma.memoryJob.findMany({
    orderBy: { sourceRevision: "asc" }, where: { userId: f.userId, kind: "INDEX_HISTORY" }
  });
  const job = (id: string) => prisma.memoryJob.findUniqueOrThrow({ where: { id } });

  it("indexes turns settled within the window in one run", async () => {
    const f = await fixture();
    const settledFrom = Date.now();
    await landFence(f, "settlement");
    await landFence(f, "settlement");
    const settledTo = Date.now();
    const [backfilled, older, newest] = await historyJobs(f);
    expect(backfilled!.id).toBe(f.job.id);
    for (const turn of [older!, newest!]) {
      expect(turn.state).toBe("QUEUED");
      expect(turn.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(settledFrom + MEMORY_HISTORY_QUIET_WINDOW_MS);
      expect(turn.nextAttemptAt!.getTime()).toBeLessThanOrEqual(settledTo + MEMORY_HISTORY_QUIET_WINDOW_MS);
    }
    // Inside the window only the superseded backfill job is due. It settles at
    // its claim gate, before any stage.
    await f.drive();
    expect(await job(backfilled!.id)).toMatchObject({ state: "STALE", errorCode: "memory_source_stale", stage: null });
    expect(await job(older!.id)).toMatchObject({ state: "QUEUED", attemptCount: 0 });
    expect(await job(newest!.id)).toMatchObject({ state: "QUEUED", attemptCount: 0 });

    untilQuiet(f, newest!);
    await f.drive();
    // The older turn's job is superseded; only the newest source is indexed.
    expect(await job(older!.id)).toMatchObject({ state: "STALE", errorCode: "memory_source_stale", stage: null });
    expect(await job(newest!.id)).toMatchObject({ state: "SUCCEEDED" });
    await noHistoryCalls(f);
    expect(await readMemoryHistoryIndexingProgress(prisma, f.userId, true)).toMatchObject({ state: "READY" });
    await assertRecall(f);
  }, 30_000);

  it("indexes a single settled turn once its window has passed", async () => {
    const f = await fixture();
    await landFence(f, "settlement");
    const turn = (await historyJobs(f)).at(-1)!;
    expect(turn.id).not.toBe(f.job.id);
    // A second before the window ends the job is still not claimable.
    f.advance(Math.max(0, turn.nextAttemptAt!.getTime() - f.now().getTime() - 1_000));
    await f.drive();
    expect(await job(turn.id)).toMatchObject({ state: "QUEUED", attemptCount: 0 });
    expect(await readMemoryHistoryIndexingProgress(prisma, f.userId, true)).toMatchObject({ state: "INDEXING" });

    f.advance(1_000);
    await f.drive();
    expect(await job(turn.id)).toMatchObject({ state: "SUCCEEDED" });
    expect(await readMemoryHistoryIndexingProgress(prisma, f.userId, true)).toMatchObject({ state: "READY" });
    await assertRecall(f);
  }, 30_000);
});

/** A history classification call of an earlier release, written as fixture
 * construction: current indexing never binds one. */
async function legacyHistoryCall(f: HistoryRecoveryFixture, input: Readonly<{
  createdAt: Date;
  jobId: string;
  ordinal: number;
  role?: "MEMORY_HISTORY_CLASSIFY" | "MEMORY_STATEMENT_CLASSIFY";
  state: "OUTCOME_UNKNOWN" | "PENDING" | "RUNNING";
}>) {
  const role = input.role ?? "MEMORY_HISTORY_CLASSIFY";
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: f.userId } });
  const policy = await resolveCurrentMemoryUtilityPolicy(prisma, f.userId, settings);
  const target = policy.targets.get("MEMORY_STATEMENT_CLASSIFY");
  if (!target) throw new Error("memory_history_legacy_call_target_missing");
  const versions = {
    pipelineVersion: "memory-history-structured-budget-v1",
    policyVersion: "memory-contextual-narrative-key-v4",
    promptVersion: "memory-contextual-key-prompt-legacy",
    retrievalConfigFingerprint: "legacy-history-fixture",
    schemaVersion: "memory-contextual-key-schema-legacy"
  };
  const compatibility = resolveMemoryExecutionCompatibility({ role, target, versions });
  const snapshot = createMemoryExecutionSnapshot({
    acceptedUtilityEgressFingerprint: policy.fingerprint,
    compatibilityId: compatibility.compatibilityId,
    compatibilityRequirement: compatibility.requirement,
    requiresStrictStructuredOutput: compatibility.requiresStrictStructuredOutput,
    role,
    target,
    utilityPolicyVersion: policy.policyVersion
  });
  const provider = target.snapshot;
  const started = input.state === "PENDING" ? null : input.createdAt;
  return prisma.memoryExecutionBinding.create({ data: {
    connectionId: provider.connectionId, createdAt: input.createdAt,
    credentialId: provider.credentialId!, credentialVersionId: provider.credentialVersionId!,
    destinationFingerprint: target.destinationFingerprint, inputHash: input.ordinal.toString(16).padStart(64, "0"),
    logicalRole: role, memoryJobId: input.jobId, ordinal: input.ordinal, ownerType: "JOB",
    pipelineVersion: versions.pipelineVersion, policyVersion: versions.policyVersion,
    promptVersion: versions.promptVersion, providerId: provider.providerFamily,
    providerModelId: provider.providerModelId, schemaVersion: versions.schemaVersion,
    secretFreeExecutionSnapshot: storedMemoryExecutionSnapshot(snapshot, null) as Prisma.InputJsonValue,
    startedAt: started, state: input.state, userId: f.userId,
    ...(input.state === "OUTCOME_UNKNOWN" ? {
      completedAt: input.createdAt, errorCode: "memory_execution_outcome_unknown",
      recoverableUntil: new Date(input.createdAt.getTime() + MEMORY_EXECUTION_RECOVERY_HORIZON_MS)
    } : {})
  } });
}

describe("history calls left unsettled by an earlier release", () => {
  /** The job settled under this release; the call of its earlier attempt lingers. */
  async function orphan(state: "PENDING" | "RUNNING", options: Readonly<{
    end?: "CLAIMED" | "SUCCEEDED" | "TERMINAL_FAILED";
    role?: "MEMORY_HISTORY_CLASSIFY" | "MEMORY_STATEMENT_CLASSIFY";
  }> = {}) {
    const f = await fixture();
    const created = await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } });
    if (options.end === "CLAIMED") {
      // A live attempt still owns the job and may yet settle its own call.
      await prisma.memoryJob.update({ where: { id: f.job.id }, data: {
        attemptCount: { increment: 1 }, leaseExpiresAt: new Date(f.now().getTime() + 3_600_000),
        leaseToken: randomUUID(), state: "CLAIMED"
      } });
    } else if (options.end === "TERMINAL_FAILED") {
      await prisma.memoryJob.update({ where: { id: f.job.id }, data: {
        state: "TERMINAL_FAILED", errorCode: "memory_history_classification_unavailable",
        stage: "contextual_key_generation", completedAt: f.now(), nextAttemptAt: null
      } });
    } else {
      await f.drive();
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ state: "SUCCEEDED" });
    }
    const call = await legacyHistoryCall(f, {
      createdAt: created.createdAt, jobId: f.job.id, ordinal: 0, state,
      ...(options.role ? { role: options.role } : {})
    });
    return { call, f };
  }
  const receipts = (f: HistoryRecoveryFixture, bindingId: string) =>
    prisma.usageEvent.findMany({ where: { userId: f.userId, memoryExecutionBindingId: bindingId } });

  it.each(["SUCCEEDED", "TERMINAL_FAILED"] as const)("settles a running call of a %s job once as an unknown outcome, never sending it", async (end) => {
    const { call, f } = await orphan("RUNNING", { end });
    const job = await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } });
    // Within the first recovery delay an earlier attempt may still be ending its call.
    expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now() })).toBe(0);
    expect(await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: call.id } })).toEqual(call);
    f.advance();
    expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now() })).toBe(0);
    const settled = await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: call.id } });
    expect(settled).toMatchObject({ state: "OUTCOME_UNKNOWN", errorCode: MEMORY_HISTORY_RECOVERED_UNCERTAIN_CODE,
      acceptedOutputHash: null, providerResponseId: null, usageCompleteness: "UNAVAILABLE", totalTokens: null,
      startedAt: call.startedAt, completedAt: f.now() });
    expect(await receipts(f, call.id)).toEqual([
      expect.objectContaining({ usageCompleteness: "UNAVAILABLE", inputTokens: null, totalTokens: null })
    ]);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toEqual(job);

    // Later passes and worker runs change nothing.
    f.advance(MEMORY_RECOVERY_DELAYS_MS[1]);
    expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now() })).toBe(0);
    await f.drive();
    expect(await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: call.id } })).toEqual(settled);
    expect(await receipts(f, call.id)).toHaveLength(1);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toEqual(job);
  }, 30_000);

  it("cancels a never-started call of a settled job as abandoned", async () => {
    const { call, f } = await orphan("PENDING");
    f.advance();
    expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now() })).toBe(0);
    expect(await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({
      state: "CANCELLED", errorCode: "memory_history_dispatch_abandoned", startedAt: null,
      providerResponseId: null, usageCompleteness: "UNAVAILABLE", totalTokens: null
    });
    expect(await receipts(f, call.id)).toEqual([
      expect.objectContaining({ usageCompleteness: "UNAVAILABLE", totalTokens: null })
    ]);
  }, 30_000);

  it.each(["leased", "receipt", "response", "output", "role"] as const)("leaves a %s call to its owner", async (guard) => {
    const { call, f } = await orphan("RUNNING", guard === "role" ? { role: "MEMORY_STATEMENT_CLASSIFY" }
      : guard === "leased" ? { end: "CLAIMED" } : {});
    if (guard === "receipt") await prisma.usageEvent.create({ data: {
      memoryExecutionBindingId: call.id, modelId: providerAuthority.providerModelId,
      provider: "openai_compatible", providerModelId: providerAuthority.providerModelId, userId: f.userId
    } });
    if (guard === "response" || guard === "output") await prisma.memoryExecutionBinding.update({
      where: { id: call.id },
      data: guard === "response" ? { providerResponseId: "resp_orphan_fixture" } : { acceptedOutputHash: "b".repeat(64) }
    });
    const before = await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: call.id } });
    const receiptCount = await prisma.usageEvent.count({ where: { userId: f.userId } });
    f.advance();
    expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now() })).toBe(0);
    expect(await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: call.id } })).toEqual(before);
    expect(await prisma.usageEvent.count({ where: { userId: f.userId } })).toBe(receiptCount);
  }, 30_000);
});

describe("history fence casualties left by an earlier release", () => {
  /** The previous-release outcome of a fence that won while the job
   * classified: fixture construction, never a repair action. */
  async function casualty(fence: "branch" | "exclusion" | "forget") {
    const f = await fixture();
    await landFence(f, fence);
    const completedAt = f.now();
    await prisma.memoryJob.update({ where: { id: f.job.id }, data: {
      state: "TERMINAL_FAILED", errorCode: "memory_history_job_invalid", stage: "digest_generation",
      completedAt, nextAttemptAt: null
    } });
    return { completedAt, f };
  }
  const backfill = (f: HistoryRecoveryFixture) => withLockedMemoryTransaction(prisma, f.userId,
    (tx, settings) => seedMemoryHistoryBackfill(tx, settings, { now: f.now() }));
  const job = (f: HistoryRecoveryFixture) => prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } });

  it("re-indexes a Forget casualty from its current source without resurrection", async () => {
    const { completedAt, f } = await casualty("forget");
    // Before repair the terminal row blocks the unchanged source forever.
    expect(await backfill(f)).toMatchObject({ enqueuedJobs: 0 });
    expect(await readMemoryHistoryIndexingProgress(prisma, f.userId, true)).toMatchObject({ state: "INDEXING" });
    expect(await repairFencedMemoryHistoryJobs(prisma, { now: f.now() })).toBeGreaterThanOrEqual(1);
    const repaired = await job(f);
    expect(repaired).toMatchObject({ state: "STALE", errorCode: "memory_history_job_invalid", completedAt,
      recoveryCount: 0, leaseToken: null });
    await repairFencedMemoryHistoryJobs(prisma, { now: f.now() });
    expect(await job(f)).toEqual(repaired);
    expect(await backfill(f)).toMatchObject({ enqueuedJobs: 1 });
    const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: f.userId } });
    expect(await job(f)).toMatchObject({ state: "QUEUED", attemptCount: 0, errorCode: null, completedAt: null,
      memoryGenerationSnapshot: settings.memoryGeneration });
    await f.drive();
    expect(await job(f)).toMatchObject({ state: "SUCCEEDED" });
    await noHistoryCalls(f);
    // The Forget still holds: the forgotten turn is not indexed again.
    expect(await prisma.memoryRecallChunk.count({ where: { userId: f.userId, state: "ACTIVE" } })).toBe(0);
    expect(await prisma.memoryRecallRound.count({ where: { userId: f.userId, state: "ACTIVE" } })).toBe(0);
    expect(await readMemoryHistoryIndexingProgress(prisma, f.userId, true)).toMatchObject({ state: "READY" });
  });

  it("indexes a moved-on chat with a fresh job and never revives the released casualty", async () => {
    const { f } = await casualty("branch");
    await repairFencedMemoryHistoryJobs(prisma, { now: f.now() });
    expect(await job(f)).toMatchObject({ state: "STALE", errorCode: "memory_history_job_invalid" });
    // Work created by the database clock must be current for the fixed worker clock.
    f.advance(60_000);
    expect(await backfill(f)).toMatchObject({ enqueuedJobs: 1 });
    const chat = await prisma.chat.findUniqueOrThrow({ where: { id: f.chat.id } });
    const fresh = await prisma.memoryJob.findFirstOrThrow({ where: { userId: f.userId, state: "QUEUED" } });
    expect(fresh).toMatchObject({ kind: "INDEX_HISTORY", branchGeneration: chat.memoryBranchGeneration,
      sourceRevision: chat.memorySourceRevision });
    expect(fresh.id).not.toBe(f.job.id);
    await f.drive();
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: fresh.id } })).toMatchObject({ state: "SUCCEEDED" });
    expect(await job(f)).toMatchObject({ state: "STALE", errorCode: "memory_history_job_invalid" });
    await noHistoryCalls(f);
    await assertRecall(f);
  });

  it("keeps an excluded casualty settled and its source unindexed", async () => {
    const { f } = await casualty("exclusion");
    await repairFencedMemoryHistoryJobs(prisma, { now: f.now() });
    expect(await job(f)).toMatchObject({ state: "STALE", errorCode: "memory_history_job_invalid" });
    expect(await backfill(f)).toMatchObject({ enqueuedJobs: 0 });
    await f.drive();
    expect(await job(f)).toMatchObject({ state: "STALE" });
    expect(await prisma.memoryJob.count({ where: { userId: f.userId } })).toBe(1);
    expect(await prisma.memoryRecallChunk.count({ where: { userId: f.userId, state: "ACTIVE" } })).toBe(0);
  });

  it("releases a casualty beside an ambiguous earlier call and re-indexes without sending anything", async () => {
    const { f } = await casualty("forget");
    const created = await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } });
    const ambiguous = await legacyHistoryCall(f, {
      createdAt: created.createdAt, jobId: f.job.id, ordinal: 0, state: "OUTCOME_UNKNOWN"
    });
    await repairFencedMemoryHistoryJobs(prisma, { now: f.now() });
    expect(await job(f)).toMatchObject({ state: "STALE", errorCode: "memory_history_job_invalid" });
    expect(await backfill(f)).toMatchObject({ enqueuedJobs: 1 });
    await f.drive();
    expect(await job(f)).toMatchObject({ state: "SUCCEEDED" });
    expect(await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId } })).toEqual([ambiguous]);
    expect(await prisma.usageEvent.count({ where: { userId: f.userId } })).toBe(0);
  });
});

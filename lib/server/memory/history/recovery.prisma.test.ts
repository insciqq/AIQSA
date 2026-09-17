import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import type { MemoryStructuredOutputProvider } from "../execution";
import { createPrismaMemoryExecutionAdmission } from "../execution/admission";
import { probeMemoryStructuredOutputAuthority } from "../execution/structuredClassifier";
import { detachExpiredMemoryExecutionBindings, MEMORY_EXECUTION_RECOVERY_HORIZON_MS } from "../execution/lifecycle";
import { createPrismaLocalMemoryRetrievalRepository } from "../retrieval/localRepository";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { seedMemoryHistoryBackfill } from "./backfill";
import { createPrismaMemoryHistoryIndexHandler } from "./handler";
import { MEMORY_CONTEXTUAL_KEY_VERSIONS } from "./contextualKeys";
import { inspectMemoryHistoryPurge, purgeMemoryHistorySelection } from "./purge";

let providerAuthority: TestProviderExecutionAuthority;
let priorPolicy: { assignmentSource: import("@prisma/client").MemoryUtilityAssignmentSource; providerModelId: string | null; reasoningEffort: string | null; updatedAt: Date; version: number } | null;
const owners = new Set<string>();

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
    await tx.memoryHistoryExecution.deleteMany({ where: { userId } });
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
  await probeMemoryStructuredOutputAuthority({
    authority: { now }, client: prisma, role: "MEMORY_HISTORY_CLASSIFY", userId,
    versions: MEMORY_CONTEXTUAL_KEY_VERSIONS
  });
  const run = vi.fn<MemoryStructuredOutputProvider["run"]>().mockImplementation(async (_snapshot, request) => {
    const data = JSON.parse(request.userPrompt);
    const output = request.name === "memory_contextual_grounding_v1"
      ? { decisions: data.statements.map((statement: { handle: string }) => ({ handle: statement.handle, support: "SUPPORTED" })) }
      : Array.isArray(data.rounds)
        ? { rounds: data.rounds.map((round: { handle: string; current: { source_ref: string } }) => ({
            handle: round.handle, language_code: "en", statements: [{
              source_refs: [round.current.source_ref], text: "Saturday pottery classes take place at Pine studio."
            }]
          })) }
        : { decisions: [], open_loops: [], topics: ["Pottery"], summary: "The user takes pottery classes on Saturdays at Pine studio." };
    return { output, providerResponseId: null, usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, completeness: "complete" } };
  });
  const handler = () => createPrismaMemoryHistoryIndexHandler(prisma, undefined, {
    authority: { now }, structuredProvider: { run }
  });
  const repository = createPrismaMemoryCoordinatorRepository(prisma);
  const drive = async (selected: MemoryJobHandler = handler(), repo: MemoryCoordinatorRepository = repository) => {
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob(selected);
    const worker = new MemoryCoordinator({ now, registry, repository: repo,
      policy: { maxJobParallel: 1, maxJobParallelPerUser: 1, maxDeletionParallel: 1 } });
    try { await worker.reconcileNow(); } finally { await worker.stop(); }
  };
  const failCommit = async () => {
    await drive(handler(), { ...repository, commitJobSuccess: (input) => repository.commitJobSuccess({
      ...input, apply: async (tx, claim) => {
        await input.apply?.(tx, claim);
        throw new MemoryCoordinatorError("memory_job_commit_timeout", true);
      }
    }) });
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      state: "TERMINAL_FAILED", attemptCount: 3, stage: "lexical_apply", errorCode: "memory_job_commit_timeout"
    });
    expect(run).toHaveBeenCalledTimes(3);
    expect(await prisma.memoryHistoryExecution.count({ where: { userId, clearedAt: null } })).toBe(3);
    expect(await prisma.memoryRecallRound.count({ where: { userId } })).toBe(0);
  };
  return { chat, job, message, userId, now, handler, drive, failCommit, repository, run,
    advance: (ms = MEMORY_RECOVERY_DELAYS_MS[0]!) => { clock = new Date(clock.getTime() + ms); } };
}

async function assertRecall(f: Awaited<ReturnType<typeof fixture>>) {
  const now = f.now();
  const plan = planMemoryRetrieval({ currentUserText: "Pine studio pottery Saturday",
    filters: { sourceKinds: ["HISTORY"] }, mode: "PAST_CHAT_SEARCH", now, temporalIntent: "ANY" });
  const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
  const result = await repository.retrieve({ assistantId: null, chatId: f.chat.id, now, plan, userId: f.userId });
  expect(result.lexicalState).toBe("READY");
  const selected = fuseMemoryRetrievalCandidates(plan, result.laneResults, now)
    .find(({ itemType }) => itemType === "RECALL_ROUND");
  expect(selected).toBeDefined();
  const [expanded] = await repository.expand(result.snapshot, plan, [selected!]);
  expect(expanded?.safeText).toContain("I take pottery classes every Saturday at Pine studio.");
}

describe("history recovery without repeated provider work", () => {
  it("automatically recovers an exhausted transaction after restart, preserving results, usage and alert truth", async () => {
    const f = await fixture();
    await f.failCommit();
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "HISTORY", reason: "PROCESSING_FAILED" })
    ]));
    f.advance();
    await Promise.all([f.drive(), f.drive()]);
    await f.drive();
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({
      state: "SUCCEEDED", attemptCount: 4, recoveryCount: 1, recoveryErrorCode: "memory_job_commit_timeout",
      operationalCounters: expect.objectContaining({ contextualProviderRequests: 0, contextualRoundsGenerated: 1 })
    });
    expect(await prisma.chatMemoryCheckpoint.findFirstOrThrow({ where: { userId: f.userId } })).toMatchObject({
      status: "READY", sourceRevision: 2
    });
    expect(await prisma.chatMemoryDigest.count({ where: { userId: f.userId } })).toBe(1);
    expect(await prisma.memoryRecallRound.findFirstOrThrow({ where: { userId: f.userId } })).toMatchObject({
      state: "ACTIVE", contextualKeyState: "GENERATED"
    });
    expect(await prisma.memoryHistoryExecution.count({ where: { userId: f.userId, clearedAt: null } })).toBe(0);
    expect(await prisma.memoryHistoryExecution.count({ where: { userId: f.userId } })).toBe(3);
    expect(await prisma.usageEvent.aggregate({ where: { userId: f.userId }, _count: true, _sum: { totalTokens: true } }))
      .toMatchObject({ _count: 3, _sum: { totalTokens: 75 } });
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues.filter(({ stage }) => stage === "HISTORY")).toEqual([]);
    await assertRecall(f);
  });

  it("adopts legacy hash-only executions as explicit raw-history recovery without repaying for unavailable outputs", async () => {
    const f = await fixture();
    await f.failCommit();
    // Exact previous-release shape: usage-backed settled bindings without a
    // staging table row. This is fixture construction, never a repair action.
    await prisma.memoryHistoryExecution.deleteMany({ where: { userId: f.userId } });
    await prisma.memoryJob.update({ data: { errorCode: "memory_job_commit_database_failed" }, where: { id: f.job.id } });
    f.advance();
    await f.drive();
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({
      state: "SUCCEEDED", stage: "lexical_ready:recovery_raw_fallback", recoveryCount: 1
    });
    expect(await prisma.memoryRecallRound.findFirstOrThrow({ where: { userId: f.userId } })).toMatchObject({
      state: "ACTIVE", contextualKeyState: "RAW_FALLBACK"
    });
    expect(await prisma.usageEvent.count({ where: { userId: f.userId } })).toBe(3);
    await assertRecall(f);
  });

  it.each(["excluded", "branch", "generation", "paused", "inactive"])("does not revive a %s source", async (fence) => {
    const f = await fixture();
    await f.failCommit();
    if (fence === "excluded") await prisma.chat.update({ data: { memoryMode: "EXCLUDED" }, where: { id: f.chat.id } });
    if (fence === "branch") await prisma.chat.update({ data: { memoryBranchGeneration: { increment: 1 } }, where: { id: f.chat.id } });
    if (fence === "generation") await prisma.userMemorySettings.update({ data: { memoryGeneration: { increment: 1 } }, where: { userId: f.userId } });
    if (fence === "paused") await prisma.userMemorySettings.update({ data: { referenceChatHistory: false }, where: { userId: f.userId } });
    if (fence === "inactive") await prisma.user.update({ data: { status: "disabled" }, where: { id: f.userId } });
    f.advance();
    expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now() })).toBe(0);
    expect(await prisma.memoryRecallRound.count({ where: { userId: f.userId } })).toBe(0);
    if (fence !== "paused") {
      await prisma.$transaction((tx) => purgeMemoryHistorySelection(tx, f.userId, { kind: "SOURCE", chatId: f.chat.id }));
      expect(await prisma.memoryHistoryExecution.count({ where: { userId: f.userId, clearedAt: null } })).toBe(0);
    }
    expect(f.run).toHaveBeenCalledTimes(3);
  });

  it("keeps a crash-ambiguous dispatch protected", async () => {
    const f = await fixture();
    await f.failCommit();
    const binding = await prisma.memoryExecutionBinding.findFirstOrThrow({ where: { userId: f.userId }, orderBy: { ordinal: "asc" } });
    // A distinct dispatch which was accepted but whose settlement was lost.
    await prisma.memoryExecutionBinding.create({ data: {
      ...binding, id: randomUUID(), ordinal: 3, state: "OUTCOME_UNKNOWN", acceptedOutputHash: null,
      secretFreeExecutionSnapshot: binding.secretFreeExecutionSnapshot as Prisma.InputJsonValue,
      errorCode: "memory_execution_outcome_unknown", completedAt: f.now()
    } });
    f.advance();
    expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now() })).toBe(0);
    expect(await readMemoryRecoveryStatus(prisma, f.now())).toMatchObject({ protected: 1 });
    expect(f.run).toHaveBeenCalledTimes(3);
  });

  it("settles a provably undispatched admission without inventing usage or making a provider call", async () => {
    const f = await fixture();
    await createPrismaMemoryExecutionAdmission({ now: f.now }, prisma).bind(f.userId, {
      inputHash: "a".repeat(64), ordinal: 0, owner: { memoryJobId: f.job.id, type: "JOB" },
      role: "MEMORY_HISTORY_CLASSIFY", versions: MEMORY_CONTEXTUAL_KEY_VERSIONS
    });
    await prisma.memoryJob.update({ where: { id: f.job.id }, data: {
      state: "TERMINAL_FAILED", attemptCount: 3, completedAt: f.now(),
      errorCode: "memory_job_commit_timeout", stage: "lexical_apply"
    } });
    f.advance();
    await f.drive();
    expect(f.run).not.toHaveBeenCalled();
    expect(await prisma.memoryExecutionBinding.findFirstOrThrow({ where: { userId: f.userId } }))
      .toMatchObject({ state: "CANCELLED", startedAt: null, totalTokens: null, usageCompleteness: "UNAVAILABLE" });
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } }))
      .toMatchObject({ state: "SUCCEEDED", stage: "lexical_ready:recovery_raw_fallback" });
    await assertRecall(f);
  });

  it("clears expired staging and completes raw retrieval without replaying detached executions", async () => {
    const f = await fixture();
    await f.failCommit();
    f.advance(MEMORY_EXECUTION_RECOVERY_HORIZON_MS + 1_000);
    await f.repository.recoverEligibleJobs({ limit: 8, now: f.now() });
    expect(await prisma.memoryHistoryExecution.count({ where: { userId: f.userId, clearedAt: null } })).toBe(0);
    await withLockedMemoryTransaction(prisma, f.userId, (tx) =>
      detachExpiredMemoryExecutionBindings(tx, { userId: f.userId }, f.now()));
    expect(await prisma.memoryHistoryExecution.count({ where: { userId: f.userId, clearedAt: null } })).toBe(0);
    await f.drive();
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({
      state: "SUCCEEDED", stage: "lexical_ready:recovery_raw_fallback"
    });
    await assertRecall(f);
  });

  it("never recreates staged content when source exclusion and purge win during provider I/O", async () => {
    const f = await fixture();
    const produce = f.run.getMockImplementation()!;
    f.run.mockImplementationOnce(async (...args) => {
      const result = await produce(...args);
      await prisma.chat.update({ data: { memoryMode: "EXCLUDED" }, where: { id: f.chat.id } });
      await prisma.$transaction((tx) => purgeMemoryHistorySelection(tx, f.userId, { kind: "SOURCE", chatId: f.chat.id }));
      return result;
    });
    await f.drive();
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(await prisma.memoryHistoryExecution.count({ where: { userId: f.userId, clearedAt: null } })).toBe(0);
    expect(await prisma.memoryHistoryExecution.count({ where: { userId: f.userId } })).toBe(1);
    expect(await prisma.usageEvent.count({ where: { userId: f.userId } })).toBe(1);
    expect(await prisma.memoryRecallRound.count({ where: { userId: f.userId } })).toBe(0);
  });

  it.each(["CLEAR", "ALL_REUSABLE", "SUPPRESSED"] as const)("clears retained private outputs for %s without touching another owner", async (kind) => {
    const f = await fixture();
    await f.failCommit();
    const other = await fixture();
    await other.failCommit();
    const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: f.userId } });
    const selection = kind === "SUPPRESSED" ? { kind } : { kind, barrierId: (await prisma.memorySourceBarrier.create({
      data: { userId: f.userId, kind: kind === "CLEAR" ? "HISTORY_INDEX" : "ALL_REUSABLE",
        memoryGeneration: settings.memoryGeneration, sourceCreatedAtCutoff: f.now(), createdAt: f.now() }
    })).id };
    if (kind === "SUPPRESSED") await prisma.memorySuppression.create({ data: {
      userId: f.userId, scope: "SOURCE_MESSAGE", sourceChatId: f.chat.id,
      sourceMessageId: f.message.id, sourceBranchGeneration: 0,
      deletionGeneration: settings.memoryGeneration, fingerprintKeyVersion: "history-test-v1",
      normalizationVersion: "memory-search-normalization-v1"
    } });
    expect(await prisma.$transaction((tx) => inspectMemoryHistoryPurge(tx, f.userId, selection)))
      .toMatchObject({ complete: false });
    await prisma.$transaction((tx) => purgeMemoryHistorySelection(tx, f.userId, selection));
    expect(await prisma.$transaction((tx) => inspectMemoryHistoryPurge(tx, f.userId, selection)))
      .toMatchObject({ complete: true });
    expect(await prisma.memoryHistoryExecution.count({ where: { userId: f.userId, clearedAt: null } })).toBe(0);
    expect(await prisma.memoryHistoryExecution.count({ where: { userId: other.userId, clearedAt: null } })).toBe(3);
    expect(await prisma.usageEvent.count({ where: { userId: f.userId } })).toBe(3);
    expect(f.run).toHaveBeenCalledTimes(3);
  });

  it("rejects alteration of a retained output and never uses a revoked execution destination", async () => {
    const f = await fixture();
    await f.failCommit();
    const receipt = await prisma.memoryHistoryExecution.findFirstOrThrow({ where: { userId: f.userId } });
    await expect(prisma.$executeRaw`UPDATE "MemoryHistoryExecution" SET "acceptedOutput" = '{}'::jsonb WHERE id = ${receipt.id}`)
      .rejects.toMatchObject({ code: "P2010", meta: { code: "23514" } });
    await prisma.providerCredential.update({ where: { id: providerAuthority.credentialId }, data: { enabled: false } });
    try {
      f.advance();
      await f.drive();
      expect(f.run).toHaveBeenCalledTimes(3);
      // Optional semantic authority can disappear without disabling local
      // history. No generated output from that destination may be published.
      expect(await prisma.memoryRecallRound.findFirstOrThrow({ where: { userId: f.userId } }))
        .toMatchObject({ state: "ACTIVE", contextualKeyState: "RAW_FALLBACK" });
      expect(await prisma.chatMemoryDigest.count({ where: { userId: f.userId } })).toBe(0);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({
        state: "SUCCEEDED", stage: "lexical_ready:recovery_raw_fallback"
      });
      expect(await prisma.usageEvent.count({ where: { userId: f.userId } })).toBe(3);
    } finally {
      await prisma.providerCredential.update({ where: { id: providerAuthority.credentialId }, data: { enabled: true } });
    }
  });
});

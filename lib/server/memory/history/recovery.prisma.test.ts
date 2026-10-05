import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestProviderExecutionAuthority, deleteTestProviderExecutionAuthority,
  type TestProviderExecutionAuthority } from "@/tests/support/providerExecutionAuthority";
import { textMessageContent } from "../../../domain/content";
import { fuseMemoryRetrievalCandidates, planMemoryRetrieval } from "../../../domain/memory/retrieval";
import { prisma } from "../../prisma";
import { structuredOutputVerificationEvidence } from "../../providers/structuredOutputEvidence";
import { StructuredOutputDecodeError } from "../../providers/structuredOutput";
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
import { probeMemoryStructuredOutputAuthority, MemoryStructuredOutputProviderError } from "../execution/structuredClassifier";
import { authorizeMemoryExecutionResultsForCommit, detachExpiredMemoryExecutionBindings,
  MEMORY_EXECUTION_RECOVERY_HORIZON_MS } from "../execution/lifecycle";
import { createPrismaLocalMemoryRetrievalRepository } from "../retrieval/localRepository";
import { advanceMemoryMutation, withLockedMemoryTransaction } from "../persistence/transaction";
import { readMemoryHistoryIndexingProgress, seedMemoryHistoryBackfill } from "./backfill";
import { repairFencedMemoryHistoryJobs } from "./fenceRepair";
import { createPrismaMemoryHistoryIndexHandler } from "./handler";
import { createPrismaMemoryContextualKeyGenerator, MEMORY_CONTEXTUAL_KEY_VERSIONS,
  type MemoryContextualKeyGenerator } from "./contextualKeys";
import { inspectMemoryHistoryPurge, purgeMemoryHistorySelection } from "./purge";
import { autoHealIncompleteMemoryHistory } from "./autoHeal";
import { MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS, MEMORY_HISTORY_QUIET_WINDOW_MS, MEMORY_HISTORY_RECOVERED_UNCERTAIN_CODE,
  memoryHistoryAutoHealJobFingerprint } from "./contract";
import { resolveCurrentMemoryUtilityPolicy } from "../execution/policy";
import { applyMemorySourceMutations, lockMemorySourceChat } from "../sourceState";
import { defaultMemorySourceMutationHooks } from "../sourceHooks";
import { parseMemoryExecutionSnapshot } from "../execution/snapshot";
import { MEMORY_CONTEXTUAL_KEY_POLICY_VERSION } from "./rounds";

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

async function fixture(roundCount = 1) {
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
  let leaf = answer.id;
  const messages: Prisma.MessageCreateManyInput[] = [];
  const runs: Prisma.ModelRunCreateManyInput[] = [];
  for (let index = 1; index < roundCount; index += 1) {
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    messages.push({ id: userMessageId, chatId: chat.id, parentMessageId: leaf,
      role: "user", status: "complete", content: message.content as Prisma.InputJsonValue },
    { id: assistantMessageId, chatId: chat.id, parentMessageId: userMessageId,
      role: "assistant", status: "complete", content: answer.content as Prisma.InputJsonValue });
    runs.push({ assistantMessageId, userMessageId, chatId: chat.id, userId,
      modelId: "history-fixture-model", provider: "history-fixture-provider", status: "complete",
      normalizedRequest: { prompt: { baseline: { source: "standard_chat", timeZone: "UTC", timeZoneSource: "client" } } } });
    leaf = assistantMessageId;
  }
  await prisma.message.createMany({ data: messages });
  await prisma.modelRun.createMany({ data: runs });
  await prisma.chat.update({ data: { activeLeafMessageId: leaf, memorySourceRevision: roundCount * 2 }, where: { id: chat.id } });
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
  const generator = createPrismaMemoryContextualKeyGenerator(prisma, { authority: { now }, provider: { run } });
  // Force small provider batches to exercise 37 real governed results with a
  // tiny source graph, independently of the generator's character heuristics.
  const oneRoundPerBatch: MemoryContextualKeyGenerator = {
    async generate(rounds, targets, options) {
      const batches = [];
      for (const target of targets) batches.push(await generator.generate(rounds, [target], options));
      return {
        policyVersion: MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
        executions: batches.flatMap(batch => batch.executions),
        outputs: batches.flatMap(batch => batch.outputs),
        fallbackRoundIds: batches.flatMap(batch => batch.fallbackRoundIds),
        fallbackDiagnostics: batches.flatMap(batch => batch.fallbackDiagnostics ?? []),
        providerRequests: batches.reduce((sum, batch) => sum + batch.providerRequests, 0)
      };
    }
  };
  const handler = () => createPrismaMemoryHistoryIndexHandler(prisma, undefined, {
    authority: { now }, structuredProvider: { run },
    ...(roundCount > 1 ? { contextualKeyGenerator: oneRoundPerBatch } : {})
  });
  const repository = createPrismaMemoryCoordinatorRepository(prisma);
  const drive = async (selected: MemoryJobHandler = handler(), repo: MemoryCoordinatorRepository = repository) => {
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob(selected);
    const worker = new MemoryCoordinator({ now, registry, repository: repo,
      policy: { maxJobParallel: 1, maxJobParallelPerUser: 1, maxDeletionParallel: 1 } });
    try { await worker.reconcileNow(); } finally { await worker.stop(); }
  };
  const failCommit = async (code = "memory_job_commit_timeout") => {
    await drive(handler(), { ...repository, commitJobSuccess: (input) => repository.commitJobSuccess({
      ...input, apply: async (tx, claim) => {
        await input.apply?.(tx, claim);
        throw new MemoryCoordinatorError(code, true);
      }
    }) });
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      state: "TERMINAL_FAILED", attemptCount: 3, stage: "lexical_apply", errorCode: code
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
    .find(({ itemType }) => itemType === "RECALL_ROUND" || itemType === "RECALL_CHUNK");
  expect(selected, JSON.stringify({ lexicalEvidence: result.lexicalEvidence,
    digestEvidence: result.digestEvidence, lanes: result.laneResults.map(lane => ({
      lane: lane.lane, candidates: lane.candidates.length
    })) })).toBeDefined();
  const [expanded] = await repository.expand(result.snapshot, plan, [selected!]);
  expect(expanded?.safeText).toContain("I take pottery classes every Saturday at Pine studio.");
}

describe("history recovery without repeated provider work", () => {
  it("recovers a chunk-limit snapshot failure through the worker and dispatches new work only once", async () => {
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
    expect(f.run).not.toHaveBeenCalled();
    expect(await prisma.memoryExecutionBinding.count({ where: { userId: f.userId } })).toBe(0);
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues).toContainEqual(
      expect.objectContaining({ stage: "HISTORY", reason: "PROCESSING_FAILED" })
    );
    f.advance();
    expect(await readMemoryRecoveryStatus(prisma, f.now())).toMatchObject({ eligible: 1 });
    await f.drive();
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({
      state: "SUCCEEDED", recoveryCount: 1, recoveryErrorCode: errorCode, lastRecoveryAt: f.now()
    });
    expect(f.run).toHaveBeenCalledTimes(3);
    const bindings = await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    const usage = await prisma.usageEvent.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    expect(bindings).toHaveLength(3);
    expect(usage).toHaveLength(3);
    expect(bindings.every(({ state }) => state === "SUCCEEDED")).toBe(true);
    await f.drive();
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } })).toEqual(bindings);
    expect(await prisma.usageEvent.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } })).toEqual(usage);
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues).not.toContainEqual(
      expect.objectContaining({ stage: "HISTORY", reason: "PROCESSING_FAILED" })
    );
    await assertRecall(f);
  });

  it("repairs an invalid answer inside the job without auto-heal or an incomplete notice", async () => {
    const f = await fixture();
    f.run.mockResolvedValueOnce({ output: {}, providerResponseId: null,
      usage: { inputTokens: 20, outputTokens: 9, totalTokens: 29, completeness: "complete" } });
    await f.drive();
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } }))
      .toMatchObject({ state: "SUCCEEDED", stage: "lexical_ready" });
    expect(f.run).toHaveBeenCalledTimes(4);
    const bindings = await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { ordinal: "asc" } });
    expect(bindings.map(({ ordinal, state, errorCode, decodeReason }) => ({ ordinal, state, errorCode, decodeReason }))).toEqual([
      { ordinal: 0, state: "FAILED", errorCode: "memory_classifier_output_invalid", decodeReason: "contextual_key_output_invalid" },
      { ordinal: 1, state: "SUCCEEDED", errorCode: null, decodeReason: null },
      { ordinal: 2, state: "SUCCEEDED", errorCode: null, decodeReason: null },
      { ordinal: 3, state: "SUCCEEDED", errorCode: null, decodeReason: null }
    ]);
    // The retry reused the identical input and paid for its own call.
    expect(bindings[1]!.inputHash).toBe(bindings[0]!.inputHash);
    expect(await prisma.usageEvent.findMany({ where: { userId: f.userId }, select: { memoryExecutionBindingId: true, totalTokens: true } }))
      .toEqual(expect.arrayContaining([{ memoryExecutionBindingId: bindings[0]!.id, totalTokens: 29 },
        { memoryExecutionBindingId: bindings[1]!.id, totalTokens: 25 }]));
    expect(await prisma.usageEvent.count({ where: { userId: f.userId } })).toBe(4);
    expect(await prisma.memoryRecallRound.findFirstOrThrow({ where: { userId: f.userId } }))
      .toMatchObject({ state: "ACTIVE", contextualKeyState: "GENERATED" });
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues.filter(({ stage }) => stage === "HISTORY")).toEqual([]);
    f.advance(MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS[0]);
    expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(0);
    await f.drive();
    expect(f.run).toHaveBeenCalledTimes(4);
    await assertRecall(f);
  });

  it("keeps incomplete history and a failed auto-heal successor as separate admin issues", async () => {
    const f = await fixture();
    // Every in-job validation retry of the first input is rejected too.
    for (let call = 0; call < 3; call += 1) f.run.mockResolvedValueOnce({ output: {}, providerResponseId: null,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, completeness: "complete" } });
    await f.drive();
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ state: "SUCCEEDED" });
    f.advance(MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS[0]);
    expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(1);
    await f.drive(f.handler(), { ...f.repository, commitJobSuccess: (input) => f.repository.commitJobSuccess({
      ...input, apply: async (tx, claim) => {
        await input.apply?.(tx, claim);
        throw new MemoryCoordinatorError("memory_execution_input_invalid", false);
      }
    }) });
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues.filter(issue => issue.stage === "HISTORY"))
      .toEqual([
        expect.objectContaining({ reason: "PROCESSING_FAILED", severity: "bad", count: 1 }),
        expect.objectContaining({ reason: "HISTORY_INCOMPLETE", severity: "warn", autoHeal: "UNAVAILABLE", count: 1 })
      ]);
    expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(0);
    expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now() })).toBe(0);
    await assertRecall(f);
  });

  it.each(["fresh", "auto_heal", "recovery"] as const)(
    "commits more than 32 governed results once through the %s path", async (mode) => {
      const f = await fixture(18);
      const produce = f.run.getMockImplementation()!;
      if (mode === "auto_heal") {
        f.run.mockResolvedValue({ output: {}, providerResponseId: null,
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, completeness: "complete" } });
        await f.drive();
        expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ state: "SUCCEEDED" });
        f.run.mockImplementation(produce);
        f.advance(MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS[0]);
        expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(1);
      }
      if (mode === "recovery") {
        await f.drive(f.handler(), { ...f.repository, commitJobSuccess: (input) => f.repository.commitJobSuccess({
          ...input, apply: async (tx, claim) => {
            await input.apply?.(tx, claim);
            throw new MemoryCoordinatorError("memory_execution_input_invalid", false);
          }
        }) });
        expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } }))
          .toMatchObject({ state: "TERMINAL_FAILED", stage: "lexical_apply", errorCode: "memory_execution_input_invalid" });
        expect(await prisma.memoryRecallRound.count({ where: { userId: f.userId } })).toBe(0);
        const bindings = await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
        const usage = await prisma.usageEvent.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
        expect(bindings.length).toBeGreaterThanOrEqual(37);
        f.advance();
        await f.drive();
        expect(f.run).toHaveBeenCalledTimes(bindings.length);
        expect(await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } })).toEqual(bindings);
        expect(await prisma.usageEvent.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } })).toEqual(usage);
      } else await f.drive();
      const completed = await prisma.memoryJob.findFirstOrThrow({ where: { userId: f.userId, kind: "INDEX_HISTORY" }, orderBy: { createdAt: "desc" } });
      expect(completed).toMatchObject({ state: "SUCCEEDED", stage: "lexical_ready" });
      expect(await prisma.memoryExecutionBinding.count({ where: { userId: f.userId, memoryJobId: completed.id, state: "SUCCEEDED" } })).toBeGreaterThanOrEqual(37);
      expect(await prisma.memoryHistoryExecution.count({ where: { userId: f.userId, clearedAt: null } })).toBe(0);
      expect(await prisma.memoryRecallRound.count({ where: { userId: f.userId, state: "ACTIVE" } })).toBe(18);
      const calls = f.run.mock.calls.length;
      await f.drive();
      expect(f.run).toHaveBeenCalledTimes(calls);
      expect(await prisma.memoryRecallRound.count({ where: { userId: f.userId, state: "ACTIVE" } })).toBe(18);
      expect((await readAdminMemoryProcessing(prisma, f.now())).issues.filter(({ stage }) => stage === "HISTORY")).toEqual([]);
      await assertRecall(f);
    }, 30_000
  );

  it.each(["memory_job_commit_database_p2002", "memory_execution_policy_drift"])(
    "recovers %s locally without buying completed stages again", async (code) => {
      const f = await fixture();
      await f.failCommit(code);
      const usage = await prisma.usageEvent.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
      const bindings = await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
      f.advance();
      await Promise.all([f.drive(), f.drive()]);
      await f.drive();
      expect(f.run).toHaveBeenCalledTimes(3);
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } }))
        .toMatchObject({ state: "SUCCEEDED", recoveryCount: 1, recoveryErrorCode: code });
      expect(await prisma.usageEvent.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } })).toEqual(usage);
      expect(await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } })).toEqual(bindings);
      expect((await readAdminMemoryProcessing(prisma, f.now())).issues.filter(({ stage }) => stage === "HISTORY")).toEqual([]);
      await assertRecall(f);
    }
  );

  it.each(["recovery", "backfill"])("rebuilds a failed v9 source through a current %s successor without replay", async (entry) => {
    const f = await fixture();
    await f.failCommit("memory_job_commit_database_p2002");
    await prisma.memoryJob.update({ where: { id: f.job.id }, data: {
      pipelineVersion: "memory-history-incremental-v9", idempotencyFingerprint: `legacy-history:${f.job.id}`
    } });
    const original = await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } });
    const bindings = await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    const usage = await prisma.usageEvent.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    f.advance();
    if (entry === "backfill") await withLockedMemoryTransaction(prisma, f.userId,
      (tx, settings) => seedMemoryHistoryBackfill(tx, settings, { now: f.now() }));
    await f.drive();
    await f.drive();
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toEqual(original);
    expect(await prisma.memoryJob.findFirstOrThrow({ where: { userId: f.userId, id: { not: f.job.id }, kind: "INDEX_HISTORY" } }))
      .toMatchObject({ state: "SUCCEEDED", pipelineVersion: "memory-history-incremental-v10", stage: "lexical_ready:recovery_raw_fallback" });
    expect(await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } })).toEqual(bindings);
    expect(await prisma.usageEvent.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } })).toEqual(usage);
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues.filter(({ stage }) => stage === "HISTORY")).toEqual([]);
    await assertRecall(f);
  });

  it.each([2, 3])("keeps snapshot v%s results publishable after an unrelated System reranker change", async (snapshotVersion) => {
    const prior = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
    const f = await fixture();
    try {
      await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: {
        providerModelId: providerAuthority.providerModelId, reasoningEffort: null, version: { increment: 1 }
      } });
      const produce = f.run.getMockImplementation()!;
      let calls = 0;
      f.run.mockImplementation(async (...args) => {
        const result = await produce(...args);
        if (++calls === 3) {
          await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: {
            providerModelId: null, version: { increment: 1 }
          } });
          for (const binding of await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId } })) {
            await prisma.memoryExecutionBinding.update({ where: { id: binding.id }, data: {
              secretFreeExecutionSnapshot: { ...(binding.secretFreeExecutionSnapshot as Prisma.JsonObject), version: snapshotVersion }
            } });
            const snapshot = parseMemoryExecutionSnapshot(binding.secretFreeExecutionSnapshot);
            await expect(createPrismaMemoryExecutionAdmission({ now: f.now }, prisma).bind(f.userId, {
              owner: { type: "JOB", memoryJobId: f.job.id }, role: "MEMORY_HISTORY_CLASSIFY",
              ordinal: binding.ordinal, inputHash: binding.inputHash,
              versions: snapshot.compatibilityRequirement
            })).resolves.toMatchObject({ id: binding.id, replayed: true });
          }
        }
        return result;
      });
      await f.drive();
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: f.userId } });
      const policy = await resolveCurrentMemoryUtilityPolicy(prisma, f.userId, settings);
      const bindings = await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId } });
      expect(bindings).toHaveLength(3);
      for (const binding of bindings) {
        expect(binding.state).toBe("SUCCEEDED");
        expect(binding.secretFreeExecutionSnapshot).toMatchObject({ version: snapshotVersion });
        expect((binding.secretFreeExecutionSnapshot as Prisma.JsonObject).acceptedUtilityEgressFingerprint).not.toBe(policy.fingerprint);
      }
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } }))
        .toMatchObject({ state: "SUCCEEDED", stage: "lexical_ready" });
      expect(await prisma.memoryRecallRound.findFirstOrThrow({ where: { userId: f.userId } }))
        .toMatchObject({ contextualKeyState: "GENERATED" });
      expect(f.run).toHaveBeenCalledTimes(3);
      expect(await prisma.usageEvent.count({ where: { userId: f.userId } })).toBe(3);
    } finally {
      await prisma.systemModelPolicy.update({ where: { id: prior.id }, data: {
        providerModelId: prior.providerModelId, reasoningEffort: prior.reasoningEffort,
        version: prior.version, updatedAt: prior.updatedAt
      } });
    }
  });

  it("stops after three persisted auto-heal attempts across worker restarts and reports exhaustion", async () => {
    const f = await fixture();
    f.run.mockResolvedValue({ output: {}, providerResponseId: null, usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, completeness: "complete" } });
    await f.drive();
    for (const delay of MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS) {
      expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(0);
      f.advance(delay);
      expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(1);
      expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(0);
      await f.drive();
    }
    f.advance(24 * 60 * 60_000);
    expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(0);
    expect(await prisma.memoryJob.count({ where: { userId: f.userId, kind: "INDEX_HISTORY" } })).toBe(4);
    // Per job: three calls for the contextual input, then the breaker (four
    // invalid answers for the role) leaves the digest a single call.
    expect(f.run).toHaveBeenCalledTimes(16);
    for (const job of await prisma.memoryJob.findMany({ where: { userId: f.userId, kind: "INDEX_HISTORY" } })) {
      expect(await prisma.memoryExecutionBinding.count({ where: { memoryJobId: job.id, state: "FAILED",
        errorCode: "memory_classifier_output_invalid" } })).toBe(4);
    }
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues).toContainEqual(
      expect.objectContaining({ reason: "HISTORY_INCOMPLETE", autoHeal: "EXHAUSTED", count: 1 }));
    await assertRecall(f);
  });

  it.each(["summary_length", "response_json"] as const)("repairs a known %s failure with precise feedback, preserving successful stages", async (violation) => {
    const f = await fixture();
    const produce = f.run.getMockImplementation()!;
    // The first job's digest call and both of its in-job retries are rejected.
    let rejected = 0;
    f.run.mockImplementation(async (...args) => {
      if (args[1].name.startsWith("memory_chat_digest") && rejected < 3) {
        rejected += 1;
        if (violation === "response_json") throw new MemoryStructuredOutputProviderError(null,
          { inputTokens: 20, outputTokens: 8, totalTokens: 28 }, { cause: new StructuredOutputDecodeError("invalid_json") });
        return { output: { summary: "s".repeat(2_761), topics: [], decisions: [], open_loops: [] },
          providerResponseId: null, usage: { inputTokens: 20, outputTokens: 1000, totalTokens: 1020 } };
      }
      return produce(...args);
    });
    await f.drive();
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({
      state: "SUCCEEDED", stage: `lexical_ready:digest_contract_${violation}`
    });
    const original = await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    const usage = await prisma.usageEvent.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    const failed = expect.objectContaining({ errorCode: "memory_classifier_output_invalid",
      decodeReason: violation === "response_json" ? "invalid_json" : "digest_contract_summary_length" });
    expect(original.filter(b => b.state === "FAILED")).toEqual([failed, failed, failed]);
    expect(new Set(original.filter(b => b.state === "FAILED").map(b => b.inputHash)).size).toBe(1);
    f.advance(MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS[0]);
    expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(1);
    await f.drive();
    expect(f.run).toHaveBeenCalledTimes(6);
    expect(f.run.mock.calls.at(-1)![1].responseReminder).toContain(`contract_${violation}`);
    expect(await prisma.memoryExecutionBinding.findMany({ where: { id: { in: original.map(b => b.id) } }, orderBy: { id: "asc" } })).toEqual(original);
    expect(await prisma.usageEvent.findMany({ where: { id: { in: usage.map(u => u.id) } }, orderBy: { id: "asc" } })).toEqual(usage);
    expect(await prisma.chatMemoryDigest.count({ where: { userId: f.userId, state: "ACTIVE" } })).toBe(1);
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues.filter(i => i.stage === "HISTORY")).toEqual([]);
    await assertRecall(f);
  });

  it.each(["generator_upgrade", "memory_role_change"] as const)("opens one new bounded cycle after %s without rewriting exhausted work", async (change) => {
    const f = await fixture();
    const produce = f.run.getMockImplementation()!;
    f.run.mockResolvedValue({ output: {}, providerResponseId: null,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, completeness: "complete" } });
    await f.drive();
    for (const delay of MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS) {
      f.advance(delay);
      expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(1);
      await f.drive();
    }
    expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(0);
    if (change === "generator_upgrade") {
      const chat = await prisma.chat.findUniqueOrThrow({ where: { id: f.chat.id } });
      const repairs = await prisma.memoryJob.findMany({ where: { userId: f.userId, idempotencyFingerprint: { startsWith: "heal-history:" } } });
      for (const job of repairs) await prisma.memoryJob.update({ where: { id: job.id }, data: {
        idempotencyFingerprint: memoryHistoryAutoHealJobFingerprint({ ...chat, userId: f.userId, sourceHash: job.sourceHash! }, Number(job.idempotencyFingerprint.at(-1)))
      } });
    } else {
      await prisma.memoryUtilityModelPolicy.update({ where: { id: "installation" }, data: { version: { increment: 1 } } });
    }
    const oldJobs = await prisma.memoryJob.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    const oldBindings = await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    const oldUsage = await prisma.usageEvent.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    f.run.mockImplementation(produce);
    f.advance(MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS[0]);
    const admissions = await Promise.all([1, 2].map(() => autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })));
    expect(admissions.reduce((a, b) => a + b, 0)).toBe(1);
    await f.drive();
    expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(0);
    expect(await prisma.memoryJob.findMany({ where: { id: { in: oldJobs.map(j => j.id) } }, orderBy: { id: "asc" } })).toEqual(oldJobs);
    expect(await prisma.memoryExecutionBinding.findMany({ where: { id: { in: oldBindings.map(b => b.id) } }, orderBy: { id: "asc" } })).toEqual(oldBindings);
    expect(await prisma.usageEvent.findMany({ where: { id: { in: oldUsage.map(u => u.id) } }, orderBy: { id: "asc" } })).toEqual(oldUsage);
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues.filter(i => i.stage === "HISTORY")).toEqual([]);
  });

  it("keeps queued v2 repairs valid and reopens a chat exhausted under v2 until a v3 repair heals it", async () => {
    const f = await fixture();
    const produce = f.run.getMockImplementation()!;
    f.run.mockResolvedValue({ output: {}, providerResponseId: null,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, completeness: "complete" } });
    await f.drive();
    // Three repairs admitted before the upgrade carry the v2 identity. Each
    // stays a valid claim until it settles, and none counts toward v3.
    for (const [index, delay] of MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS.entries()) {
      f.advance(delay);
      expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(1);
      const repair = await prisma.memoryJob.findFirstOrThrow({ where: { userId: f.userId, state: "QUEUED",
        idempotencyFingerprint: { startsWith: "heal-history:" } } });
      expect(repair.idempotencyFingerprint).toMatch(/:v3:[1-9][0-9]*:1$/u);
      await prisma.memoryJob.update({ where: { id: repair.id }, data: { idempotencyFingerprint:
        repair.idempotencyFingerprint.replace(/:v3:([1-9][0-9]*):1$/u, `:v2:$1:${index + 1}`) } });
      await f.drive();
      expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: repair.id } })).toMatchObject({ state: "SUCCEEDED" });
    }
    expect(await prisma.memoryJob.count({ where: { userId: f.userId, idempotencyFingerprint: { contains: ":v2:" } } })).toBe(3);
    const history = async () => (await readAdminMemoryProcessing(prisma, f.now())).issues
      .filter(({ stage }) => stage === "HISTORY");
    // Exhausted under v2, the chat has a fresh v3 budget: recovering, not failed.
    expect(await history()).toEqual([expect.objectContaining({ reason: "HISTORY_INCOMPLETE", autoHeal: "RETRYING", count: 1 })]);
    f.run.mockImplementation(produce);
    f.advance(MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS[0]);
    expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(1);
    const healed = await prisma.memoryJob.findFirstOrThrow({ where: { userId: f.userId, state: "QUEUED" } });
    expect(healed.idempotencyFingerprint).toMatch(/:v3:[1-9][0-9]*:1$/u);
    await f.drive();
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: healed.id } })).toMatchObject({ state: "SUCCEEDED" });
    expect(await history()).toEqual([]);
    expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(0);
    await assertRecall(f);
  });

  it("reuses a completed digest and source projections while healing only failed context", async () => {
    const f = await fixture();
    const produce = f.run.getMockImplementation()!;
    f.run.mockImplementationOnce(async () => { throw new MemoryStructuredOutputProviderError(null, {
      inputTokens: 20, outputTokens: 448, totalTokens: 468
    }, { cause: Object.assign(new Error("bounded failure"), { code: "structured_output_output_limit_exceeded" }) }); });
    await f.drive();
    const before = await prisma.chatMemoryDigest.findFirstOrThrow({ where: { userId: f.userId }, select: { id: true, contentHash: true } });
    expect(f.run).toHaveBeenCalledTimes(2);
    f.run.mockImplementation(produce);
    f.advance(MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS[0]);
    expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(1);
    await f.drive();
    expect(f.run).toHaveBeenCalledTimes(4);
    expect(await prisma.chatMemoryDigest.findFirstOrThrow({ where: { userId: f.userId }, select: { id: true, contentHash: true } })).toEqual(before);
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues.filter(({ stage }) => stage === "HISTORY")).toEqual([]);
  });

  it("reports ongoing healing while its provider execution is running, without admitting duplicate work", async () => {
    const f = await fixture();
    const produce = f.run.getMockImplementation()!;
    f.run.mockResolvedValue({ output: {}, providerResponseId: null,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, completeness: "complete" } });
    await f.drive();
    f.advance(MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS[0]);
    expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(1);
    const observed: Array<string | undefined> = [];
    const duplicates: number[] = [];
    f.run.mockImplementation(async (...args) => {
      observed.push((await readAdminMemoryProcessing(prisma, f.now())).issues.find(({ stage }) => stage === "HISTORY")?.autoHeal);
      duplicates.push(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() }));
      return produce(...args);
    });
    await f.drive();
    expect(observed).toEqual(["RETRYING", "RETRYING", "RETRYING"]);
    expect(duplicates).toEqual([0, 0, 0]);
    expect(f.run).toHaveBeenCalledTimes(7);
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues.filter(({ stage }) => stage === "HISTORY")).toEqual([]);
  });

  it("automatically regenerates only missing enrichment once under concurrent admission, preserving original calls and usage", async () => {
    const f = await fixture();
    const produce = f.run.getMockImplementation()!;
    f.run.mockRejectedValue(new MemoryStructuredOutputProviderError(null, {
      inputTokens: 20, outputTokens: 448, totalTokens: 468
    }, { cause: Object.assign(new Error("bounded failure"), { code: "structured_output_output_limit_exceeded" }) }));
    await f.drive();
    const original = await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } });
    const bindings = await prisma.memoryExecutionBinding.findMany({ where: { memoryJobId: f.job.id }, orderBy: { ordinal: "asc" } });
    const usage = await prisma.usageEvent.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    const chunks = await prisma.memoryRecallChunk.findMany({ where: { userId: f.userId }, select: { id: true, contentHash: true }, orderBy: { id: "asc" } });
    f.run.mockImplementation(produce);
    expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(0);
    f.advance(MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS[0]);
    const requests = await Promise.all([0, 1].map(() => autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })));
    expect(requests.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(0);
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues).toContainEqual(expect.objectContaining({ reason: "OUTPUT_LIMIT" }));
    f.advance(1_000);
    await f.drive();
    const replacement = await prisma.memoryJob.findFirstOrThrow({ where: { userId: f.userId, kind: "INDEX_HISTORY", id: { not: f.job.id } } });
    expect(replacement).toMatchObject({ state: "SUCCEEDED", stage: "lexical_ready", operationalCounters: expect.objectContaining({
      contextualRoundsGenerated: 1, contextualRoundsFallback: 0, historyChunksBuilt: 0, historyChunksReused: chunks.length
    }) });
    expect(await prisma.chatMemoryDigest.count({ where: { userId: f.userId } })).toBe(1);
    expect(await prisma.memoryRecallChunk.findMany({ where: { userId: f.userId }, select: { id: true, contentHash: true }, orderBy: { id: "asc" } })).toEqual(chunks);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toEqual(original);
    expect(await prisma.memoryExecutionBinding.findMany({ where: { memoryJobId: f.job.id }, orderBy: { ordinal: "asc" } })).toEqual(bindings);
    expect(await prisma.usageEvent.findMany({ where: { id: { in: usage.map((event) => event.id) } }, orderBy: { id: "asc" } })).toEqual(usage);
    expect(f.run).toHaveBeenCalledTimes(5);
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues.filter(({ stage }) => stage === "HISTORY")).toEqual([]);
    expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(0);
    await assertRecall(f);
  });

  it.each(["excluded", "branch", "generation", "paused", "inactive", "ambiguous", "unsettled"] as const)("refuses automatic generation across the %s fence", async (fence) => {
    const f = await fixture();
    f.run.mockResolvedValue({ output: {}, providerResponseId: null, usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, completeness: "complete" } });
    await f.drive();
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues).toContainEqual(expect.objectContaining({ reason: "HISTORY_INCOMPLETE" }));
    if (fence === "excluded" || fence === "branch") await prisma.$transaction(async (tx) => {
      const chat = await lockMemorySourceChat(tx, { userId: f.userId, chatId: f.chat.id, lock: "UPDATE" });
      if (!chat) throw new Error("missing fixture source");
      await applyMemorySourceMutations(tx, { chat, hooks: defaultMemorySourceMutationHooks,
        mutations: [fence === "excluded" ? "SOURCE_EXCLUDE" : "BRANCH_PATH_CHANGE"],
        ...(fence === "excluded" ? { patch: { memoryMode: "EXCLUDED" as const } } : {}) });
    });
    if (fence === "generation") await prisma.userMemorySettings.update({ data: { memoryGeneration: { increment: 1 } }, where: { userId: f.userId } });
    if (fence === "paused") await prisma.userMemorySettings.update({ data: { referenceChatHistory: false }, where: { userId: f.userId } });
    if (fence === "inactive") await prisma.user.update({ data: { status: "disabled" }, where: { id: f.userId } });
    if (fence === "ambiguous") {
      const binding = await prisma.memoryExecutionBinding.findFirstOrThrow({ where: { userId: f.userId } });
      await prisma.memoryExecutionBinding.create({ data: {
        ...binding, id: randomUUID(), ordinal: 99, state: "OUTCOME_UNKNOWN", acceptedOutputHash: null,
        secretFreeExecutionSnapshot: binding.secretFreeExecutionSnapshot as Prisma.InputJsonValue,
        errorCode: "memory_execution_outcome_unknown", decodeReason: null, completedAt: f.now()
      } });
    }
    if (fence === "unsettled") await prisma.usageEvent.deleteMany({ where: { userId: f.userId } });
    f.advance(MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS[0]);
    expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(0);
    expect(await prisma.memoryJob.count({ where: { userId: f.userId, kind: "INDEX_HISTORY", idempotencyFingerprint: { startsWith: "heal-history:" } } })).toBe(0);
    expect(f.run).toHaveBeenCalledTimes(4);
  });

  it("keeps raw history and paid usage after output exhaustion, with truthful current admin status and no replay", async () => {
    const f = await fixture();
    f.run.mockRejectedValue(new MemoryStructuredOutputProviderError(null, {
      inputTokens: 20, outputTokens: 4096, reasoningTokens: 4096, totalTokens: 4116
    }, { cause: Object.assign(new Error("bounded failure"), { code: "structured_output_output_limit_exceeded" }) }));
    await f.drive();
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({
      state: "SUCCEEDED", stage: "lexical_ready:digest_output_limit",
      operationalCounters: expect.objectContaining({ contextualRoundsGenerated: 0, contextualRoundsFallback: 1,
        contextualFallbackProviderOutputLimit: 1 })
    });
    expect(await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId } }))
      .toEqual([expect.objectContaining({ state: "FAILED", errorCode: "memory_classifier_output_limit_exceeded", reasoningTokens: 4096 }),
        expect.objectContaining({ state: "FAILED", errorCode: "memory_classifier_output_limit_exceeded", reasoningTokens: 4096 })]);
    expect(await prisma.usageEvent.aggregate({ where: { userId: f.userId }, _count: true, _sum: { totalTokens: true } }))
      .toMatchObject({ _count: 2, _sum: { totalTokens: 8232 } });
    expect(await prisma.chatMemoryDigest.count({ where: { userId: f.userId } })).toBe(0);
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues.filter(({ stage }) => stage === "HISTORY"))
      .toEqual([expect.objectContaining({ reason: "OUTPUT_LIMIT", count: 1, severity: "warn" })]);
    await assertRecall(f);
    f.advance();
    await f.drive();
    expect(f.run).toHaveBeenCalledTimes(2);
    await prisma.$transaction(async (tx) => {
      await tx.chatMemoryCheckpoint.update({ where: { userId_chatId: { userId: f.userId, chatId: f.chat.id } },
        data: { status: "PENDING" } });
      await tx.chat.update({ where: { id: f.chat.id }, data: { memorySourceRevision: { increment: 1 } } });
    });
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues.filter(({ stage }) => stage === "HISTORY")).toEqual([]);
  });
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
    // The exclusion fenced the job; it is never a terminal failure that blocks the source.
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } }))
      .toMatchObject({ state: "STALE", errorCode: "memory_source_stale", leaseToken: null });
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
    const authorize = (jobId = f.job.id, outputHash = receipt.acceptedOutputHash) =>
      withLockedMemoryTransaction(prisma, f.userId, (tx, settings) =>
        authorizeMemoryExecutionResultsForCommit({ now: f.now }, tx, settings, f.userId,
          { memoryJobId: jobId, role: "MEMORY_HISTORY_CLASSIFY" },
          [{ bindingId: receipt.executionBindingId, acceptedOutputHash: outputHash }]));
    await expect(authorize()).resolves.toHaveLength(1);
    await expect(authorize(randomUUID())).rejects.toMatchObject({ code: "memory_execution_state_conflict" });
    await expect(authorize(f.job.id, "b".repeat(64))).rejects.toMatchObject({ code: "memory_execution_state_conflict" });
    await expect(prisma.$executeRaw`UPDATE "MemoryHistoryExecution" SET "acceptedOutput" = '{}'::jsonb WHERE id = ${receipt.id}`)
      .rejects.toMatchObject({ code: "P2010", meta: { code: "23514" } });
    await prisma.providerCredential.update({ where: { id: providerAuthority.credentialId }, data: { enabled: false } });
    try {
      await expect(authorize()).rejects.toMatchObject({ code: "memory_execution_target_unavailable" });
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

type HistoryRecoveryFixture = Awaited<ReturnType<typeof fixture>>;
type ClassificationFence = "append" | "settlement" | "branch" | "forget" | "exclusion" | "disabled";

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

/** Commits one source, Forget or settings fence through its product mutation. */
async function landFence(f: HistoryRecoveryFixture, fence: ClassificationFence): Promise<void> {
  if (fence === "branch") return mutateFixtureSource(f, { mutations: ["BRANCH_PATH_CHANGE"] });
  if (fence === "exclusion") {
    return mutateFixtureSource(f, { mutations: ["SOURCE_EXCLUDE"], patch: { memoryMode: "EXCLUDED" } });
  }
  if (fence === "disabled") {
    await prisma.userMemorySettings.update({ data: { referenceChatHistory: false }, where: { userId: f.userId } });
    return;
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

/** Lands `fence` while the job's second paid call (grounding) is in flight;
 * the next dispatch (the digest) then finds the job fenced. */
async function fenceDuringClassification(f: HistoryRecoveryFixture, fence: ClassificationFence): Promise<void> {
  const produce = f.run.getMockImplementation()!;
  f.run.mockImplementationOnce(produce).mockImplementationOnce(async (...args) => {
    const result = await produce(...args);
    await landFence(f, fence);
    return result;
  });
  await f.drive();
}

/** Moves the fixed worker clock to the end of a settled turn's quiet window,
 * which also makes work created by the database clock current for it. */
function untilQuiet(f: HistoryRecoveryFixture, job: Readonly<{ nextAttemptAt: Date | null }>): void {
  f.advance(Math.max(0, job.nextAttemptAt!.getTime() - f.now().getTime()));
}

describe("history work fenced during classification", () => {
  it.each([
    ["append", "STALE", "memory_source_stale"],
    ["settlement", "STALE", "memory_source_stale"],
    ["branch", "STALE", "memory_source_stale"],
    ["forget", "STALE", "memory_source_stale"],
    ["exclusion", "STALE", "memory_source_stale"],
    ["disabled", "CANCELLED", "memory_history_disabled"]
  ] as const)("settles a job fenced by %s during classification as %s, never as a failure", async (fence, state, errorCode) => {
    const f = await fixture();
    await fenceDuringClassification(f, fence);
    const job = await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } });
    expect(job).toMatchObject({ state, errorCode, stage: "digest_generation", leaseToken: null });
    expect(job.completedAt).not.toBeNull();
    // Only the two calls dispatched before the fence were bought; the fenced
    // dispatch never bound.
    const bindings = await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId, memoryJobId: f.job.id } });
    expect(bindings).toHaveLength(2);
    expect(bindings.every((binding) => binding.state === "SUCCEEDED")).toBe(true);
    expect(await prisma.usageEvent.count({
      where: { userId: f.userId, memoryExecutionBindingId: { in: bindings.map(({ id }) => id) } }
    })).toBe(2);
    expect(f.run).toHaveBeenCalledTimes(2);
    if (fence !== "settlement") return;
    // The settled turn indexes the latest source through its own job once its
    // chat has stayed quiet; the fenced job's pass did not claim it early.
    const successor = await prisma.memoryJob.findFirstOrThrow({ where: { userId: f.userId, id: { not: f.job.id } } });
    expect(successor).toMatchObject({ kind: "INDEX_HISTORY", state: "QUEUED" });
    untilQuiet(f, successor);
    await f.drive();
    const chat = await prisma.chat.findUniqueOrThrow({ where: { id: f.chat.id } });
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: successor.id } }))
      .toMatchObject({ state: "SUCCEEDED", sourceRevision: chat.memorySourceRevision });
    expect(await readMemoryHistoryIndexingProgress(prisma, f.userId, true)).toMatchObject({ state: "READY" });
    await assertRecall(f);
  }, 30_000);
});

describe("history indexing quiet window", () => {
  const historyJobs = (f: HistoryRecoveryFixture) => prisma.memoryJob.findMany({
    orderBy: { sourceRevision: "asc" }, where: { userId: f.userId, kind: "INDEX_HISTORY" }
  });
  const job = (id: string) => prisma.memoryJob.findUniqueOrThrow({ where: { id } });

  it("indexes turns settled within the window in one paid run", async () => {
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
    // its claim gate, before any stage or call.
    await f.drive();
    expect(f.run).not.toHaveBeenCalled();
    expect(await job(backfilled!.id)).toMatchObject({ state: "STALE", errorCode: "memory_source_stale", stage: null });
    expect(await job(older!.id)).toMatchObject({ state: "QUEUED", attemptCount: 0 });
    expect(await job(newest!.id)).toMatchObject({ state: "QUEUED", attemptCount: 0 });

    untilQuiet(f, newest!);
    await f.drive();
    // The older turn's job is superseded without a binding; only the newest
    // source is indexed, by a single paid run.
    expect(await job(older!.id)).toMatchObject({ state: "STALE", errorCode: "memory_source_stale", stage: null });
    expect(await job(newest!.id)).toMatchObject({ state: "SUCCEEDED" });
    const bindings = await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId } });
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings.every(({ memoryJobId, state }) => memoryJobId === newest!.id && state === "SUCCEEDED")).toBe(true);
    expect(f.run).toHaveBeenCalledTimes(bindings.length);
    expect(await prisma.usageEvent.count({ where: { userId: f.userId } })).toBe(bindings.length);
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
    expect(f.run).not.toHaveBeenCalled();
    expect(await job(turn.id)).toMatchObject({ state: "QUEUED", attemptCount: 0 });
    expect(await readMemoryHistoryIndexingProgress(prisma, f.userId, true)).toMatchObject({ state: "INDEXING" });

    f.advance(1_000);
    await f.drive();
    expect(await job(turn.id)).toMatchObject({ state: "SUCCEEDED" });
    expect(f.run).toHaveBeenCalled();
    expect(await readMemoryHistoryIndexingProgress(prisma, f.userId, true)).toMatchObject({ state: "READY" });
    await assertRecall(f);
  }, 30_000);
});

describe("history fence casualties left by an earlier release", () => {
  /** The same race as above, rewritten into the exact previous-release
   * outcome: fixture construction, never a repair action. */
  async function casualty(fence: ClassificationFence) {
    const f = await fixture();
    await fenceDuringClassification(f, fence);
    const settled = await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } });
    expect(settled).toMatchObject({ state: "STALE", stage: "digest_generation" });
    await prisma.memoryJob.update({ where: { id: f.job.id },
      data: { state: "TERMINAL_FAILED", errorCode: "memory_history_job_invalid" } });
    return { completedAt: settled.completedAt, f };
  }
  const backfill = (f: HistoryRecoveryFixture) => withLockedMemoryTransaction(prisma, f.userId,
    (tx, settings) => seedMemoryHistoryBackfill(tx, settings, { now: f.now() }));
  const job = (f: HistoryRecoveryFixture) => prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } });

  it("re-indexes a Forget casualty from its current source without resurrection or replay", async () => {
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
    const bindings = await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    await f.drive();
    // The revived row holds bindings, so it only restores exact retained
    // outputs: no new dispatch and no replay of either earlier call.
    expect(await job(f)).toMatchObject({ state: "SUCCEEDED", stage: "lexical_ready:recovery_raw_fallback" });
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } }))
      .toEqual(bindings);
    // The Forget still holds: the forgotten turn is not indexed again.
    expect(await prisma.memoryRecallChunk.count({ where: { userId: f.userId, state: "ACTIVE" } })).toBe(0);
    expect(await prisma.memoryRecallRound.count({ where: { userId: f.userId, state: "ACTIVE" } })).toBe(0);
    expect(await prisma.chatMemoryDigest.count({ where: { userId: f.userId } })).toBe(0);
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
    expect(f.run).toHaveBeenCalledTimes(5);
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
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it("keeps a casualty with an ambiguous dispatch protected and never replays it", async () => {
    const { f } = await casualty("forget");
    const binding = await prisma.memoryExecutionBinding.findFirstOrThrow({ where: { userId: f.userId }, orderBy: { ordinal: "asc" } });
    // A distinct dispatch which was accepted but whose settlement was lost.
    await prisma.memoryExecutionBinding.create({ data: {
      ...binding, id: randomUUID(), ordinal: 9, state: "OUTCOME_UNKNOWN", acceptedOutputHash: null,
      secretFreeExecutionSnapshot: binding.secretFreeExecutionSnapshot as Prisma.InputJsonValue,
      errorCode: "memory_execution_outcome_unknown", completedAt: f.now()
    } });
    await repairFencedMemoryHistoryJobs(prisma, { now: f.now() });
    expect(await job(f)).toMatchObject({ state: "TERMINAL_FAILED", errorCode: "memory_history_job_invalid" });
    expect(await backfill(f)).toMatchObject({ enqueuedJobs: 0 });
    await f.drive();
    expect(await job(f)).toMatchObject({ state: "TERMINAL_FAILED" });
    expect(f.run).toHaveBeenCalledTimes(2);
  });
});

describe("history validation retries across fences", () => {
  it.each([
    ["forget", "STALE", "memory_source_stale"],
    ["exclusion", "STALE", "memory_source_stale"],
    ["disabled", "CANCELLED", "memory_history_disabled"]
  ] as const)("never discloses the source again once %s lands between a rejected answer and its retry", async (fence, state, errorCode) => {
    const f = await fixture();
    f.run.mockImplementationOnce(async () => {
      await landFence(f, fence);
      return { output: {}, providerResponseId: null,
        usage: { inputTokens: 20, outputTokens: 9, totalTokens: 29, completeness: "complete" } };
    });
    await f.drive();
    // The rejected answer was settled and paid for; the revalidation before
    // its retry found the fence, so nothing was bound or sent again.
    expect(f.run).toHaveBeenCalledOnce();
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } }))
      .toMatchObject({ state, errorCode, stage: "contextual_key_generation", leaseToken: null });
    expect(await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId } })).toEqual([
      expect.objectContaining({ ordinal: 0, state: "FAILED", errorCode: "memory_classifier_output_invalid",
        decodeReason: "contextual_key_output_invalid" })
    ]);
    expect(await prisma.usageEvent.count({ where: { userId: f.userId } })).toBe(1);
  });
});

describe("history classifications orphaned by a lost worker", () => {
  function gate() {
    let release!: () => void;
    const opened = new Promise<void>((resolve) => { release = resolve; });
    return { opened, release };
  }

  /** Runs the job until its call at `ordinal` is in flight, then loses the
   * worker: the call ignores cancellation, so the bounded shutdown drain ends
   * with the binding still RUNNING and the job claimed, as after SIGKILL. */
  async function loseWorkerAt(f: HistoryRecoveryFixture, ordinal: number) {
    const produce = f.run.getMockImplementation()!;
    const dispatched = gate();
    const lost = gate();
    let calls = 0;
    f.run.mockImplementation(async (...args) => {
      if (calls++ !== ordinal) return produce(...args);
      dispatched.release();
      await lost.opened;
      throw new Error("worker_process_lost");
    });
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob(f.handler());
    const worker = new MemoryCoordinator({ now: f.now, registry, repository: f.repository,
      policy: { maxJobParallel: 1, maxJobParallelPerUser: 1, maxDeletionParallel: 1 } });
    const pass = worker.reconcileNow();
    await dispatched.opened;
    await expect(worker.stop({ drainTimeoutMs: 50 })).resolves.toEqual({ drained: false, pendingCount: 1 });
    f.run.mockImplementation(produce);
    const bindings = await prisma.memoryExecutionBinding.findMany({
      where: { userId: f.userId }, orderBy: { ordinal: "asc" }
    });
    expect(bindings.map(({ ordinal: index, state }) => ({ index, state }))).toEqual([
      ...Array.from({ length: ordinal }, (_, index) => ({ index, state: "SUCCEEDED" })),
      { index: ordinal, state: "RUNNING" }
    ]);
    expect(bindings.at(-1)).toMatchObject({ logicalRole: "MEMORY_HISTORY_CLASSIFY", ownerType: "JOB",
      completedAt: null, acceptedOutputHash: null, providerResponseId: null, usageCompleteness: "UNAVAILABLE" });
    const usage = await prisma.usageEvent.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    expect(usage).toHaveLength(ordinal);
    expect(await prisma.memoryHistoryExecution.count({ where: { userId: f.userId, clearedAt: null } })).toBe(ordinal);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ state: "CLAIMED" });
    return {
      orphan: bindings.at(-1)!,
      settled: bindings.slice(0, -1),
      usage,
      /** The lost call ends; the stopped attempt never commits or settles over recovery. */
      async release() {
        lost.release();
        await pass;
      }
    };
  }

  /** Infrastructure maintenance after the stop: the claim becomes retryable
   * with its execution bindings untouched, as the coordinator's own retry. */
  const maintenanceRequeue = (f: HistoryRecoveryFixture) => prisma.memoryJob.update({
    where: { id: f.job.id },
    data: { state: "RETRYABLE_FAILED", errorCode: "memory_job_lease_lost", leaseToken: null,
      leaseExpiresAt: null, nextAttemptAt: f.now(), progressAt: f.now() }
  });

  /** The previous release's outcome of that restart, written as fixture
   * construction: its recovery guard failed the job before any dispatch. */
  const previousReleaseFailure = (f: HistoryRecoveryFixture) => prisma.memoryJob.update({
    where: { id: f.job.id },
    data: { state: "TERMINAL_FAILED", errorCode: "memory_history_execution_protected", stage: "source_snapshot",
      attemptCount: 2, completedAt: f.now(), leaseToken: null, leaseExpiresAt: null, nextAttemptAt: null,
      progressAt: f.now() }
  });

  // The lost call is the first one, follows partial progress, or follows a
  // long run of retained results.
  const shapes = [
    { name: "first call", rounds: 2, settled: 0 },
    { name: "partial progress", rounds: 3, settled: 2 },
    { name: "long retained run", rounds: 47, settled: 92 }
  ] as const;
  const restarts = ["maintenance_requeue", "previous_release_failure", "lease_expiry"] as const;
  const cases = shapes.flatMap((shape) => restarts
    .filter((restart) => restart !== "lease_expiry" || shape.settled === 2)
    .map((restart) => ({ ...shape, restart })));

  it.each(cases)("recovers a $name orphan ($settled settled calls) after $restart without dispatching again", async ({
    rounds, settled, restart
  }) => {
    const f = await fixture(rounds);
    const lost = await loseWorkerAt(f, settled);
    if (restart === "maintenance_requeue") await maintenanceRequeue(f);
    if (restart === "lease_expiry") f.advance(30_001);
    if (restart === "previous_release_failure") {
      await previousReleaseFailure(f);
      expect((await readAdminMemoryProcessing(prisma, f.now())).issues).toContainEqual(
        expect.objectContaining({ stage: "HISTORY", reason: "PROCESSING_FAILED" }));
      expect(await readMemoryRecoveryStatus(prisma, f.now())).toMatchObject({ scheduled: 1, protected: 0 });
      f.advance();
      expect(await readMemoryRecoveryStatus(prisma, f.now())).toMatchObject({ eligible: 1, protected: 0 });
    }
    await f.drive();

    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({
      state: "SUCCEEDED", stage: "lexical_ready:recovery_raw_fallback",
      recoveryCount: restart === "previous_release_failure" ? 1 : 0,
      operationalCounters: expect.objectContaining({ contextualProviderRequests: 0,
        contextualRoundsGenerated: settled / 2, contextualRoundsFallback: rounds - settled / 2 })
    });
    // Nothing was dispatched again: neither the orphan nor any later input.
    expect(f.run).toHaveBeenCalledTimes(settled + 1);
    expect(await prisma.memoryExecutionBinding.findMany({
      where: { userId: f.userId, id: { not: lost.orphan.id } }, orderBy: { ordinal: "asc" }
    })).toEqual(lost.settled);
    const orphan = await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: lost.orphan.id } });
    expect(orphan).toMatchObject({ state: "OUTCOME_UNKNOWN", errorCode: MEMORY_HISTORY_RECOVERED_UNCERTAIN_CODE,
      acceptedOutputHash: null, providerResponseId: null, usageCompleteness: "UNAVAILABLE", totalTokens: null,
      startedAt: lost.orphan.startedAt, completedAt: expect.any(Date) });
    // Settled receipts stay exact; the orphan gains only an unavailable one.
    expect(await prisma.usageEvent.findMany({
      where: { userId: f.userId, memoryExecutionBindingId: { not: lost.orphan.id } }, orderBy: { id: "asc" }
    })).toEqual(lost.usage);
    expect(await prisma.usageEvent.findMany({ where: { userId: f.userId, memoryExecutionBindingId: lost.orphan.id } }))
      .toEqual([expect.objectContaining({ usageCompleteness: "UNAVAILABLE", totalTokens: null, inputTokens: null })]);
    expect(await prisma.memoryHistoryExecution.count({ where: { userId: f.userId } })).toBe(settled);
    expect(await prisma.memoryHistoryExecution.count({ where: { userId: f.userId, clearedAt: null } })).toBe(0);
    const recallRounds = await prisma.memoryRecallRound.findMany({
      where: { userId: f.userId, state: "ACTIVE" }, select: { contextualKeyState: true }
    });
    expect(recallRounds).toHaveLength(rounds);
    expect(recallRounds.filter(({ contextualKeyState }) => contextualKeyState === "GENERATED")).toHaveLength(settled / 2);
    expect(await prisma.chatMemoryDigest.count({ where: { userId: f.userId } })).toBe(0);
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues.filter(({ stage }) => stage === "HISTORY")).toEqual([]);
    expect(await readMemoryRecoveryStatus(prisma, f.now()))
      .toMatchObject({ eligible: 0, scheduled: 0, protected: 0, permanent: 0 });

    // A repeated restart and recovery pass change nothing.
    const bindings = await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    const usage = await prisma.usageEvent.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    f.advance(MEMORY_RECOVERY_DELAYS_MS[1]);
    expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now() })).toBe(0);
    await f.drive();
    expect(f.run).toHaveBeenCalledTimes(settled + 1);
    expect(await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } })).toEqual(bindings);
    expect(await prisma.usageEvent.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } })).toEqual(usage);

    // The lost attempt's late failure cannot overwrite the recovered evidence.
    await lost.release();
    expect(await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } })).toEqual(bindings);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ state: "SUCCEEDED" });
    await assertRecall(f);
  }, 120_000);

  // A moved branch retires the job's source for good, so the obsolete-orphan
  // sweep settles its call; an exclusion flipped in place keeps the source
  // counters, so the job may become current again and its recovery keeps it.
  it.each([["branch", "OUTCOME_UNKNOWN"], ["excluded", "RUNNING"]] as const)("never recovers or dispatches an orphaned job of a %s source", async (fence, orphanState) => {
    const f = await fixture(3);
    const lost = await loseWorkerAt(f, 2);
    await previousReleaseFailure(f);
    if (fence === "branch") await prisma.chat.update({ data: { memoryBranchGeneration: { increment: 1 } }, where: { id: f.chat.id } });
    if (fence === "excluded") await prisma.chat.update({ data: { memoryMode: "EXCLUDED" }, where: { id: f.chat.id } });
    f.advance();
    expect(await readMemoryRecoveryStatus(prisma, f.now())).toMatchObject({ eligible: 0, protected: 0, obsolete: 1 });
    await f.drive();
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } }))
      .toMatchObject({ state: "TERMINAL_FAILED", errorCode: "memory_history_execution_protected", recoveryCount: 0 });
    expect(await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: lost.orphan.id } }))
      .toMatchObject({ state: orphanState });
    expect(await prisma.memoryRecallRound.count({ where: { userId: f.userId } })).toBe(0);
    await lost.release();
  }, 30_000);

  it.each(["previous_release_failure", "stale_restart"] as const)("settles the orphan of a %s job once its chat moved on, exactly once and without dispatch", async (end) => {
    const f = await fixture(3);
    const lost = await loseWorkerAt(f, 2);
    if (end === "previous_release_failure") await previousReleaseFailure(f);
    await landFence(f, "append");
    if (end === "stale_restart") {
      // The restarted worker reclaims the expired lease and finds the source moved on.
      f.advance(30_001);
      await f.drive();
    }
    const ended = await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } });
    expect(ended).toMatchObject(end === "stale_restart"
      ? { state: "STALE", errorCode: "memory_source_stale", leaseToken: null }
      : { state: "TERMINAL_FAILED", errorCode: "memory_history_execution_protected", leaseToken: null });
    expect(await readMemoryRecoveryStatus(prisma, f.now())).toMatchObject({ eligible: 0, protected: 0, obsolete: 1 });
    const orphanEvidence = () => Promise.all([
      prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: lost.orphan.id } }),
      prisma.usageEvent.findMany({ where: { userId: f.userId, memoryExecutionBindingId: lost.orphan.id } })
    ]);

    // Within the job's recovery delay the lost attempt may still be ending its call.
    expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now() })).toBe(0);
    expect(await orphanEvidence()).toEqual([lost.orphan, []]);
    f.advance();
    expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now() })).toBe(0);
    const [orphan, receipts] = await orphanEvidence();
    expect(orphan).toEqual({ ...lost.orphan, state: "OUTCOME_UNKNOWN", errorCode: MEMORY_HISTORY_RECOVERED_UNCERTAIN_CODE,
      completedAt: f.now(), recoverableUntil: new Date(f.now().getTime() + MEMORY_EXECUTION_RECOVERY_HORIZON_MS) });
    expect(orphan).toMatchObject({ acceptedOutputHash: null, providerResponseId: null, usageCompleteness: "UNAVAILABLE", totalTokens: null });
    expect(receipts).toEqual([expect.objectContaining({ usageCompleteness: "UNAVAILABLE", inputTokens: null, totalTokens: null })]);
    // Every settled call and receipt stays exact; the job is neither revived nor recovered.
    expect(await prisma.memoryExecutionBinding.findMany({
      where: { userId: f.userId, id: { not: lost.orphan.id } }, orderBy: { ordinal: "asc" }
    })).toEqual(lost.settled);
    expect(await prisma.usageEvent.findMany({
      where: { userId: f.userId, memoryExecutionBindingId: { not: lost.orphan.id } }, orderBy: { id: "asc" }
    })).toEqual(lost.usage);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toEqual(ended);

    // Later sweeps, worker passes and the lost attempt's own late end change nothing.
    const bindings = await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    const usage = await prisma.usageEvent.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    f.advance(MEMORY_RECOVERY_DELAYS_MS[2]);
    expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now() })).toBe(0);
    await f.drive();
    await lost.release();
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(await prisma.memoryExecutionBinding.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } })).toEqual(bindings);
    expect(await prisma.usageEvent.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } })).toEqual(usage);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toEqual(ended);
    expect(await prisma.memoryRecallRound.count({ where: { userId: f.userId } })).toBe(0);
  }, 60_000);

  it.each(["current", "leased", "receipt", "response", "output"] as const)("leaves a %s orphaned classification to its owner", async (guard) => {
    const f = await fixture(3);
    const lost = await loseWorkerAt(f, 2);
    if (guard !== "leased") await previousReleaseFailure(f);
    if (guard !== "current") await landFence(f, "append");
    if (guard === "receipt") await prisma.usageEvent.create({ data: {
      memoryExecutionBindingId: lost.orphan.id, modelId: providerAuthority.providerModelId,
      provider: "openai_compatible", providerModelId: providerAuthority.providerModelId, userId: f.userId
    } });
    if (guard === "response" || guard === "output") await prisma.memoryExecutionBinding.update({
      where: { id: lost.orphan.id },
      data: guard === "response" ? { providerResponseId: "resp_orphan_fixture" } : { acceptedOutputHash: "b".repeat(64) }
    });
    const before = await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: lost.orphan.id } });
    const receipts = await prisma.usageEvent.count({ where: { userId: f.userId } });
    // The lost attempt still holds its live lease; every terminal job is due.
    if (guard !== "leased") f.advance();
    // A current job is recovered instead; its handler settles the orphan in-job.
    expect(await f.repository.recoverEligibleJobs({ limit: 8, now: f.now() })).toBe(guard === "current" ? 1 : 0);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject(
      guard === "current" ? { state: "QUEUED", recoveryCount: 1 }
        : guard === "leased" ? { state: "CLAIMED" } : { state: "TERMINAL_FAILED", recoveryCount: 0 });
    expect(await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: lost.orphan.id } })).toEqual(before);
    expect(await prisma.usageEvent.count({ where: { userId: f.userId } })).toBe(receipts);
    expect(f.run).toHaveBeenCalledTimes(3);
    await lost.release();
  }, 30_000);

  it("keeps an orphaned job protected while a settled call lacks its usage receipt", async () => {
    const f = await fixture(3);
    const lost = await loseWorkerAt(f, 2);
    await previousReleaseFailure(f);
    await prisma.usageEvent.deleteMany({ where: { userId: f.userId, memoryExecutionBindingId: lost.settled[0]!.id } });
    f.advance();
    expect(await readMemoryRecoveryStatus(prisma, f.now())).toMatchObject({ eligible: 0, protected: 1 });
    await f.drive();
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: f.job.id } }))
      .toMatchObject({ state: "TERMINAL_FAILED", errorCode: "memory_history_execution_protected", recoveryCount: 0 });
    expect(await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: lost.orphan.id } }))
      .toMatchObject({ state: "RUNNING" });
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues).toContainEqual(
      expect.objectContaining({ stage: "HISTORY", reason: "PROCESSING_FAILED" }));
    await lost.release();
  }, 30_000);
});

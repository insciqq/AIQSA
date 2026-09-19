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
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { seedMemoryHistoryBackfill } from "./backfill";
import { createPrismaMemoryHistoryIndexHandler } from "./handler";
import { createPrismaMemoryContextualKeyGenerator, MEMORY_CONTEXTUAL_KEY_VERSIONS,
  type MemoryContextualKeyGenerator } from "./contextualKeys";
import { inspectMemoryHistoryPurge, purgeMemoryHistorySelection } from "./purge";
import { autoHealIncompleteMemoryHistory } from "./autoHeal";
import { MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS, memoryHistoryAutoHealJobFingerprint } from "./contract";
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
  it("keeps incomplete history and a failed auto-heal successor as separate admin issues", async () => {
    const f = await fixture();
    f.run.mockResolvedValueOnce({ output: {}, providerResponseId: null,
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
    expect(f.run).toHaveBeenCalledTimes(8);
    expect((await readAdminMemoryProcessing(prisma, f.now())).issues).toContainEqual(
      expect.objectContaining({ reason: "HISTORY_INCOMPLETE", autoHeal: "EXHAUSTED", count: 1 }));
    await assertRecall(f);
  });

  it.each(["summary_length", "response_json"] as const)("repairs a known %s failure with precise feedback, preserving successful stages", async (violation) => {
    const f = await fixture();
    const produce = f.run.getMockImplementation()!;
    let rejected = false;
    f.run.mockImplementation(async (...args) => {
      if (args[1].name.startsWith("memory_chat_digest") && !rejected) {
        rejected = true;
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
    expect(original.filter(b => b.state === "FAILED")).toEqual([expect.objectContaining({ errorCode: "memory_classifier_output_invalid" })]);
    f.advance(MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS[0]);
    expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(1);
    await f.drive();
    expect(f.run).toHaveBeenCalledTimes(4);
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
    expect(f.run).toHaveBeenCalledTimes(5);
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
        ...binding, id: randomUUID(), ordinal: 3, state: "OUTCOME_UNKNOWN", acceptedOutputHash: null,
        secretFreeExecutionSnapshot: binding.secretFreeExecutionSnapshot as Prisma.InputJsonValue,
        errorCode: "memory_execution_outcome_unknown", completedAt: f.now()
      } });
    }
    if (fence === "unsettled") await prisma.usageEvent.deleteMany({ where: { userId: f.userId } });
    f.advance(MEMORY_HISTORY_AUTO_HEAL_DELAYS_MS[0]);
    expect(await autoHealIncompleteMemoryHistory(prisma, { limit: 8, now: f.now() })).toBe(0);
    expect(await prisma.memoryJob.count({ where: { userId: f.userId, kind: "INDEX_HISTORY", idempotencyFingerprint: { startsWith: "heal-history:" } } })).toBe(0);
    expect(f.run).toHaveBeenCalledTimes(2);
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

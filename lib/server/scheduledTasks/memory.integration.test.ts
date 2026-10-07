// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { MEMORY_DECAY_POLICY_VERSION } from "../../domain/memory/retrieval";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { providerTemplateIds } from "../../domain/providerTemplates";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { createPrismaMessageBranchRepository } from "../messages/prismaRepository";
import { createPrismaMemoryFactRepository } from "../memory/persistence/facts";
import { memorySha256 } from "../memory/persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../memory/persistence/scopes";
import { withLockedMemoryTransaction } from "../memory/persistence/transaction";
import { touchFrozenMemoryPack } from "../memory/retrieval/decayTouch";
import { requireMemorySearchActiveBranch } from "../memory/search/authority";
import { MemorySuppressionKeyring } from "../memory/suppressionKeyring";
import { prisma } from "../prisma";
import { loadProviderAdmissionPlan } from "../providerRuntime/admission";
import type { NormalizedRunRequest } from "../providers/types";
import { createDefaultSendMessageDeps } from "../runs/defaultSendMessageDeps";
import { createRegenerateModelRunHandler, stopModelRun } from "../runs/handlers";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import type { CreateRunInput, ScheduledOccurrenceAdmission } from "../runs/runRepositoryContract";
import { createPrismaScheduledTaskOwnerLoader, createScheduledTaskSend } from "./admission";
import { createPrismaScheduledTaskRunCatalogLoader } from "./catalog";
import { createPrismaScheduledTaskPinnedSkillLoader } from "./pinnedSkills";
import { createScheduledTaskRunner } from "./runner";
import { createPrismaScheduledTaskRunnerStore } from "./runnerStore";
import { scheduledTaskScheduleColumns } from "./store";

/**
 * Read-only Memory for scheduled task runs, on the disposable database: the
 * ordinary send and regenerate handlers with the fake provider, and run
 * creation itself for the frozen contract.
 */
const users: string[] = [];
const sendDeps = () => ({ ...createDefaultSendMessageDeps(), allowFakeProvider: true });
const FACT = "My preferred editor is Vim.";
const suppressionKeyring = MemorySuppressionKeyring.parse(
  `current=scheduled-memory-v1,scheduled-memory-v1=${Buffer.from(Array.from({ length: 32 }, (_, index) => index + 29)).toString("base64")}`
);

function runner() {
  const deps = sendDeps();
  return createScheduledTaskRunner({
    appBaseUrl: "http://localhost:3000",
    // Due tasks start at once here; the spread has its own tests.
    dispatchOffsetMs: () => 0,
    loadCatalog: createPrismaScheduledTaskRunCatalogLoader(prisma),
    loadPinnedSkills: createPrismaScheduledTaskPinnedSkillLoader(prisma),
    send: createScheduledTaskSend({ loadOwner: createPrismaScheduledTaskOwnerLoader(prisma), sendDeps: deps }),
    stopRun: ({ code, message, runId, userId }) => stopModelRun(deps, { payload: { code, message }, runId, userId }),
    store: createPrismaScheduledTaskRunnerStore(prisma)
  });
}

/** An explicit saved fact, classified so standing context admits it. */
async function saveFact(userId: string): Promise<Readonly<{ factId: string; versionId: string }>> {
  const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
  const saved = await createPrismaMemoryFactRepository(suppressionKeyring, prisma, { consumeExplicitAuthorization: async () => undefined })
    .save(userId, {
      authorization: { action: "SAVE", authorizationId: `scheduled-memory-authorization-${randomUUID()}`, authorizedPayloadHash: "f".repeat(64) },
      evidence: { kind: "EXPLICIT_ACTION", observedAt: new Date("2026-08-10T12:00:00.000Z"), safeExcerpt: FACT,
        safeSourceHash: "a".repeat(64), safetyClass: "NORMAL", sourceProjectionVersion: "scheduled-memory-test-v1" },
      explicitSuppressionOverride: false,
      idempotencyFingerprint: `scheduled-memory-fact-${randomUUID()}`,
      requestId: `scheduled-memory-fact-request-${randomUUID()}`,
      scopeId: scope.id,
      value: { canonicalKey: `profile.preferred_editor.${randomUUID()}`, category: "profile", confidence: 1, directness: "DIRECT",
        displayText: FACT, importance: 0.8, languageCode: "en", modality: "STATE", pipelineVersion: "scheduled-memory-test-v1",
        secretTaintedSourceWindow: false, sensitivityClass: "NORMAL", sourceMode: "EXPLICIT", structuredValue: { value: "Vim" } }
    });
  const executionId = randomUUID();
  const completedAt = new Date("2026-08-10T12:00:01.000Z");
  const startedAt = new Date(completedAt.getTime() - 1);
  await prisma.$transaction(async (tx) => {
    await tx.memoryExecutionBinding.create({ data: {
      acceptedOutputHash: memorySha256({ executionId, output: "NORMAL" }), cachedInputTokens: 0, completedAt, createdAt: startedAt,
      destinationFingerprint: memorySha256({ destination: "scheduled-memory-fixture" }), id: executionId,
      inputHash: memorySha256({ executionId, input: "fixture" }), inputTokens: 0, logicalRole: "MEMORY_STATEMENT_CLASSIFY",
      mutationAuthorizationId: `scheduled-memory-classification-${executionId}`, ordinal: 0, outputTokens: 0,
      ownerType: "MUTATION_AUTHORIZATION", pipelineVersion: "scheduled-memory-test-v1", policyVersion: "memory-statement-safety-policy-v1",
      promptVersion: "scheduled-memory-test-v1", providerId: "scheduled-memory-fixture", reasoningTokens: 0, recoverableUntil: completedAt,
      relationsDetachedAt: completedAt, schemaVersion: "memory-safety-classification-schema-v1",
      secretFreeExecutionSnapshot: { providerExecutionSnapshot: { providerFamily: "scheduled-memory-fixture",
        providerModelId: "scheduled-memory-fixture-model" }, version: 1 },
      startedAt, state: "SUCCEEDED", totalTokens: 0, usageCompleteness: "COMPLETE", userId
    } });
    await tx.usageEvent.create({ data: { cachedInputTokens: 0, inputTokens: 0, memoryExecutionBindingId: executionId,
      modelId: "scheduled-memory-fixture-model", outputTokens: 0, provider: "scheduled-memory-fixture",
      providerModelId: "scheduled-memory-fixture-model", reasoningTokens: 0, totalTokens: 0, userId } });
    await tx.memoryFactVersion.update({ data: {
      safetyClassificationReasonCode: "fixture_normal", safetyClassificationState: "CLASSIFIED", safetyClassifiedAt: completedAt,
      safetyClassifierExecutionId: executionId, safetyClassifierModelId: "scheduled-memory-fixture-model",
      safetyClassifierPolicyVersion: "memory-statement-safety-policy-v1", safetyClassifierProviderId: "scheduled-memory-fixture"
    }, where: { id: saved.versionId } });
  });
  return { factId: saved.factId, versionId: saved.versionId };
}

/** An owner of the fake model with one saved fact, access decay on, and the given Memory settings. */
async function owner(settings: Readonly<{ referenceChatHistory?: boolean; useMemoryFacts?: boolean }> = {}) {
  const userId = `scheduled-memory-${randomUUID()}`;
  users.push(userId);
  await prisma.user.create({ data: { displayName: "Synthetic scheduled Memory owner", email: `${userId}@example.test`, id: userId,
    status: "active" } });
  await prisma.userSettings.create({ data: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
    defaultSearchStrategyId: "search-disabled", userId } });
  await prisma.accessGrant.create({ data: { providerConnectionId: providerTemplateIds.fakeConnection, userId } });
  const fact = await saveFact(userId);
  await prisma.userMemorySettings.update({
    data: { decayEnabled: true, decayPolicyVersion: MEMORY_DECAY_POLICY_VERSION, ...settings }, where: { userId }
  });
  return { fact, userId };
}

async function createTask(userId: string, overrides: Record<string, unknown> = {}) {
  return prisma.scheduledTask.create({ data: {
    ...scheduledTaskScheduleColumns({ kind: "daily", time: "09:00" }), chatMode: "NEW", memoryEnabled: true,
    modelId: providerTemplateIds.fakeModel, nextRunAt: new Date(Date.now() - 1_000), prompt: "Summarize the synthetic fixture",
    provider: providerTemplateIds.fakeConnection, timeZone: "Europe/Moscow", title: "Synthetic brief", userId, ...overrides
  } });
}

/** One tick of a fresh runner: the task's due run, admitted and finished. */
async function runOnce(taskId: string) {
  const scheduler = runner();
  await scheduler.tick();
  await scheduler.idle();
  const occurrence = await prisma.scheduledTaskOccurrence.findFirstOrThrow({ orderBy: { scheduledFor: "desc" }, where: { taskId } });
  expect(occurrence).toMatchObject({ state: "COMPLETED" });
  return prisma.modelRun.findUniqueOrThrow({ where: { id: occurrence.runId! } });
}

/** Everything a task turn could change in Memory: its facts, receipts, learning jobs, history and access signal. */
async function memoryWrites(userId: string, factId: string) {
  return {
    fact: await prisma.memoryFact.findUniqueOrThrow({ select: { lastUsedAt: true, temperatureClass: true, temperatureScore: true },
      where: { id: factId } }),
    facts: await prisma.memoryFact.count({ where: { userId } }),
    learningJobs: await prisma.memoryJob.count({ where: { kind: { in: ["EXTRACT_FACTS", "INDEX_HISTORY", "MEMORY_COMMAND"] }, userId } }),
    receipts: await prisma.memoryOperationReceipt.count({ where: { userId } }),
    chunks: await prisma.memoryRecallChunk.count({ where: { userId } }),
    rounds: await prisma.memoryRecallRound.count({ where: { userId } }),
    toolEvents: await prisma.memoryToolEvent.count({ where: { userId } })
  };
}

/** A Regenerate of `assistantMessageId` by its owner, through the ordinary handler; returns the new run. */
async function regenerate(userId: string, chatId: string, assistantMessageId: string) {
  const user = await prisma.user.findUniqueOrThrow({ select: { displayName: true, email: true, id: true, role: true, status: true },
    where: { id: userId } });
  const session: AuthenticatedSession = { expiresAt: new Date(Date.now() + 60_000), id: "scheduled-memory-test", user, userId };
  const response = await createRegenerateModelRunHandler({ ...sendDeps(), resolveAuth: async () => session })(
    new Request(`http://localhost/api/messages/${assistantMessageId}/regenerate`, { body: JSON.stringify({
      admissionId: randomUUID(), mcp: { mode: "off" }, modelId: providerTemplateIds.fakeModel, provider: providerTemplateIds.fakeConnection,
      searchPlan: { mode: "all_selected", optionIds: [] }, skills: { mode: "off" }, timeZone: "Europe/Moscow", workspace: { enabled: false }
    }), headers: { "content-type": "application/json" }, method: "POST" }), { params: { messageId: assistantMessageId } });
  expect(response.status).toBe(200);
  await response.text();
  const run = await prisma.modelRun.findFirstOrThrow({ orderBy: { createdAt: "desc" }, where: { chatId, userId } });
  expect(run).toMatchObject({ scheduledTaskId: null, status: "complete" });
  return run;
}

function frozen(run: Readonly<{ normalizedRequest: unknown }>): Partial<NormalizedRunRequest> {
  return run.normalizedRequest as Partial<NormalizedRunRequest>;
}

afterEach(async () => {
  for (const userId of users.splice(0)) {
    await prisma.scheduledTask.deleteMany({ where: { userId } });
    await prisma.$transaction(async (tx) => {
      await tx.memoryDeletionOutbox.updateMany({ data: { leaseExpiresAt: new Date(Date.now() + 60_000),
        leaseToken: "scheduled-memory-test-cleanup", nextAttemptAt: null, state: "RUNNING" }, where: { operation: "TEMPORARY_DELETE", userId } });
      await tx.memoryFeedback.deleteMany({ where: { userId } });
      await tx.memorySuppression.deleteMany({ where: { userId } });
      await tx.memoryRetrievalAttemptItem.deleteMany({ where: { recallChunkId: { not: null }, userId } });
      await tx.memoryRecallChunk.deleteMany({ where: { userId } });
      await tx.usageEvent.deleteMany({ where: { userId } });
      await tx.memoryScope.updateMany({ data: { assistantId: null, chatId: null, folderId: null, orphanedAt: new Date(), state: "ORPHANED" },
        where: { scopeType: { in: ["ASSISTANT", "CHAT", "FOLDER"] }, userId } });
      await tx.memoryOperationReceipt.deleteMany({ where: { userId } });
      await tx.memoryMutationAuthorization.deleteMany({ where: { userId } });
      await tx.chatMemoryCheckpointMessage.deleteMany({ where: { userId } });
      await tx.memoryJob.deleteMany({ where: { userId } });
      await tx.chat.deleteMany({ where: { userId } });
      await tx.memoryDeletionOutbox.deleteMany({ where: { userId } });
      await tx.user.deleteMany({ where: { id: userId } });
    });
  }
});
afterAll(() => prisma.$disconnect());

describe("scheduled task Memory", () => {
  it("reads the owner's standing facts in its excluded chat while the task has Memory on, and changes nothing", async () => {
    const { fact, userId } = await owner();
    const task = await createTask(userId);
    const before = await memoryWrites(userId, fact.factId);
    const run = await runOnce(task.id);
    expect(await prisma.chat.findUniqueOrThrow({ where: { id: run.chatId } })).toMatchObject({ memoryMode: "EXCLUDED", userId });
    // Standing context and, for the tool-calling fake model, Memory search: frozen with the run.
    expect(frozen(run)).toMatchObject({
      memorySearch: { referenceChatHistory: true, version: "memory-search-v1" },
      memoryStandingVersion: 1,
      personalContext: { itemCount: 1, mode: "standing-v1", text: expect.stringContaining(FACT) }
    });
    const binding = await prisma.modelRunMemoryBinding.findUniqueOrThrow({ where: { modelRunId: run.id } });
    expect(binding.outcome).toBe("USED");
    const items = await prisma.modelRunMemoryItem.findMany({ where: { bindingId: binding.id } });
    expect(items).toMatchObject([{ decayTouchedAt: null, factVersionId: fact.versionId, selectionReason: "standing.explicit" }]);
    // Read-only: no access touch, even for a standing fact a search also matched (an access signal on an
    // ordinary turn), and no learning job, history or Memory write from the task's turn.
    await prisma.modelRunMemoryItem.update({ data: { featureSnapshot: {
      ...(items[0]!.featureSnapshot as Prisma.JsonObject), standingFactSearchMatched: true } }, where: { id: items[0]!.id } });
    await expect(touchFrozenMemoryPack(prisma, { bindingId: binding.id, userId })).resolves.toEqual({ eligibleItems: 0, touchedItems: 0 });
    expect(await memoryWrites(userId, fact.factId)).toEqual(before);
    expect(await prisma.memoryJob.count({ where: { chatId: run.chatId, userId } })).toBe(0);
    expect(before.fact.lastUsedAt).toBeNull();
  });

  it("reads nothing with the switch off or Memory paused, and still reads facts with history off", async () => {
    const off = await owner();
    const offRun = await runOnce((await createTask(off.userId, { memoryEnabled: false })).id);
    expect(frozen(offRun).memoryStandingVersion).toBeUndefined();
    expect(frozen(offRun).memorySearch).toBeUndefined();
    expect(frozen(offRun).personalContext).toBeUndefined();
    expect(await prisma.modelRunMemoryBinding.count({ where: { modelRunId: offRun.id } })).toBe(0);
    expect(await prisma.memoryRetrievalAttempt.count({ where: { modelRunId: offRun.id } })).toBe(0);

    // The owner's master switch decides what any task may read.
    const paused = await owner({ useMemoryFacts: false });
    const pausedRun = await runOnce((await createTask(paused.userId)).id);
    expect(frozen(pausedRun).memorySearch).toBeUndefined();
    expect(frozen(pausedRun).personalContext).toBeUndefined();
    expect(await prisma.modelRunMemoryBinding.findUniqueOrThrow({ where: { modelRunId: pausedRun.id } }))
      .toMatchObject({ contextTokenCount: 0, outcome: "DISABLED" });

    const factsOnly = await owner({ referenceChatHistory: false });
    const factsRun = await runOnce((await createTask(factsOnly.userId)).id);
    expect(frozen(factsRun)).toMatchObject({ memorySearch: { referenceChatHistory: false },
      personalContext: { text: expect.stringContaining(FACT) } });
  });

  it("answers a prompt that reads as a Memory command as text and writes nothing", async () => {
    const { fact, userId } = await owner();
    const prompt = "/memory remember that my favourite colour is teal";
    const task = await createTask(userId, { prompt });
    const before = await memoryWrites(userId, fact.factId);
    const run = await runOnce(task.id);
    expect(frozen(run)).toMatchObject({ memoryStandingVersion: 1, personalContext: { text: expect.stringContaining(FACT) } });
    const answer = await prisma.message.findUniqueOrThrow({ where: { id: run.assistantMessageId! } });
    expect(textFromContentBlocks(answer.content as { blocks?: unknown[] })).toContain(`Fake answer: ${prompt}`);
    expect(await memoryWrites(userId, fact.factId)).toEqual(before);
    expect(await prisma.memoryFact.count({ where: { userId } })).toBe(1);
  });

  it("lets a Regenerate follow the task's current switch, and read nothing once the task is gone or in a branch copy", async () => {
    const { fact, userId } = await owner();
    const task = await createTask(userId, { chatMode: "SAME" });
    const first = await runOnce(task.id);
    const before = await memoryWrites(userId, fact.factId);
    const reads = (run: Readonly<{ normalizedRequest: unknown }>) => frozen(run).personalContext?.text.includes(FACT) === true;

    const on = await regenerate(userId, first.chatId, first.assistantMessageId!);
    expect(on.userMessageId).toBe(first.userMessageId);
    expect(reads(on)).toBe(true);
    expect(frozen(on).memoryStandingVersion).toBe(1);
    await prisma.scheduledTask.update({ data: { memoryEnabled: false }, where: { id: task.id } });
    const off = await regenerate(userId, first.chatId, on.assistantMessageId!);
    expect(frozen(off).memoryStandingVersion).toBeUndefined();
    expect(reads(off)).toBe(false);
    expect(await prisma.modelRunMemoryBinding.count({ where: { modelRunId: off.id } })).toBe(0);
    await prisma.scheduledTask.update({ data: { memoryEnabled: true }, where: { id: task.id } });
    const again = await regenerate(userId, first.chatId, off.assistantMessageId!);
    expect(reads(again)).toBe(true);

    // A branch copy carries the prompt's mark but no run that names the task.
    const branched = await createPrismaMessageBranchRepository(prisma).createChatBranchFromMessage({
      sourceMessageId: again.assistantMessageId!, userId });
    if (!branched?.activeLeafMessageId) throw new Error("scheduled_memory_test_branch_missing");
    const copied = await prisma.message.findFirstOrThrow({ where: { chatId: branched.id, role: "user" } });
    expect(copied.scheduledTaskPrompt).toBe(true);
    const inCopy = await regenerate(userId, branched.id, branched.activeLeafMessageId);
    expect(reads(inCopy)).toBe(false);
    expect(frozen(inCopy).memoryStandingVersion).toBeUndefined();

    // The task is deleted: its chat stays, and its turns read nothing.
    await prisma.scheduledTask.delete({ where: { id: task.id } });
    const gone = await regenerate(userId, first.chatId, again.assistantMessageId!);
    expect(reads(gone)).toBe(false);
    expect(frozen(gone).memoryStandingVersion).toBeUndefined();
    expect(await memoryWrites(userId, fact.factId)).toEqual(before);
  });

  it("keeps an accepted run's frozen Memory contract and its search authority to its own excluded chat", async () => {
    const { fact, userId } = await owner();
    const runs = createPrismaRunRepository(prisma);
    const task = await createTask(userId, { chatMode: "SAME", nextRunAt: null, status: "PAUSED" });
    const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, memoryMode: "EXCLUDED",
      title: "Synthetic brief", userId } });
    const occurrence = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(), startedAt: new Date(),
      taskId: task.id, trigger: "manual", userId } });
    const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
    const input = async (scheduledOccurrence?: ScheduledOccurrenceAdmission): Promise<CreateRunInput> => {
      const content = textMessageContent("Summarize the synthetic fixture");
      const leaf = await prisma.chat.findUniqueOrThrow({ select: { activeLeafMessageId: true }, where: { id: chat.id } });
      const request: NormalizedRunRequest = {
        attachmentIds: [], chatId: chat.id, content,
        context: { messages: [{ content, id: "current-user-message", role: "user" }], mode: "branch_path" },
        knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
        memorySearch: { comparisonResultTokens: 12000, destinations: [], maxCalls: 3, memoryGeneration: settings.memoryGeneration,
          referenceChatHistory: true, resultTokens: 6000, timeoutSeconds: 30, version: "memory-search-v1" },
        memoryStandingVersion: 1,
        modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, toolCalling: true, vision: false },
        modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
        searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto"
      };
      return {
        chatId: chat.id, content, expectedActiveLeafId: leaf.activeLeafMessageId, modelId: "fake-qsa", provider: "fake",
        memoryMaterializer(personalContext, memoryActionAnswerResult) {
          const normalizedRequest: NormalizedRunRequest = { ...request, ...(personalContext ? { personalContext } : {}),
            prompt: { ...request.prompt, ...(memoryActionAnswerResult ? { memoryActionAnswerResult } : {}) } };
          return { contextTruncation: null, normalizedRequest, providerRequest: { ...normalizedRequest, attachments: [] },
            providerRequestPreview: {} };
        },
        normalizedRequest: request,
        providerAdmissionPlan: await loadProviderAdmissionPlan(prisma, { providerConnectionId: providerTemplateIds.fakeConnection,
          providerModelId: providerTemplateIds.fakeModel, searchPlan: { mode: "all_selected", optionIds: [] }, userId }),
        providerRequestPreview: {},
        ...(scheduledOccurrence ? { scheduledOccurrence } : {}),
        userId
      };
    };
    const searchAuthority = (runId: string) =>
      withLockedMemoryTransaction(prisma, userId, (tx) => requireMemorySearchActiveBranch(tx, userId, runId));

    // The task's own run reads standing facts in its excluded chat.
    const accepted = await runs.createRun(await input({ memory: true, occurrenceId: occurrence.id, previousResult: null,
      relevantMcpServerIds: null, taskGeneration: task.generation, taskId: task.id, taskRevision: task.revision }));
    expect(accepted.materializedRequest?.normalizedRequest.personalContext?.text).toContain(FACT);
    const stored = await prisma.modelRun.findUniqueOrThrow({ where: { id: accepted.runId } });
    expect(stored).toMatchObject({ scheduledTaskId: task.id, status: "streaming" });
    expect(frozen(stored)).toMatchObject({ memoryStandingVersion: 1, personalContext: { text: expect.stringContaining(FACT) } });
    await expect(searchAuthority(accepted.runId)).resolves.toBeUndefined();

    // Turning the switch off or deleting the task changes only future runs: the accepted run keeps its contract.
    await prisma.scheduledTask.update({ data: { memoryEnabled: false }, where: { id: task.id } });
    await prisma.scheduledTask.delete({ where: { id: task.id } });
    await expect(searchAuthority(accepted.runId)).resolves.toBeUndefined();
    await expect(runs.recoverPreparingRun({ now: new Date(), runId: accepted.runId, userId })).resolves.toBe("finalized");
    expect(frozen(await prisma.modelRun.findUniqueOrThrow({ where: { id: accepted.runId } })).personalContext?.text).toContain(FACT);
    await expect(touchFrozenMemoryPack(prisma, { modelRunId: accepted.runId, userId }))
      .resolves.toEqual({ eligibleItems: 0, touchedItems: 0 });
    expect((await prisma.memoryFact.findUniqueOrThrow({ where: { id: fact.factId } })).lastUsedAt).toBeNull();
    await runs.cancelRun({ payload: { code: "model_run_cancelled", message: "Model run cancelled" }, runId: accepted.runId, userId });

    // The owner's own turn in the excluded task chat keeps the excluded behavior: no read and no search authority.
    const own = await runs.createRun(await input());
    expect(own.materializedRequest?.normalizedRequest.personalContext).toBeUndefined();
    expect(await prisma.modelRunMemoryBinding.findUniqueOrThrow({ where: { modelRunId: own.runId } }))
      .toMatchObject({ outcome: "DISABLED" });
    await expect(searchAuthority(own.runId)).rejects.toThrow("memory_search_authority_changed");
    await runs.cancelRun({ payload: { code: "model_run_cancelled", message: "Model run cancelled" }, runId: own.runId, userId });
  });
});

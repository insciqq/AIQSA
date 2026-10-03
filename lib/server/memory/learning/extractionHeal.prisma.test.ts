import { randomUUID } from "node:crypto";
import type { MemoryJob, MemoryUtilityAssignmentSource } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestProviderExecutionAuthority, deleteTestProviderExecutionAuthority,
  type TestProviderExecutionAuthority } from "@/tests/support/providerExecutionAuthority";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { MemoryCoordinator } from "../coordinator/coordinator";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import { MemoryCoordinatorRegistry } from "../coordinator/registry";
import type { MemoryReportedUsage } from "../execution";
import { withLockedMemoryTransaction, type MemoryTransaction } from "../persistence/transaction";
import { defaultMemorySourceMutationHooks } from "../sourceHooks";
import { applyMemorySourceMutations, lockMemorySourceChat } from "../sourceState";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import { memoryFactExtractionHealJobFingerprint } from "./extraction/contract";
import { createMemoryFactExtractionHandler, type MemoryFactExtractionHandlerDependencies } from "./extraction/handler";
import { MEMORY_FACT_EXTRACTION_TOOL_NAME } from "./extraction/prompt";
import { createPrismaMemoryFactExtractionRepository } from "./extraction/repository";
import { MemoryFactProviderCallError, type MemoryFactProvider } from "./extraction/runtime";
import { healFailedMemoryFactExtractions, MEMORY_FACT_EXTRACTION_HEAL_OWNER_LIMIT,
  MEMORY_FACT_EXTRACTION_HEAL_SAME_POLICY_DELAY_MS } from "./extractionHeal";

const keyring = MemorySuppressionKeyring.parse(
  `current=facts-v1,facts-v1=${Buffer.from(Array.from({ length: 32 }, (_, index) => index + 41)).toString("base64")}`
);
const HOUR = 60 * 60_000;
let authority: TestProviderExecutionAuthority;
let priorPolicy: { assignmentSource: MemoryUtilityAssignmentSource; providerModelId: string | null;
  reasoningEffort: string | null; updatedAt: Date; version: number } | null;
const owners = new Set<string>();

beforeAll(async () => {
  authority = await createTestProviderExecutionAuthority(prisma, "extraction-heal");
  priorPolicy = await prisma.memoryUtilityModelPolicy.findUnique({ where: { id: "installation" },
    select: { assignmentSource: true, providerModelId: true, reasoningEffort: true, updatedAt: true, version: true } });
  await prisma.memoryUtilityModelPolicy.upsert({ where: { id: "installation" },
    create: { id: "installation", providerModelId: authority.providerModelId, assignmentSource: "OPERATOR" },
    update: { providerModelId: authority.providerModelId, assignmentSource: "OPERATOR", version: { increment: 1 } } });
});

afterEach(async () => {
  for (const userId of owners) {
    await prisma.usageEvent.deleteMany({ where: { userId } });
    await prisma.memoryExecutionBinding.deleteMany({ where: { userId } });
    await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
  owners.clear();
});

afterAll(async () => {
  if (priorPolicy) await prisma.memoryUtilityModelPolicy.update({ where: { id: "installation" }, data: priorPolicy });
  else await prisma.memoryUtilityModelPolicy.deleteMany({ where: { id: "installation", providerModelId: authority.providerModelId } });
  await deleteTestProviderExecutionAuthority(prisma, authority);
  await prisma.$disconnect();
});

const policyVersion = async () =>
  (await prisma.memoryUtilityModelPolicy.findUniqueOrThrow({ where: { id: "installation" } })).version;
const changePolicy = () => prisma.memoryUtilityModelPolicy.update({ where: { id: "installation" },
  data: { version: { increment: 1 } } });

type Settlement = Readonly<{ acceptedOutputHash: string | null; errorCode: string | null;
  providerResponseId: string | null; state: "FAILED" | "OUTCOME_UNKNOWN" | "SUCCEEDED"; usage: MemoryReportedUsage }>;

/** Real binding and usage rows that freeze the current Memory-role policy
 * revision as governed admission does; the provider and its authority are fake. */
function execution(): MemoryFactExtractionHandlerDependencies["execution"] {
  const settle = async (tx: MemoryTransaction, userId: string, bindingId: string, result: Settlement,
    recoverableUntil: Date) => {
    const binding = await tx.memoryExecutionBinding.findUniqueOrThrow({ where: { id: bindingId } });
    if (binding.state !== "RUNNING") throw new Error("memory_execution_state_conflict");
    await tx.memoryExecutionBinding.update({ where: { id: bindingId }, data: {
      acceptedOutputHash: result.acceptedOutputHash, cachedInputTokens: result.usage.cachedInputTokens,
      completedAt: new Date(Math.max(Date.now(), binding.startedAt!.getTime())), errorCode: result.errorCode,
      estimatedCostMicros: result.usage.estimatedCostMicros, inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens, providerResponseId: result.providerResponseId,
      reasoningTokens: result.usage.reasoningTokens, recoverableUntil, state: result.state,
      totalTokens: result.usage.totalTokens, usageCompleteness: result.usage.completeness
    } });
    await tx.usageEvent.create({ data: { cachedInputTokens: result.usage.cachedInputTokens,
      estimatedCostMicros: result.usage.estimatedCostMicros, inputTokens: result.usage.inputTokens,
      memoryExecutionBindingId: bindingId, modelId: "extraction-heal-model", outputTokens: result.usage.outputTokens,
      provider: "openai_compatible", providerModelId: authority.providerModelId,
      reasoningTokens: result.usage.reasoningTokens, totalTokens: result.usage.totalTokens,
      usageCompleteness: result.usage.completeness, userId } });
    return { state: result.state };
  };
  return {
    admission: {
      async bind(userId: string, request: Readonly<{ inputHash: string; ordinal: number;
        owner: Readonly<{ memoryJobId: string }>; versions: Readonly<{ pipelineVersion: string;
          policyVersion: string; promptVersion: string; schemaVersion: string }> }>) {
        const binding = await prisma.memoryExecutionBinding.create({ data: {
          connectionId: authority.connectionId, createdAt: new Date(Date.now() - 1_000),
          credentialId: authority.credentialId, credentialVersionId: authority.credentialVersionId,
          destinationFingerprint: "d".repeat(64), inputHash: request.inputHash, logicalRole: "MEMORY_FACT_EXTRACT",
          memoryJobId: request.owner.memoryJobId, ordinal: request.ordinal, ownerType: "JOB",
          pipelineVersion: request.versions.pipelineVersion, policyVersion: request.versions.policyVersion,
          promptVersion: request.versions.promptVersion, providerId: "openai_compatible",
          providerModelId: authority.providerModelId, schemaVersion: request.versions.schemaVersion,
          secretFreeExecutionSnapshot: { policyRevision: await policyVersion() }, userId
        } });
        return { id: binding.id };
      },
      async start(userId: string, bindingId: string) {
        const started = await prisma.memoryExecutionBinding.updateMany({
          data: { startedAt: new Date(), state: "RUNNING" }, where: { id: bindingId, state: "PENDING", userId } });
        if (started.count !== 1) throw new Error("memory_execution_state_conflict");
        return { bindingId, snapshot: { logicalRole: "MEMORY_FACT_EXTRACT", requiresStrictStructuredOutput: true,
          providerExecutionSnapshot: { connectionId: authority.connectionId, credentialId: authority.credentialId,
            credentialVersionId: authority.credentialVersionId, providerModelId: authority.providerModelId } } };
      }
    },
    lifecycle: {
      settle: (userId: string, bindingId: string, result: Settlement) =>
        withLockedMemoryTransaction(prisma, userId, (tx) => settle(tx, userId, bindingId, result,
          new Date(Date.now() + 86_400_000))),
      settleSucceededWithDurableResult: (userId: string, bindingId: string, result: Settlement,
        persist: (tx: MemoryTransaction, evidence: Readonly<{ recoverableUntil: Date }>) => Promise<void>) => {
        const recoverableUntil = new Date(Date.now() + 86_400_000);
        return withLockedMemoryTransaction(prisma, userId, async (tx) => {
          await persist(tx, { recoverableUntil });
          return settle(tx, userId, bindingId, result, recoverableUntil);
        });
      },
      withAuthorizedResultCommit: <T>(userId: string, _result: unknown,
        commit: (tx: MemoryTransaction, evidence: Readonly<{ settings: unknown }>) => Promise<T>) =>
        withLockedMemoryTransaction(prisma, userId, (tx, settings) => commit(tx, { settings }))
    }
  } as unknown as MemoryFactExtractionHandlerDependencies["execution"];
}

const failing = (classification: "PERMANENT" | "REPLAY_SAFE_TRANSIENT"): MemoryFactProvider => ({
  run: async () => { throw new MemoryFactProviderCallError({ cause: new Error("synthetic outage"), classification, usage: null }); }
});
const answering = () => ({ run: vi.fn<MemoryFactProvider["run"]>(async () => ({ providerResponseId: "heal-response",
  toolCalls: [{ arguments: { observations: [] }, id: `heal-call-${randomUUID()}`, name: MEMORY_FACT_EXTRACTION_TOOL_NAME }],
  usage: { cachedInputTokens: 0, inputTokens: 40, outputTokens: 4, reasoningTokens: 0, totalTokens: 44 } })) });

async function settle(userId: string, chatId: string, mutation: "NORMAL_APPEND" | "TERMINAL_SETTLEMENT",
  turn: Readonly<{ assistantId: string; runId: string }>) {
  await prisma.$transaction(async (tx) => {
    const chat = await lockMemorySourceChat(tx, { chatId, lock: "UPDATE", userId });
    if (!chat) throw new Error("extraction_heal_fixture_chat_missing");
    await applyMemorySourceMutations(tx, { chat, hooks: defaultMemorySourceMutationHooks, mutations: [mutation],
      ...(mutation === "NORMAL_APPEND" ? { patch: { activeLeafMessageId: turn.assistantId } }
        : { terminalSettlement: { assistantMessageId: turn.assistantId, runId: turn.runId, status: "complete" as const } }) });
  });
}

/** One settled direct user turn per text, each admitted for automatic extraction. */
async function fixture(texts: readonly string[] = ["I moved to Lisbon last spring."]) {
  const userId = `extraction-heal-${randomUUID()}`;
  owners.add(userId);
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, displayName: "Extraction heal fixture", status: "active" } });
  await prisma.userMemorySettings.update({ where: { userId }, data: { learnAutomatically: true, referenceChatHistory: false } });
  const chat = await prisma.chat.create({ data: { userId, title: "Synthetic extraction heal" } });
  let parentMessageId: string | null = null;
  const turns: Array<{ userMessageId: string; assistantId: string; runId: string; createdAt: Date }> = [];
  for (const [index, text] of texts.entries()) {
    const createdAt = new Date(Date.now() - (texts.length - index) * 60_000);
    const user = await prisma.message.create({ data: { chatId: chat.id, role: "user", status: "complete",
      parentMessageId, content: textMessageContent(text), createdAt, updatedAt: createdAt } });
    const assistant = await prisma.message.create({ data: { chatId: chat.id, role: "assistant", status: "complete",
      parentMessageId: user.id, content: textMessageContent("Noted."), createdAt, updatedAt: createdAt } });
    const run = await prisma.modelRun.create({ data: { assistantMessageId: assistant.id, chatId: chat.id,
      modelId: "extraction-heal-model", provider: "extraction-heal-provider", status: "complete", userId,
      userMessageId: user.id, normalizedRequest: { prompt: { baseline: { source: "standard_chat", timeZone: "UTC",
        timeZoneSource: "client" } } } } });
    const turn = { assistantId: assistant.id, runId: run.id };
    await settle(userId, chat.id, "NORMAL_APPEND", turn);
    await settle(userId, chat.id, "TERMINAL_SETTLEMENT", turn);
    turns.push({ userMessageId: user.id, createdAt, ...turn });
    parentMessageId = assistant.id;
  }
  let clock = Date.now() + 1_000;
  const now = () => new Date(clock);
  const drive = async (provider: MemoryFactProvider) => {
    const registry = new MemoryCoordinatorRegistry();
    registry.registerJob(createMemoryFactExtractionHandler({ execution: execution(), now, provider,
      probeAuthority: async () => undefined,
      repository: createPrismaMemoryFactExtractionRepository(prisma, { keyring: () => keyring }) }));
    const worker = new MemoryCoordinator({ now, registry, repository: createPrismaMemoryCoordinatorRepository(prisma),
      policy: { maxJobParallel: 1, maxJobParallelPerUser: 1, maxDeletionParallel: 1 } });
    try { await worker.reconcileNow(); } finally { await worker.stop(); }
  };
  const heal = (offsetMs = 0, available = true) => healFailedMemoryFactExtractions(prisma,
    { now: new Date(clock + offsetMs), authorityAvailable: async () => available });
  const jobs = () => prisma.memoryJob.findMany({ where: { userId, kind: "EXTRACT_FACTS" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const bindings = (memoryJobId: string) => prisma.memoryExecutionBinding.findMany({ where: { userId, memoryJobId },
    orderBy: { ordinal: "asc" } });
  return { userId, chat, turns, now, drive, heal, jobs, bindings, advance: (ms: number) => { clock += ms; } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function failPermanently(f: Fixture): Promise<MemoryJob> {
  await f.drive(failing("PERMANENT"));
  const [failed] = await f.jobs();
  expect(failed).toMatchObject({ state: "SUCCEEDED", stage: "fact_provider_unavailable" });
  expect(await f.bindings(failed!.id)).toEqual([expect.objectContaining({ state: "FAILED",
    errorCode: "memory_fact_provider_unavailable", secretFreeExecutionSnapshot: { policyRevision: await policyVersion() } })]);
  return failed!;
}

const healKeyOf = (job: MemoryJob) => job.idempotencyFingerprint.replace(/:[a-f0-9]{64}$/u, "");

describe("re-extraction after a provider failure that produced no output", () => {
  it("retries a failure under the current Memory-role policy once after six hours and never again under it", async () => {
    const f = await fixture();
    const failed = await failPermanently(f);
    const policy = await policyVersion();
    const before = { job: failed, bindings: await f.bindings(failed.id) };
    expect(await f.heal()).toBe(0);
    expect(await f.heal(MEMORY_FACT_EXTRACTION_HEAL_SAME_POLICY_DELAY_MS - 60_000)).toBe(0);
    expect(await f.jobs()).toHaveLength(1);

    expect(await f.heal(MEMORY_FACT_EXTRACTION_HEAL_SAME_POLICY_DELAY_MS + 60_000)).toBe(1);
    const [, retry] = await f.jobs();
    expect(healKeyOf(retry!)).toBe(`extract-facts:vnext:heal.u${policy}.same-policy`);
    // A new job of the exact failed source snapshot, never a revival.
    expect(retry).toMatchObject({ state: "QUEUED", pipelineVersion: failed.pipelineVersion,
      chatId: failed.chatId, sourceMessageId: failed.sourceMessageId, activeLeafMessageId: failed.activeLeafMessageId,
      branchGeneration: failed.branchGeneration, sourceRevision: failed.sourceRevision, sourceHash: failed.sourceHash,
      memoryGenerationSnapshot: failed.memoryGenerationSnapshot });
    expect(await f.heal(MEMORY_FACT_EXTRACTION_HEAL_SAME_POLICY_DELAY_MS + 60_000)).toBe(0);

    f.advance(MEMORY_FACT_EXTRACTION_HEAL_SAME_POLICY_DELAY_MS + 60_000);
    await f.drive(failing("PERMANENT"));
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: retry!.id } }))
      .toMatchObject({ state: "SUCCEEDED", stage: "fact_provider_unavailable" });
    for (const offset of [0, MEMORY_FACT_EXTRACTION_HEAL_SAME_POLICY_DELAY_MS + 60_000, 30 * 24 * HOUR]) {
      expect(await f.heal(offset)).toBe(0);
    }
    expect(await f.jobs()).toHaveLength(2);
    expect({ job: await prisma.memoryJob.findUniqueOrThrow({ where: { id: failed.id } }),
      bindings: await f.bindings(failed.id) }).toEqual(before);
  });

  it("re-admits right away and exactly once after a Memory-role policy change, then extracts the source", async () => {
    const f = await fixture();
    const failed = await failPermanently(f);
    const usage = await prisma.usageEvent.findMany({ where: { userId: f.userId }, orderBy: { id: "asc" } });
    await changePolicy();
    const policy = await policyVersion();
    const admissions = await Promise.all([f.heal(), f.heal()]);
    expect(admissions.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await f.heal()).toBe(0);
    const [, healJob] = await f.jobs();
    expect(healKeyOf(healJob!)).toBe(`extract-facts:vnext:heal.u${policy}`);
    expect(healJob!.idempotencyFingerprint).toBe(memoryFactExtractionHealJobFingerprint({
      activeLeafMessageId: failed.activeLeafMessageId!, branchGeneration: failed.branchGeneration!, chatId: failed.chatId!,
      memoryGenerationSnapshot: failed.memoryGenerationSnapshot, sourceHash: failed.sourceHash!,
      sourceMessageId: failed.sourceMessageId!, sourceRevision: failed.sourceRevision!, userId: f.userId
    }, "UNICODE_V2", { samePolicy: false, utilityPolicyVersion: policy }));

    const provider = answering();
    await f.drive(provider);
    expect(provider.run).toHaveBeenCalledTimes(1);
    expect(provider.run.mock.calls[0]![1].source.sourceMessageId).toBe(failed.sourceMessageId);
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: healJob!.id } }))
      .toMatchObject({ state: "SUCCEEDED", stage: "fact_observations_empty" });
    expect(await f.bindings(healJob!.id)).toEqual([expect.objectContaining({ ordinal: 0, state: "SUCCEEDED",
      secretFreeExecutionSnapshot: { policyRevision: policy } })]);
    // The failed job, its call and its usage stay exactly as settled.
    expect(await prisma.memoryJob.findUniqueOrThrow({ where: { id: failed.id } })).toEqual(failed);
    expect(await prisma.usageEvent.findMany({ where: { id: { in: usage.map(({ id }) => id) } }, orderBy: { id: "asc" } }))
      .toEqual(usage);
    for (const offset of [0, 30 * 24 * HOUR]) expect(await f.heal(offset)).toBe(0);
    await changePolicy();
    expect(await f.heal()).toBe(0);
    expect(await f.jobs()).toHaveLength(2);
  });

  it("retries exhausted transient failures once after six hours", async () => {
    const f = await fixture();
    await f.drive(failing("REPLAY_SAFE_TRANSIENT"));
    f.advance(10_000);
    await f.drive(failing("REPLAY_SAFE_TRANSIENT"));
    const [failed] = await f.jobs();
    expect(failed).toMatchObject({ state: "TERMINAL_FAILED", errorCode: "memory_fact_provider_transient", stage: "provider_call" });
    expect((await f.bindings(failed!.id)).map(({ state, errorCode }) => ({ state, errorCode })))
      .toEqual([0, 1].map(() => ({ state: "FAILED", errorCode: "memory_fact_provider_transient" })));
    expect(await f.heal(HOUR)).toBe(0);
    expect(await f.heal(MEMORY_FACT_EXTRACTION_HEAL_SAME_POLICY_DELAY_MS + 60_000)).toBe(1);
    const [, retry] = await f.jobs();
    expect(healKeyOf(retry!)).toBe(`extract-facts:vnext:heal.u${await policyVersion()}.same-policy`);
  });

  it.each(["OUTCOME_UNKNOWN", "RUNNING", "unaccounted"] as const)(
    "never re-admits an exhausted transient failure with a %s call", async (ambiguity) => {
      const f = await fixture();
      await f.drive(failing("REPLAY_SAFE_TRANSIENT"));
      f.advance(10_000);
      await f.drive(failing("REPLAY_SAFE_TRANSIENT"));
      const [failed] = await f.jobs();
      const [binding] = await f.bindings(failed!.id);
      if (ambiguity === "unaccounted") {
        await prisma.usageEvent.deleteMany({ where: { memoryExecutionBindingId: binding!.id } });
      } else {
        await prisma.memoryExecutionBinding.create({ data: { ...binding!, id: randomUUID(), ordinal: 9,
          state: ambiguity, acceptedOutputHash: null, providerResponseId: null,
          secretFreeExecutionSnapshot: { policyRevision: await policyVersion() },
          ...(ambiguity === "RUNNING"
            ? { completedAt: null, errorCode: null, recoverableUntil: null, usageCompleteness: "UNAVAILABLE",
              inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, totalTokens: null }
            : { errorCode: "memory_fact_provider_outcome_unknown" }) } });
      }
      expect(await f.heal(MEMORY_FACT_EXTRACTION_HEAL_SAME_POLICY_DELAY_MS + 60_000)).toBe(0);
      await changePolicy();
      expect(await f.heal(MEMORY_FACT_EXTRACTION_HEAL_SAME_POLICY_DELAY_MS + 60_000)).toBe(0);
      expect(await f.jobs()).toHaveLength(1);
    });

  it.each(["generation", "excluded", "edited", "resumed", "learning_off", "inactive", "newer_attempt", "model_unavailable"] as const)(
    "refuses re-extraction across the %s fence", async (fence) => {
      const f = await fixture();
      const failed = await failPermanently(f);
      await changePolicy();
      const turn = f.turns[0]!;
      if (fence === "generation") {
        await prisma.userMemorySettings.update({ where: { userId: f.userId }, data: { memoryGeneration: { increment: 1 } } });
      }
      if (fence === "excluded") await prisma.$transaction(async (tx) => {
        const chat = await lockMemorySourceChat(tx, { userId: f.userId, chatId: f.chat.id, lock: "UPDATE" });
        await applyMemorySourceMutations(tx, { chat: chat!, hooks: defaultMemorySourceMutationHooks,
          mutations: ["SOURCE_EXCLUDE"], patch: { memoryMode: "EXCLUDED" } });
      });
      if (fence === "edited") {
        // An edit branches the DAG: the new active path no longer holds the source.
        const at = new Date();
        const edited = await prisma.message.create({ data: { chatId: f.chat.id, role: "user", status: "complete",
          content: textMessageContent("I moved to Porto last spring."), createdAt: at, updatedAt: at } });
        const reply = await prisma.message.create({ data: { chatId: f.chat.id, role: "assistant", status: "complete",
          parentMessageId: edited.id, content: textMessageContent("Noted."), createdAt: at, updatedAt: at } });
        await prisma.$transaction(async (tx) => {
          const chat = await lockMemorySourceChat(tx, { userId: f.userId, chatId: f.chat.id, lock: "UPDATE" });
          await applyMemorySourceMutations(tx, { chat: chat!, hooks: defaultMemorySourceMutationHooks,
            mutations: ["BRANCH_PATH_CHANGE"], patch: { activeLeafMessageId: reply.id } });
        });
      }
      if (fence === "resumed") {
        await prisma.memoryPauseInterval.create({ data: { userId: f.userId, scope: "AUTOMATIC_LEARNING",
          memoryGeneration: failed.memoryGenerationSnapshot, pausedAt: new Date(turn.createdAt.getTime() + 1_000),
          resumedAt: new Date(turn.createdAt.getTime() + 2_000) } });
      }
      if (fence === "learning_off") {
        await prisma.userMemorySettings.update({ where: { userId: f.userId }, data: { learnAutomatically: false } });
      }
      if (fence === "inactive") await prisma.user.update({ where: { id: f.userId }, data: { status: "disabled" } });
      if (fence === "newer_attempt") {
        await prisma.memoryJob.create({ data: { userId: f.userId, kind: "EXTRACT_FACTS", state: "CANCELLED",
          pipelineVersion: failed.pipelineVersion, memoryGenerationSnapshot: failed.memoryGenerationSnapshot,
          memoryRevisionSnapshot: failed.memoryRevisionSnapshot, chatId: failed.chatId, sourceMessageId: failed.sourceMessageId,
          activeLeafMessageId: failed.activeLeafMessageId, branchGeneration: failed.branchGeneration,
          sourceRevision: failed.sourceRevision, sourceHash: failed.sourceHash, completedAt: new Date(),
          errorCode: "memory_fact_source_command_excluded", idempotencyFingerprint: memoryFactExtractionHealJobFingerprint({
            activeLeafMessageId: failed.activeLeafMessageId!, branchGeneration: failed.branchGeneration!, chatId: failed.chatId!,
            memoryGenerationSnapshot: failed.memoryGenerationSnapshot, sourceHash: failed.sourceHash!,
            sourceMessageId: failed.sourceMessageId!, sourceRevision: failed.sourceRevision!, userId: f.userId
          }, "UNICODE_V2", { samePolicy: true, utilityPolicyVersion: (await policyVersion()) - 1 }) } });
      }
      expect(await f.heal(MEMORY_FACT_EXTRACTION_HEAL_SAME_POLICY_DELAY_MS + 60_000,
        fence !== "model_unavailable")).toBe(0);
      expect(await prisma.memoryJob.count({ where: { userId: f.userId, kind: "EXTRACT_FACTS",
        idempotencyFingerprint: { startsWith: "extract-facts:vnext:heal." }, state: { not: "CANCELLED" } } })).toBe(0);
    });

  it("keeps at most two re-extractions of one owner in flight", async () => {
    const f = await fixture(["I moved to Lisbon last spring.", "I work as a nurse.", "I play the cello."]);
    await f.drive(failing("PERMANENT"));
    expect((await f.jobs()).map(({ stage }) => stage)).toEqual(Array(3).fill("fact_provider_unavailable"));
    await changePolicy();
    expect(await f.heal()).toBe(MEMORY_FACT_EXTRACTION_HEAL_OWNER_LIMIT);
    expect(await f.heal()).toBe(0);
    const provider = answering();
    await f.drive(provider);
    expect(provider.run).toHaveBeenCalledTimes(2);
    expect(await f.heal()).toBe(1);
    await f.drive(provider);
    expect(await f.heal()).toBe(0);
    expect(new Set(provider.run.mock.calls.map(([, input]) => input.source.sourceMessageId)))
      .toEqual(new Set(f.turns.map(({ userMessageId }) => userMessageId)));
  });
});

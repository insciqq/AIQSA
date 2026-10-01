import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../../contracts/memory";
import { textMessageContent } from "../../../domain/content";
import { providerTemplateIds } from "../../../domain/providerTemplates";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import { prisma } from "../../prisma";
import { createMemoryConsumerService, MemoryConsumerServiceError } from "../consumer/service";
import { createPrismaExplicitMemoryRepository } from "../explicit/repository";
import { createExplicitMemoryService } from "../explicit/service";
import { MEMORY_FACT_SOURCE_PROJECTION_VERSION } from "../learning/extraction/contract";
import { createPrismaMemoryMutationAuthorizationRepository } from "../persistence/authorizations";
import { loadPersonalEligibleFactVersionIds } from "../persistence/eligibility";
import { memoryPersistenceFailureCode } from "../persistence/errors";
import { createPrismaMemoryFactRepository, type MemoryFactValueInput } from "../persistence/facts";
import { memorySha256 } from "../persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import { MEMORY_PURGE_REQUIRED_CONTRIBUTORS } from "../purge/contract";
import { registerMemoryDeletionContributors } from "../purge/leaves";
import { MemoryDeletionContributorRegistry } from "../purge/registry";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import { createPrismaMemoryLifecycleRepository } from "./repository";
import {
  MEMORY_FORGET_SOURCE_CAPACITY,
  memoryForgetPeerCascadeCount
} from "./sourcePreservation";
import {
  createMemoryLifecycleService,
  MemoryLifecycleServiceError,
  type MemoryLifecycleAuthorizationRepository
} from "./service";

vi.mock("../../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../observability")>(),
  logEvent: vi.fn()
}));

// Synthetic regressions for issue #42. Every fixture is owned by a fresh user
// and removed afterwards; outputs are aggregate codes, counts and durations.
const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 133));
const keyring = MemorySuppressionKeyring.parse(
  `current=forget-diagnostics-v1,forget-diagnostics-v1=${keyBytes.toString("base64")}`
);
const SCALE = 1024;
const STALE_PROJECTION_VERSION = "memory-forget-diagnostics-stale-projection-v0";
const FORGOTTEN_TEXT = "My workshop lamp is amber.";
const createdUsers: string[] = [];

afterEach(async () => {
  vi.mocked(logEvent).mockClear();
  const userIds = createdUsers.splice(0);
  if (userIds.length === 0) return;
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

function chunks<T>(values: readonly T[], size = 500): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function createActiveUser(label: string): Promise<string> {
  const id = randomUUID();
  await prisma.user.create({ data: {
    displayName: `Forget diagnostics ${label}`,
    email: `forget-diagnostics-${label}-${id}@example.test`,
    id,
    settings: { create: {
      defaultControlValues: {},
      defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled"
    } },
    status: "active"
  } });
  createdUsers.push(id);
  return id;
}

function purgeRegistry(): MemoryDeletionContributorRegistry {
  const registry = new MemoryDeletionContributorRegistry({
    operation: "FORGET_PURGE",
    requirements: MEMORY_PURGE_REQUIRED_CONTRIBUTORS
  });
  registerMemoryDeletionContributors(registry);
  return registry;
}

function services(options: Readonly<{
  afterAuthorization?: () => Promise<void>;
}> = {}) {
  const authorizations = createPrismaMemoryMutationAuthorizationRepository(prisma);
  const readRepository = createPrismaExplicitMemoryRepository(prisma);
  const explicit = createExplicitMemoryService({
    authorizationRepository: authorizations,
    factRepository: createPrismaMemoryFactRepository(keyring, prisma),
    readRepository,
    scopeRepository: createPrismaMemoryScopeRepository(prisma)
  });
  const authorizationRepository: MemoryLifecycleAuthorizationRepository = {
    async resolveForUse(userId, input) {
      const resolved = await authorizations.resolveForUse(userId, input);
      await options.afterAuthorization?.();
      return resolved;
    }
  };
  const lifecycle = createMemoryLifecycleService({
    authorizationRepository,
    mutationRepository: createPrismaMemoryLifecycleRepository(keyring, purgeRegistry(), prisma),
    readRepository
  });
  return { explicit, lifecycle };
}

function automaticValue(canonicalKey: string, statement: string): MemoryFactValueInput {
  return {
    canonicalKey, category: "preference", confidence: 0.9, directness: "DIRECT",
    displayText: statement, importance: 0.8, languageCode: "en", modality: "PREFERENCE",
    pipelineVersion: "memory-forget-diagnostics-test-v1", secretTaintedSourceWindow: false,
    sensitivityClass: "NORMAL", sourceMode: "AUTOMATIC", structuredValue: { statement }
  };
}

type SourceMessage = Readonly<{ chatId: string; messageId: string; text: string }>;
type Fact = Readonly<{ factId: string; versionId: string }>;

/** Linear user-message chats; every message stays on its chat's active path. */
async function seedUserMessages(userId: string, texts: readonly string[], perChat = 64): Promise<SourceMessage[]> {
  const chatIds = Array.from({ length: Math.ceil(texts.length / perChat) }, () => randomUUID());
  await prisma.chat.createMany({ data: chatIds.map((id) => ({
    defaultProviderModelId: providerTemplateIds.fakeModel, id, title: "Forget diagnostics source", userId
  })) });
  const messages = texts.map((text, index) => ({
    chatId: chatIds[Math.floor(index / perChat)]!, messageId: randomUUID(), text
  }));
  const rows = messages.map((message, index) => ({
    chatId: message.chatId, content: textMessageContent(message.text), id: message.messageId,
    parentMessageId: index % perChat === 0 ? null : messages[index - 1]!.messageId,
    role: "user", status: "complete" as const
  }));
  for (const chunk of chunks(rows)) await prisma.message.createMany({ data: chunk });
  for (const chatId of chatIds) {
    const leaf = messages.filter((message) => message.chatId === chatId).at(-1)!;
    await prisma.chat.update({ data: { activeLeafMessageId: leaf.messageId }, where: { id: chatId } });
  }
  return messages;
}

/** Completed, delivered memory_search answers that independently retrieved
 * the fact. Each run echoes it into a user and an assistant message. */
async function seedSearchEchoes(input: Readonly<{
  runs: number; statement: string; userId: string; userText?: (index: number) => string; versionId: string;
}>, perChat = 64) {
  const chatIds = Array.from({ length: Math.ceil(input.runs / perChat) }, () => randomUUID());
  await prisma.chat.createMany({ data: chatIds.map((id) => ({ id, title: "Forget diagnostics echoes", userId: input.userId })) });
  const runs = Array.from({ length: input.runs }, (_, index) => ({
    assistantMessageId: randomUUID(), chatId: chatIds[Math.floor(index / perChat)]!, index,
    providerCallId: randomUUID(), runId: randomUUID(), toolCallId: randomUUID(), userMessageId: randomUUID()
  }));
  const messages: Prisma.MessageCreateManyInput[] = [];
  const leaves = new Map<string, string>();
  for (const run of runs) {
    messages.push({ chatId: run.chatId, content: textMessageContent(input.userText?.(run.index) ?? "Recall my preference"),
      id: run.userMessageId, parentMessageId: leaves.get(run.chatId) ?? null, role: "user", status: "complete" });
    messages.push({ chatId: run.chatId, content: textMessageContent(input.statement), id: run.assistantMessageId,
      parentMessageId: run.userMessageId, role: "assistant", status: "complete" });
    leaves.set(run.chatId, run.assistantMessageId);
  }
  for (const chunk of chunks(messages)) await prisma.message.createMany({ data: chunk });
  for (const [chatId, leaf] of leaves) {
    await prisma.chat.update({ data: { activeLeafMessageId: leaf }, where: { id: chatId } });
  }
  const now = new Date();
  for (const chunk of chunks(runs)) {
    await prisma.modelRun.createMany({ data: chunk.map((run) => ({
      assistantMessageId: run.assistantMessageId, chatId: run.chatId, id: run.runId,
      modelId: providerTemplateIds.fakeModel, normalizedRequest: {}, provider: providerTemplateIds.fakeConnection,
      status: "complete" as const, userId: input.userId, userMessageId: run.userMessageId
    })) });
    await prisma.modelRunToolCall.createMany({ data: chunk.map((run) => ({
      arguments: { comparison: false, query: "Recall my preference" }, completedAt: now, id: run.toolCallId,
      modelRunId: run.runId, ordinal: 0, providerCallId: run.providerCallId, result: {
        content: [{ text: input.statement, type: "text" }], status: "complete"
      }, roundIndex: 0, startedAt: now, state: "complete" as const, toolName: "memory_search"
    })) });
    await prisma.memoryHistoryRun.createMany({ data: chunk.map((run) => {
      const providerResult = { callId: run.providerCallId, content: [{ text: input.statement, type: "text" }],
        name: "memory_search", status: "complete" };
      return {
        completedAt: now, durationMs: 1, indexingEvidence: { delivered: true }, invocationOrdinal: 1,
        modelRunId: run.runId, modelRunToolCallId: run.toolCallId, outcome: "RESULTS" as const,
        privateRequest: { version: "memory-search-v1" }, providerResult, query: "Recall my preference",
        queryHash: memorySha256("Recall my preference"), receiptVersion: "memory-search-v1",
        resultCount: 1, resultHash: memorySha256(providerResult), results: { results: [{
          exactItemId: input.versionId, factVersionId: input.versionId, featureSnapshot: {},
          includedText: input.statement, itemType: "FACT_VERSION", recallChunkId: null, recallRoundId: null,
          selectionReason: "search", sourceBranchGenerationSnapshot: null, sourceChatId: null,
          sourceContentHashSnapshot: null, sourceMessageIds: [], sourceRevisionSnapshot: null
        }], version: "memory-search-v1" }, state: "COMPLETE" as const, userId: input.userId
      };
    }) });
  }
  return runs;
}

async function saveAutomatic(userId: string, input: Readonly<{
  canonicalKey: string; excerpt: string; message: SourceMessage; projectionVersion?: string; statement: string;
}>): Promise<Fact> {
  const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
  const created = await createPrismaMemoryFactRepository(keyring, prisma).save(userId, {
    evidence: {
      branchGeneration: 0, chatId: input.message.chatId, kind: "MESSAGE", messageId: input.message.messageId,
      observedAt: new Date(), safeExcerpt: input.excerpt, safeSourceHash: memorySha256(input.message.text),
      safetyClass: "NORMAL", sourceProjectionVersion: input.projectionVersion ?? MEMORY_FACT_SOURCE_PROJECTION_VERSION,
      sourceRole: "user"
    },
    explicitSuppressionOverride: false, idempotencyFingerprint: randomUUID(), requestId: randomUUID(),
    scopeId: scope.id, value: automaticValue(input.canonicalKey, input.statement)
  });
  return { factId: created.factId, versionId: created.versionId };
}

/** Assigns exact provenance (fingerprint, offsets, content hash) in one statement. */
async function makeExact(userId: string, rows: ReadonlyArray<Readonly<{
  excerpt: string; message: SourceMessage; versionId: string;
}>>): Promise<void> {
  for (const chunk of chunks(rows)) {
    const values = chunk.map((row) => {
      const start = row.message.text.indexOf(row.excerpt);
      if (start < 0) throw new Error("fixture_excerpt_missing");
      return Prisma.sql`(${row.versionId}, ${row.message.messageId}, ${start}::integer, ${start + row.excerpt.length}::integer)`;
    });
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "MemoryEvidence" AS support
      SET "evidenceFingerprint" = encode(sha256(convert_to(support."id", 'UTF8')), 'hex'),
        "sourceStartOffset" = data."start", "sourceEndOffset" = data."finish",
        "sourceMessageContentHash" = support."safeSourceHash"
      FROM (VALUES ${Prisma.join(values)}) AS data("versionId", "messageId", "start", "finish")
      WHERE support."userId" = ${userId} AND support."factVersionId" = data."versionId"
        AND support."messageId" = data."messageId" AND support."evidenceFingerprint" IS NULL
    `);
  }
}

/** Repeated exact testimony of one version in further messages. */
async function addExactEvidence(userId: string, versionId: string, excerpt: string, messages: readonly SourceMessage[]) {
  const observedAt = new Date();
  for (const chunk of chunks(messages)) {
    await prisma.memoryEvidence.createMany({ data: chunk.map((message) => {
      const start = message.text.indexOf(excerpt);
      return {
        branchGeneration: 0, chatId: message.chatId, evidenceFingerprint: memorySha256({ messageId: message.messageId, versionId }),
        factVersionId: versionId, messageId: message.messageId, observedAt, safeExcerpt: excerpt,
        safeSourceHash: memorySha256(message.text), safetyClass: "NORMAL" as const,
        sourceEndOffset: start + excerpt.length, sourceMessageContentHash: memorySha256(message.text),
        sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION, sourceRole: "user",
        sourceStartOffset: start, sourceType: "MESSAGE" as const, stance: "SUPPORTS" as const, userId
      };
    }) });
  }
}

/** Planner statistics as autovacuum maintains them on a running installation;
 * a bulk-loaded disposable database otherwise plans with empty-table estimates. */
async function analyzeFixtures(): Promise<void> {
  await prisma.$executeRawUnsafe(`ANALYZE "Chat", "Message", "ModelRun", "ModelRunToolCall", "MemoryHistoryRun",
    "MemoryEvidence", "MemoryFact", "MemoryFactVersion", "MemorySuppression", "MemoryFactVersionSourceDependency"`);
}

async function eligibleCount(userId: string, versionIds: readonly string[]): Promise<number> {
  let count = 0;
  for (const chunk of chunks(versionIds)) count += (await loadPersonalEligibleFactVersionIds(prisma, userId, chunk)).size;
  return count;
}

function failureLabel(error: unknown): string {
  const prismaCode = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : databaseFailureCode(error);
  const code = memoryPersistenceFailureCode(error) ??
    (error instanceof MemoryLifecycleServiceError ? error.code : "unclassified");
  return `${code}/${prismaCode}`;
}

async function forgetFact(
  lifecycle: ReturnType<typeof services>["lifecycle"],
  explicit: ReturnType<typeof services>["explicit"],
  userId: string,
  fact: Fact
): Promise<Readonly<{ cascadedPeers: number; durationMs: number; label: string }>> {
  const authorization = await explicit.mintAuthorization(userId, {
    action: "FORGET", confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    expectedTargetVersionId: fact.versionId, requestNonce: randomUUID(), targetFactId: fact.factId
  });
  const started = performance.now();
  try {
    const response = await lifecycle.forget(userId, fact.factId, {
      expectedVersionId: fact.versionId, mutationAuthorizationId: authorization.mutationAuthorizationId
    });
    return { cascadedPeers: memoryForgetPeerCascadeCount(response), durationMs: Math.round(performance.now() - started), label: "ok" };
  } catch (error) {
    return { cascadedPeers: 0, durationMs: Math.round(performance.now() - started), label: failureLabel(error) };
  }
}

function record(scenario: string, values: Readonly<Record<string, number | string>>): void {
  // Content-free measurement line for the task record.
  console.info(`forget-diagnostics ${JSON.stringify({ scenario, ...values })}`);
}

async function expectRolledBack(userId: string, fact: Fact): Promise<void> {
  expect(await prisma.memoryFact.findUniqueOrThrow({ select: { currentVersionId: true, state: true }, where: { id: fact.factId } }))
    .toEqual({ currentVersionId: fact.versionId, state: "ACTIVE" });
  expect(await prisma.memorySuppression.count({ where: { userId } })).toBe(0);
  expect(await prisma.memoryDeletionOutbox.count({ where: { userId } })).toBe(0);
  expect(await prisma.memoryOperationReceipt.count({ where: { operation: "FORGET", userId } })).toBe(0);
}

async function expectForgotten(userId: string, fact: Fact): Promise<void> {
  expect(await prisma.memoryFact.findUniqueOrThrow({ select: { currentVersionId: true, state: true }, where: { id: fact.factId } }))
    .toEqual({ currentVersionId: null, state: "FORGOTTEN" });
  expect(await prisma.memoryOperationReceipt.count({ where: { operation: "FORGET", outcome: "APPLIED", targetFactId: fact.factId, userId } })).toBe(1);
  expect(await prisma.memoryDeletionOutbox.count({ where: { operation: "FORGET_PURGE", targetId: fact.factId, userId } })).toBe(1);
}

describe("owner-authorized Forget failure diagnostics (#42)", () => {
  it("H1: forgets a fact echoed by more retrieval sources than the former 256 limit", async () => {
    const userId = await createActiveUser("h1-sources");
    const { explicit, lifecycle } = services();
    const texts = [FORGOTTEN_TEXT, "My garden gate is blue."];
    const origins = await seedUserMessages(userId, texts);
    const facts: Fact[] = [];
    const seeded = performance.now();
    for (const [index, text] of texts.entries()) {
      const fact = await saveAutomatic(userId, { canonicalKey: `learned.h1.${index}`, excerpt: text, message: origins[index]!, statement: text });
      await makeExact(userId, [{ excerpt: text, message: origins[index]!, versionId: fact.versionId }]);
      await seedSearchEchoes({ runs: SCALE, statement: text, userId, versionId: fact.versionId });
      facts.push(fact);
    }
    const fixtureMs = Math.round(performance.now() - seeded);

    // Observation: with empty-table planner estimates right after the bulk
    // load, the same work may exceed the explicit bound. That failure is a
    // distinguishable P2028, commits nothing, and the owner can retry.
    const unanalyzed = await forgetFact(lifecycle, explicit, userId, facts[0]!);
    record("h1_sources", { fixture_ms: fixtureMs, forget_ms: unanalyzed.durationMs, outcome: unanalyzed.label,
      sources: 2 * SCALE + 1, stats: "fresh" });
    expect(["ok", "unclassified/P2028"]).toContain(unanalyzed.label);
    if (unanalyzed.label !== "ok") await expectRolledBack(userId, facts[0]!);
    await analyzeFixtures();
    const analyzed = await forgetFact(lifecycle, explicit, userId, facts[1]!);
    record("h1_sources", { forget_ms: analyzed.durationMs, outcome: analyzed.label, sources: 2 * SCALE + 1, stats: "analyzed" });
    expect(analyzed.label).toBe("ok");
    await expectForgotten(userId, facts[1]!);
    expect(analyzed.durationMs).toBeLessThan(15_000);
    if (unanalyzed.label !== "ok") {
      const retried = await forgetFact(lifecycle, explicit, userId, facts[0]!);
      record("h1_sources", { forget_ms: retried.durationMs, outcome: retried.label, sources: 2 * SCALE + 1, stats: "analyzed_retry" });
      expect(retried.label).toBe("ok");
    }
    await expectForgotten(userId, facts[0]!);
    expect(await prisma.memorySuppression.count({ where: { scope: "SOURCE_MESSAGE", userId } })).toBe(2 * (2 * SCALE + 1));
  }, 600_000);

  it("H2: forgets a fact whose shared sources carry more peers than the former 256 limit", async () => {
    const userId = await createActiveUser("h2-peers");
    const { explicit, lifecycle } = services();
    const peerTexts = Array.from({ length: 320 }, (_, index) => `My peer note ${index} is teal.`);
    const texts = Array.from({ length: 32 }, (_, message) =>
      [FORGOTTEN_TEXT, ...peerTexts.slice(message * 10, message * 10 + 10)].join(" "));
    const messages = await seedUserMessages(userId, texts);
    const fact = await saveAutomatic(userId, { canonicalKey: "learned.h2.lamp", excerpt: FORGOTTEN_TEXT, message: messages[0]!, statement: FORGOTTEN_TEXT });
    await makeExact(userId, [{ excerpt: FORGOTTEN_TEXT, message: messages[0]!, versionId: fact.versionId }]);
    await addExactEvidence(userId, fact.versionId, FORGOTTEN_TEXT, messages.slice(1));
    const peers: Array<Fact & { excerpt: string; message: SourceMessage }> = [];
    for (const [index, text] of peerTexts.entries()) {
      const message = messages[Math.floor(index / 10)]!;
      peers.push({ ...await saveAutomatic(userId, { canonicalKey: `learned.h2.peer.${index}`, excerpt: text, message, statement: text }), excerpt: text, message });
    }
    await makeExact(userId, peers);
    await analyzeFixtures();
    expect(await eligibleCount(userId, peers.map(({ versionId }) => versionId))).toBe(peers.length);

    const result = await forgetFact(lifecycle, explicit, userId, fact);
    record("h2_peers", { forget_ms: result.durationMs, outcome: result.label, peers: peers.length, sources: messages.length });
    expect(result.label).toBe("ok");
    await expectForgotten(userId, fact);
    expect(await eligibleCount(userId, peers.map(({ versionId }) => versionId))).toBe(peers.length);
  }, 600_000);

  // The same scenario at MEMORY_FORGET_*_CAPACITY (4096/4096) was measured
  // once for the capacity constants; the suite keeps the 1024 acceptance scale.
  it.each([SCALE])("capacity: forgets with %i unique sources and as many peers within the explicit timeout", async (scale) => {
    const userId = await createActiveUser(`capacity-${scale}`);
    const { explicit, lifecycle } = services();
    const peerTexts = Array.from({ length: scale }, (_, index) => `My capacity note ${index} is teal.`);
    const messages = await seedUserMessages(userId, peerTexts.map((text) => `${FORGOTTEN_TEXT} ${text}`));
    const fact = await saveAutomatic(userId, { canonicalKey: "learned.capacity.lamp", excerpt: FORGOTTEN_TEXT, message: messages[0]!, statement: FORGOTTEN_TEXT });
    await makeExact(userId, [{ excerpt: FORGOTTEN_TEXT, message: messages[0]!, versionId: fact.versionId }]);
    await addExactEvidence(userId, fact.versionId, FORGOTTEN_TEXT, messages.slice(1));
    const seeded = performance.now();
    const peers: Array<Fact & { excerpt: string; message: SourceMessage }> = [];
    for (const [index, text] of peerTexts.entries()) {
      peers.push({ ...await saveAutomatic(userId, { canonicalKey: `learned.capacity.peer.${index}`, excerpt: text,
        message: messages[index]!, statement: text }), excerpt: text, message: messages[index]! });
    }
    await makeExact(userId, peers);
    await analyzeFixtures();
    const fixtureMs = Math.round(performance.now() - seeded);

    const result = await forgetFact(lifecycle, explicit, userId, fact);
    record("capacity", { fixture_ms: fixtureMs, forget_ms: result.durationMs, outcome: result.label, peers: scale, sources: scale });
    expect(result.label).toBe("ok");
    await expectForgotten(userId, fact);
    expect(result.durationMs).toBeLessThan(15_000);
    expect(await eligibleCount(userId, peers.map(({ versionId }) => versionId))).toBe(scale);
    const preserved = await prisma.memorySuppression.findMany({ select: { preservedEvidenceIds: true }, where: { scope: "SOURCE_MESSAGE", userId } });
    expect(preserved).toHaveLength(scale);
    expect(preserved.every(({ preservedEvidenceIds }) => preservedEvidenceIds.length === 1)).toBe(true);
  }, 900_000);

  it("refuses beyond the measured capacity with bounded limit reasons and no side effects", async () => {
    const userId = await createActiveUser("limits");
    const { explicit, lifecycle } = services();
    const messages = await seedUserMessages(userId, Array.from({ length: MEMORY_FORGET_SOURCE_CAPACITY + 1 }, () => FORGOTTEN_TEXT));
    const fact = await saveAutomatic(userId, { canonicalKey: "learned.limits.lamp", excerpt: FORGOTTEN_TEXT, message: messages[0]!, statement: FORGOTTEN_TEXT });
    await makeExact(userId, [{ excerpt: FORGOTTEN_TEXT, message: messages[0]!, versionId: fact.versionId }]);
    await addExactEvidence(userId, fact.versionId, FORGOTTEN_TEXT, messages.slice(1));
    await analyzeFixtures();
    const sources = await forgetFact(lifecycle, explicit, userId, fact);
    record("source_limit", { forget_ms: sources.durationMs, outcome: sources.label, sources: messages.length });
    expect(sources.label).toBe("memory_forget_source_limit/unknown");
    await expectRolledBack(userId, fact);

    // One fenced message can preserve at most 256 peer spans (database check).
    const peerTexts = Array.from({ length: 257 }, (_, index) => `Note ${index} is teal.`);
    const [crowded] = await seedUserMessages(userId, [[FORGOTTEN_TEXT, ...peerTexts].join(" ")]);
    const crowdedFact = await saveAutomatic(userId, { canonicalKey: "learned.limits.crowded", excerpt: FORGOTTEN_TEXT, message: crowded!, statement: "My lamp is amber." });
    const rows = [{ excerpt: FORGOTTEN_TEXT, message: crowded!, versionId: crowdedFact.versionId }];
    for (const [index, text] of peerTexts.entries()) {
      rows.push({ excerpt: text, message: crowded!, ...await saveAutomatic(userId, { canonicalKey: `learned.limits.peer.${index}`,
        excerpt: text, message: crowded!, statement: text }) });
    }
    await makeExact(userId, rows);
    await analyzeFixtures();
    const peers = await forgetFact(lifecycle, explicit, userId, crowdedFact);
    record("peer_limit", { forget_ms: peers.durationMs, outcome: peers.label, peers: peerTexts.length });
    expect(peers.label).toBe("memory_forget_peer_limit/unknown");
    await expectRolledBack(userId, crowdedFact);
  }, 600_000);

  it("H3: refuses a retrieval-only shared source whose peer evidence is not exact, without side effects", async () => {
    const userId = await createActiveUser("h3-retrieval");
    const { explicit, lifecycle } = services();
    const peerText = "My hiking boots are green.";
    const [origin] = await seedUserMessages(userId, [FORGOTTEN_TEXT]);
    const fact = await saveAutomatic(userId, { canonicalKey: "learned.h3.lamp", excerpt: FORGOTTEN_TEXT, message: origin!, statement: FORGOTTEN_TEXT });
    await makeExact(userId, [{ excerpt: FORGOTTEN_TEXT, message: origin!, versionId: fact.versionId }]);
    const [run] = await seedSearchEchoes({ runs: 1, statement: FORGOTTEN_TEXT, userId, userText: () => peerText, versionId: fact.versionId });
    const echo = { chatId: run!.chatId, messageId: run!.userMessageId, text: peerText };
    const peer = await saveAutomatic(userId, { canonicalKey: "learned.h3.boots", excerpt: peerText, message: echo,
      projectionVersion: STALE_PROJECTION_VERSION, statement: peerText });
    await makeExact(userId, [{ excerpt: peerText, message: echo, versionId: peer.versionId }]);
    expect(await eligibleCount(userId, [peer.versionId])).toBe(1);

    const result = await forgetFact(lifecycle, explicit, userId, fact);
    record("h3_retrieval_inexact", { forget_ms: result.durationMs, outcome: result.label });
    expect(result.label).toBe("memory_forget_peer_retrieval_inexact/unknown");
    await expectRolledBack(userId, fact);
    expect(await eligibleCount(userId, [peer.versionId])).toBe(1);
  }, 120_000);

  it("3b: overlapping and inexact spans of a direct shared source do not block Forget", async () => {
    const userId = await createActiveUser("3b-overlap");
    const { explicit, lifecycle } = services();
    const second = "My bicycle is silver.";
    const text = `${FORGOTTEN_TEXT} ${second}`;
    const [message] = await seedUserMessages(userId, [text]);
    const fact = await saveAutomatic(userId, { canonicalKey: "learned.3b.lamp", excerpt: text, message: message!, statement: FORGOTTEN_TEXT });
    const overlapping = await saveAutomatic(userId, { canonicalKey: "learned.3b.bicycle", excerpt: text, message: message!, statement: second });
    const stale = await saveAutomatic(userId, { canonicalKey: "learned.3b.bicycle.stale", excerpt: second, message: message!,
      projectionVersion: STALE_PROJECTION_VERSION, statement: "The bicycle is silver." });
    await makeExact(userId, [
      { excerpt: text, message: message!, versionId: fact.versionId },
      { excerpt: text, message: message!, versionId: overlapping.versionId },
      { excerpt: second, message: message!, versionId: stale.versionId }
    ]);
    // Inexact (legacy-shaped) support of the forgotten fact in the same message.
    await prisma.memoryEvidence.create({ data: {
      branchGeneration: 0, chatId: message!.chatId, factVersionId: fact.versionId, messageId: message!.messageId,
      observedAt: new Date(), safeExcerpt: FORGOTTEN_TEXT, safeSourceHash: memorySha256(text), safetyClass: "NORMAL",
      sourceProjectionVersion: STALE_PROJECTION_VERSION, sourceRole: "user", sourceType: "MESSAGE", stance: "SUPPORTS", userId
    } });
    const peerIds = [overlapping.versionId, stale.versionId];
    expect(await eligibleCount(userId, peerIds)).toBe(2);

    const result = await forgetFact(lifecycle, explicit, userId, fact);
    record("3b_overlap_inexact", { forget_ms: result.durationMs, outcome: result.label });
    expect(result.label).toBe("ok");
    await expectForgotten(userId, fact);
    expect(await eligibleCount(userId, peerIds)).toBe(2);
    expect(await prisma.memoryFactVersion.count({ where: { id: { in: peerIds }, state: "ACTIVE" } })).toBe(2);
    const suppression = await prisma.memorySuppression.findFirstOrThrow({ where: { scope: "SOURCE_MESSAGE", userId } });
    const peerEvidence = await prisma.memoryEvidence.findMany({ select: { id: true }, where: { factVersionId: { in: peerIds }, userId } });
    expect(new Set(suppression.preservedEvidenceIds)).toEqual(new Set(peerEvidence.map(({ id }) => id)));
    // The forgotten bytes stay fenced against re-extraction.
    await expect(saveAutomatic(userId, { canonicalKey: "learned.3b.replayed", excerpt: FORGOTTEN_TEXT, message: message!,
      statement: "The workshop lamp has an amber colour." })).rejects.toMatchObject({ code: "memory_fact_suppressed" });
  }, 120_000);

  it("H4: a peer that depends on the forgotten version is a legitimate cascade, not a refusal", async () => {
    const userId = await createActiveUser("h4-cascade");
    const { explicit, lifecycle } = services();
    const second = "It lights my bench.";
    const text = `${FORGOTTEN_TEXT} ${second}`;
    const [message] = await seedUserMessages(userId, [text]);
    const fact = await saveAutomatic(userId, { canonicalKey: "learned.h4.lamp", excerpt: FORGOTTEN_TEXT, message: message!, statement: FORGOTTEN_TEXT });
    const dependent = await saveAutomatic(userId, { canonicalKey: "learned.h4.bench", excerpt: second, message: message!,
      statement: "The amber lamp lights my bench." });
    await makeExact(userId, [
      { excerpt: FORGOTTEN_TEXT, message: message!, versionId: fact.versionId },
      { excerpt: second, message: message!, versionId: dependent.versionId }
    ]);
    await prisma.memoryFactVersionSourceDependency.create({ data: {
      dependencyKind: "COREFERENCE_ANTECEDENT", sourceFactVersionId: fact.versionId,
      targetFactVersionId: dependent.versionId, userId
    } });
    expect(await eligibleCount(userId, [dependent.versionId])).toBe(1);

    const result = await forgetFact(lifecycle, explicit, userId, fact);
    record("h4_dependency_cascade", { cascaded_peers: result.cascadedPeers, forget_ms: result.durationMs, outcome: result.label });
    expect(result.label).toBe("ok");
    expect(result.cascadedPeers).toBe(1);
    await expectForgotten(userId, fact);
    expect(await prisma.memoryFactVersion.findUniqueOrThrow({ select: { state: true }, where: { id: dependent.versionId } }))
      .toEqual({ state: "ACTIVE" });
    expect(await eligibleCount(userId, [dependent.versionId])).toBe(0);
  }, 120_000);

  it("H4 control: an unexpected peer loss after the fence still fails closed atomically", async () => {
    const userId = await createActiveUser("h4-unexpected");
    const { explicit, lifecycle } = services();
    const second = "My kettle is black.";
    const text = `${FORGOTTEN_TEXT} ${second}`;
    const [message] = await seedUserMessages(userId, [text]);
    const fact = await saveAutomatic(userId, { canonicalKey: "learned.h4c.lamp", excerpt: FORGOTTEN_TEXT, message: message!, statement: FORGOTTEN_TEXT });
    await makeExact(userId, [{ excerpt: FORGOTTEN_TEXT, message: message!, versionId: fact.versionId }]);
    // Legacy-shaped peer support cannot be preserved by the database guard.
    const legacy = await saveAutomatic(userId, { canonicalKey: "learned.h4c.kettle", excerpt: second, message: message!, statement: second });
    expect(await eligibleCount(userId, [legacy.versionId])).toBe(1);

    const result = await forgetFact(lifecycle, explicit, userId, fact);
    record("h4_unexpected_loss", { forget_ms: result.durationMs, outcome: result.label });
    expect(result.label).toBe("memory_forget_peer_ineligible_after_fence/unknown");
    await expectRolledBack(userId, fact);
    expect(await eligibleCount(userId, [legacy.versionId])).toBe(1);
  }, 120_000);

  it("H5: Forget waits for a background settings lock longer than the Prisma default timeout", async () => {
    const userId = await createActiveUser("h5-lock");
    const holdMs = 7_000;
    let holder: Promise<unknown> | null = null;
    const { explicit, lifecycle } = services({
      async afterAuthorization() {
        let locked!: () => void;
        const acquired = new Promise<void>((resolve) => { locked = resolve; });
        holder = prisma.$transaction(async (tx) => {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`);
          await tx.$queryRaw(Prisma.sql`SELECT "userId" FROM "UserMemorySettings" WHERE "userId" = ${userId} FOR UPDATE`);
          locked();
          await tx.$executeRaw(Prisma.sql`SELECT pg_sleep(${holdMs / 1000}::double precision)`);
        }, { maxWait: 2_000, timeout: holdMs + 10_000 });
        await acquired;
      }
    });
    const [message] = await seedUserMessages(userId, [FORGOTTEN_TEXT]);
    const fact = await saveAutomatic(userId, { canonicalKey: "learned.h5.lamp", excerpt: FORGOTTEN_TEXT, message: message!, statement: FORGOTTEN_TEXT });
    await makeExact(userId, [{ excerpt: FORGOTTEN_TEXT, message: message!, versionId: fact.versionId }]);

    const result = await forgetFact(lifecycle, explicit, userId, fact);
    await holder;
    record("h5_lock_wait", { forget_ms: result.durationMs, hold_ms: holdMs, outcome: result.label });
    expect(result.label).toBe("ok");
    await expectForgotten(userId, fact);
    expect(result.durationMs).toBeGreaterThanOrEqual(holdMs - 500);
    expect(result.durationMs).toBeLessThan(15_000);
  }, 120_000);

  it("consumer Forget commits state, receipt and deletion obligation, and diagnoses a refusal", async () => {
    const userId = await createActiveUser("consumer");
    const { explicit, lifecycle } = services();
    let target: Fact | null = null;
    const consumer = createMemoryConsumerService({
      explicitService: explicit,
      lifecycleService: lifecycle,
      readResetState: async () => null,
      refs: {
        mintCursor: () => "cursor",
        mintItem: () => "item",
        resolveCursor: () => null,
        resolveItem: () => target && { factId: target.factId, factVersionId: target.versionId }
      },
      settingsService: {} as never
    });
    const [message] = await seedUserMessages(userId, [FORGOTTEN_TEXT]);
    const fact = await saveAutomatic(userId, { canonicalKey: "learned.consumer.lamp", excerpt: FORGOTTEN_TEXT, message: message!, statement: FORGOTTEN_TEXT });
    await makeExact(userId, [{ excerpt: FORGOTTEN_TEXT, message: message!, versionId: fact.versionId }]);
    target = fact;
    await expect(consumer.forget(userId, "opaque", { requestId: randomUUID() })).resolves.toEqual({ status: "FORGOTTEN" });
    await expectForgotten(userId, fact);
    const outbox = await prisma.memoryDeletionOutbox.findFirstOrThrow({ where: { operation: "FORGET_PURGE", targetId: fact.factId, userId } });
    expect(outbox.state).toBe("PENDING");
    expect(vi.mocked(logEvent).mock.calls.filter(([event]) => event === "service_operation")).toEqual([]);

    // A refused Forget (H3 shape) keeps its precise reason in one content-free event.
    const peerText = "My hiking boots are green.";
    const [origin] = await seedUserMessages(userId, ["My studio chair is red."]);
    const refused = await saveAutomatic(userId, { canonicalKey: "learned.consumer.chair", excerpt: "My studio chair is red.", message: origin!, statement: "My studio chair is red." });
    await makeExact(userId, [{ excerpt: "My studio chair is red.", message: origin!, versionId: refused.versionId }]);
    const [run] = await seedSearchEchoes({ runs: 1, statement: "My studio chair is red.", userId, userText: () => peerText, versionId: refused.versionId });
    const echo = { chatId: run!.chatId, messageId: run!.userMessageId, text: peerText };
    const peer = await saveAutomatic(userId, { canonicalKey: "learned.consumer.boots", excerpt: peerText, message: echo,
      projectionVersion: STALE_PROJECTION_VERSION, statement: peerText });
    await makeExact(userId, [{ excerpt: peerText, message: echo, versionId: peer.versionId }]);
    target = refused;
    const error = await consumer.forget(userId, "opaque", { requestId: randomUUID() }).catch((caught: unknown) => caught);
    expect(error).toEqual(new MemoryConsumerServiceError("memory_action_failed"));
    const events = vi.mocked(logEvent).mock.calls.filter(([event]) => event === "service_operation");
    expect(events).toEqual([["service_operation", expect.objectContaining({
      action: "fail", code: "memory_forget_peer_retrieval_inexact", outcome: "failed", prisma_code: "unknown",
      stage: "delete", subsystem: "memory"
    })]]);
    expect(JSON.stringify(events)).not.toContain(userId);
    expect(JSON.stringify(events)).not.toContain(refused.factId);
  }, 120_000);
});

// @vitest-environment node
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { normalizeTokenUsage } from "../../../domain/usage";
import { providerTemplateIds } from "../../../domain/providerTemplates";
import { databaseFailureKind } from "../../observability/databaseFailure";
import { prisma } from "../../prisma";
import { createPrismaRunRepository } from "../../runs/prismaRepository";
import type { RunRepository } from "../../runs/runRepositoryContract";
import { createUploadHandler } from "../../uploads/handlers";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import type { MemoryJobClaim } from "../coordinator/types";
import type { MemoryItemEmbeddingPin } from "../embedding/contract";
import { memoryVectorSpaceFingerprint, resolveCurrentMemoryUtilityPolicy } from "../execution/policy";
import { createPrismaMemoryHistoryIndexHandler } from "../history/handler";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { MEMORY_RECLASSIFICATION_PIPELINE_VERSION } from "../reclassification/classifier";
import { defaultMemorySourceMutationHooks } from "../sourceHooks";
import { applyMemorySourceMutations, lockMemorySourceChat } from "../sourceState";
import { parseMemoryRebuildJobFingerprint } from "./contract";
import { createMemoryRebuildHandler } from "./handler";
import { createPrismaMemoryRebuildRepository } from "./repository";
import { wakeCurrentMemoryShadowRebuildInTransaction } from "./wake";

// Production (2026-10-08): an owner's re-embedding rebuild held the owner row
// for up to 20 s per catch-up pass, so usage settlement, uploads and the GET
// chat reconcile of the same owner expired their 5 s Prisma transactions
// (P2028). This owner's history is large enough that the unbounded pass held
// the owner for 9 s (first pass) and 5 s (each later pass) on the disposable
// database, measured before the fix.
const HISTORY_CHATS = 60;
const HISTORY_TURNS = 10;
const EMBEDDING_DIMENSION = 1_024;

const words = ["alpha", "harbor", "copper", "lantern", "meadow", "quartz", "violet", "summit", "falcon", "ember",
  "glacier", "orchard", "pixel", "rhythm", "saffron", "timber", "umbra", "vertex", "willow", "zephyr"];

function syntheticText(seed: number, characters: number, label: string): string {
  let state = seed >>> 0;
  const parts = [label];
  let length = label.length;
  while (length < characters) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const word = words[state % words.length]!;
    parts.push(state % 13 === 0 ? `${word} ${state % 997}.` : word);
    length += word.length + 1;
  }
  return parts.join(" ");
}

async function createOwner(label: string): Promise<string> {
  const userId = `memory-contention-${label}-${randomUUID()}`;
  await prisma.user.create({ data: {
    displayName: `Memory contention ${label}`, email: `${userId}@example.test`, id: userId, status: "active",
    settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled" } }
  } });
  await prisma.userMemorySettings.update({
    data: { learnAutomatically: false, referenceChatHistory: true, useMemoryFacts: true },
    where: { userId }
  });
  return userId;
}

async function cleanupOwner(userId: string): Promise<void> {
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
  await prisma.attachment.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

function mutateSource(userId: string, chatId: string,
  input: Omit<Parameters<typeof applyMemorySourceMutations>[1], "chat" | "hooks">) {
  return prisma.$transaction(async (tx) => {
    const chat = await lockMemorySourceChat(tx, { chatId, lock: "UPDATE", userId });
    if (!chat) throw new Error("memory_contention_chat_missing");
    return applyMemorySourceMutations(tx, { ...input, chat, hooks: defaultMemorySourceMutationHooks });
  }, { timeout: 30_000 });
}

/** One settled personal chat whose turns the real history indexer projects. */
async function seedChat(userId: string, ordinal: number, turns: number, answerCharacters: number): Promise<void> {
  const chat = await prisma.chat.create({ data: { title: `Contention ${ordinal}`, userId } });
  const base = Date.UTC(2026, 6, 1) + ordinal * 3_600_000;
  let parentMessageId: string | null = null;
  let last = { assistantMessageId: "", runId: "" };
  for (let turn = 0; turn < turns; turn += 1) {
    const createdAt = new Date(base + turn * 120_000);
    const answeredAt = new Date(createdAt.getTime() + 1_000);
    const question: { id: string } = await prisma.message.create({ data: { chatId: chat.id,
      content: textMessageContent(syntheticText(ordinal * 1_000 + turn, 280, `Question ${ordinal}-${turn}.`)),
      createdAt, parentMessageId, role: "user", status: "complete", updatedAt: createdAt } });
    const answer: { id: string } = await prisma.message.create({ data: { chatId: chat.id,
      content: textMessageContent(syntheticText(ordinal * 1_000 + turn + 500, answerCharacters, `Answer ${ordinal}-${turn}.`)),
      createdAt: answeredAt, modelId: "contention-model", parentMessageId: question.id, provider: "contention-provider",
      role: "assistant", status: "complete", updatedAt: answeredAt } });
    const run = await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId: chat.id,
      modelId: "contention-model", provider: "contention-provider", status: "complete", userId, userMessageId: question.id,
      normalizedRequest: { prompt: { baseline: { source: "standard_chat", timeZone: "Europe/Moscow", timeZoneSource: "client" } } } } });
    parentMessageId = answer.id;
    last = { assistantMessageId: answer.id, runId: run.id };
  }
  await mutateSource(userId, chat.id, { mutations: ["NORMAL_APPEND"], patch: { activeLeafMessageId: last.assistantMessageId } });
  await mutateSource(userId, chat.id, { mutations: ["TERMINAL_SETTLEMENT"], terminalSettlement: {
    assistantMessageId: last.assistantMessageId, runId: last.runId, status: "complete"
  } });
}

async function claimJob(jobId: string): Promise<MemoryJobClaim> {
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + 10 * 60_000);
  const job = await prisma.memoryJob.update({
    data: { attemptCount: { increment: 1 }, leaseExpiresAt, leaseToken: claimToken, state: "CLAIMED", updatedAt: new Date() },
    where: { id: jobId }
  });
  return {
    activeLeafMessageId: job.activeLeafMessageId, attemptCount: job.attemptCount, branchGeneration: job.branchGeneration,
    chatId: job.chatId, claimToken, id: job.id, idempotencyFingerprint: job.idempotencyFingerprint, kind: job.kind,
    leaseExpiresAt, memoryGenerationSnapshot: job.memoryGenerationSnapshot, memoryRevisionSnapshot: job.memoryRevisionSnapshot,
    pipelineVersion: job.pipelineVersion, recoveredLease: false, sourceHash: job.sourceHash,
    sourceMessageId: job.sourceMessageId, sourceRevision: job.sourceRevision, stage: job.stage,
    targetFactVersionId: job.targetFactVersionId, userId: job.userId
  };
}

/** Indexes every settled chat through the production handler and commit. */
async function indexHistory(userId: string): Promise<void> {
  const handler = createPrismaMemoryHistoryIndexHandler(prisma);
  const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
  for (;;) {
    const job = await prisma.memoryJob.findFirst({
      orderBy: [{ sourceRevision: "desc" }, { createdAt: "desc" }],
      where: { kind: "INDEX_HISTORY", state: "QUEUED", userId }
    });
    if (!job) return;
    // The newest turn supersedes every older queued turn of its chat.
    if (job.chatId) {
      await prisma.memoryJob.updateMany({ data: { errorCode: "memory_source_stale", state: "STALE" },
        where: { chatId: job.chatId, id: { not: job.id }, kind: "INDEX_HISTORY", state: "QUEUED", userId } });
    }
    const claim = await claimJob(job.id);
    const decision = await handler.preflight(claim);
    if (decision.status !== "READY") {
      await coordinator.settleJobGate({ claim, decision, now: new Date() });
      continue;
    }
    const now = new Date();
    const result = await handler.execute(claim, { now: () => now, setStage: async () => undefined,
      signal: new AbortController().signal });
    expect(await coordinator.commitJobSuccess({ acceptedResultHash: result.acceptedResultHash, apply: result.apply,
      claim, now, stage: result.stage ?? null })).toBe(true);
  }
}

async function seedHistory(userId: string, chats: number, turns: number, answerCharacters: number): Promise<void> {
  for (let chat = 0; chat < chats; chat += 1) {
    await seedChat(userId, chat, turns, answerCharacters);
    if (chat % 10 === 9) await indexHistory(userId);
  }
  await indexHistory(userId);
  // Autovacuum statistics a long-lived installation has; a fresh bulk set
  // would otherwise plan the source guards and enumeration without them.
  await prisma.$executeRawUnsafe(`ANALYZE "Chat", "Message", "ModelRun", "ChatMemoryCheckpoint", ` +
    `"ChatMemoryCheckpointMessage", "MemoryRecallChunk", "MemoryRecallChunkMessage", "MemoryRecallRound", ` +
    `"MemoryRecallRoundMessage", "MemoryRecallRoundSegment", "MemoryRecallRoundSegmentMessage", "MemorySearchEntry"`);
}

async function configureEmbeddingProvider(userId: string): Promise<Readonly<{
  cleanup(): Promise<void>; modelId: string; pin: MemoryItemEmbeddingPin;
}>> {
  const suffix = randomUUID();
  const connectionId = `memory-contention-connection-${suffix}`;
  const credentialId = `memory-contention-credential-${suffix}`;
  const credentialVersionId = `memory-contention-version-${suffix}`;
  const modelId = `memory-contention-model-${suffix}`;
  const now = new Date();
  const configuration = {
    adapterKind: "openai_embeddings_compatible", answerSelectable: false,
    capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
    defaultParams: {},
    embedding: { nativeDimension: EMBEDDING_DIMENSION, providerFamily: "openai_compatible",
      queryInstructionTemplate: null, supportsMrl: false, targetDimension: EMBEDDING_DIMENSION },
    modelClass: "embedding", upstreamModelId: "memory-contention-embedding-v1"
  } as const;
  const connection = { allowPrivateNetwork: false, apiRoot: "https://memory-contention.example.test/v1",
    authenticationMode: "bearer", responseTimeoutMs: 30_000 };
  await prisma.providerConnection.create({ data: { activeConfig: connection, activeVersion: 1, activatedAt: now,
    displayName: "Memory contention embedding", draftConfig: connection, draftVersion: 1, enabled: true,
    family: "openai_compatible", id: connectionId, unassignedPolicy: "use_default" } });
  await prisma.providerCredential.create({ data: { activatedAt: now, connectionId, draftVersion: 1, enabled: true,
    id: credentialId, label: "Memory contention credential", testedAt: now } });
  await prisma.providerCredentialVersion.create({ data: { activatedAt: now, credentialId, id: credentialVersionId,
    secretEnvelope: "test-only-envelope", testedAt: now, testEvidence: { authenticationMode: "bearer" }, version: 1 } });
  await prisma.providerCredential.update({ data: { activeVersionId: credentialVersionId }, where: { id: credentialId } });
  await prisma.providerConnection.update({ data: { defaultCredentialId: credentialId }, where: { id: connectionId } });
  await prisma.providerModel.create({ data: { activeConfig: configuration, activeVersion: 1, activatedAt: now,
    capabilities: configuration.capabilities, connectionId, defaultParams: {}, displayName: "Memory contention model",
    draftConfig: configuration, draftVersion: 1, enabled: true, id: modelId, modelClass: "embedding",
    modelId: configuration.upstreamModelId, provider: "openai_compatible" } });
  await prisma.providerModelCredentialCheck.create({ data: { checkedAt: now, connectionId, connectionVersion: 1,
    credentialId, credentialVersionId, evidence: { embedding: { dimensions: EMBEDDING_DIMENSION, document: true,
      probeVersion: 1, query: true }, method: "tiny_generation", selectedProviders: [],
    upstreamModelId: configuration.upstreamModelId }, modelVersion: 1, providerModelId: modelId, status: "available" } });
  await prisma.accessGrant.create({ data: { enabled: true, providerModelId: modelId, userId } });
  await prisma.userMemorySettings.update({ data: { embeddingProviderModelId: modelId }, where: { userId } });
  const policy = await prisma.$transaction(async (tx) => resolveCurrentMemoryUtilityPolicy(tx, userId,
    await tx.userMemorySettings.findUniqueOrThrow({ where: { userId } })));
  const target = policy.targets.get("MEMORY_DOCUMENT_EMBED");
  const vectorSpaceFingerprint = target ? memoryVectorSpaceFingerprint(target) : null;
  if (!target || !vectorSpaceFingerprint) throw new Error("memory_contention_embedding_unavailable");
  return {
    async cleanup() {
      await prisma.providerModelCredentialCheck.deleteMany({ where: { connectionId } });
      await prisma.providerConnection.updateMany({ data: { defaultCredentialId: null }, where: { id: connectionId } });
      await prisma.providerCredential.updateMany({ data: { activeVersionId: null }, where: { id: credentialId } });
      await prisma.providerModel.deleteMany({ where: { id: modelId } });
      await prisma.providerCredentialVersion.deleteMany({ where: { credentialId } });
      await prisma.providerCredential.deleteMany({ where: { id: credentialId } });
      await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    },
    modelId,
    pin: { configurationFingerprint: target.compatibilityFingerprints.configFingerprint, connectionId,
      dimension: EMBEDDING_DIMENSION, providerModelId: modelId, vectorSpaceFingerprint }
  };
}

async function createForegroundRun(repository: RunRepository, userId: string, title: string) {
  const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title, userId } });
  const content = textMessageContent(title);
  const created = await repository.createRun({
    chatId: chat.id, content,
    defaults: { controlDefaults: {}, modelId: providerTemplateIds.fakeModel, provider: providerTemplateIds.fakeConnection,
      searchPlan: { mode: "all_selected", optionIds: [] }, userId },
    expectedActiveLeafId: null, modelId: "fake-qsa",
    normalizedRequest: { attachmentIds: [], chatId: chat.id, content,
      knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 }, toolMode: "auto",
      modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
      modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
      searchPlan: { mode: "all_selected", options: [] } },
    provider: "fake", providerRequestPreview: {}, userId
  });
  return { assistantMessageId: created.assistantMessageId, chatId: chat.id, runId: created.runId };
}

/** The upload route's personal persistence: the attachment and its processing
 * job reference the owner through foreign keys. */
function uploadHandler(userId: string, storage: ReturnType<typeof createMemoryStorageAdapter>) {
  return createUploadHandler({
    createAttachment: async (input) => {
      const attachment = await prisma.$transaction((tx) => tx.attachment.create({
        data: {
          byteSize: input.byteSize, checksum: input.checksum, extractedText: input.extractedText,
          fileName: input.fileName, kind: input.kind, metadata: input.metadata as Prisma.InputJsonValue,
          mimeType: input.mimeType, processingErrorCode: input.processingErrorCode,
          ...(input.status === "processing"
            ? { processingJob: { create: { ownerUserId: input.processingOwnerUserId ?? input.userId } } } : {}),
          status: input.status, storageKey: input.storageKey, userId: input.userId
        }
      }));
      return { ...input, id: attachment.id, kind: input.kind, processingErrorCode: null, updatedAt: attachment.updatedAt };
    },
    deletionOutbox: {
      async complete(jobId) { await prisma.attachmentDeletionJob.deleteMany({ where: { id: jobId } }); },
      stage: (storageKey) => prisma.attachmentDeletionJob.upsert({ create: { storageKey }, update: {}, where: { storageKey } })
    },
    resolveAuth: async () => ({
      expiresAt: new Date(Date.now() + 60_000), id: "contention-session",
      user: { displayName: "Owner", email: `${userId}@example.test`, id: userId, role: "user", status: "active" },
      userId
    }),
    storage
  });
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

function uploadRequest(): Request {
  const form = new FormData();
  form.set("file", new File([png], "contention.png", { type: "image/png" }));
  return new Request("http://app.local/api/uploads", { body: form, method: "POST" });
}

type Outcome<T> = Readonly<{ finishedMs: number } & (
  | { ok: true; value: T }
  | { code: string | null; detail: string | null; errorClass: string; ok: false }
)>;

/** When an operation settled and, for a failure, Prisma's own error class,
 * code and transaction or SQLSTATE detail, never a statement. */
function settled<T>(operation: Promise<T>, origin: number): Promise<Outcome<T>> {
  const finishedMs = () => Math.round(performance.now() - origin);
  return operation.then((value) => ({ finishedMs: finishedMs(), ok: true as const, value }), (error: unknown) => {
    const known = error instanceof Prisma.PrismaClientKnownRequestError ? error : null;
    const meta: Record<string, unknown> = known?.meta ?? {};
    return {
      code: known?.code ?? null,
      detail: typeof meta.code === "string" ? meta.code : typeof meta.error === "string" ? meta.error.slice(0, 72) : null,
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
      finishedMs: finishedMs(),
      ok: false as const
    };
  });
}

describe("Memory background commits and the owner's foreground writes", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps usage settlement, an upload and a stale-run failure writable during every rebuild pass", async () => {
    const userId = await createOwner("rebuild");
    let provider: Awaited<ReturnType<typeof configureEmbeddingProvider>> | null = null;
    try {
      await seedHistory(userId, HISTORY_CHATS, HISTORY_TURNS, 5_200);
      provider = await configureEmbeddingProvider(userId);
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      const rebuild = createPrismaMemoryRebuildRepository(prisma);
      const admitted = await rebuild.admit(userId, { embeddingDeploymentId: provider.modelId,
        expectedMemoryRevision: settings.memoryRevision, expectedSettingsRevision: settings.settingsRevision,
        operation: "REEMBED", pin: provider.pin, requestIdentity: { nonce: "contention" } });
      if (admitted.kind !== "ok") throw new Error(admitted.kind);
      const identity = parseMemoryRebuildJobFingerprint((await prisma.memoryJob.findUniqueOrThrow({
        where: { id: admitted.jobId } })).idempotencyFingerprint);
      if (!identity || identity.type !== "SHADOW") throw new Error("memory_contention_shadow_missing");
      const eligibleEntries = await prisma.memorySearchEntry.count({
        where: { indexGenerationId: settings.activeIndexGenerationId!, userId } });

      const runs = createPrismaRunRepository(prisma);
      const storage = createMemoryStorageAdapter();
      const POST = uploadHandler(userId, storage);
      const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
      const handler = createMemoryRebuildHandler(rebuild);
      const usage = normalizeTokenUsage({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
      const evidence: Array<Readonly<{ maintenance: boolean }>> = [];
      const fixtures: Array<{ failed: { assistantMessageId: string; runId: string };
        usage: { chatId: string; runId: string } }> = [];
      for (let pass = 0; pass < 30; pass += 1) {
        const job = await prisma.memoryJob.findUniqueOrThrow({ where: { id: admitted.jobId } });
        const generation = await prisma.memoryIndexGeneration.findUniqueOrThrow({ where: { id: identity.generationId } });
        // Every window pass while the entry set is built, then one embedding
        // progress pass of the completed set, woken as an embedding would.
        if (job.state === "SUCCEEDED") {
          if (evidence.some(({ maintenance }) => maintenance)) break;
          expect(generation.state).toBe("CATCHING_UP");
          await expect(prisma.$transaction((tx) => wakeCurrentMemoryShadowRebuildInTransaction(tx, userId)))
            .resolves.toBe(1);
        } else {
          // An unfinished entry set records no caught-up revision.
          expect([job.state, generation.state, generation.indexedThroughMemoryRevision])
            .toEqual(["QUEUED", "BUILDING", 0]);
        }
        const fixture = { failed: await createForegroundRun(runs, userId, `Stale ${pass}`),
          usage: await createForegroundRun(runs, userId, `Usage ${pass}`) };
        fixtures.push(fixture);
        const claim = await claimJob(admitted.jobId);
        await expect(handler.preflight(claim)).resolves.toEqual({ status: "READY" });
        const now = new Date();
        const result = await handler.execute(claim, { now: () => now, setStage: async () => undefined,
          signal: new AbortController().signal });
        let ownerHeld!: () => void;
        const held = new Promise<void>((resolve) => { ownerHeld = resolve; });
        const origin = performance.now();
        const commit = settled(coordinator.commitJobSuccess({
          acceptedResultHash: result.acceptedResultHash,
          // The coordinator calls apply once it holds the owner lock.
          apply: async (tx, committedClaim) => { ownerHeld(); return result.apply!(tx, committedClaim); },
          claim, now, stage: result.stage ?? null
        }), origin);
        await held;
        const [recorded, uploaded, failed] = await Promise.all([
          settled(runs.recordRunUsageEvents({ chatId: fixture.usage.chatId, runId: fixture.usage.runId, userId,
            usageAttributions: [{ modelId: "fake-qsa", provider: "fake", purpose: "chat_answer", usage }] }), origin),
          settled(POST(uploadRequest()).then((response) => response.status), origin),
          // The GET chat reconcile ends an orphaned run through this write.
          settled(runs.failRun(fixture.failed.runId, fixture.failed.assistantMessageId,
            { code: "run_orphaned", message: "Run stopped reporting progress and was marked failed." }), origin)
        ]);
        const memory = await commit;
        const outcome = { failed, maintenance: job.state === "SUCCEEDED", memory, pass, recorded, uploaded };
        evidence.push(outcome);
        console.info("memory_foreground_contention_pass", JSON.stringify(outcome));
        expect({ failed, memory, recorded, uploaded }).toEqual({
          failed: expect.objectContaining({ ok: true, value: true }),
          memory: expect.objectContaining({ ok: true, value: true }),
          recorded: expect.objectContaining({ ok: true, value: true }),
          uploaded: expect.objectContaining({ ok: true, value: 200 })
        });
      }
      console.info("memory_foreground_contention", JSON.stringify({ eligibleEntries, passes: evidence.length }));

      // Each pass wrote at most one window; the completed shadow holds every
      // eligible item once and waits for its vectors.
      expect(evidence.filter(({ maintenance }) => !maintenance).length)
        .toBe(Math.ceil(eligibleEntries / 500));
      expect(evidence.filter(({ maintenance }) => maintenance)).toHaveLength(1);
      const shadow = await prisma.memoryIndexGeneration.findUniqueOrThrow({ where: { id: identity.generationId } });
      expect(shadow.state).toBe("CATCHING_UP");
      expect(shadow.indexedThroughMemoryRevision).toBeGreaterThanOrEqual(settings.memoryRevision);
      await expect(prisma.memorySearchEntry.count({ where: { indexGenerationId: identity.generationId, userId } }))
        .resolves.toBe(eligibleEntries);
      // Provider-reported usage persisted exactly once per run; every stale
      // run ended once, and every uploaded object has its attachment row.
      for (const fixture of fixtures) {
        await expect(prisma.usageEvent.count({ where: { modelRunId: fixture.usage.runId, purpose: "chat_answer" } }))
          .resolves.toBe(1);
        await expect(prisma.modelRun.findUniqueOrThrow({ select: { errorPayload: true, status: true },
          where: { id: fixture.failed.runId } })).resolves.toMatchObject({
          errorPayload: { code: "run_orphaned" }, status: "error" });
      }
      const attachments = await prisma.attachment.findMany({ select: { storageKey: true }, where: { userId } });
      expect(attachments.map(({ storageKey }) => storageKey).sort()).toEqual([...storage.objects.keys()].sort());
      expect(attachments).toHaveLength(fixtures.length);
    } finally {
      await cleanupOwner(userId);
      await provider?.cleanup();
    }
  }, 600_000);

  it("never makes a foreign-key insert wait for a held Memory owner lock, yet still orders explicit owner locks", async () => {
    const userId = await createOwner("foreign-key");
    try {
      let ownerHeld!: () => void;
      const held = new Promise<void>((resolve) => { ownerHeld = resolve; });
      let releasedAt = 0;
      const memory = withLockedMemoryTransaction(prisma, userId, async () => {
        ownerHeld();
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        releasedAt = performance.now();
      }, { interactiveBounds: { maxWaitMs: 2_000, timeoutMs: 15_000 } });
      await held;
      const done = (operation: Promise<unknown>) => operation.then(() => performance.now());
      const [attachmentAt, chatAt, ownerLockAt] = await Promise.all([
        done(prisma.attachment.create({ data: { byteSize: 1, checksum: "0".repeat(64), fileName: "fk.png",
          kind: "image", metadata: {}, mimeType: "image/png", processingJob: { create: { ownerUserId: userId } },
          status: "processing", storageKey: `${userId}/${randomUUID()}-fk.png`, userId } })),
        done(prisma.chat.create({ data: { title: "Foreign key", userId } })),
        // Run settlement still serializes with Memory through the owner row.
        done(prisma.$transaction((tx) => tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE
        `), { timeout: 15_000, maxWait: 2_000 }))
      ]);
      await memory;
      expect(attachmentAt).toBeLessThan(releasedAt);
      expect(chatAt).toBeLessThan(releasedAt);
      expect(ownerLockAt).toBeGreaterThanOrEqual(releasedAt);
    } finally {
      await cleanupOwner(userId);
    }
  }, 60_000);

  it("yields a background commit's owner wait to a foreground holder and retries a usage write past one", async () => {
    const userId = await createOwner("yield");
    const writer = vi.spyOn(process.stdout, "write");
    try {
      const runs = createPrismaRunRepository(prisma);
      const usageRun = await createForegroundRun(runs, userId, "Usage behind a long owner lock");
      const exhaustedRun = await createForegroundRun(runs, userId, "Usage behind a longer owner lock");
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      const job = await prisma.memoryJob.create({ data: {
        idempotencyFingerprint: `memory-contention-yield-${randomUUID()}`, kind: "RECLASSIFY_FACTS",
        memoryGenerationSnapshot: settings.memoryGeneration, memoryRevisionSnapshot: settings.memoryRevision,
        pipelineVersion: MEMORY_RECLASSIFICATION_PIPELINE_VERSION, userId
      } });
      const holdOwner = (milliseconds: number) => {
        let ownerHeld!: () => void;
        const held = new Promise<void>((resolve) => { ownerHeld = resolve; });
        const holder = prisma.$transaction(async (tx) => {
          await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`);
          ownerHeld();
          await new Promise((resolve) => setTimeout(resolve, milliseconds));
        }, { maxWait: 2_000, timeout: milliseconds + 5_000 });
        return { held, holder };
      };
      writer.mockImplementation(() => true);

      const first = holdOwner(2_500);
      await first.held;
      const usage = normalizeTokenUsage({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
      const claim = await claimJob(job.id);
      const [committed, recorded] = await Promise.all([
        createPrismaMemoryCoordinatorRepository(prisma).commitJobSuccess({ acceptedResultHash: "c".repeat(64), claim,
          now: new Date(), stage: "contention_settled" }),
        runs.recordRunUsageEvents({ chatId: usageRun.chatId, runId: usageRun.runId, userId,
          usageAttributions: [{ modelId: "fake-qsa", provider: "fake", purpose: "chat_answer", usage }] })
      ]);
      await first.holder;
      expect([committed, recorded]).toEqual([true, true]);
      const records = writer.mock.calls.flatMap(([chunk]) => {
        try { return [JSON.parse(String(chunk)) as Record<string, unknown>]; } catch { return []; }
      });
      expect(records).toContainEqual(expect.objectContaining({ event: "job_persistence", stage: "complete",
        action: "retry", prisma_code: "P2010", db_failure: "lock_timeout" }));
      await expect(prisma.usageEvent.count({ where: { modelRunId: usageRun.runId } })).resolves.toBe(1);

      // Past three bounded waits the rolled-back write ends with its lock
      // timeout instead of an expired transaction, and writes nothing.
      const second = holdOwner(7_500);
      await second.held;
      const exhausted = await runs.recordRunUsageEvents({ chatId: exhaustedRun.chatId, runId: exhaustedRun.runId,
        userId, usageAttributions: [{ modelId: "fake-qsa", provider: "fake", purpose: "chat_answer", usage }] })
        .catch((error: unknown) => error);
      await second.holder;
      expect(exhausted).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(databaseFailureKind(exhausted)).toBe("lock_timeout");
      await expect(prisma.usageEvent.count({ where: { modelRunId: exhaustedRun.runId } })).resolves.toBe(0);
    } finally {
      writer.mockRestore();
      await cleanupOwner(userId);
    }
  }, 60_000);

  it("writes a large catch-up diff in requeued windows and leaves exact round segments untouched", async () => {
    const userId = await createOwner("window");
    try {
      await seedHistory(userId, 3, 2, 400);
      const segmentRows = () => prisma.$queryRaw<Array<{ id: string; version: string }>>(Prisma.sql`
        SELECT segment."id", segment."xmin"::text AS "version" FROM "MemoryRecallRoundSegment" AS segment
        WHERE segment."userId" = ${userId} ORDER BY segment."id"
      `);
      const segmentsBefore = await segmentRows();
      expect(segmentsBefore.length).toBeGreaterThan(0);
      const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
      const repository = createPrismaMemoryRebuildRepository(prisma, { catchUpWriteWindow: 2 });
      const admitted = await repository.admit(userId, { expectedMemoryRevision: settings.memoryRevision,
        expectedSettingsRevision: settings.settingsRevision, operation: "REBUILD_SEARCH_INDEX",
        requestIdentity: { nonce: "window" } });
      if (admitted.kind !== "ok") throw new Error(admitted.kind);
      const identity = parseMemoryRebuildJobFingerprint((await prisma.memoryJob.findUniqueOrThrow({
        where: { id: admitted.jobId } })).idempotencyFingerprint);
      if (!identity || identity.type !== "SHADOW") throw new Error("memory_contention_shadow_missing");
      const eligible = await prisma.memorySearchEntry.findMany({
        select: { itemType: true, recallChunkId: true, recallRoundSegmentId: true },
        where: { indexGenerationId: settings.activeIndexGenerationId!, userId }
      });
      const handler = createMemoryRebuildHandler(repository);
      const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
      const entryCounts: number[] = [];
      for (let pass = 0; pass < 40; pass += 1) {
        const job = await prisma.memoryJob.findUniqueOrThrow({ where: { id: admitted.jobId } });
        if (job.state !== "QUEUED") break;
        const claim = await claimJob(job.id);
        await expect(handler.preflight(claim)).resolves.toEqual({ status: "READY" });
        const now = new Date();
        const result = await handler.execute(claim, { now: () => now, setStage: async () => undefined,
          signal: new AbortController().signal });
        expect(await coordinator.commitJobSuccess({ acceptedResultHash: result.acceptedResultHash,
          apply: result.apply, claim, now, stage: result.stage ?? null })).toBe(true);
        entryCounts.push(await prisma.memorySearchEntry.count({ where: { indexGenerationId: identity.generationId, userId } }));
        const generation = await prisma.memoryIndexGeneration.findUniqueOrThrow({ where: { id: identity.generationId } });
        if (generation.state !== "ACTIVE") expect(generation.state).toBe("BUILDING");
      }
      // Two entry writes per pass, each pass queued again; the pass that
      // writes the last window proves the whole set and cuts over.
      expect(entryCounts).toEqual(Array.from({ length: Math.ceil(eligible.length / 2) },
        (_, index) => Math.min(eligible.length, 2 * (index + 1))));
      await expect(prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }))
        .resolves.toMatchObject({ activeIndexGenerationId: identity.generationId });
      const published = await prisma.memorySearchEntry.findMany({
        select: { itemType: true, recallChunkId: true, recallRoundSegmentId: true },
        where: { indexGenerationId: identity.generationId, userId }
      });
      const key = (entry: (typeof eligible)[number]) =>
        `${entry.itemType}:${entry.recallChunkId ?? ""}:${entry.recallRoundSegmentId ?? ""}`;
      expect(published.map(key).sort()).toEqual(eligible.map(key).sort());
      await expect(segmentRows()).resolves.toEqual(segmentsBefore);
    } finally {
      await cleanupOwner(userId);
    }
  }, 120_000);
});

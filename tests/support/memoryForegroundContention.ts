import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma } from "@prisma/client";
import { textMessageContent } from "@/lib/domain/content";
import { providerTemplateIds } from "@/lib/domain/providerTemplates";
import { prisma } from "@/lib/server/prisma";
import type { MemoryJobClaim } from "@/lib/server/memory/coordinator/types";
import type { MemoryItemEmbeddingPin } from "@/lib/server/memory/embedding/contract";
import {
  memoryVectorSpaceFingerprint,
  resolveCurrentMemoryUtilityPolicy
} from "@/lib/server/memory/execution/policy";
import { MEMORY_CONTEXTUAL_KEY_POLICY_VERSION, MEMORY_RECALL_ROUND_PROJECTION_VERSION } from
  "@/lib/server/memory/history/rounds";
import { MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION } from "@/lib/server/memory/history/segments";
import {
  MEMORY_LEXICAL_ANALYSIS_PROFILE,
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_NORMALIZATION_VERSION
} from "@/lib/server/memory/persistence/lexical";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from "@/lib/server/memory/retrieval/vector";
import { initializeMemoryLexicalProjectionState } from "@/lib/server/memory/searchProjection/repository";
import { defaultMemorySourceMutationHooks } from "@/lib/server/memory/sourceHooks";
import { applyMemorySourceMutations, lockMemorySourceChat } from "@/lib/server/memory/sourceState";
import type { RunRepository } from "@/lib/server/runs/runRepositoryContract";
import { createUploadHandler } from "@/lib/server/uploads/handlers";
import type { createMemoryStorageAdapter } from "./storage";

// Shared by the stateful suites proving that background Memory commits keep
// the owner's foreground writes (run settlement, uploads) and the source
// chat's own writers within their budgets. Fixtures are synthetic.

const EMBEDDING_DIMENSION = 1_024;
const words = ["alpha", "harbor", "copper", "lantern", "meadow", "quartz", "violet", "summit", "falcon", "ember",
  "glacier", "orchard", "pixel", "rhythm", "saffron", "timber", "umbra", "vertex", "willow", "zephyr"];

/** Deterministic plain text of about `characters` characters. */
export function syntheticText(seed: number, characters: number, label: string): string {
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

export async function createContentionOwner(label: string): Promise<string> {
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

export async function cleanupContentionOwner(userId: string): Promise<void> {
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
  await prisma.attachment.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

export function mutateContentionSource(userId: string, chatId: string,
  input: Omit<Parameters<typeof applyMemorySourceMutations>[1], "chat" | "hooks">) {
  return prisma.$transaction(async (tx) => {
    const chat = await lockMemorySourceChat(tx, { chatId, lock: "UPDATE", userId });
    if (!chat) throw new Error("memory_contention_chat_missing");
    return applyMemorySourceMutations(tx, { ...input, chat, hooks: defaultMemorySourceMutationHooks });
  }, { timeout: 30_000 });
}

/** Claims one job directly, as the coordinator's claim would. */
export async function claimContentionJob(jobId: string): Promise<MemoryJobClaim> {
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

export type ContentionEmbedding = Readonly<{
  cleanup(): Promise<void>;
  connectionId: string;
  modelId: string;
  pin: MemoryItemEmbeddingPin;
}>;

/** An owner-granted embedding model with stored availability evidence; no
 * call ever reaches its synthetic endpoint. */
export async function configureContentionEmbedding(userId: string): Promise<ContentionEmbedding> {
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
    connectionId,
    modelId,
    pin: { configurationFingerprint: target.compatibilityFingerprints.configFingerprint, connectionId,
      dimension: EMBEDDING_DIMENSION, providerModelId: modelId, vectorSpaceFingerprint }
  };
}

/** Makes a vector (HYBRID) generation on the embedding the owner's active
 * index before any history exists, as an owner with vector search has. */
export async function activateContentionVectorIndex(userId: string, embedding: ContentionEmbedding): Promise<string> {
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
  const latest = await prisma.memoryIndexGeneration.aggregate({ _max: { generation: true }, where: { userId } });
  const now = new Date();
  const generation = await prisma.memoryIndexGeneration.create({ data: {
    chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION, contextualKeyPolicyVersion: MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
    embeddingConfigurationFingerprint: embedding.pin.configurationFingerprint,
    embeddingConnectionId: embedding.connectionId, embeddingDimension: EMBEDDING_DIMENSION,
    embeddingProviderModelId: embedding.modelId, generation: (latest._max.generation ?? -1) + 1, indexMode: "HYBRID",
    indexedThroughMemoryRevision: settings.memoryRevision, languageProfile: MEMORY_LEXICAL_ANALYSIS_PROFILE,
    normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION, readyAt: now,
    retrievalPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
    roundProjectionVersion: MEMORY_RECALL_ROUND_PROJECTION_VERSION,
    roundSegmentProjectionVersion: MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION,
    state: "READY", targetMemoryRevision: settings.memoryRevision, userId,
    vectorSpaceFingerprint: embedding.pin.vectorSpaceFingerprint
  } });
  await prisma.$transaction(async (tx) => {
    await initializeMemoryLexicalProjectionState(tx, { indexGenerationId: generation.id,
      targetMemoryRevision: settings.memoryRevision, userId });
    await tx.userMemorySettings.update({ data: { activeIndexGenerationId: generation.id }, where: { userId } });
    await tx.memoryIndexGeneration.update({ data: { activatedAt: now, state: "ACTIVE" }, where: { id: generation.id } });
  });
  return generation.id;
}

/** A queued personal run in its own chat, as the owner's next message makes. */
export async function createForegroundRun(repository: RunRepository, userId: string, title: string) {
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
export function contentionUploadHandler(userId: string, storage: ReturnType<typeof createMemoryStorageAdapter>) {
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

export function contentionUploadRequest(): Request {
  const form = new FormData();
  form.set("file", new File([png], "contention.png", { type: "image/png" }));
  return new Request("http://app.local/api/uploads", { body: form, method: "POST" });
}

export type ContentionOutcome<T> = Readonly<{ finishedMs: number } & (
  | { ok: true; value: T }
  | { code: string | null; detail: string | null; errorClass: string; ok: false }
)>;

/** When an operation settled and, for a failure, Prisma's own error class,
 * code and transaction or SQLSTATE detail, never a statement. */
export function settled<T>(operation: Promise<T>, origin: number): Promise<ContentionOutcome<T>> {
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

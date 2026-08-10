import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import {
  fuseMemoryRetrievalCandidates,
  MEMORY_CONTEXT_HARD_CAP_TOKENS,
  packMemoryPersonalContext,
  planMemoryRetrieval,
  type MemoryRankedCandidate
} from "../../../domain/memory/retrieval";
import { prisma } from "../../prisma";
import {
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
  memorySha256,
  normalizeMemorySearchText,
  normalizeMemorySearchTextYo
} from "../persistence/lexical";
import { createPrismaLocalMemoryRetrievalRepository } from "./localRepository";

const fixtureNow = new Date("2026-08-10T12:00:00.000Z");
const suffix = randomUUID();
const ownerIds: string[] = [];

type RetrievalFixture = Readonly<{
  currentChatId: string;
  enFactVersionId: string;
  episodeId: string;
  excludedChunkId: string;
  foreignFactVersionId: string;
  generationId: string;
  historicalFactVersionId: string;
  otherFolderFactVersionId: string;
  rawSourceText: string;
  ruFactVersionId: string;
  safeChunkText: string;
  secretChunkId: string;
  sensitiveFactVersionId: string;
  sourceChatId: string;
  staleAutomaticFactVersionId: string;
  staleChunkId: string;
  userId: string;
  validChunkId: string;
}>;

let fixture: RetrievalFixture;

async function createOwner(prefix: string): Promise<string> {
  const userId = `${prefix}-${suffix}`;
  ownerIds.push(userId);
  await prisma.user.create({
    data: {
      displayName: `Memory retrieval ${prefix}`,
      email: `${prefix}-${suffix}@example.test`,
      id: userId,
      status: "active"
    }
  });
  return userId;
}

async function activateLexicalGeneration(userId: string): Promise<string> {
  const generation = await prisma.memoryIndexGeneration.create({
    data: {
      chunkingVersion: "memory-history-chunking-v1",
      generation: 0,
      indexMode: "LEXICAL_ONLY",
      indexedThroughMemoryRevision: 0,
      languageProfile: "RU_EN_MULTILINGUAL_V1",
      normalizationVersion: "memory-search-normalization-v1",
      readyAt: fixtureNow,
      retrievalPipelineVersion: MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
      state: "READY",
      targetMemoryRevision: 0,
      userId
    }
  });
  await prisma.$transaction(async (tx) => {
    await tx.userMemorySettings.update({
      data: {
        activeIndexGenerationId: generation.id,
        referenceChatHistory: true,
        useMemoryFacts: true
      },
      where: { userId }
    });
    await tx.memoryIndexGeneration.update({
      data: { activatedAt: fixtureNow, state: "ACTIVE" },
      where: { id: generation.id }
    });
  });
  return generation.id;
}

async function createChatWithLeaf(input: Readonly<{
  memoryMode?: "EXCLUDED" | "NORMAL" | "TEMPORARY";
  sourceRevision?: number;
  title: string;
  userId: string;
  userText: string;
}>): Promise<Readonly<{ chatId: string; messageId: string }>> {
  const chat = await prisma.chat.create({
    data: {
      memoryMode: input.memoryMode ?? "NORMAL",
      memorySourceRevision: input.sourceRevision ?? 1,
      title: input.title,
      userId: input.userId
    }
  });
  const message = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent(input.userText),
      createdAt: new Date("2026-07-15T09:00:00.000Z"),
      role: "user",
      status: "complete",
      updatedAt: new Date("2026-07-15T09:00:00.000Z")
    }
  });
  await prisma.chat.update({
    data: { activeLeafMessageId: message.id },
    where: { id: chat.id }
  });
  return { chatId: chat.id, messageId: message.id };
}

async function createCheckpoint(input: Readonly<{
  chatId: string;
  messageId: string;
  sourceHash: string;
  userId: string;
}>): Promise<void> {
  await prisma.chatMemoryCheckpoint.create({
    data: {
      activeLeafMessageId: input.messageId,
      branchGeneration: 0,
      chatId: input.chatId,
      lastDreamedMessageId: input.messageId,
      lastIndexedMessageId: input.messageId,
      lastSucceededAt: fixtureNow,
      sourceContentHash: input.sourceHash,
      sourceRevision: 1,
      status: "READY",
      userId: input.userId
    }
  });
}

async function createFact(input: Readonly<{
  canonicalKey: string;
  displayText: string;
  generationId: string;
  languageCode: string;
  scopeFolderId?: string;
  sensitivityClass?: "NORMAL" | "SECRET" | "SENSITIVE";
  source?: Readonly<{ branchGeneration: number; chatId: string; messageId: string }>;
  sourceMode?: "AUTOMATIC" | "EXPLICIT";
  userId: string;
}>): Promise<string> {
  const sourceMode = input.sourceMode ?? "EXPLICIT";
  const event = await prisma.memoryEvent.create({
    data: {
      actorType: sourceMode === "EXPLICIT" ? "USER" : "JOB",
      actorUserId: sourceMode === "EXPLICIT" ? input.userId : null,
      operation: sourceMode === "EXPLICIT" ? "EXPLICIT_SAVE" : "PROMOTE",
      sourceChatId: input.source?.chatId ?? null,
      sourceGeneration: input.source?.branchGeneration ?? null,
      userId: input.userId
    }
  });
  const scope = input.scopeFolderId
    ? await prisma.memoryScope.create({
        data: {
          folderId: input.scopeFolderId,
          scopeType: "FOLDER",
          targetDisplaySnapshot: "Other folder",
          targetIdSnapshot: input.scopeFolderId,
          userId: input.userId
        }
      })
    : (await prisma.memoryScope.findFirst({
        where: {
          scopeType: "GLOBAL_USER",
          state: "ACTIVE",
          userId: input.userId
        }
      })) ?? await prisma.memoryScope.create({
        data: { scopeType: "GLOBAL_USER", userId: input.userId }
      });
  const normalized = normalizeMemorySearchText(input.displayText);
  const factId = randomUUID();
  const versionId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.memoryFact.create({
      data: {
        canonicalKey: input.canonicalKey,
        category: "preference",
        currentVersionId: versionId,
        id: factId,
        scopeId: scope.id,
        state: "ACTIVE",
        userId: input.userId
      }
    });
    await tx.memoryFactVersion.create({
      data: {
        category: "preference",
        confidence: 1,
        createdByEventId: event.id,
        directness: "DIRECT",
        displayText: input.displayText,
        factId,
        id: versionId,
        importance: 0.9,
        languageCode: input.languageCode,
        modality: "PREFERENCE",
        normalizedSearchText: normalized,
        pipelineVersion: "memory-retrieval-test-v1",
        sensitivityClass: input.sensitivityClass ?? "NORMAL",
        sourceMode,
        state: "ACTIVE",
        structuredValue: { statement: input.displayText },
        userId: input.userId
      }
    });
    await tx.memoryEvidence.create({
      data: sourceMode === "EXPLICIT"
        ? {
            factVersionId: versionId,
            memoryEventId: event.id,
            observedAt: fixtureNow,
            safeExcerpt: input.displayText,
            safeSourceHash: memorySha256(input.displayText),
            safetyClass: input.sensitivityClass ?? "NORMAL",
            sourceProjectionVersion: "memory-retrieval-test-v1",
            sourceType: "EXPLICIT_ACTION",
            stance: "SUPPORTS",
            userId: input.userId
          }
        : {
            branchGeneration: input.source!.branchGeneration,
            chatId: input.source!.chatId,
            factVersionId: versionId,
            messageId: input.source!.messageId,
            observedAt: fixtureNow,
            safeExcerpt: input.displayText,
            safeSourceHash: memorySha256(input.displayText),
            safetyClass: input.sensitivityClass ?? "NORMAL",
            sourceProjectionVersion: "memory-retrieval-test-v1",
            sourceRole: "user",
            sourceType: "MESSAGE",
            stance: "SUPPORTS",
            userId: input.userId
          }
    });
    await tx.memorySearchEntry.create({
      data: {
        embeddingState: "NOT_APPLICABLE",
        factVersionId: versionId,
        indexGenerationId: input.generationId,
        itemType: "FACT_VERSION",
        languageCode: input.languageCode,
        safeContentHash: memorySha256({ displayText: input.displayText }),
        safeSearchText: normalized,
        safeSearchTextYoNormalized: normalizeMemorySearchTextYo(input.displayText),
        safetyIdentitySnapshot: memorySha256({ sensitivity: input.sensitivityClass ?? "NORMAL" }),
        sourceIdentitySnapshot: memorySha256({ sourceMode, versionId }),
        suppressionIdentitySnapshot: memorySha256({
          canonicalKey: input.canonicalKey,
          normalizedValue: normalized
        }),
        userId: input.userId
      }
    });
  });
  return versionId;
}

async function createHistoricalFactVersion(input: Readonly<{
  currentVersionId: string;
  displayText: string;
  userId: string;
  validFrom: Date;
  validTo: Date;
}>): Promise<string> {
  const current = await prisma.memoryFactVersion.findUniqueOrThrow({
    select: { category: true, factId: true },
    where: { id: input.currentVersionId }
  });
  const event = await prisma.memoryEvent.create({
    data: {
      actorType: "USER",
      actorUserId: input.userId,
      factId: current.factId,
      operation: "EDIT",
      userId: input.userId
    }
  });
  const versionId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.memoryFactVersion.create({
      data: {
        category: current.category,
        confidence: 1,
        createdAt: input.validFrom,
        createdByEventId: event.id,
        directness: "DIRECT",
        displayText: input.displayText,
        factId: current.factId,
        id: versionId,
        importance: 0.9,
        languageCode: "en",
        modality: "PREFERENCE",
        normalizedSearchText: normalizeMemorySearchText(input.displayText),
        pipelineVersion: "memory-retrieval-test-v1",
        sensitivityClass: "NORMAL",
        sourceMode: "EXPLICIT",
        state: "SUPERSEDED",
        structuredValue: { statement: input.displayText },
        systemFrom: input.validFrom,
        systemTo: input.validTo,
        temporalResolverVersion: "memory-temporal-resolver-v1",
        userId: input.userId,
        validFrom: input.validFrom,
        validTo: input.validTo
      }
    });
    await tx.memoryEvidence.create({
      data: {
        factVersionId: versionId,
        memoryEventId: event.id,
        observedAt: input.validFrom,
        safeExcerpt: input.displayText,
        safeSourceHash: memorySha256(input.displayText),
        safetyClass: "NORMAL",
        sourceProjectionVersion: "memory-retrieval-test-v1",
        sourceType: "EXPLICIT_ACTION",
        stance: "SUPPORTS",
        userId: input.userId
      }
    });
  });
  return versionId;
}

async function createChunk(input: Readonly<{
  branchGeneration?: number;
  chatId: string;
  chunkOrdinal?: number;
  generationId: string;
  messageId: string;
  safetyClass?: "HIGHLY_SENSITIVE" | "NORMAL";
  safeText: string;
  state?: "ACTIVE" | "INVALIDATED";
  suppressionSnapshot: string;
  userId: string;
}>): Promise<string> {
  const contentHash = memorySha256({ chatId: input.chatId, safeText: input.safeText });
  const chunk = await prisma.memoryRecallChunk.create({
    data: {
      branchGeneration: input.branchGeneration ?? 0,
      chatId: input.chatId,
      chunkOrdinal: input.chunkOrdinal ?? 0,
      chunkingVersion: "memory-history-chunking-v1",
      contentHash,
      languageCode: "ru",
      normalizedSafeSearchText: normalizeMemorySearchText(input.safeText),
      occurredFrom: new Date("2026-07-15T09:00:00.000Z"),
      occurredTo: new Date("2026-07-15T09:05:00.000Z"),
      redactionState: "NOT_NEEDED",
      safeProjectedText: input.safeText,
      safetyClass: input.safetyClass ?? "NORMAL",
      sourceProjectionVersion: "memory-history-source-projection-v1",
      sourceRevisionAtCreation: 1,
      state: input.state ?? "ACTIVE",
      invalidatedAt: input.state === "INVALIDATED" ? fixtureNow : null,
      userId: input.userId
    }
  });
  await prisma.memoryRecallChunkMessage.create({
    data: {
      chatId: input.chatId,
      chunkId: chunk.id,
      messageId: input.messageId,
      ordinal: 0,
      role: "user",
      userId: input.userId
    }
  });
  await prisma.memorySearchEntry.create({
    data: {
      embeddingState: "NOT_APPLICABLE",
      indexGenerationId: input.generationId,
      itemType: "RECALL_CHUNK",
      languageCode: "ru",
      recallChunkId: chunk.id,
      safeContentHash: contentHash,
      safeSearchText: normalizeMemorySearchText(input.safeText),
      safeSearchTextYoNormalized: normalizeMemorySearchTextYo(input.safeText),
      safetyIdentitySnapshot: memorySha256({ safety: input.safetyClass ?? "NORMAL" }),
      sourceIdentitySnapshot: memorySha256({ branch: input.branchGeneration ?? 0, chunkId: chunk.id }),
      suppressionIdentitySnapshot: input.suppressionSnapshot,
      userId: input.userId
    }
  });
  return chunk.id;
}

async function createEpisode(input: Readonly<{
  chatId: string;
  generationId: string;
  messageId: string;
  safeSummary: string;
  sourceHash: string;
  suppressionSnapshot: string;
  userId: string;
}>): Promise<string> {
  const job = await prisma.memoryJob.create({
    data: {
      activeLeafMessageId: input.messageId,
      branchGeneration: 0,
      chatId: input.chatId,
      completedAt: fixtureNow,
      idempotencyFingerprint: memorySha256({ episode: input.safeSummary, job: true }),
      kind: "EXTRACT_EPISODE",
      memoryGenerationSnapshot: 0,
      memoryRevisionSnapshot: 0,
      pipelineVersion: "memory-episode-test-v1",
      sourceHash: input.sourceHash,
      sourceRevision: 1,
      state: "SUCCEEDED",
      userId: input.userId
    }
  });
  const binding = await prisma.memoryExecutionBinding.create({
    data: {
      acceptedOutputHash: memorySha256(input.safeSummary),
      completedAt: fixtureNow,
      createdAt: new Date(fixtureNow.getTime() - 60_000),
      destinationFingerprint: "d".repeat(64),
      inputHash: memorySha256({ sourceHash: input.sourceHash }),
      logicalRole: "MEMORY_EPISODE_EXTRACT",
      memoryJobId: job.id,
      ordinal: 0,
      ownerType: "JOB",
      pipelineVersion: "memory-episode-test-v1",
      policyVersion: "memory-episode-test-policy-v1",
      promptVersion: "memory-episode-test-prompt-v1",
      providerId: "memory-retrieval-test-provider",
      recoverableUntil: fixtureNow,
      relationsDetachedAt: fixtureNow,
      schemaVersion: "memory-episode-test-schema-v1",
      secretFreeExecutionSnapshot: {},
      state: "SUCCEEDED",
      userId: input.userId
    }
  });
  const episode = await prisma.memoryEpisode.create({
    data: {
      branchGeneration: 0,
      chatId: input.chatId,
      createdByExecutionId: binding.id,
      extractorRole: "SYSTEM_MEMORY",
      languageCode: "ru",
      normalizedSafeSearchText: normalizeMemorySearchText(input.safeSummary),
      occurredFrom: new Date("2026-07-15T09:00:00.000Z"),
      occurredTo: new Date("2026-07-15T09:05:00.000Z"),
      pipelineVersion: "memory-episode-test-v1",
      redactionState: "NOT_NEEDED",
      safeSummary: input.safeSummary,
      safetyClass: "NORMAL",
      sourceHash: input.sourceHash,
      sourceProjectionVersion: "memory-history-source-projection-v1",
      sourceRevisionAtCreation: 1,
      state: "ACTIVE",
      userId: input.userId
    }
  });
  await prisma.memoryEpisodeMessage.create({
    data: {
      chatId: input.chatId,
      episodeId: episode.id,
      messageId: input.messageId,
      ordinal: 0,
      userId: input.userId
    }
  });
  await prisma.memorySearchEntry.create({
    data: {
      embeddingState: "NOT_APPLICABLE",
      episodeId: episode.id,
      indexGenerationId: input.generationId,
      itemType: "EPISODE",
      languageCode: "ru",
      safeContentHash: memorySha256(input.safeSummary),
      safeSearchText: normalizeMemorySearchText(input.safeSummary),
      safeSearchTextYoNormalized: normalizeMemorySearchTextYo(input.safeSummary),
      safetyIdentitySnapshot: memorySha256({ safety: "NORMAL" }),
      sourceIdentitySnapshot: memorySha256({ episodeId: episode.id }),
      suppressionIdentitySnapshot: input.suppressionSnapshot,
      userId: input.userId
    }
  });
  return episode.id;
}

function percentile95(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0;
}

function topFive(
  result: Awaited<ReturnType<ReturnType<typeof createPrismaLocalMemoryRetrievalRepository>["retrieve"]>>,
  query: string
): readonly MemoryRankedCandidate[] {
  return fuseMemoryRetrievalCandidates(
    planMemoryRetrieval({ currentUserText: query, now: fixtureNow }),
    result.laneResults,
    fixtureNow
  ).slice(0, 5);
}

describe("local Memory retrieval on PostgreSQL", () => {
  beforeAll(async () => {
    const userId = await createOwner("memory-local-owner");
    const foreignUserId = await createOwner("memory-local-foreign");
    const generationId = await activateLexicalGeneration(userId);
    const foreignGenerationId = await activateLexicalGeneration(foreignUserId);
    const current = await createChatWithLeaf({
      sourceRevision: 0,
      title: "Current retrieval chat",
      userId,
      userText: "current request"
    });
    const rawSourceText = "RAW_MESSAGE_CONTENT_MUST_NEVER_BE_EXPANDED";
    const source = await createChatWithLeaf({
      title: "Миграция PostgreSQL",
      userId,
      userText: rawSourceText
    });
    const sourceHash = memorySha256({ source: "retrieval-source" });
    await createCheckpoint({
      chatId: source.chatId,
      messageId: source.messageId,
      sourceHash,
      userId
    });
    const suppressionSnapshot = memorySha256({ barriers: [], suppressions: [] });
    const safeChunkText = "Мы обсуждали безопасный план миграции PostgreSQL для MacBook без исходного сообщения.";
    const validChunkId = await createChunk({
      chatId: source.chatId,
      generationId,
      messageId: source.messageId,
      safeText: safeChunkText,
      suppressionSnapshot,
      userId
    });
    const episodeId = await createEpisode({
      chatId: source.chatId,
      generationId,
      messageId: source.messageId,
      safeSummary: "Обсуждение миграции PostgreSQL в июле.",
      sourceHash,
      suppressionSnapshot,
      userId
    });
    const staleChunkId = await createChunk({
      chatId: source.chatId,
      chunkOrdinal: 1,
      generationId,
      messageId: source.messageId,
      safeText: "Устаревшая ветка миграции PostgreSQL.",
      state: "INVALIDATED",
      suppressionSnapshot,
      userId
    });
    const excluded = await createChatWithLeaf({
      memoryMode: "EXCLUDED",
      title: "Excluded source",
      userId,
      userText: "excluded source"
    });
    const excludedChunkId = await createChunk({
      chatId: excluded.chatId,
      generationId,
      messageId: excluded.messageId,
      safeText: "Excluded PostgreSQL migration source.",
      state: "INVALIDATED",
      suppressionSnapshot,
      userId
    });
    const secretChunkId = await createChunk({
      chatId: source.chatId,
      chunkOrdinal: 2,
      generationId,
      messageId: source.messageId,
      safeText: "Secret-tainted PostgreSQL migration source.",
      safetyClass: "HIGHLY_SENSITIVE",
      suppressionSnapshot,
      userId
    });
    const otherFolder = await prisma.folder.create({
      data: { name: "Other folder", userId }
    });
    const enFactVersionId = await createFact({
      canonicalKey: "profile.preferred_editor",
      displayText: "My preferred editor is Neovim.",
      generationId,
      languageCode: "en",
      userId
    });
    const historicalFactVersionId = await createHistoricalFactVersion({
      currentVersionId: enFactVersionId,
      displayText: "My preferred editor was Vim in July 2025.",
      userId,
      validFrom: new Date("2025-07-01T00:00:00.000Z"),
      validTo: new Date("2025-08-01T00:00:00.000Z")
    });
    const ruFactVersionId = await createFact({
      canonicalKey: "preference.editor_ru",
      displayText: "Мой предпочтительный редактор — Helix.",
      generationId,
      languageCode: "ru",
      userId
    });
    const otherFolderFactVersionId = await createFact({
      canonicalKey: "workflow.editor",
      displayText: "My preferred editor is forbidden-folder Vim.",
      generationId,
      languageCode: "en",
      scopeFolderId: otherFolder.id,
      userId
    });
    const sensitiveFactVersionId = await createFact({
      canonicalKey: "profile.sensitive_editor",
      displayText: "My preferred editor reveals a sensitive private detail.",
      generationId,
      languageCode: "en",
      sensitivityClass: "SENSITIVE",
      userId
    });
    const staleAutomaticFactVersionId = await createFact({
      canonicalKey: "profile.stale_editor",
      displayText: "My preferred editor is stale-branch Emacs.",
      generationId,
      languageCode: "en",
      source: { branchGeneration: 1, chatId: source.chatId, messageId: source.messageId },
      sourceMode: "AUTOMATIC",
      userId
    });
    const foreignFactVersionId = await createFact({
      canonicalKey: "profile.preferred_editor",
      displayText: "My preferred editor is foreign-tenant VS Code.",
      generationId: foreignGenerationId,
      languageCode: "en",
      userId: foreignUserId
    });
    fixture = {
      currentChatId: current.chatId,
      enFactVersionId,
      episodeId,
      excludedChunkId,
      foreignFactVersionId,
      generationId,
      historicalFactVersionId,
      otherFolderFactVersionId,
      rawSourceText,
      ruFactVersionId,
      safeChunkText,
      secretChunkId,
      sensitiveFactVersionId,
      sourceChatId: source.chatId,
      staleAutomaticFactVersionId,
      staleChunkId,
      userId,
      validChunkId
    };
  });

  afterAll(async () => {
    for (const userId of ownerIds.reverse()) {
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await prisma.$disconnect();
  });

  it("keeps RU/EN relevant facts in Recall@5 and excludes tenant/scope/source/safety violations", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const enQuery = "What is my preferred editor?";
    const enResult = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan: planMemoryRetrieval({ currentUserText: enQuery, now: fixtureNow }),
      userId: fixture.userId
    });
    const enTop = topFive(enResult, enQuery);
    expect(enTop.map((item) => item.itemId)).toContain(fixture.enFactVersionId);
    const allEnIds = enResult.laneResults.flatMap((lane) => lane.candidates.map((item) => item.itemId));
    expect(allEnIds).not.toContain(fixture.foreignFactVersionId);
    expect(allEnIds).not.toContain(fixture.otherFolderFactVersionId);
    expect(allEnIds).not.toContain(fixture.sensitiveFactVersionId);
    expect(allEnIds).not.toContain(fixture.staleAutomaticFactVersionId);

    const ruQuery = "Какой мой предпочтительный редактор?";
    const ruResult = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan: planMemoryRetrieval({ currentUserText: ruQuery, now: fixtureNow }),
      userId: fixture.userId
    });
    expect(topFive(ruResult, ruQuery).map((item) => item.itemId)).toContain(
      fixture.ruFactVersionId
    );
  });

  it("uses a dated historical version without substituting an undated current fact", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const query = "Which editor did I prefer in July 2025?";
    const plan = planMemoryRetrieval({ currentUserText: query, now: fixtureNow });
    const result = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan,
      userId: fixture.userId
    });
    const ranked = fuseMemoryRetrievalCandidates(plan, result.laneResults, fixtureNow);
    expect(ranked.map((item) => item.itemId)).toContain(fixture.historicalFactVersionId);
    expect(ranked.map((item) => item.itemId)).not.toContain(fixture.enFactVersionId);
    const expanded = await repository.expand(result.snapshot, plan, ranked);
    const pack = packMemoryPersonalContext({ expanded, plan, ranked });
    expect(pack.text).toContain("historical state");
    expect(pack.text).toContain("Vim in July 2025");
    expect(pack.text).not.toContain("Neovim");
  });

  it("retrieves only current safe source projections and expands an episode through a safe chunk", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const query = "Когда мы обсуждали миграцию PostgreSQL в предыдущем чате?";
    const plan = planMemoryRetrieval({ currentUserText: query, now: fixtureNow });
    const result = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan,
      userId: fixture.userId
    });
    const candidateIds = result.laneResults.flatMap((lane) =>
      lane.candidates.map((candidate) => candidate.itemId));
    expect(candidateIds).toContain(fixture.validChunkId);
    expect(candidateIds).toContain(fixture.episodeId);
    expect(candidateIds).not.toContain(fixture.staleChunkId);
    expect(candidateIds).not.toContain(fixture.excludedChunkId);
    expect(candidateIds).not.toContain(fixture.secretChunkId);

    const ranked = fuseMemoryRetrievalCandidates(plan, result.laneResults, fixtureNow);
    const expanded = await repository.expand(result.snapshot, plan, ranked);
    const episode = expanded.find((item) => item.itemId === fixture.episodeId);
    expect(episode).toMatchObject({
      projectionKind: "RECALL_CHUNK_SAFE_PROJECTED_TEXT",
      safeText: fixture.safeChunkText,
      sourceChatId: fixture.sourceChatId,
      supportingItemId: fixture.validChunkId
    });
    expect(expanded.map((item) => item.safeText).join("\n")).not.toContain(fixture.rawSourceText);
    const pack = packMemoryPersonalContext({ expanded, plan, ranked });
    expect(pack.approxTokens).toBeLessThanOrEqual(MEMORY_CONTEXT_HARD_CAP_TOKENS);
    expect(pack.text).not.toContain(fixture.rawSourceText);
    expect(pack.items.length).toBeLessThanOrEqual(12);
  });

  it("matches a cross-script product alias but injects no unrelated past-chat result", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const aliasQuery = "Что мы решили по Макбуку в предыдущем чате?";
    const aliasPlan = planMemoryRetrieval({ currentUserText: aliasQuery, now: fixtureNow });
    const aliasResult = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan: aliasPlan,
      userId: fixture.userId
    });
    expect(fuseMemoryRetrievalCandidates(aliasPlan, aliasResult.laneResults, fixtureNow)
      .slice(0, 5).map((item) => item.itemId)).toContain(fixture.validChunkId);

    const irrelevantQuery = "Что мы решили по квантовым бананам в предыдущем чате?";
    const irrelevantPlan = planMemoryRetrieval({
      currentUserText: irrelevantQuery,
      now: fixtureNow
    });
    const irrelevantResult = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan: irrelevantPlan,
      userId: fixture.userId
    });
    expect(fuseMemoryRetrievalCandidates(
      irrelevantPlan,
      irrelevantResult.laneResults,
      fixtureNow
    )).toEqual([]);
  });

  it("injects nothing for an irrelevant generic query", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const plan = planMemoryRetrieval({ currentUserText: "What is photosynthesis?", now: fixtureNow });
    const result = await repository.retrieve({
      assistantId: null,
      chatId: fixture.currentChatId,
      now: fixtureNow,
      plan,
      userId: fixture.userId
    });
    expect(result.laneResults).toEqual([]);
    expect(fuseMemoryRetrievalCandidates(plan, result.laneResults, fixtureNow)).toEqual([]);
  });

  it("emits reproducible sanitized Recall@5, isolation, bounds, and latency evidence", async () => {
    const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
    const cases = [
      { expected: fixture.enFactVersionId, query: "What is my preferred editor?" },
      { expected: fixture.ruFactVersionId, query: "Какой мой предпочтительный редактор?" },
      { expected: fixture.validChunkId, query: "Когда мы обсуждали миграцию PostgreSQL в предыдущем чате?" }
    ];
    const latencies: number[] = [];
    let crossTenantHits = 0;
    let recalled = 0;
    let maximumCandidateCount = 0;
    for (let iteration = 0; iteration < 5; iteration += 1) {
      for (const testCase of cases) {
        const plan = planMemoryRetrieval({ currentUserText: testCase.query, now: fixtureNow });
        const started = performance.now();
        const result = await repository.retrieve({
          assistantId: null,
          chatId: fixture.currentChatId,
          now: fixtureNow,
          plan,
          userId: fixture.userId
        });
        maximumCandidateCount = Math.max(
          maximumCandidateCount,
          result.laneResults.reduce((total, lane) => total + lane.candidates.length, 0)
        );
        crossTenantHits += result.laneResults.flatMap((lane) => lane.candidates)
          .filter((candidate) => candidate.itemId === fixture.foreignFactVersionId).length;
        latencies.push(performance.now() - started);
        if (fuseMemoryRetrievalCandidates(plan, result.laneResults, fixtureNow)
          .slice(0, 5).some((item) => item.itemId === testCase.expected)) recalled += 1;
      }
    }
    const irrelevantQueries = [
      "What is photosynthesis?",
      "Что мы решили по квантовым бананам в предыдущем чате?"
    ];
    let irrelevantInjections = 0;
    for (const query of irrelevantQueries) {
      const plan = planMemoryRetrieval({ currentUserText: query, now: fixtureNow });
      const result = await repository.retrieve({
        assistantId: null,
        chatId: fixture.currentChatId,
        now: fixtureNow,
        plan,
        userId: fixture.userId
      });
      if (fuseMemoryRetrievalCandidates(plan, result.laneResults, fixtureNow).length > 0) {
        irrelevantInjections += 1;
      }
    }
    const sampleCount = cases.length * 5;
    const evidence = Object.freeze({
      candidateHardCap: 150,
      crossTenantHits,
      evidenceVersion: "memory-phase5-local-retrieval-qualification-v1",
      irrelevantInjectionRate: irrelevantInjections / irrelevantQueries.length,
      latencyP95Ms: Number(percentile95(latencies).toFixed(2)),
      maximumCandidateCount,
      recallAt5: recalled / sampleCount,
      sanitizedAggregatesOnly: true,
      sampleCount
    });
    expect(evidence).toMatchObject({
      candidateHardCap: 150,
      crossTenantHits: 0,
      irrelevantInjectionRate: 0,
      maximumCandidateCount: expect.any(Number),
      recallAt5: 1,
      sanitizedAggregatesOnly: true,
      sampleCount: 15
    });
    expect(evidence.latencyP95Ms).toBeLessThan(1_000);
    expect(evidence.maximumCandidateCount).toBeLessThanOrEqual(evidence.candidateHardCap);
    expect(JSON.stringify(evidence)).not.toContain(fixture.userId);
    expect(JSON.stringify(evidence)).not.toContain(fixture.safeChunkText);
    console.info("memory_phase5_local_retrieval_qualification", evidence);
  });

  it("applies a durable ALL suppression before ranking", async () => {
    const suppression = await prisma.memorySuppression.create({
      data: {
        deletionGeneration: 1,
        fingerprintKeyVersion: "memory-test-v1",
        normalizationVersion: "memory-search-normalization-v1",
        scope: "ALL",
        userId: fixture.userId
      }
    });
    try {
      const repository = createPrismaLocalMemoryRetrievalRepository(prisma);
      const query = "What is my preferred editor?";
      const result = await repository.retrieve({
        assistantId: null,
        chatId: fixture.currentChatId,
        now: fixtureNow,
        plan: planMemoryRetrieval({ currentUserText: query, now: fixtureNow }),
        userId: fixture.userId
      });
      expect(result.laneResults.flatMap((lane) => lane.candidates)).toEqual([]);
    } finally {
      await prisma.memorySuppression.delete({ where: { id: suppression.id } });
    }
  });
});

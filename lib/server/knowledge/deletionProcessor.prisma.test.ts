import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaAdminRepository } from "../auth/adminRepository";
import { listAdminDashboard } from "../auth/adminDashboardQueries";
import { prisma } from "../prisma";
import {
  createPrismaRetentionRepository,
  drainDeletionObligations
} from "../retention/prune";
import { createToolObservationRepository, ObservationStoreError } from "../toolObservations/repository";
import { requestKnowledgeDeletion } from "./deletionRequest.testFixtures";
import { createAccountKnowledgeDeletionHook } from "./accountDeletion";

const checksum = "a".repeat(64);
const deletedKnowledgeReceiptHash = createHash("sha256")
  .update("aiqsa:knowledge:evidence-deleted:v1", "utf8")
  .digest("hex");

function purgedProviderAttemptKey(attemptId: string): string {
  return `purged:${createHash("sha256").update(attemptId, "utf8").digest("hex")}`;
}

type H2ProfileFixture = Readonly<{
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  modelId: string;
  profileId: string;
  profileRevisionId: string;
}>;

async function createH2ProfileFixture(suffix: string): Promise<H2ProfileFixture> {
  const connectionId = `knowledge-delete-connection-${suffix}`;
  const credentialId = randomUUID();
  const credentialVersionId = randomUUID();
  const modelId = randomUUID();
  const profileId = `knowledge-delete-profile-${suffix}`;
  const profileRevisionId = randomUUID();
  await prisma.providerConnection.create({
    data: { displayName: "Deletion embedding connection", family: "test", id: connectionId }
  });
  await prisma.providerModel.create({
    data: {
      capabilities: {},
      connectionId,
      defaultParams: {},
      displayName: "Deletion embedding model",
      id: modelId,
      modelClass: "embedding",
      modelId: `deletion-embedding-${suffix}`,
      provider: "test"
    }
  });
  await prisma.providerCredential.create({
    data: { connectionId, enabled: true, id: credentialId, label: "Deletion credential" }
  });
  await prisma.providerCredentialVersion.create({
    data: {
      activatedAt: new Date(),
      credentialId,
      id: credentialVersionId,
      testEvidence: { authenticationMode: "none", synthetic: true },
      testedAt: new Date(),
      version: 1
    }
  });
  await prisma.knowledgeIndexProfile.create({ data: { id: profileId } });
  await prisma.knowledgeIndexProfileRevision.create({
    data: {
      activatedAt: new Date(),
      chunkingProfileVersion: 1,
      egressPolicy: {},
      embeddingConfiguration: {},
      embeddingProviderModelId: modelId,
      executionAuthority: "installation",
      id: profileRevisionId,
      preflightCheckedAt: new Date(),
      preflightStatus: "ready",
      profileConfiguration: {},
      profileId,
      revisionNumber: 1,
      targetDimension: 1_024,
      vectorSpaceFingerprint: "d".repeat(64)
    }
  });
  return {
    connectionId,
    credentialId,
    credentialVersionId,
    modelId,
    profileId,
    profileRevisionId
  };
}

async function cleanupH2ProfileFixture(fixture: H2ProfileFixture): Promise<void> {
  // Profile revisions are database-immutable. The acknowledged disposable
  // database owns final cleanup for the complete synthetic execution graph.
  void fixture;
}

async function createH2RunPrivacyAudit(input: Readonly<{
  baseId: string;
  evidenceItemId: string;
  fixture: H2ProfileFixture;
  messageId: string;
  modelRunId: string;
  sourceArtifactId: string;
  sourceId: string;
  sourceVersionId: string;
  suffix: string;
}>): Promise<Readonly<{
  attemptId: string;
  manifestId: string;
  profileBindingId: string;
  reservationId: string;
  sourceBindingId: string;
}>> {
  const profileBinding = await prisma.knowledgeRunProfileBinding.create({
    data: {
      embeddingConnectionId: input.fixture.connectionId,
      embeddingCredentialId: input.fixture.credentialId,
      embeddingCredentialSource: "default",
      embeddingCredentialVersionId: input.fixture.credentialVersionId,
      embeddingExecutionSnapshot: { synthetic: true },
      embeddingProviderModelId: input.fixture.modelId,
      modelRunId: input.modelRunId,
      ordinal: 0,
      profileRevisionId: input.fixture.profileRevisionId,
      targetDimension: 1_024,
      vectorSpaceFingerprint: "d".repeat(64)
    },
    select: { id: true }
  });
  const sourceBinding = await prisma.knowledgeRunSourceBinding.create({
    data: {
      accessProvenance: {
        knowledgeBaseIds: [input.baseId],
        owner: true,
        projectId: null
      },
      baseProvenance: [{
        indexGenerationId: `private-generation-${input.suffix}`,
        knowledgeBaseId: input.baseId
      }],
      directSelected: true,
      fileNameSnapshot: `private-file-${input.suffix}.md`,
      modelRunId: input.modelRunId,
      ordinal: 0,
      profileBindingId: profileBinding.id,
      readinessState: "ready",
      selectionKind: "direct",
      sourceAlias: "S1",
      sourceArtifactId: input.sourceArtifactId,
      sourceId: input.sourceId,
      sourceNameSnapshot: `private-source-${input.suffix}`,
      sourceVersionId: input.sourceVersionId,
      sourceVersionNumber: 1
    },
    select: { id: true }
  });
  await prisma.providerRunBinding.create({
    data: {
      bindingKey: "answer",
      credentialSource: "default",
      executionSnapshot: { synthetic: true },
      modelRunId: input.modelRunId,
      role: "answer"
    }
  });
  const attempt = await prisma.knowledgeProviderAttempt.create({
    data: {
      checkpointHash: "e".repeat(64),
      estimatedUsage: {
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        estimatedCostMicros: 0,
        inputTokens: 1,
        outputTokens: 0,
        reasoningTokens: null,
        totalTokens: 1
      },
      idempotencyKey: `attempt:${input.suffix}`,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      leaseToken: `attempt-lease:${input.suffix}`,
      modelRunId: input.modelRunId,
      ordinal: 1,
      providerBindingKey: "answer",
      purpose: "answer",
      requestHash: "f".repeat(64),
      roundIndex: 0,
      state: "reserved"
    },
    select: { id: true }
  });
  const messageText = `private manifest ${input.suffix}`;
  const manifest = await prisma.knowledgeEvidenceDispatchManifest.create({
    data: {
      coverage: { privateCoverage: input.sourceId },
      excludedCount: 1,
      exclusions: {
        create: {
          evidenceItemId: input.evidenceItemId,
          handle: "K1",
          ordinal: 1,
          reason: "budget"
        }
      },
      itemCount: 1,
      items: {
        create: {
          contextBoundaries: { privateContext: input.sourceId },
          evidenceItemId: input.evidenceItemId,
          exactExcerpt: `private excerpt ${input.suffix}`,
          excerptBytes: Buffer.byteLength(`private excerpt ${input.suffix}`),
          excerptHash: "1".repeat(64),
          handle: "K1",
          ordinal: 0,
          renderedBlock: messageText,
          renderedBlockHash: "2".repeat(64),
          renderedBytes: Buffer.byteLength(messageText),
          renderedTokens: 3,
          representation: "full",
          safeMetadata: { sourceLabel: `private-source-${input.suffix}` },
          sourceAlias: "S1",
          sourceArtifactId: input.sourceArtifactId,
          sourceVersionId: input.sourceVersionId
        }
      },
      messageHash: "3".repeat(64),
      messageText,
      modelRunId: input.modelRunId,
      packingVersion: "knowledge_evidence_pack_v1",
      profileRevisionIds: [input.fixture.profileRevisionId],
      promptFragmentVersion: "knowledge_evidence_prompt_v1",
      providerAttemptId: attempt.id,
      retrievalSessionId: (await prisma.knowledgeRetrievalSession.findUniqueOrThrow({
        select: { id: true },
        where: { modelRunId: input.modelRunId }
      })).id,
      shortenedCount: 0,
      totalBytes: Buffer.byteLength(messageText),
      totalTokens: 3,
      version: 1
    },
    select: { id: true }
  });
  const settledAt = new Date();
  await prisma.knowledgeProviderAttempt.update({
    data: {
      actualUsage: {
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        estimatedCostMicros: 0,
        inputTokens: 1,
        outputTokens: 0,
        reasoningTokens: null,
        totalTokens: 1
      },
      dispatchedAt: settledAt,
      leaseExpiresAt: null,
      leaseToken: null,
      providerResponseId: `private-attempt-response-${input.suffix}`,
      settledAt,
      state: "settled"
    },
    where: { id: attempt.id }
  });
  const auditToolCall = await prisma.modelRunToolCall.create({
    data: {
      arguments: { query: "content-free audit" },
      completedAt: settledAt,
      modelRunId: input.modelRunId,
      ordinal: 2,
      providerCallId: `audit-${input.suffix}`,
      result: { audited: true },
      roundIndex: 0,
      startedAt: settledAt,
      state: "complete",
      toolName: "discover_sources"
    },
    select: { id: true }
  });
  const reservationId = randomUUID();
  const idempotencyKey = `reservation:${input.suffix}`;
  const operationRequest = {
    discovery: {
      cursor: null,
      fields: ["filename", "heading", "source_name", "tag", "title"],
      limit: 40,
      query: "content-free audit"
    },
    idempotencyKey,
    operation: "discover_sources",
    originalQuery: { reference: input.messageId, sha256: checksum },
    phaseOrdinal: 0,
    profileRevisionId: input.fixture.profileRevisionId,
    profileRevisionNumber: 1,
    reservationId,
    resolvedSourceIds: [input.sourceId],
    sourceAliases: [],
    subqueryOrdinal: 2,
    version: 2
  };
  await prisma.knowledgeBudgetReservation.create({
    data: {
      actualCandidates: 0,
      actualCostMicros: 0,
      actualEmbeddingCalls: 0,
      actualLatencyMs: 1,
      actualRetrievedTokens: 0,
      createdAt: settledAt,
      dispatchAttemptKey: `dispatch:${input.suffix}`,
      dispatchedAt: settledAt,
      estimatedCandidates: 0,
      estimatedCostMicros: 0,
      estimatedEmbeddingCalls: 0,
      estimatedLatencyMs: 1,
      estimatedRetrievedTokens: 0,
      id: reservationId,
      idempotencyKey,
      modelRunId: input.modelRunId,
      modelRunToolCallId: auditToolCall.id,
      operation: "discover_sources",
      operationOrdinal: 1,
      operationRequest: operationRequest as Prisma.InputJsonValue,
      operationRequestHash: createHash("sha256").update(JSON.stringify(operationRequest)).digest("hex"),
      phaseOrdinal: 0,
      policyVersion: 1,
      receiptHash: "4".repeat(64),
      settledAt,
      state: "settled",
      subqueryOrdinal: 2
    }
  });
  return {
    attemptId: attempt.id,
    manifestId: manifest.id,
    profileBindingId: profileBinding.id,
    reservationId,
    sourceBindingId: sourceBinding.id
  };
}

async function createActiveProviderAttemptPrivacyAudit(input: Readonly<{
  modelRunId: string;
  suffix: string;
}>): Promise<Readonly<{ dispatchedId: string; reservedId: string }>> {
  const estimatedUsage = {
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    estimatedCostMicros: 0,
    inputTokens: 1,
    outputTokens: 0,
    reasoningTokens: null,
    totalTokens: 1
  };
  const now = new Date();
  const reserved = await prisma.knowledgeProviderAttempt.create({
    data: {
      checkpointHash: "6".repeat(64),
      createdAt: now,
      estimatedUsage,
      idempotencyKey: `active-reserved:${input.suffix}`,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      leaseToken: `active-reserved-lease:${input.suffix}`,
      modelRunId: input.modelRunId,
      ordinal: 2,
      providerBindingKey: "answer",
      purpose: "answer",
      requestHash: "7".repeat(64),
      roundIndex: 0,
      state: "reserved"
    },
    select: { id: true }
  });
  const dispatched = await prisma.knowledgeProviderAttempt.create({
    data: {
      checkpointHash: "8".repeat(64),
      createdAt: now,
      dispatchedAt: now,
      estimatedUsage,
      idempotencyKey: `active-dispatched:${input.suffix}`,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      leaseToken: `active-dispatched-lease:${input.suffix}`,
      modelRunId: input.modelRunId,
      ordinal: 3,
      providerBindingKey: "answer",
      providerResponseId: `private-active-response:${input.suffix}`,
      purpose: "answer",
      requestHash: "9".repeat(64),
      roundIndex: 0,
      state: "dispatched"
    },
    select: { id: true }
  });
  return { dispatchedId: dispatched.id, reservedId: reserved.id };
}

async function createStructuredAnswerPrivacyAudit(input: Readonly<{
  contractVersion?: 1 | 2 | 5 | 17 | 21;
  modelRunId: string;
  ordinal?: number;
  purpose?:
    | "knowledge_answer_draft_v5"
    | "knowledge_answer_draft_v21"
    | "knowledge_answer_draft_supplement_v21"
    | "knowledge_coverage_auditor_v2"
    | "knowledge_coverage_auditor_v1"
    | "knowledge_grounded_selector_final_v17"
    | "knowledge_grounded_selector_v17";
  suffix: string;
}>): Promise<string> {
  const now = new Date();
  const usage = {
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    estimatedCostMicros: 0,
    inputTokens: 1,
    outputTokens: 1,
    reasoningTokens: null,
    totalTokens: 2
  };
  const contractVersion = input.contractVersion ?? 5;
  const ordinal = input.ordinal ?? 4;
  const purpose = input.purpose ?? "knowledge_answer_draft_v5";
  const attempt = await prisma.knowledgeProviderAttempt.create({
    data: {
      acceptedRequest: {
        privateEvidence: `private structured request ${input.suffix}`,
        version: 1
      },
      acceptedResult: {
        privateClaim: `private structured result ${input.suffix}`,
        version: 1
      },
      actualUsage: usage,
      checkpointHash: "a".repeat(64),
      contractVersion,
      createdAt: now,
      dispatchedAt: now,
      estimatedUsage: usage,
      evidenceReceiptHash: "b".repeat(64),
      idempotencyKey: `structured-answer:${ordinal}:${input.suffix}`,
      modelRunId: input.modelRunId,
      ordinal,
      providerBindingKey: "answer",
      providerResponseId: `private-structured-response:${input.suffix}`,
      purpose,
      requestHash: "c".repeat(64),
      resultAcceptedAt: now,
      resultHash: "d".repeat(64),
      roundIndex: 0,
      settledAt: now,
      state: "settled"
    },
    select: { id: true }
  });
  return attempt.id;
}

async function createRetiredAnalysisPrivacyFixture(input: Readonly<{
  baseEvidence: Prisma.InputJsonValue;
  invocationOrdinal: number;
  marker: string;
  modelRunId: string;
  operation: "structured_analysis" | "visual_analysis";
  toolCallOrdinal: number;
}>): Promise<Readonly<{ knowledgeRunId: string; toolCallId: string }>> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
    const toolCall = await tx.modelRunToolCall.create({
      data: {
        arguments: { legacyPayload: input.marker },
        completedAt: now,
        modelRunId: input.modelRunId,
        ordinal: input.toolCallOrdinal,
        providerCallId: `retired-${input.operation}-${randomUUID()}`,
        result: { legacyPayload: input.marker },
        roundIndex: 0,
        startedAt: now,
        state: "complete",
        toolName: input.operation
      },
      select: { id: true }
    });
    const results = input.operation === "structured_analysis"
      ? [{ structuredAnalysis: { cells: [input.marker], summary: input.marker } }]
      : [{ visualAnalysis: { observations: [input.marker], summary: input.marker } }];
    const knowledgeRun = await tx.knowledgeRun.create({
      data: {
        baseEvidence: input.baseEvidence,
        candidateCount: 1,
        candidateLimit: 1,
        durationMs: 1,
        embeddingUsage: [],
        fusion: "rrf_k60",
        invocationOrdinal: input.invocationOrdinal,
        modelRunId: input.modelRunId,
        modelRunToolCallId: toolCall.id,
        operation: input.operation,
        outcome: "complete",
        providerText: input.marker,
        query: "deleted_knowledge_resource",
        resultLimit: 1,
        results
      },
      select: { id: true }
    });
    return { knowledgeRunId: knowledgeRun.id, toolCallId: toolCall.id };
  });
}

async function cleanup(input: Readonly<{
  baseIds: readonly string[];
  ownerUserId: string;
  storageKeys?: readonly string[];
}>): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL aiqsa.knowledge_purge = 'on'");
    await tx.sharedChatSnapshot.deleteMany({ where: { ownerUserId: input.ownerUserId } });
    await tx.chat.deleteMany({ where: { userId: input.ownerUserId } });
    await tx.knowledgeDeletionJob.deleteMany({ where: { ownerUserId: input.ownerUserId } });
    await tx.knowledgeBaseSnapshotSource.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeBaseSnapshot.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeV1GenerationArtifactMap.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeV1DocumentVersionSourceMap.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeV1DocumentSourceMap.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeBaseSource.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeDocument.updateMany({
      data: { currentVersionId: null },
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeDocumentVersion.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeDocument.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeUploadBatch.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeBase.updateMany({
      data: { activeIndexGenerationId: null },
      where: { id: { in: [...input.baseIds] } }
    });
    await tx.knowledgeIndexGeneration.updateMany({
      data: {
        sourceBaseVersion: null,
        sourceIndexGenerationId: null,
        targetContentRevision: null,
        targetSourceRevision: null
      },
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeIndexGeneration.deleteMany({
      where: { knowledgeBaseId: { in: [...input.baseIds] } }
    });
    await tx.knowledgeBase.deleteMany({ where: { id: { in: [...input.baseIds] } } });
    await tx.knowledgeSource.updateMany({
      data: { currentVersionId: null, pendingVersionId: null },
      where: { ownerUserId: input.ownerUserId }
    });
    await tx.projectKnowledgeSourceBinding.deleteMany({
      where: { source: { ownerUserId: input.ownerUserId } }
    });
    await tx.knowledgeSourceIndexArtifact.deleteMany({
      where: { sourceVersion: { ownerUserId: input.ownerUserId } }
    });
    await tx.knowledgeSourceVersion.deleteMany({ where: { ownerUserId: input.ownerUserId } });
    await tx.knowledgeSource.deleteMany({ where: { ownerUserId: input.ownerUserId } });
    if (input.storageKeys && input.storageKeys.length > 0) {
      await tx.attachmentDeletionJob.deleteMany({
        where: { storageKey: { in: [...input.storageKeys] } }
      });
    }
    await tx.user.deleteMany({ where: { id: input.ownerUserId } });
  });
}

describe("Prisma Knowledge trash and permanent deletion", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("scrubs a deleted Base from an empty-result historical receipt", async () => {
    const suffix = randomUUID();
    const ownerUserId = "knowledge-base-receipt-delete-owner-" + suffix;
    await prisma.user.create({
      data: { displayName: "Base receipt deletion owner", id: ownerUserId, status: "active" }
    });
    const base = await prisma.knowledgeBase.create({
      data: { name: "Private empty Base", ownerUserId },
      select: { id: true }
    });
    const chat = await prisma.chat.create({
      data: { title: "Empty Knowledge receipt", userId: ownerUserId },
      select: { id: true }
    });
    const message = await prisma.message.create({
      data: { chatId: chat.id, content: { text: "question" }, role: "user" },
      select: { id: true }
    });
    const run = await prisma.modelRun.create({
      data: {
        chatId: chat.id,
        modelId: "test-model",
        normalizedRequest: { knowledgePlan: { baseIds: [base.id] } },
        provider: "test",
        status: "complete",
        userId: ownerUserId,
        userMessageId: message.id
      },
      select: { id: true }
    });
    const toolCall = await prisma.modelRunToolCall.create({
      data: {
        arguments: { query: "private empty base" },
        completedAt: new Date(),
        modelRunId: run.id,
        ordinal: 0,
        providerCallId: "knowledge-empty-" + suffix,
        result: {
          bases: [{ baseName: "Private empty Base", knowledgeBaseId: base.id }],
          results: []
        },
        roundIndex: 0,
        startedAt: new Date(),
        state: "complete",
        toolName: "retrieve_knowledge"
      },
      select: { id: true }
    });
    const knowledgeRun = await prisma.knowledgeRun.create({
      data: {
        baseEvidence: [{ baseName: "Private empty Base", knowledgeBaseId: base.id }],
        candidateCount: 0,
        candidateLimit: 12,
        durationMs: 4,
        embeddingUsage: [],
        fusion: "rrf_k60",
        invocationOrdinal: 1,
        modelRunId: run.id,
        modelRunToolCallId: toolCall.id,
        outcome: "base_empty",
        providerText: "Knowledge retrieval returned no indexed passages: base_empty.",
        query: "private empty base",
        resultLimit: 8,
        results: [],
      },
      select: { id: true }
    });

    try {
      await requestKnowledgeDeletion(prisma, { id: base.id, ownerUserId, targetType: "BASE" });
      const summary = await drainDeletionObligations({
        repository: createPrismaRetentionRepository(prisma),
        storage: { async deleteObject() {} }
      });
      expect(summary.knowledgeJobs.failed).toBe(0);

      const historical = await prisma.knowledgeRun.findUnique({
        select: { baseEvidence: true, providerText: true, results: true },
        where: { id: knowledgeRun.id }
      });
      expect(historical).toEqual({
        baseEvidence: [{ deleted: true }],
        providerText: "Knowledge citation evidence was deleted.",
        results: []
      });
      expect(JSON.stringify(historical)).not.toContain(base.id);
      expect(JSON.stringify(historical)).not.toContain("Private empty Base");
      await expect(prisma.modelRunToolCall.findUnique({
        select: { result: true },
        where: { id: toolCall.id }
      })).resolves.toEqual({ result: null });
      await expect(prisma.modelRun.findUnique({
        select: { normalizedRequest: true },
        where: { id: run.id }
      })).resolves.toEqual({ normalizedRequest: { knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 } } });
    } finally {
      await cleanup({ baseIds: [base.id], ownerUserId });
    }
  });

  it("scrubs observation previews, reader fragments and carried notes of deleted Knowledge evidence", async () => {
    const suffix = randomUUID();
    const ownerUserId = "knowledge-copies-delete-owner-" + suffix;
    const excerpt = "private excerpt " + suffix;
    const knowledgeNotesText = "Notes derived from " + excerpt;
    const earlierNotesText = "Unrelated earlier notes " + suffix;
    await prisma.user.create({
      data: { displayName: "Retained copies deletion owner", id: ownerUserId, status: "active" }
    });
    const base = await prisma.knowledgeBase.create({
      data: { name: "Private copies Base", ownerUserId },
      select: { id: true }
    });
    const chat = await prisma.chat.create({
      data: { title: "Retained Knowledge copies", userId: ownerUserId },
      select: { id: true }
    });
    const messageIds: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const created = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: { text: index % 2 === 0 ? `question ${index}` : `generated answer ${index}` },
          parentMessageId: messageIds.at(-1) ?? null,
          role: index % 2 === 0 ? "user" : "assistant"
        },
        select: { id: true }
      });
      messageIds.push(created.id);
    }
    const [earlierRunId, knowledgeRunId, childRunId, readerRunId] =
      [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const notes = (seed: string, text: string) => ({
      formatVersion: 1, id: `cs1_${seed.repeat(32)}`, notes: text, sourceDigest: seed.repeat(64), sourceRefs: []
    });
    const earlierNotes = notes("a", earlierNotesText);
    const knowledgeNotes = notes("b", knowledgeNotesText);
    const childNotes = notes("c", "Child notes carrying " + excerpt);
    type Notes = ReturnType<typeof notes>;
    const policy = (reuse?: Readonly<{ coveredMessageId: string; runId: string; summary: Notes }>) => ({
      mode: "hybrid",
      source: { digest: "7".repeat(64), leafMessageId: null, messageCount: 1 },
      version: 1,
      ...(reuse ? { reuse } : {})
    });
    const compaction = (runId: string, summary: Notes | null) => ({
      branchId: "branch",
      followupDigest: "1".repeat(64),
      followupRevision: 0,
      measurement: {
        afterTokens: 10, beforeTokens: 20, budgetTokens: 100, legacyFallback: false,
        maskedBatches: 0, maskedObservations: 0, outcome: "already_fits", version: 1
      },
      observationRefs: [],
      ownerId: ownerUserId,
      pinDigest: "2".repeat(64),
      policyRevision: "hybrid-v1",
      providerProjectionRevision: 1,
      recentTailCallIds: [],
      runId,
      sourceDigest: "3".repeat(64),
      summary,
      summaryAttempts: [{
        attempt: 1, bindingDigest: "4".repeat(64), id: `csa1_${runId}`, sourceDigest: "5".repeat(64),
        state: "committed", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }
      }],
      version: 1
    });
    const toolLoopState = (runId: string, summary: Notes, providerToolMessages: Prisma.InputJsonValue[]) => ({
      answerRoundUsage: [],
      contextCompaction: compaction(runId, summary),
      phase: "provider_running",
      providerContinuation: { providerResponseId: null, providerToolMessages },
      providerCursor: null,
      roundIndex: 1,
      version: 2
    });
    const unrelatedMessage = { call_id: "unrelated-" + suffix, output: "safe retained output", type: "function_call_output" };
    const knowledgeProviderCallId = "knowledge-" + suffix;
    const knowledgeReaderProviderCallId = "reader-own-" + suffix;
    const childReaderProviderCallId = "reader-child-" + suffix;
    const observationId = randomUUID().replaceAll("-", "");
    const handle = `tor1_${observationId}`;
    const readerMessages = (providerCallId: string) => [
      { arguments: JSON.stringify({ handle }), call_id: providerCallId, name: "read_tool_result", type: "function_call" },
      { call_id: providerCallId, output: `{"fragment":"${excerpt}"}`, type: "function_call_output" }
    ];

    const earlierState = toolLoopState(earlierRunId, earlierNotes, [unrelatedMessage]);
    await prisma.modelRun.create({
      data: {
        assistantMessageId: messageIds[1], chatId: chat.id, id: earlierRunId, modelId: "test-model",
        normalizedRequest: { contextCompactionPolicy: policy() }, provider: "test", status: "complete",
        toolLoopState: earlierState, userId: ownerUserId, userMessageId: messageIds[0]!
      }
    });
    await prisma.modelRun.create({
      data: {
        assistantMessageId: messageIds[3], chatId: chat.id, id: knowledgeRunId, modelId: "test-model",
        normalizedRequest: {
          contextCompactionPolicy: policy({ coveredMessageId: messageIds[0]!, runId: earlierRunId, summary: earlierNotes }),
          knowledgePlan: { baseIds: [base.id] }
        },
        provider: "test", status: "complete",
        toolLoopState: toolLoopState(knowledgeRunId, knowledgeNotes, [
          { arguments: "{}", call_id: knowledgeProviderCallId, name: "retrieve_knowledge", type: "function_call" },
          { call_id: knowledgeProviderCallId, output: excerpt, type: "function_call_output" },
          ...readerMessages(knowledgeReaderProviderCallId),
          unrelatedMessage
        ]),
        userId: ownerUserId, userMessageId: messageIds[2]!
      }
    });
    await prisma.modelRun.create({
      data: {
        assistantMessageId: messageIds[5], chatId: chat.id, id: childRunId, modelId: "test-model",
        normalizedRequest: {
          contextCompactionPolicy: policy({ coveredMessageId: messageIds[2]!, runId: knowledgeRunId, summary: knowledgeNotes }),
          knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 }
        },
        provider: "test", status: "complete",
        toolLoopState: toolLoopState(childRunId, childNotes, [...readerMessages(childReaderProviderCallId), unrelatedMessage]),
        userId: ownerUserId, userMessageId: messageIds[4]!
      }
    });
    // An active later turn carried the child's notes unchanged; it also reads.
    await prisma.modelRun.create({
      data: {
        assistantMessageId: messageIds[7], chatId: chat.id, id: readerRunId, modelId: "test-model",
        normalizedRequest: {
          contextCompactionPolicy: policy({ coveredMessageId: messageIds[4]!, runId: childRunId, summary: childNotes }),
          knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 }
        },
        provider: "test", status: "streaming",
        toolLoopState: toolLoopState(readerRunId, childNotes, [unrelatedMessage]),
        userId: ownerUserId, userMessageId: messageIds[6]!
      }
    });
    const knowledgeCall = await prisma.modelRunToolCall.create({
      data: {
        arguments: { query: "private copies query" },
        completedAt: new Date(),
        modelRunId: knowledgeRunId,
        ordinal: 0,
        providerCallId: knowledgeProviderCallId,
        result: { bases: [{ baseName: "Private copies Base", knowledgeBaseId: base.id }], results: [] },
        roundIndex: 0,
        startedAt: new Date(),
        state: "complete",
        toolName: "retrieve_knowledge"
      },
      select: { id: true }
    });
    await prisma.knowledgeRun.create({
      data: {
        baseEvidence: [{ baseName: "Private copies Base", knowledgeBaseId: base.id }],
        candidateCount: 0,
        candidateLimit: 12,
        durationMs: 4,
        embeddingUsage: [],
        fusion: "rrf_k60",
        invocationOrdinal: 1,
        modelRunId: knowledgeRunId,
        modelRunToolCallId: knowledgeCall.id,
        outcome: "base_empty",
        providerText: "Knowledge retrieval returned no indexed passages: base_empty.",
        query: "private copies query",
        resultLimit: 8,
        results: []
      }
    });
    await prisma.toolObservation.create({
      data: {
        byteSize: 64,
        checksum: "e".repeat(64),
        executionOutcome: "complete",
        id: observationId,
        maskable: false,
        modelRunId: knowledgeRunId,
        projection: {
          fragmentKind: "serialized_json_text",
          incomplete: false,
          observation: { handle },
          preview: excerpt,
          reader: "read_tool_result"
        },
        reservedBytes: 64,
        sourceKind: "knowledge",
        state: "READY",
        storageMode: "SOURCE",
        toolCallId: knowledgeCall.id
      }
    });
    const readerCall = (modelRunId: string, providerCallId: string) => prisma.modelRunToolCall.create({
      data: {
        arguments: { handle, query: excerpt },
        completedAt: new Date(),
        modelRunId,
        ordinal: 1,
        providerCallId,
        result: {
          callId: providerCallId, content: [{ type: "json", value: { fragment: excerpt } }],
          name: "read_tool_result", status: "complete"
        },
        roundIndex: 0,
        startedAt: new Date(),
        state: "complete",
        toolName: "read_tool_result"
      },
      select: { id: true }
    });
    const ownReader = await readerCall(knowledgeRunId, knowledgeReaderProviderCallId);
    const childReader = await readerCall(childRunId, childReaderProviderCallId);
    // Authority of the later reader run is independent of the Knowledge owner:
    // the handle resolves before deletion and resolves to nothing afterwards.
    const observations = createToolObservationRepository({
      authorizeSource: async () => undefined,
      loadSource: async () => null,
      prisma
    });
    const reader = { runId: readerRunId, userId: ownerUserId };
    await expect(observations.read(reader, observationId)).resolves.toMatchObject({ id: observationId });

    try {
      await requestKnowledgeDeletion(prisma, { id: base.id, ownerUserId, targetType: "BASE" });
      const summary = await drainDeletionObligations({
        repository: createPrismaRetentionRepository(prisma),
        storage: { async deleteObject() {} }
      });
      expect(summary.knowledgeJobs.failed).toBe(0);

      await expect(prisma.toolObservation.findUnique({ where: { id: observationId } })).resolves.toBeNull();
      await expect(observations.read(reader, observationId)).rejects.toMatchObject({ code: "tool_observation_unavailable" });
      await expect(observations.read(reader, observationId)).rejects.toBeInstanceOf(ObservationStoreError);
      const calls = await prisma.modelRunToolCall.findMany({
        select: { arguments: true, id: true, result: true, state: true },
        where: { id: { in: [knowledgeCall.id, ownReader.id, childReader.id] } }
      });
      expect(calls).toHaveLength(3);
      for (const call of calls) {
        expect(call).toMatchObject({ arguments: { deleted: true }, result: null, state: "complete" });
      }

      const runs = new Map((await prisma.modelRun.findMany({
        select: { id: true, normalizedRequest: true, status: true, toolLoopState: true },
        where: { chatId: chat.id }
      })).map((run) => [run.id, run]));
      // Notes a Knowledge run only carried from an unrelated earlier turn stay there.
      expect(runs.get(earlierRunId)?.toolLoopState).toEqual(earlierState);
      for (const runId of [knowledgeRunId, childRunId, readerRunId]) {
        const run = runs.get(runId)!;
        const state = run.toolLoopState as { contextCompaction: Record<string, unknown>; providerContinuation: { providerToolMessages: unknown[] } };
        expect(JSON.stringify(run)).not.toContain(excerpt);
        expect(JSON.stringify(run)).not.toContain(earlierNotesText);
        expect((run.normalizedRequest as { contextCompactionPolicy: unknown }).contextCompactionPolicy).toEqual(policy());
        expect(state.contextCompaction).not.toHaveProperty("summary");
        expect(state.contextCompaction.summaryAttempts).toEqual(compaction(runId, null).summaryAttempts);
        expect(state.providerContinuation.providerToolMessages).toEqual([unrelatedMessage]);
      }
      expect(runs.get(readerRunId)?.status).toBe("streaming");
      await expect(prisma.message.findUnique({ select: { content: true }, where: { id: messageIds[3]! } }))
        .resolves.toEqual({ content: { text: "generated answer 3" } });
    } finally {
      await cleanup({ baseIds: [base.id], ownerUserId });
    }
  });

  it("stages expired Source trash before Base trash and leaves newer trash alone", async () => {
    const suffix = randomUUID();
    const ownerUserId = "knowledge-retention-owner-" + suffix;
    const oldTrashTime = new Date("2000-01-01T00:00:00.000Z");
    const cutoff = new Date("2001-01-01T00:00:00.000Z");
    const newerTrashTime = new Date("2002-01-01T00:00:00.000Z");
    const now = new Date("2026-08-18T04:00:00.000Z");
    await prisma.user.create({
      data: { displayName: "Knowledge retention owner", id: ownerUserId, status: "active" }
    });
    const base = await prisma.knowledgeBase.create({
      data: { name: "Expired Base", ownerUserId, trashedAt: oldTrashTime },
      select: { id: true }
    });
    const expiredSource = await prisma.knowledgeSource.create({
      data: { name: "Expired Source", ownerUserId, trashedAt: oldTrashTime },
      select: { id: true }
    });
    const newerSource = await prisma.knowledgeSource.create({
      data: { name: "Newer Source", ownerUserId, trashedAt: newerTrashTime },
      select: { id: true }
    });

    try {
      const repository = createPrismaRetentionRepository(prisma);
      await expect(repository.stageExpiredKnowledgeTrash({ cutoff, limit: 1, now }))
        .resolves.toEqual({ bases: 0, jobsStaged: 1, sources: 1 });
      await expect(prisma.knowledgeDeletionJob.findMany({
        orderBy: { id: "asc" },
        select: { targetId: true, targetType: true },
        where: { ownerUserId }
      })).resolves.toEqual([{ targetId: expiredSource.id, targetType: "SOURCE" }]);

      await expect(repository.stageExpiredKnowledgeTrash({ cutoff, limit: 1, now }))
        .resolves.toEqual({ bases: 1, jobsStaged: 1, sources: 0 });
      const jobs = await prisma.knowledgeDeletionJob.findMany({
        select: { targetId: true, targetType: true },
        where: { ownerUserId }
      });
      expect(jobs).toHaveLength(2);
      expect(jobs).toEqual(expect.arrayContaining([
        { targetId: expiredSource.id, targetType: "SOURCE" },
        { targetId: base.id, targetType: "BASE" }
      ]));
      await expect(prisma.knowledgeSource.findUnique({
        select: { deletionRequestedAt: true },
        where: { id: newerSource.id }
      })).resolves.toEqual({ deletionRequestedAt: null });
    } finally {
      await cleanup({ baseIds: [base.id], ownerUserId });
    }
  });

  it("holds account deletion until every owned Knowledge obligation settles", async () => {
    const suffix = randomUUID();
    const ownerUserId = "knowledge-account-delete-owner-" + suffix;
    await prisma.user.create({
      data: { displayName: "Disabled Knowledge owner", id: ownerUserId, status: "disabled" }
    });
    const base = await prisma.knowledgeBase.create({
      data: { name: "Account Base", ownerUserId },
      select: { id: true }
    });
    const source = await prisma.knowledgeSource.create({
      data: { name: "Account Source", ownerUserId },
      select: { id: true }
    });
    await prisma.knowledgeBaseSource.create({
      data: { knowledgeBaseId: base.id, ownerUserId, sourceId: source.id }
    });
    let kicks = 0;
    const admin = createPrismaAdminRepository(prisma, {
      accountKnowledgeDeletionHook: () => createAccountKnowledgeDeletionHook({
        kick: () => {
          kicks += 1;
        }
      })
    });

    try {
      const dashboard = await listAdminDashboard(prisma, {
        actingAdminUserId: "admin-" + suffix,
        now: new Date("2026-08-18T04:00:00.000Z")
      });
      expect(dashboard.users.find((user) => user.id === ownerUserId)?.deletion)
        .toMatchObject({ canDelete: true, reason: null });
      expect(dashboard.users.find((user) => user.id === ownerUserId)?.deletion.summary)
        .toMatch(/Memory or personal MCP/u);

      await expect(admin.deleteStaleUser({
        actingAdminUserId: "admin-" + suffix,
        userId: ownerUserId
      })).resolves.toBe("deletion_pending");
      expect(kicks).toBe(1);
      await expect(prisma.knowledgeDeletionJob.count({
        where: { ownerUserId }
      })).resolves.toBe(2);
      await expect(prisma.knowledgeBase.findUnique({
        select: { deletionRequestedAt: true, trashedAt: true },
        where: { id: base.id }
      })).resolves.toMatchObject({
        deletionRequestedAt: expect.any(Date),
        trashedAt: expect.any(Date)
      });

      const drained = await drainDeletionObligations({
        repository: createPrismaRetentionRepository(prisma),
        storage: { async deleteObject() {} }
      });
      expect(drained.knowledgeJobs.failed).toBe(0);
      await expect(admin.deleteStaleUser({
        actingAdminUserId: "admin-" + suffix,
        userId: ownerUserId
      })).resolves.toBe("deleted");
      await expect(prisma.user.findUnique({ where: { id: ownerUserId } }))
        .resolves.toBeNull();
      await expect(prisma.knowledgeDeletionJob.count({
        where: { ownerUserId }
      })).resolves.toBe(0);
    } finally {
      if (await prisma.user.count({ where: { id: ownerUserId } })) {
        await cleanup({ baseIds: [base.id], ownerUserId });
      }
    }
  });
});

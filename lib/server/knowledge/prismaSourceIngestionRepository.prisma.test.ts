import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import {
  createKnowledgeModelPdfAttemptRepository,
  KnowledgeModelPdfAttemptError
} from "./modelPdfAttemptRepository";
import { createPrismaKnowledgeSourceIngestionRepository } from "./prismaSourceIngestionRepository";

const fingerprint = "a".repeat(64);

type Fixture = Readonly<{
  artifactId: string;
  baseId: string;
  connectionId: string;
  generationId: string;
  modelId: string;
  ownerUserId: string;
  profileId: string;
  profileRevisionId: string;
  sourceId: string;
  sourceVersionId: string;
}>;

async function createFixture(now: Date): Promise<Fixture> {
  const suffix = randomUUID();
  const ownerUserId = `knowledge-claim-owner-${suffix}`;
  const connectionId = `knowledge-claim-connection-${suffix}`;
  const modelId = `knowledge-claim-model-${suffix}`;
  const profileId = `knowledge-claim-profile-${suffix}`;
  const profileRevisionId = `knowledge-claim-profile-revision-${suffix}`;
  const baseId = `knowledge-claim-base-${suffix}`;
  const generationId = `knowledge-claim-generation-${suffix}`;
  const sourceId = `knowledge-claim-source-${suffix}`;
  const sourceVersionId = `knowledge-claim-source-version-${suffix}`;
  const artifactId = `knowledge-claim-artifact-${suffix}`;

  await prisma.user.create({
    data: { displayName: "Knowledge claim owner", id: ownerUserId, status: "active" }
  });
  await prisma.providerConnection.create({
    data: { displayName: "Knowledge claim embeddings", family: "test", id: connectionId }
  });
  await prisma.providerModel.create({
    data: {
      capabilities: {},
      connectionId,
      defaultParams: {},
      displayName: "Knowledge claim embedding model",
      id: modelId,
      modelClass: "embedding",
      modelId: `embedding-${suffix}`,
      provider: "test"
    }
  });
  await prisma.knowledgeIndexProfile.create({ data: { id: profileId } });
  await prisma.knowledgeIndexProfileRevision.create({
    data: {
      activatedAt: now,
      chunkingProfileVersion: 1,
      egressPolicy: {},
      embeddingConfiguration: {},
      embeddingProviderModelId: modelId,
      executionAuthority: "installation",
      id: profileRevisionId,
      preflightCheckedAt: now,
      preflightStatus: "ready",
      profileConfiguration: {},
      profileId,
      revisionNumber: 1,
      targetDimension: 1024,
      vectorSpaceFingerprint: fingerprint
    }
  });
  await prisma.knowledgeIndexProfile.update({
    data: { activeRevisionId: profileRevisionId },
    where: { id: profileId }
  });
  await prisma.knowledgeBase.create({
    data: { id: baseId, name: "Knowledge claim base", ownerUserId }
  });
  await prisma.knowledgeIndexGeneration.create({
    data: {
      activatedAt: now,
      chunkingProfileVersion: 1,
      embeddingConfiguration: {},
      embeddingProviderModelId: modelId,
      id: generationId,
      indexedContentRevision: 0,
      knowledgeBaseId: baseId,
      profileRevisionId,
      readyAt: now,
      status: "active",
      targetDimension: 1024,
      vectorSpaceFingerprint: fingerprint
    }
  });
  await prisma.knowledgeBase.update({
    data: { activeIndexGenerationId: generationId },
    where: { id: baseId }
  });
  await prisma.knowledgeSource.create({
    data: { id: sourceId, name: "Restartable source", ownerUserId }
  });
  await prisma.knowledgeSourceVersion.create({
    data: {
      byteSize: 64,
      checksum: "b".repeat(64),
      fileName: "restartable.txt",
      id: sourceVersionId,
      mimeType: "text/plain",
      ownerUserId,
      sourceId,
      versionNumber: 1
    }
  });
  await prisma.knowledgeSource.update({
    data: { currentVersionId: sourceVersionId },
    where: { id: sourceId }
  });
  await prisma.knowledgeBaseSource.create({
    data: { knowledgeBaseId: baseId, ownerUserId, sourceId }
  });
  await prisma.knowledgeSourceIndexArtifact.create({
    data: {
      id: artifactId,
      nextAttemptAt: now,
      processingStage: "queued",
      profileRevisionId,
      sourceVersionId,
      state: "pending"
    }
  });

  return {
    artifactId,
    baseId,
    connectionId,
    generationId,
    modelId,
    ownerUserId,
    profileId,
    profileRevisionId,
    sourceId,
    sourceVersionId
  };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
    await tx.knowledgeSourceIndexArtifact.deleteMany({
      where: { sourceVersionId: fixture.sourceVersionId }
    });
    await tx.knowledgeBaseSource.deleteMany({
      where: { knowledgeBaseId: fixture.baseId, sourceId: fixture.sourceId }
    });
    await tx.knowledgeBase.updateMany({
      data: { activeIndexGenerationId: null },
      where: { id: fixture.baseId }
    });
    // A concurrently running disposable worker may legitimately create a
    // shadow generation for this fixture-owned Base. Detach the self-relation
    // and remove only generations owned by that Base so cleanup stays
    // order-independent without touching another fixture.
    await tx.knowledgeIndexGeneration.updateMany({
      data: {
        sourceBaseVersion: null,
        sourceIndexGenerationId: null,
        targetContentRevision: null,
        targetSourceRevision: null
      },
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeIndexGeneration.deleteMany({
      where: { knowledgeBaseId: fixture.baseId }
    });
    await tx.knowledgeBase.deleteMany({ where: { id: fixture.baseId } });
    await tx.knowledgeSource.updateMany({
      data: { currentVersionId: null },
      where: { id: fixture.sourceId }
    });
    await tx.knowledgeSourceVersion.deleteMany({
      where: { id: fixture.sourceVersionId }
    });
    await tx.knowledgeSource.deleteMany({ where: { id: fixture.sourceId } });
    await tx.user.deleteMany({ where: { id: fixture.ownerUserId } });
  });
}

describe("Prisma Knowledge Source ingestion claims", () => {
  // Keep the fixture invisible to an ordinary dev worker sharing the
  // disposable database. The repository under test receives this explicit
  // clock, so only the test workers can make the artifact due.
  const now = new Date("2097-03-01T00:00:00.000Z");
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await createFixture(now);
  });

  afterAll(async () => {
    await cleanupFixture(fixture);
    await prisma.$disconnect();
  });

  it("admits one worker, preserves its checkpoint across restart, and fences the stale lease", async () => {
    const repository = createPrismaKnowledgeSourceIngestionRepository(prisma);
    const initialStaleBefore = new Date(now.getTime() - 60_000);
    const claims = await Promise.all([
      repository.claim({ claimToken: "worker-a", now, staleBefore: initialStaleBefore }),
      repository.claim({ claimToken: "worker-b", now, staleBefore: initialStaleBefore })
    ]);
    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    const first = winners[0]!;
    expect(first).toMatchObject({
      artifact: { id: fixture.artifactId },
      attemptCount: 1,
      sourceVersionId: fixture.sourceVersionId,
      state: "queued"
    });

    await expect(repository.advanceSourceToParsing({
      artifactId: first.artifact.id,
      claimToken: first.claimToken,
      now: new Date(now.getTime() + 1_000),
      sourceVersionId: first.sourceVersionId
    })).resolves.toBe(true);

    const restartedRepository = createPrismaKnowledgeSourceIngestionRepository(prisma);
    const restartNow = new Date(now.getTime() + 120_000);
    const restarted = await restartedRepository.claim({
      claimToken: "worker-after-restart",
      now: restartNow,
      staleBefore: new Date(now.getTime() + 60_000)
    });
    expect(restarted).toMatchObject({
      artifact: { id: fixture.artifactId },
      attemptCount: 2,
      sourceVersionId: fixture.sourceVersionId,
      state: "parsing"
    });
    await expect(repository.heartbeat({
      artifactId: first.artifact.id,
      claimToken: first.claimToken,
      now: restartNow,
      sourceVersionId: first.sourceVersionId
    })).resolves.toBe(false);
    await expect(restartedRepository.heartbeat({
      artifactId: restarted!.artifact.id,
      claimToken: restarted!.claimToken,
      now: new Date(restartNow.getTime() + 1_000),
      sourceVersionId: restarted!.sourceVersionId
    })).resolves.toBe(true);
    await expect(prisma.knowledgeSourceIndexArtifact.findUniqueOrThrow({
      select: { attemptCount: true, claimToken: true, processingStage: true, state: true },
      where: { id: fixture.artifactId }
    })).resolves.toEqual({
      attemptCount: 2,
      claimToken: "worker-after-restart",
      processingStage: "parsing",
      state: "processing"
    });

    const work = {
      artifactId: restarted!.artifact.id,
      claimToken: restarted!.claimToken,
      sourceVersionId: restarted!.sourceVersionId
    };
    const pdfAttempts = createKnowledgeModelPdfAttemptRepository(prisma);
    const snapshot: ProviderExecutionSnapshot = {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 30_000
      },
      connectionDisplayName: "Connection",
      connectionId: fixture.connectionId,
      credentialId: "credential-1",
      credentialVersionId: "credential-version-1",
      model: {
        adapterKind: "openai_responses_native",
        answerSelectable: true,
        capabilities: {
          nativePdfInput: true,
          nativeSearch: false,
          pdf: true,
          reasoning: false,
          streaming: true,
          vision: true
        },
        defaultParams: {},
        modelClass: "answer",
        upstreamModelId: "pdf-transcription-test"
      },
      modelDisplayName: "PDF transcription test",
      providerFamily: "test",
      providerModelId: fixture.modelId,
      version: 1
    };
    const identity = {
      artifactId: fixture.artifactId,
      batchIndex: 0,
      mode: "system_model_direct_pdf" as const,
      pageEnd: 2,
      pageStart: 1,
      requestDigest: "f".repeat(64),
      sourceVersionId: fixture.sourceVersionId
    };
    const reservation = await pdfAttempts.reserve({ ...identity, now: restartNow });
    expect(reservation.kind).toBe("dispatch");
    if (reservation.kind !== "dispatch") throw new Error("expected PDF dispatch");
    await expect(pdfAttempts.markDispatched({
      ...identity,
      attemptId: reservation.attemptId,
      now: restartNow
    })).resolves.toBe(true);
    await expect(pdfAttempts.settle({
      ...identity,
      attemptId: reservation.attemptId,
      now: restartNow,
      ownerUserId: fixture.ownerUserId,
      resultText: "<<<AIQSA_PAGE_000001>>>\nrow\tvalue\n<<<AIQSA_END_PAGE_000001>>>",
      snapshot,
      usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 0, totalTokens: 14 }
    })).resolves.toMatchObject({ attemptId: reservation.attemptId });
    await expect(pdfAttempts.reserve({ ...identity, now: restartNow })).resolves.toMatchObject({
      kind: "settled"
    });

    const uncertainIdentity = {
      ...identity,
      batchIndex: 1,
      pageEnd: 3,
      pageStart: 3,
      requestDigest: "e".repeat(64)
    };
    const uncertain = await pdfAttempts.reserve({ ...uncertainIdentity, now: restartNow });
    expect(uncertain.kind).toBe("dispatch");
    if (uncertain.kind !== "dispatch") throw new Error("expected PDF dispatch");
    await expect(pdfAttempts.markDispatched({
      ...uncertainIdentity,
      attemptId: uncertain.attemptId,
      now: restartNow
    })).resolves.toBe(true);
    await expect(pdfAttempts.reserve({
      ...uncertainIdentity,
      now: new Date(restartNow.getTime() + 1)
    })).rejects.toEqual(new KnowledgeModelPdfAttemptError("pdf_processing_ambiguous"));

    await expect(restartedRepository.completeParsing({
      ...work,
      normalizedTextByteSize: 64,
      normalizedTextChecksum: "c".repeat(64),
      normalizedTextStorageKey: "knowledge/test/normalized.json",
      now: new Date(restartNow.getTime() + 2_000),
      pageCount: 1,
      warningCodes: []
    })).resolves.toBe(true);
    await expect(prisma.knowledgePdfProcessingAttempt.findUniqueOrThrow({
      select: { resultChecksum: true, resultText: true, state: true },
      where: { id: reservation.attemptId }
    })).resolves.toEqual({ resultChecksum: null, resultText: null, state: "settled" });
    await expect(prisma.usageEvent.count({
      where: { knowledgePdfProcessingAttemptId: reservation.attemptId }
    })).resolves.toBe(1);
    await expect(prisma.knowledgePdfProcessingAttempt.findUniqueOrThrow({
      select: { state: true },
      where: { id: uncertain.attemptId }
    })).resolves.toEqual({ state: "ambiguous" });
    const chunk = {
      contentHash: "d".repeat(64),
      contextPrefix: "",
      documentContext: null,
      embeddingText: "A persisted embedding passage.",
      embeddingTextHash: "e".repeat(64),
      headingPath: [] as string[],
      index: 0,
      page: 1,
      pageEnd: 1,
      sourceBlockEnd: 0,
      sourceBlockIds: ["block-1"],
      sourceBlockStart: 0,
      text: "A persisted embedding passage.",
      tokenCount: 4
    };
    await expect(restartedRepository.persistHierarchicalIndex({
      ...work,
      chunks: [chunk],
      document: null,
      now: new Date(restartNow.getTime() + 3_000)
    })).resolves.toBe(true);
    await expect(restartedRepository.completeChunking({
      ...work,
      chunkCount: 1,
      now: new Date(restartNow.getTime() + 4_000)
    })).resolves.toBe(true);
    await expect(restartedRepository.completedBatchIndexes(
      fixture.artifactId,
      fixture.sourceVersionId
    )).resolves.toEqual([]);
    await expect(restartedRepository.persistEmbeddingBatch({
      ...work,
      batch: {
        batchIndex: 0,
        chunks: [{ ...chunk, vector: Array<number>(1_024).fill(0) }],
        modelId: "embedding-upstream",
        provider: "test",
        providerModelId: fixture.modelId,
        usage: { inputTokens: 4, totalTokens: 4 }
      },
      now: new Date(restartNow.getTime() + 5_000),
      ownerUserId: fixture.ownerUserId,
      targetDimension: 1_024
    })).resolves.toBe(true);
    await expect(restartedRepository.completedBatchIndexes(
      fixture.artifactId,
      fixture.sourceVersionId
    )).resolves.toEqual([0]);
    await expect(prisma.usageEvent.findFirstOrThrow({
      select: {
        knowledgeBaseId: true,
        knowledgeBatchIndex: true,
        knowledgeDocumentVersionId: true,
        knowledgeIndexGenerationId: true,
        modelId: true,
        providerModelId: true
      },
      where: { modelId: "embedding-upstream", userId: fixture.ownerUserId }
    })).resolves.toEqual({
      knowledgeBaseId: null,
      knowledgeBatchIndex: null,
      knowledgeDocumentVersionId: null,
      knowledgeIndexGenerationId: null,
      modelId: "embedding-upstream",
      providerModelId: null
    });
  });
});

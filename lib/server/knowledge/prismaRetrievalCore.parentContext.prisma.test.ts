import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { KNOWLEDGE_HIERARCHICAL_INDEX_VERSION } from "./hierarchicalIndex";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";
import { KnowledgeParentContextError } from "./parentContextExpansion";
import { executeKnowledgeRetrievalCore } from "./prismaRetrievalCore";
import { createPrismaKnowledgeParentContextLoader } from "./prismaRetrievalRepository";
import {
  deleteKnowledgeSearchArtifacts,
  runKnowledgeSearchProjectionPass
} from "./searchProjection";

const fingerprint = "f".repeat(64);

function basisVector(axis: number): number[] {
  return Array.from({ length: 1_024 }, (_, index) => index === axis ? 1 : 0);
}

type Fixture = Readonly<{
  artifactId: string;
  chatId: string;
  hierarchyId: string;
  passageIds: readonly string[];
  runId: string;
  sourceId: string;
  sourceVersionId: string;
  userId: string;
}>;

const PASSAGE_TEXTS = [
  "Alpha context paragraph.",
  "Beta context paragraph.",
  "Parent expansion anchor evidence.",
  "Delta context paragraph.",
  "Epsilon context paragraph."
] as const;

const OTHER_SECTION_TEXT = "Zeta paragraph of the other section.";

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const now = new Date("2026-08-27T06:30:00.000Z");
  const userId = `knowledge-parent-owner-${suffix}`;
  const connectionId = `knowledge-parent-connection-${suffix}`;
  const modelId = `knowledge-parent-model-${suffix}`;
  const credentialId = `knowledge-parent-credential-${suffix}`;
  const credentialVersionId = `knowledge-parent-credential-version-${suffix}`;
  const profileId = `knowledge-parent-profile-${suffix}`;
  const profileRevisionId = `knowledge-parent-profile-revision-${suffix}`;
  const sourceId = `knowledge-parent-source-${suffix}`;
  const sourceVersionId = `knowledge-parent-source-version-${suffix}`;
  const artifactId = `knowledge-parent-artifact-${suffix}`;
  const hierarchyId = `knowledge-parent-hierarchy-${suffix}`;
  const sectionId = `knowledge-parent-section-${suffix}`;
  const otherSectionId = `knowledge-parent-other-section-${suffix}`;
  const passageIds = [
    ...PASSAGE_TEXTS.map((_, ordinal) => `knowledge-parent-passage-${ordinal}-${suffix}`),
    `knowledge-parent-passage-other-${suffix}`
  ];
  const embeddingTextHashes = [
    ...PASSAGE_TEXTS.map((_, ordinal) => String(ordinal + 1).repeat(64)),
    "a".repeat(64)
  ];

  await prisma.user.create({
    data: { displayName: "Knowledge parent owner", id: userId, status: "active" }
  });
  await prisma.providerConnection.create({
    data: { displayName: "Knowledge parent embeddings", family: "test", id: connectionId }
  });
  await prisma.providerModel.create({
    data: {
      capabilities: {},
      connectionId,
      defaultParams: {},
      displayName: "Knowledge parent embedding model",
      id: modelId,
      modelClass: "embedding",
      modelId: `embedding-${suffix}`,
      provider: "test"
    }
  });
  await prisma.providerCredential.create({
    data: {
      connectionId,
      enabled: true,
      id: credentialId,
      label: "Knowledge parent embedding credential"
    }
  });
  await prisma.providerCredentialVersion.create({
    data: {
      activatedAt: now,
      credentialId,
      id: credentialVersionId,
      testEvidence: { authenticationMode: "none", synthetic: true },
      testedAt: now,
      version: 1
    }
  });
  await prisma.knowledgeIndexProfile.create({ data: { id: profileId } });
  await prisma.knowledgeIndexProfileRevision.create({
    data: {
      activatedAt: now,
      chunkingProfileVersion: 7,
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
      targetDimension: 1_024,
      vectorSpaceFingerprint: fingerprint
    }
  });

  const chat = await prisma.chat.create({
    data: { title: "Knowledge parent expansion", userId },
    select: { id: true }
  });
  const message = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: { blocks: [{ text: "Find the anchor evidence", type: "text" }] },
      role: "user"
    },
    select: { id: true }
  });
  const run = await prisma.modelRun.create({
    data: {
      chatId: chat.id,
      modelId: "knowledge-parent-answer",
      normalizedRequest: {},
      provider: "test",
      status: "in_progress",
      userId,
      userMessageId: message.id
    },
    select: { id: true }
  });
  await prisma.knowledgeRunScope.create({
    data: {
      budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
      modelRunId: run.id,
      resolvedBaseCount: 0,
      resolvedSourceCount: 1,
      selection: { baseIds: [], mode: "explicit", sourceIds: [], version: 1 }
    }
  });
  const profileBinding = await prisma.knowledgeRunProfileBinding.create({
    data: {
      embeddingConnectionId: connectionId,
      embeddingCredentialId: credentialId,
      embeddingCredentialSource: "default",
      embeddingCredentialVersionId: credentialVersionId,
      embeddingExecutionSnapshot: { synthetic: true },
      embeddingProviderModelId: modelId,
      modelRunId: run.id,
      ordinal: 0,
      profileRevisionId,
      targetDimension: 1_024,
      vectorSpaceFingerprint: fingerprint
    },
    select: { id: true }
  });

  await prisma.knowledgeSource.create({
    data: { id: sourceId, name: "Parent expansion source", ownerUserId: userId }
  });
  await prisma.knowledgeSourceVersion.create({
    data: {
      byteSize: 512,
      checksum: "a".repeat(64),
      fileName: "parent-expansion.bin",
      id: sourceVersionId,
      mimeType: "application/octet-stream",
      ownerUserId: userId,
      sourceId,
      versionNumber: 1
    }
  });
  await prisma.knowledgeSource.update({
    data: { currentVersionId: sourceVersionId },
    where: { id: sourceId }
  });
  await prisma.knowledgeSourceIndexArtifact.create({
    data: {
      chunkCount: passageIds.length,
      embeddedPassageCount: 0,
      id: artifactId,
      normalizedTextByteSize: 256,
      normalizedTextChecksum: "6".repeat(64),
      normalizedTextStorageKey: `knowledge-parent/${suffix}/normalized`,
      pageCount: 2,
      processingStage: "embedding",
      profileRevisionId,
      sourceVersionId
    }
  });
  await prisma.knowledgeHierarchicalIndexArtifact.create({
    data: {
      derivationMode: "normalized_v2",
      id: hierarchyId,
      schemaVersion: KNOWLEDGE_HIERARCHICAL_INDEX_VERSION,
      sourceArtifactId: artifactId,
      sourceVersionId
    }
  });
  await prisma.knowledgeArtifactDocumentIndex.create({
    data: {
      contentHash: "c".repeat(64),
      documentType: "application/octet-stream",
      fileName: "parent-expansion.bin",
      indexArtifactId: hierarchyId,
      pageCount: 2,
      sourceName: "Parent expansion source"
    }
  });
  await prisma.knowledgeArtifactSectionIndex.createMany({
    data: [{
      contentHash: "d".repeat(64),
      fileName: "parent-expansion.bin",
      id: sectionId,
      indexArtifactId: hierarchyId,
      label: "Primary section",
      ordinal: 0,
      page: 1,
      pageEnd: 1,
      passageEnd: PASSAGE_TEXTS.length - 1,
      passageStart: 0
    }, {
      contentHash: "e".repeat(64),
      fileName: "parent-expansion.bin",
      id: otherSectionId,
      indexArtifactId: hierarchyId,
      label: "Other section",
      ordinal: 1,
      page: 2,
      pageEnd: 2,
      passageEnd: PASSAGE_TEXTS.length,
      passageStart: PASSAGE_TEXTS.length
    }]
  });
  await prisma.knowledgeArtifactPassageIndex.createMany({
    data: [
      ...PASSAGE_TEXTS.map((text, ordinal) => ({
        contentHash: String(ordinal).repeat(64),
        embeddingTextHash: embeddingTextHashes[ordinal]!,
        fileName: "parent-expansion.bin",
        id: passageIds[ordinal]!,
        indexArtifactId: hierarchyId,
        layoutKind: "body",
        ordinal,
        page: 1,
        pageEnd: 1,
        sectionId,
        sourceBlockEnd: ordinal,
        sourceBlockIds: [`block-${ordinal}`],
        sourceBlockStart: ordinal,
        sourceName: "Parent expansion source",
        text,
        tokenCount: 5
      })),
      {
        contentHash: "9".repeat(64),
        embeddingTextHash: embeddingTextHashes[PASSAGE_TEXTS.length]!,
        fileName: "parent-expansion.bin",
        id: passageIds[PASSAGE_TEXTS.length]!,
        indexArtifactId: hierarchyId,
        layoutKind: "body",
        ordinal: PASSAGE_TEXTS.length,
        page: 2,
        pageEnd: 2,
        sectionId: otherSectionId,
        sourceBlockEnd: PASSAGE_TEXTS.length,
        sourceBlockIds: [`block-${PASSAGE_TEXTS.length}`],
        sourceBlockStart: PASSAGE_TEXTS.length,
        sourceName: "Parent expansion source",
        text: OTHER_SECTION_TEXT,
        tokenCount: 6
      }
    ]
  });
  await prisma.knowledgeArtifactExactEntry.create({
    data: {
      id: `knowledge-parent-exact-${suffix}`,
      indexArtifactId: hierarchyId,
      kind: "heading",
      normalizedValue: "primary section",
      ordinal: 0,
      page: 1,
      pageEnd: 1,
      sectionId,
      value: "Primary section",
      valueHash: "7".repeat(64)
    }
  });
  const vector = `[${basisVector(0).join(",")}]`;
  for (const [ordinal, passageId] of passageIds.entries()) {
    await prisma.$executeRaw`
      INSERT INTO "KnowledgeArtifactPassageEmbedding" (
        "passageId", "indexArtifactId", "embeddingTextHash", "embeddingDimension", "embedding"
      ) VALUES (
        ${passageId}, ${hierarchyId}, ${embeddingTextHashes[ordinal]!}, 1024, ${vector}::vector
      )
    `;
  }
  await prisma.knowledgeHierarchicalIndexArtifact.update({
    data: {
      checksum: "b".repeat(64),
      documentCount: 1,
      exactEntryCount: 1,
      passageCount: passageIds.length,
      readyAt: now,
      sectionCount: 2,
      state: "ready"
    },
    where: { id: hierarchyId }
  });
  await prisma.knowledgeSourceIndexArtifact.update({
    data: {
      embeddedPassageCount: passageIds.length,
      processingStage: null,
      readyAt: now,
      state: "ready"
    },
    where: { id: artifactId }
  });
  const projection = await runKnowledgeSearchProjectionPass({ client: prisma, limit: 16 });
  if (projection.projected < 1) throw new Error("knowledge_search_projection_fixture_failed");
  await prisma.knowledgeRunSourceBinding.create({
    data: {
      directSelected: true,
      fileNameSnapshot: "parent-expansion.bin",
      modelRunId: run.id,
      ordinal: 0,
      profileBindingId: profileBinding.id,
      readinessState: "ready",
      selectionKind: "direct",
      sourceAlias: "S1",
      sourceArtifactId: artifactId,
      sourceId,
      sourceNameSnapshot: "Parent expansion source",
      sourceVersionId,
      sourceVersionNumber: 1
    }
  });

  return {
    artifactId,
    chatId: chat.id,
    hierarchyId,
    passageIds,
    runId: run.id,
    sourceId,
    sourceVersionId,
    userId
  };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await deleteKnowledgeSearchArtifacts({ indexArtifactIds: [fixture.hierarchyId] });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
    await tx.modelRun.deleteMany({ where: { id: fixture.runId } });
    await tx.chat.deleteMany({ where: { id: fixture.chatId } });
    await tx.knowledgeSourceIndexArtifact.deleteMany({ where: { id: fixture.artifactId } });
    await tx.knowledgeSource.updateMany({
      data: { currentVersionId: null },
      where: { id: fixture.sourceId }
    });
    await tx.knowledgeSourceVersion.deleteMany({ where: { id: fixture.sourceVersionId } });
    await tx.knowledgeSource.deleteMany({ where: { id: fixture.sourceId } });
    await tx.user.deleteMany({ where: { id: fixture.userId } });
  });
}

describe("Prisma Knowledge child-to-parent context expansion", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("expands a lexical hit with its canonical-section window and respects the section boundary", async () => {
    const fixture = await createFixture();
    try {
      const result = await executeKnowledgeRetrievalCore(prisma, {
        candidateLimit: 64,
        excludedOccurrenceKeys: [],
        parentContextLoader: createPrismaKnowledgeParentContextLoader(prisma),
        query: "anchor evidence",
        resultLimit: 8,
        runId: fixture.runId,
        userId: fixture.userId,
        vectors: []
      });

      const anchor = result.passages.find((passage) =>
        passage.chunkId === fixture.passageIds[2]);
      expect(anchor).toBeDefined();
      // The atomic hit and its canonical locator are untouched by expansion.
      expect(anchor).toMatchObject({
        chunkIndex: 2,
        documentVersionId: fixture.sourceVersionId,
        documentVersionNumber: 1,
        text: PASSAGE_TEXTS[2]
      });
      expect(anchor?.expansion).toMatchObject({ state: "expanded" });
      expect(anchor?.expandedContext).toContain(
        `Previous same-Source context:\n${PASSAGE_TEXTS[0]}\n${PASSAGE_TEXTS[1]}`
      );
      expect(anchor?.expandedContext).toContain(
        `Next same-Source context:\n${PASSAGE_TEXTS[3]}\n${PASSAGE_TEXTS[4]}`
      );
      // The adjacent ordinal from the other canonical section never enters
      // the window even though it is inside the ordinal radius.
      expect(anchor?.expandedContext ?? "").not.toContain(OTHER_SECTION_TEXT);
      // No passage text ships twice across primaries and their windows.
      for (const text of PASSAGE_TEXTS) {
        const shipped = result.passages.reduce((total, passage) => {
          const inPrimary = passage.text === text ? 1 : 0;
          const inContext = (passage.expandedContext ?? "").split(text).length - 1;
          return total + inPrimary + inContext;
        }, 0);
        expect(shipped).toBeLessThanOrEqual(1);
      }
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("keeps atomic evidence when classified parent expansion fails", async () => {
    const fixture = await createFixture();
    try {
      const result = await executeKnowledgeRetrievalCore(prisma, {
        candidateLimit: 64,
        excludedOccurrenceKeys: [],
        parentContextLoader: async () => {
          throw new KnowledgeParentContextError("parent_context_load_failed");
        },
        query: "anchor evidence",
        resultLimit: 8,
        runId: fixture.runId,
        userId: fixture.userId,
        vectors: []
      });
      const anchor = result.passages.find((passage) =>
        passage.chunkId === fixture.passageIds[2]);
      expect(anchor).toMatchObject({
        expansion: { reason: "parent_context_load_failed", state: "degraded" },
        text: PASSAGE_TEXTS[2]
      });
      expect(anchor?.expandedContext).toBe([
        `Previous same-Source context:\n${PASSAGE_TEXTS[1]}`,
        `Next same-Source context:\n${PASSAGE_TEXTS[3]}`
      ].join("\n\n"));
      expect(anchor?.expandedContext).not.toContain(OTHER_SECTION_TEXT);
    } finally {
      await cleanupFixture(fixture);
    }
  });
});

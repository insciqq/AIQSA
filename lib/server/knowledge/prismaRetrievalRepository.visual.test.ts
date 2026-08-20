import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { finalizeParsedDocument } from "../parsing/assessment";
import type { KnowledgeAcceptedBinding } from "./retrievalTypes";
import type { KnowledgeExtractionConfig } from "./knowledgeExtractionConfig";
import { encodeKnowledgeNormalizedDocument } from "./normalizedDocument";
import {
  knowledgeProfileConfiguration,
  knowledgeProfileEgressPolicy,
  type KnowledgeVisionProfileDestination
} from "./knowledgeProfile";
import { createPrismaKnowledgeRetrievalStore } from "./prismaRetrievalRepository";

const config: KnowledgeExtractionConfig = {
  maxChunksPerDocument: 100,
  maxFileBytes: 1_000_000,
  maxNormalizedChars: 100_000,
  maxNormalizedObjectBytes: 1_000_000,
  maxPages: 100
};
const box = {
  bottom: 80,
  coordinateOrigin: "top_left" as const,
  left: 10,
  page: 1,
  right: 90,
  top: 20
};
const encoded = encodeKnowledgeNormalizedDocument(finalizeParsedDocument({
  assets: [{
    boundingBoxes: [box],
    caption: "Quarterly revenue",
    id: "chart-1",
    kind: "chart",
    page: 1
  }],
  blocks: [{
    assetIds: ["chart-1"],
    boundingBoxes: [box],
    headingPath: ["Results"],
    index: 0,
    isTable: false,
    languageHints: ["en"],
    page: 1,
    pageEnd: 1,
    readingOrder: 0,
    table: null,
    text: "",
    type: "image"
  }, {
    assetIds: [],
    boundingBoxes: [],
    headingPath: ["Results"],
    index: 1,
    isTable: false,
    languageHints: ["en"],
    page: 1,
    pageEnd: 1,
    readingOrder: 1,
    table: null,
    text: "Quarterly revenue",
    type: "caption"
  }],
  engine: "docling",
  mediaType: "application/pdf",
  pageCount: 1,
  status: "complete"
}), config);
const original = Buffer.from("%PDF visual", "utf8");
const vision: KnowledgeVisionProfileDestination = {
  connectionDisplayName: "Vision provider",
  modelDisplayName: "Document vision",
  provider: "openai",
  providerModelId: "vision-model-1",
  supportsNativePdf: true
};

function binding(overrides: Partial<KnowledgeAcceptedBinding> = {}): KnowledgeAcceptedBinding {
  return {
    baseContentRevision: 1,
    baseName: "Reports",
    embeddingConnectionId: "embedding-connection",
    embeddingCredentialId: "embedding-credential",
    embeddingCredentialSource: "default",
    embeddingCredentialVersionId: "embedding-credential-version",
    embeddingExecutionSnapshot: {},
    embeddingProviderModelId: "embedding-model",
    includeWholeBase: true,
    indexedContentRevision: 1,
    indexGenerationId: "generation-1",
    knowledgeBaseId: "base-1",
    knowledgeBaseSnapshotId: "snapshot-1",
    ordinal: 0,
    selectedSourceIds: [],
    targetDimension: 1024,
    vectorSpaceFingerprint: "a".repeat(64),
    ...overrides
  };
}

function artifact(egressPolicy: unknown = knowledgeProfileEgressPolicy({
  embeddingProviderModelId: "embedding-model-1",
  visionDestination: vision
})) {
  return {
    id: "artifact-1",
    normalizedTextByteSize: encoded.body.byteLength,
    normalizedTextChecksum: encoded.checksum,
    normalizedTextStorageKey: "normalized/report.json",
    profileRevision: {
      egressPolicy,
      profileConfiguration: knowledgeProfileConfiguration({
        candidateLimit: 40,
        embeddingProviderModelId: "embedding-model-1",
        resultLimit: 8,
        scoreThreshold: 0.01,
        visionDestination: vision
      })
    },
    profileRevisionId: "profile-revision-1",
    sourceVersion: {
      byteSize: original.byteLength,
      checksum: createHash("sha256").update(original).digest("hex"),
      fileName: "report.pdf",
      id: "source-version-1",
      mimeType: "application/pdf",
      originalStorageKey: "original/report.pdf",
      source: { name: "Quarterly report" },
      versionNumber: 1
    },
    snapshotSources: [{
      knowledgeBaseId: "base-1",
      snapshotId: "snapshot-1",
      sourceId: "source-1",
      sourceVersionId: "source-version-1"
    }]
  };
}

describe("Prisma Knowledge visual retrieval scope", () => {
  it("derives candidates only from admitted artifact mappings and the pinned profile", async () => {
    const sharedArtifact = artifact();
    sharedArtifact.snapshotSources.push({
      knowledgeBaseId: "base-2",
      snapshotId: "snapshot-2",
      sourceId: "source-1",
      sourceVersionId: "source-version-1"
    });
    const findMany = vi.fn(async () => [sharedArtifact]);
    const analyze = vi.fn(async () => ({
      description: "North increased.",
      modelId: "vision-upstream-1",
      provider: "openai",
      providerModelId: "vision-model-1",
      usage: { inputTokens: 20, outputTokens: 8, reasoningTokens: 0, totalTokens: 28 }
    }));
    const getObject = vi.fn(async (storageKey: string) => ({
      body: storageKey === "normalized/report.json" ? encoded.body : original,
      contentType: "application/octet-stream",
      storageKey
    }));
    const store = createPrismaKnowledgeRetrievalStore({
      knowledgeSourceIndexArtifact: { findMany }
    } as never, {
      extractionConfig: config,
      storage: { getObject },
      visualRuntime: { analyze }
    });

    const result = await store.visualSearch!({
      bindings: [
        binding(),
        binding({
          baseName: "Archive reports",
          indexGenerationId: "generation-2",
          knowledgeBaseId: "base-2",
          knowledgeBaseSnapshotId: "snapshot-2",
          ordinal: 1
        })
      ],
      query: "What does the quarterly revenue chart show?",
      sourceArtifactIds: ["artifact-1"]
    });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: { in: ["artifact-1"] },
        state: "ready"
      })
    }));
    expect(result).toMatchObject({
      kind: "complete",
      canonicalSourceProvenance: [{
        artifactId: "artifact-1",
        bindings: [
          { baseName: "Reports", bindingOrdinal: 0, knowledgeBaseId: "base-1" },
          { baseName: "Archive reports", bindingOrdinal: 1, knowledgeBaseId: "base-2" }
        ],
        primaryBindingOrdinal: 0,
        sourceId: "source-1",
        sourceVersionId: "source-version-1"
      }],
      passage: {
        bindingOrdinal: 0,
        sourceArtifactId: "artifact-1",
        visualAnalysis: {
          provider: { profileRevisionId: "profile-revision-1" },
          status: "available"
        }
      }
    });
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({
      profileRevisionId: "profile-revision-1",
      providerModelId: "vision-model-1"
    }));
    expect(analyze).toHaveBeenCalledOnce();
  });

  it("does not read original bytes when the immutable egress receipt is missing", async () => {
    const getObject = vi.fn(async (storageKey: string) => {
      if (storageKey !== "normalized/report.json") throw new Error("original_must_not_be_read");
      return { body: encoded.body, contentType: "application/json", storageKey };
    });
    const analyze = vi.fn();
    const store = createPrismaKnowledgeRetrievalStore({
      knowledgeSourceIndexArtifact: { findMany: vi.fn(async () => [artifact({})]) }
    } as never, {
      extractionConfig: config,
      storage: { getObject },
      visualRuntime: { analyze }
    });

    await expect(store.visualSearch!({
      bindings: [binding()],
      query: "What does the quarterly revenue chart show?",
      sourceArtifactIds: ["artifact-1"]
    })).resolves.toMatchObject({
      kind: "complete",
      passage: { visualAnalysis: { status: "unavailable" } }
    });
    expect(analyze).not.toHaveBeenCalled();
    expect(getObject).toHaveBeenCalledTimes(1);
  });
});

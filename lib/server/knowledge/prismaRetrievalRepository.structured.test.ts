import { utils, write } from "xlsx";
import { describe, expect, it, vi } from "vitest";
import { parseSpreadsheetDocument } from "../parsing";
import type { KnowledgeExtractionConfig } from "./knowledgeExtractionConfig";
import { encodeKnowledgeNormalizedDocument } from "./normalizedDocument";
import { createPrismaKnowledgeRetrievalStore } from "./prismaRetrievalRepository";
import type { KnowledgeAcceptedBinding } from "./retrievalTypes";

const config: KnowledgeExtractionConfig = {
  maxChunksPerDocument: 1_000,
  maxFileBytes: 1_000_000,
  maxNormalizedChars: 1_000_000,
  maxNormalizedObjectBytes: 4_000_000,
  maxPages: 100
};

const sheet = utils.aoa_to_sheet([
  ["Region", "Revenue"],
  ["North", 100],
  ["South", 200]
]);
const workbook = utils.book_new();
utils.book_append_sheet(workbook, sheet, "Sales");
const encoded = encodeKnowledgeNormalizedDocument(parseSpreadsheetDocument({
  bytes: write(workbook, { bookType: "xlsx", type: "buffer" }),
  fileName: "quarterly-sales.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
}), config, { sourceDisplayName: "Quarterly Sales" });

function binding(overrides: Partial<KnowledgeAcceptedBinding> = {}): KnowledgeAcceptedBinding {
  return {
    baseContentRevision: 1,
    baseName: "Finance",
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
    targetDimension: 1_024,
    vectorSpaceFingerprint: "a".repeat(64),
    ...overrides
  };
}

describe("Prisma Knowledge structured retrieval scope", () => {
  it("analyzes one canonical artifact admitted through Bases A+B and retains provenance", async () => {
    const getObject = vi.fn(async (storageKey: string) => ({
      body: encoded.body,
      contentType: "application/json",
      storageKey
    }));
    const findMany = vi.fn(async () => [{
      hierarchicalIndexes: [{ id: "hierarchy-1" }],
      id: "artifact-1",
      normalizedTextByteSize: encoded.body.byteLength,
      normalizedTextChecksum: encoded.checksum,
      normalizedTextStorageKey: "normalized/quarterly-sales.json",
      snapshotSources: [{
        knowledgeBaseId: "base-1",
        snapshotId: "snapshot-1",
        sourceId: "source-1",
        sourceVersionId: "source-version-1"
      }, {
        knowledgeBaseId: "base-2",
        snapshotId: "snapshot-2",
        sourceId: "source-1",
        sourceVersionId: "source-version-1"
      }],
      sourceVersion: {
        fileName: "quarterly-sales.xlsx",
        id: "source-version-1",
        source: { name: "Quarterly Sales" },
        versionNumber: 1
      }
    }]);
    const findFirst = vi.fn(async () => ({
      contentHash: "a".repeat(64),
      headingPath: ["Sales"],
      id: "passage-1",
      ordinal: 0,
      sectionId: "section-1"
    }));
    const store = createPrismaKnowledgeRetrievalStore({
      knowledgeArtifactPassageIndex: { findFirst },
      knowledgeSourceIndexArtifact: { findMany }
    } as never, {
      extractionConfig: config,
      storage: { getObject }
    });

    const result = await store.structuredSearch!({
      bindings: [
        binding(),
        binding({
          baseName: "Finance archive",
          indexGenerationId: "generation-2",
          knowledgeBaseId: "base-2",
          knowledgeBaseSnapshotId: "snapshot-2",
          ordinal: 1
        })
      ],
      query: "Sum Revenue in Sales",
      sourceArtifactIds: ["artifact-1"]
    });

    expect(result).toMatchObject({
      canonicalSourceProvenance: [{
        artifactId: "artifact-1",
        bindings: [
          { baseName: "Finance", bindingOrdinal: 0, knowledgeBaseId: "base-1" },
          { baseName: "Finance archive", bindingOrdinal: 1, knowledgeBaseId: "base-2" }
        ],
        primaryBindingOrdinal: 0,
        sourceId: "source-1",
        sourceVersionId: "source-version-1"
      }],
      kind: "complete",
      passage: {
        bindingOrdinal: 0,
        sourceArtifactId: "artifact-1",
        structuredAnalysis: { rows: [[300]] }
      }
    });
    expect(getObject).toHaveBeenCalledOnce();
    expect(findFirst).toHaveBeenCalledOnce();
  });

  it("analyzes an unattached Source through its canonical profile binding", async () => {
    const getObject = vi.fn(async (storageKey: string) => ({
      body: encoded.body,
      contentType: "application/json",
      storageKey
    }));
    const findMany = vi.fn(async () => [{
      hierarchicalIndexes: [{ id: "hierarchy-1" }],
      id: "artifact-1",
      normalizedTextByteSize: encoded.body.byteLength,
      normalizedTextChecksum: encoded.checksum,
      normalizedTextStorageKey: "normalized/quarterly-sales.json",
      runSourceBindings: [{
        profileBindingId: "profile-binding-1",
        sourceId: "source-1",
        sourceVersionId: "source-version-1"
      }],
      snapshotSources: [],
      sourceVersion: {
        fileName: "quarterly-sales.xlsx",
        id: "source-version-1",
        source: { name: "Quarterly Sales" },
        versionNumber: 1
      }
    }]);
    const findFirst = vi.fn(async () => ({
      contentHash: "a".repeat(64),
      headingPath: ["Sales"],
      id: "passage-1",
      ordinal: 0,
      sectionId: "section-1"
    }));
    const store = createPrismaKnowledgeRetrievalStore({
      knowledgeArtifactPassageIndex: { findFirst },
      knowledgeSourceIndexArtifact: { findMany }
    } as never, {
      extractionConfig: config,
      storage: { getObject }
    });
    const directBinding = binding({
      baseContentRevision: 0,
      baseName: "Pinned Knowledge Profile",
      executionScope: "profile",
      includeWholeBase: false,
      indexedContentRevision: 0,
      indexGenerationId: "profile-revision-1",
      knowledgeBaseId: "profile-binding-1",
      knowledgeBaseSnapshotId: "profile-binding-1",
      profileRevisionId: "profile-revision-1",
      selectedSourceIds: ["source-1"]
    });

    const result = await store.structuredSearch!({
      bindings: [directBinding],
      query: "Sum Revenue in Sales",
      sourceArtifactIds: ["artifact-1"]
    });

    expect(result).toMatchObject({
      kind: "complete",
      passage: {
        bindingOrdinal: 0,
        documentId: "source-1",
        knowledgeBaseId: "profile-binding-1",
        sourceArtifactId: "artifact-1"
      }
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [expect.objectContaining({ runSourceBindings: { some: expect.any(Object) } })]
      })
    }));
  });
});

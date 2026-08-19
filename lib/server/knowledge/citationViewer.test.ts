import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { utils, write } from "xlsx";
import { parseSpreadsheetDocument, type ParsedDocument } from "../parsing";
import { finalizeParsedDocument } from "../parsing/assessment";
import type { StorageAdapter } from "../uploads/storage";
import type { KnowledgeExtractionConfig } from "./knowledgeExtractionConfig";
import { encodeKnowledgeNormalizedDocument } from "./normalizedDocument";
import { executeStructuredPlan, STRUCTURED_PLAN_VERSION } from "./structuredData";
import {
  readKnowledgeViewerOriginal,
  resolveKnowledgeCitationViewer,
  resolveKnowledgeSourceViewer
} from "./citationViewer";

const config: KnowledgeExtractionConfig = {
  maxChunksPerDocument: 100,
  maxFileBytes: 10_000,
  maxNormalizedChars: 10_000,
  maxNormalizedObjectBytes: 100_000,
  maxPages: 10
};

function parsedDocument(): ParsedDocument {
  return finalizeParsedDocument({
    blocks: [
      {
        assetIds: [],
        boundingBoxes: [],
        headingPath: ["Policy"],
        index: 0,
        isTable: false,
        languageHints: ["en"],
        page: 2,
        pageEnd: 2,
        readingOrder: 0,
        table: null,
        text: "Context before the cited table.",
        type: "paragraph"
      },
      {
        assetIds: [],
        boundingBoxes: [{
          bottom: 120,
          coordinateOrigin: "top_left",
          left: 30,
          page: 2,
          right: 260,
          top: 80
        }],
        headingPath: ["Policy", "Limits"],
        index: 1,
        isTable: true,
        languageHints: ["en"],
        page: 2,
        pageEnd: 2,
        readingOrder: 1,
        table: {
          cells: [{ column: 0, columnSpan: 1, row: 0, rowSpan: 1, text: "25 MB" }],
          columnCount: 1,
          rowCount: 1
        },
        text: "Maximum file size: 25 MB.",
        type: "table"
      }
    ],
    engine: "docling",
    mediaType: "application/pdf",
    pageCount: 2,
    status: "complete"
  });
}

const encoded = encodeKnowledgeNormalizedDocument(parsedDocument(), config, {
  sourceDisplayName: "policy.pdf"
});

const visualBox = {
  bottom: 160,
  coordinateOrigin: "top_left" as const,
  left: 20,
  page: 1,
  right: 280,
  top: 40
};
const visualEncoded = encodeKnowledgeNormalizedDocument(finalizeParsedDocument({
  assets: [{
    boundingBoxes: [visualBox],
    caption: "Quarterly revenue",
    id: "revenue-chart",
    kind: "chart",
    page: 1
  }],
  blocks: [{
    assetIds: ["revenue-chart"],
    boundingBoxes: [visualBox],
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
  mediaType: "image/png",
  pageCount: 1,
  status: "complete"
}), config, { sourceDisplayName: "chart.png" });

const structuredParsed = (() => {
  const sheet = utils.aoa_to_sheet([
    ["Region", "Revenue"],
    ["North", 100],
    ["South", 200]
  ]);
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, sheet, "Sales");
  return parseSpreadsheetDocument({
    bytes: write(workbook, { bookType: "xlsx", type: "buffer" }),
    fileName: "sales.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
})();

const structuredEncoded = encodeKnowledgeNormalizedDocument(structuredParsed, config, {
  sourceDisplayName: "sales.xlsx"
});

const structuredAnalysis = executeStructuredPlan(structuredParsed.workbook!, {
  aggregate: "sum",
  filters: [],
  groupBy: [],
  includeHidden: false,
  limit: 20,
  operation: "aggregate",
  select: [],
  target: { range: "A1:B3", sheet: "Sales" },
  valueColumn: "Revenue",
  version: STRUCTURED_PLAN_VERSION
});

function storage(body = encoded.body): StorageAdapter {
  return {
    deleteObject: vi.fn(),
    getObject: vi.fn().mockResolvedValue({
      body,
      contentType: "application/json",
      storageKey: "normalized/source.json"
    }),
    putObject: vi.fn()
  };
}

function personalClient(input: Readonly<{
  baseVisible?: boolean;
  evidence?: Record<string, unknown>;
  versionVisible?: boolean;
}> = {}) {
  const evidenceFindFirst = vi.fn().mockResolvedValue(input.evidence ?? {
    baseName: "Engineering handbook",
    excerpt: "Maximum file size: 25 MB.",
    fileName: "policy.pdf",
    handle: "K1",
    headingPath: ["Policy", "Limits"],
    knowledgeBaseId: "base-1",
    page: 2,
    passageId: "passage-1",
    sourceArtifactId: "artifact-1",
    sourceId: "source-1",
    sourceName: "Upload policy",
    sourceVersionId: "version-1",
    sourceVersionNumber: 1,
    state: "available",
    textTruncated: false
  });
  const baseFindFirst = vi.fn().mockResolvedValue(input.baseVisible === false ? null : {
    name: "Engineering handbook",
    ownerUserId: "user-1",
    trashedAt: null
  });
  const versionFindFirst = vi.fn().mockResolvedValue(input.versionVisible === false ? null : {
    artifacts: [{
      hierarchicalIndexes: [{
        passageIndexes: [{
          headingPath: ["Policy", "Limits"],
          page: 2,
          pageEnd: 2,
          sourceBlockEnd: 1,
          sourceBlockIds: [encoded.document.blocks[1]!.id],
          sourceBlockStart: 1
        }]
      }],
      normalizedTextByteSize: encoded.body.byteLength,
      normalizedTextChecksum: encoded.checksum,
      normalizedTextStorageKey: "normalized/source.json",
      state: "ready"
    }],
    byteSize: 5,
    checksum: createHash("sha256").update("12345").digest("hex"),
    fileName: "policy.pdf",
    id: "version-1",
    mimeType: "application/pdf",
    originalStorageKey: "original/policy.pdf",
    source: {
      baseMemberships: [{ removedAt: new Date("2026-08-18T00:00:00Z") }],
      currentVersionId: "version-2",
      deletionRequestedAt: null,
      name: "Upload policy",
      ownerUserId: "user-1",
      trashedAt: null
    },
    versionNumber: 1
  });
  return {
    evidenceFindFirst,
    value: {
      chat: {
        findUnique: vi.fn().mockResolvedValue({
          archived: false,
          permanentDeletionAt: null,
          projectId: null,
          userId: "user-1"
        })
      },
      knowledgeBase: { findFirst: baseFindFirst },
      knowledgeEvidenceItem: { findFirst: evidenceFindFirst },
      knowledgeSourceVersion: { findFirst: versionFindFirst },
      modelRun: {
        findFirst: vi.fn().mockResolvedValue({ chatId: "chat-1", id: "run-1" })
      },
      userGroup: { findMany: vi.fn().mockResolvedValue([]) }
    },
    versionFindFirst
  };
}

const request = {
  assistantMessageId: "message-1",
  handle: "K1",
  runId: "run-1",
  userId: "user-1"
};

describe("Knowledge citation viewer authorization and projection", () => {
  it("resolves immutable v2 evidence with normalized context, coordinates, table, and version states", async () => {
    const fixture = personalClient();
    const resolved = await resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(),
      request
    );

    expect(resolved).toMatchObject({
      citation: {
        blocks: [
          { relation: "before", text: "Context before the cited table." },
          {
            boundingBoxes: [{ page: 2, left: 30, right: 260 }],
            relation: "target",
            table: { cells: [{ text: "25 MB" }], truncated: false },
            text: "Maximum file size: 25 MB."
          }
        ],
        excerpt: "Maximum file size: 25 MB.",
        handle: "K1",
        locator: { pageEnd: 2, pageStart: 2 },
        originalKind: "pdf",
        source: {
          statuses: ["earlier_version", "removed"],
          versionNumber: 1
        },
        state: "available"
      },
      original: {
        checksum: createHash("sha256").update("12345").digest("hex"),
        fileName: "policy.pdf",
        mimeType: "application/pdf",
        storageKey: "original/policy.pdf"
      }
    });
  });

  it("reconstructs structured operation evidence from the immutable workbook artifact", async () => {
    const fixture = personalClient({
      evidence: {
        baseName: "Finance",
        contextBoundaries: { structuredAnalysis },
        excerpt: "Calculated sum Revenue: 300.",
        fileName: "sales.xlsx",
        handle: "K1",
        headingPath: ["Sales"],
        knowledgeBaseId: "base-1",
        locator: { ranges: structuredAnalysis.receipt.inputRanges },
        page: 1,
        passageId: "passage-sales",
        sourceArtifactId: "artifact-sales",
        sourceId: "source-sales",
        sourceName: "Quarterly sales",
        sourceVersionId: "version-sales",
        sourceVersionNumber: 1,
        state: "available",
        textTruncated: false
      }
    });
    fixture.versionFindFirst.mockResolvedValueOnce({
      artifacts: [{
        hierarchicalIndexes: [{
          passageIndexes: [{
            headingPath: ["Sales"],
            page: 1,
            pageEnd: 1,
            sourceBlockEnd: 0,
            sourceBlockIds: [structuredEncoded.document.blocks[0]!.id],
            sourceBlockStart: 0
          }]
        }],
        normalizedTextByteSize: structuredEncoded.body.byteLength,
        normalizedTextChecksum: structuredEncoded.checksum,
        normalizedTextStorageKey: "normalized/sales.json",
        state: "ready"
      }],
      byteSize: 5,
      checksum: createHash("sha256").update("12345").digest("hex"),
      fileName: "sales.xlsx",
      id: "version-sales",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      originalStorageKey: "original/sales.xlsx",
      source: {
        baseMemberships: [{ removedAt: null }],
        currentVersionId: "version-sales",
        deletionRequestedAt: null,
        name: "Quarterly sales",
        ownerUserId: "user-1",
        trashedAt: null
      },
      versionNumber: 1
    });

    const resolved = await resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(structuredEncoded.body),
      request
    );

    expect(resolved).toMatchObject({
      citation: {
        handle: "K1",
        originalKind: null,
        workbook: {
          operationSummary: "sum Revenue",
          ranges: [{
            cells: [
              { address: "B2", display: "100", value: 100 },
              { address: "B3", display: "200", value: 200 }
            ],
            range: "B2:B3",
            role: "value",
            sheet: "Sales",
            truncated: false
          }],
          result: { columns: ["sum Revenue"], rows: [[300]] }
        }
      },
      original: null
    });
  });

  it("opens visual evidence on the exact original image region without exposing provider internals", async () => {
    const visualBlock = visualEncoded.document.blocks.find((block) => block.type === "image")!;
    const visualAsset = visualEncoded.document.assets[0]!;
    const analysis = {
      assetId: visualAsset.id,
      blockId: visualBlock.id,
      boundingBoxes: [visualBox],
      caption: "Quarterly revenue",
      description: "North increased while South remained flat.",
      headingPath: ["Results"],
      kind: "chart" as const,
      label: "Quarterly revenue",
      page: 1,
      provider: {
        modelId: "vision-upstream-private",
        profileRevisionId: "profile-revision-private",
        provider: "openai",
        providerModelId: "vision-deployment-private",
        usage: { inputTokens: 20, outputTokens: 8, reasoningTokens: 0, totalTokens: 28 }
      },
      status: "available" as const,
      version: 1 as const,
      warnings: []
    };
    const fixture = personalClient({
      evidence: {
        baseName: "Reports",
        contextBoundaries: { visualAnalysis: analysis },
        excerpt: "Visual evidence: Quarterly revenue",
        fileName: "chart.png",
        handle: "K1",
        headingPath: ["Results"],
        knowledgeBaseId: "base-1",
        page: 1,
        passageId: `visual:${visualBlock.id}:${visualAsset.id}`,
        sourceArtifactId: "artifact-visual",
        sourceId: "source-visual",
        sourceName: "Quarterly report",
        sourceVersionId: "version-visual",
        sourceVersionNumber: 1,
        state: "available",
        textTruncated: false
      }
    });
    fixture.versionFindFirst.mockResolvedValueOnce({
      artifacts: [{
        hierarchicalIndexes: [{ passageIndexes: [] }],
        normalizedTextByteSize: visualEncoded.body.byteLength,
        normalizedTextChecksum: visualEncoded.checksum,
        normalizedTextStorageKey: "normalized/chart.json",
        state: "ready"
      }],
      byteSize: 3,
      checksum: createHash("sha256").update("PNG").digest("hex"),
      fileName: "chart.png",
      id: "version-visual",
      mimeType: "image/png",
      originalStorageKey: "original/chart.png",
      source: {
        baseMemberships: [{ removedAt: null }],
        currentVersionId: "version-visual",
        deletionRequestedAt: null,
        name: "Quarterly report",
        ownerUserId: "user-1",
        trashedAt: null
      },
      versionNumber: 1
    });

    const resolved = await resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(visualEncoded.body),
      request
    );

    expect(resolved).toMatchObject({
      citation: {
        blocks: expect.arrayContaining([
          expect.objectContaining({ relation: "target", type: "image" })
        ]),
        locator: { boundingBoxes: [visualBox], pageEnd: 1, pageStart: 1 },
        originalKind: "image",
        visual: {
          caption: "Quarterly revenue",
          description: "North increased while South remained flat.",
          kind: "chart",
          status: "available"
        }
      },
      original: {
        fileName: "chart.png",
        mimeType: "image/png",
        storageKey: "original/chart.png"
      }
    });
    expect(JSON.stringify(resolved?.citation)).not.toContain("vision-deployment-private");
  });

  it("returns a metadata-free deletion state after answer access", async () => {
    const fixture = personalClient({
      evidence: {
        baseName: null,
        excerpt: null,
        fileName: null,
        handle: "K1",
        headingPath: [],
        knowledgeBaseId: null,
        page: null,
        passageId: null,
        sourceArtifactId: null,
        sourceId: null,
        sourceName: null,
        sourceVersionId: null,
        sourceVersionNumber: null,
        state: "deleted",
        textTruncated: null
      }
    });
    await expect(resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(),
      request
    )).resolves.toEqual({
      citation: { handle: "K1", state: "deleted" },
      original: null
    });
    expect(fixture.versionFindFirst).not.toHaveBeenCalled();
  });

  it("exposes nothing after current Base authority is lost", async () => {
    const fixture = personalClient({ baseVisible: false });
    await expect(resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(),
      request
    )).resolves.toBeNull();
    expect(fixture.versionFindFirst).not.toHaveBeenCalled();
  });

  it("does not inspect evidence after current Project access is lost", async () => {
    const evidenceFindFirst = vi.fn();
    const client = {
      chat: {
        findUnique: vi.fn().mockResolvedValue({
          archived: false,
          permanentDeletionAt: null,
          projectId: "project-1",
          userId: null
        })
      },
      knowledgeEvidenceItem: { findFirst: evidenceFindFirst },
      modelRun: {
        findFirst: vi.fn().mockResolvedValue({ chatId: "chat-1", id: "run-1" })
      },
      project: { findUnique: vi.fn().mockResolvedValue(null) },
      user: { findFirst: vi.fn().mockResolvedValue({ groups: [], id: "user-1" }) }
    };
    await expect(resolveKnowledgeCitationViewer(
      client as never,
      storage(),
      request
    )).resolves.toBeNull();
    expect(evidenceFindFirst).not.toHaveBeenCalled();
  });

  it("keeps legacy historical handles readable without inventing native coordinates", async () => {
    const text = "The accepted legacy passage.";
    const legacy = {
      annRank: 1,
      baseName: "Engineering handbook",
      bindingOrdinal: 0,
      chunkId: "chunk-1",
      chunkIndex: 0,
      documentId: "document-1",
      documentVersionId: "document-version-1",
      documentVersionNumber: 2,
      fileName: "legacy.pdf",
      ftsRank: null,
      ftsScore: null,
      fusedScore: 1 / 61,
      handle: "K12.1",
      includedText: text,
      includedTextBytes: Buffer.byteLength(text, "utf8"),
      knowledgeBaseId: "base-1",
      page: 7,
      sourceTextBytes: Buffer.byteLength(text, "utf8"),
      textTruncated: false,
      vectorDistance: 0.2,
      vectorScore: 0.8
    };
    const client = {
      chat: {
        findUnique: vi.fn().mockResolvedValue({
          archived: false,
          permanentDeletionAt: null,
          projectId: null,
          userId: "user-1"
        })
      },
      knowledgeBase: {
        findFirst: vi.fn().mockResolvedValue({
          name: "Engineering handbook",
          ownerUserId: "user-1",
          trashedAt: null
        })
      },
      knowledgeRun: { findFirst: vi.fn().mockResolvedValue({ results: [legacy] }) },
      modelRun: {
        findFirst: vi.fn().mockResolvedValue({ chatId: "chat-1", id: "run-1" })
      },
      userGroup: { findMany: vi.fn().mockResolvedValue([]) }
    };
    await expect(resolveKnowledgeCitationViewer(client as never, storage(), {
      ...request,
      handle: "K12.1"
    })).resolves.toMatchObject({
      citation: {
        blocks: [{ boundingBoxes: [], relation: "target", text }],
        excerpt: text,
        handle: "K12.1",
        locator: { boundingBoxes: [], pageEnd: 7, pageStart: 7 },
        originalKind: null,
        state: "available"
      },
      original: null
    });
  });

  it("reads an original only within the accepted byte bound", async () => {
    const adapter = storage(Buffer.from("12345"));
    await expect(readKnowledgeViewerOriginal(adapter, {
      byteSize: 5,
      checksum: createHash("sha256").update("12345").digest("hex"),
      fileName: "policy.pdf",
      mimeType: "application/pdf",
      storageKey: "original/policy.pdf"
    })).resolves.toEqual(Buffer.from("12345"));
    await expect(readKnowledgeViewerOriginal(adapter, {
      byteSize: 4,
      checksum: createHash("sha256").update("12345").digest("hex"),
      fileName: "policy.pdf",
      mimeType: "application/pdf",
      storageKey: "original/policy.pdf"
    })).rejects.toThrow("knowledge_viewer_original_size_mismatch");
    await expect(readKnowledgeViewerOriginal(adapter, {
      byteSize: 5,
      checksum: createHash("sha256").update("different").digest("hex"),
      fileName: "policy.pdf",
      mimeType: "application/pdf",
      storageKey: "original/policy.pdf"
    })).rejects.toThrow("knowledge_viewer_original_checksum_mismatch");
  });

  it("reauthorizes a current Source Library version through an accessible Base", async () => {
    const baseFindFirst = vi.fn().mockResolvedValue({
      name: "Engineering handbook",
      ownerUserId: "owner-1",
      trashedAt: null
    });
    const client = {
      knowledgeBase: { findFirst: baseFindFirst },
      knowledgeSource: {
        findFirst: vi.fn().mockResolvedValue({
          baseMemberships: [{ knowledgeBaseId: "base-1", removedAt: null }],
          currentVersion: {
            artifacts: [{
              normalizedTextByteSize: encoded.body.byteLength,
              normalizedTextChecksum: encoded.checksum,
              normalizedTextStorageKey: "normalized/source.json",
              state: "ready"
            }],
            byteSize: 5,
            checksum: createHash("sha256").update("12345").digest("hex"),
            fileName: "policy.pdf",
            mimeType: "application/pdf",
            originalStorageKey: "original/policy.pdf",
            versionNumber: 2
          },
          deletionRequestedAt: null,
          name: "Upload policy",
          ownerUserId: "owner-1",
          trashedAt: null
        })
      },
      userGroup: { findMany: vi.fn().mockResolvedValue([]) }
    };

    await expect(resolveKnowledgeSourceViewer(client as never, storage(), {
      sourceId: "source-1",
      userId: "reader-1"
    })).resolves.toMatchObject({
      original: { storageKey: "original/policy.pdf" },
      source: {
        excerpt: "Context before the cited table.",
        source: {
          baseName: "Engineering handbook",
          name: "Upload policy",
          versionNumber: 2
        },
        state: "available"
      }
    });
    expect(baseFindFirst).toHaveBeenCalled();
  });

  it("keeps an inaccessible Source Library projection privacy neutral", async () => {
    const adapter = storage();
    const client = {
      knowledgeBase: { findFirst: vi.fn().mockResolvedValue(null) },
      knowledgeSource: {
        findFirst: vi.fn().mockResolvedValue({
          baseMemberships: [{ knowledgeBaseId: "base-private", removedAt: null }],
          currentVersion: {
            artifacts: [],
            byteSize: 5,
            checksum: createHash("sha256").update("12345").digest("hex"),
            fileName: "private.pdf",
            mimeType: "application/pdf",
            originalStorageKey: "original/private.pdf",
            versionNumber: 1
          },
          deletionRequestedAt: null,
          name: "Private source",
          ownerUserId: "owner-1",
          trashedAt: null
        })
      },
      userGroup: { findMany: vi.fn().mockResolvedValue([]) }
    };

    await expect(resolveKnowledgeSourceViewer(client as never, adapter, {
      sourceId: "source-private",
      userId: "reader-1"
    })).resolves.toBeNull();
    expect(adapter.getObject).not.toHaveBeenCalled();
  });
});

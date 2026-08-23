import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { utils, write } from "xlsx";
import { parseSpreadsheetDocument, type ParsedDocument } from "../parsing";
import { finalizeParsedDocument } from "../parsing/assessment";
import type { StorageAdapter } from "../uploads/storage";
import { toolLoopCheckpoint } from "../runs/toolLoopPersistence";
import type { KnowledgeExtractionConfig } from "./knowledgeExtractionConfig";
import { encodeKnowledgeNormalizedDocument } from "./normalizedDocument";
import { STRUCTURED_PLAN_VERSION } from "./structuredData";
import {
  createKnowledgeFieldContextSegments,
  createKnowledgeTableDocumentContext
} from "./documentContext";
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

const rowEncoded = encodeKnowledgeNormalizedDocument(finalizeParsedDocument({
  blocks: [{
    assetIds: [],
    boundingBoxes: [],
    headingPath: ["Measurements"],
    index: 0,
    isTable: true,
    languageHints: ["en"],
    page: 1,
    pageEnd: 1,
    readingOrder: 0,
    table: {
      cells: [
        { column: 0, columnSpan: 1, row: 0, rowSpan: 1, text: "Metric" },
        { column: 1, columnSpan: 1, row: 0, rowSpan: 1, text: "Actual" },
        { column: 0, columnSpan: 1, row: 1, rowSpan: 1, text: "Temperature" },
        { column: 1, columnSpan: 1, row: 1, rowSpan: 1, text: "10" },
        { column: 0, columnSpan: 1, row: 2, rowSpan: 1, text: "Pressure" },
        { column: 1, columnSpan: 1, row: 2, rowSpan: 1, text: "20" }
      ],
      columnCount: 2,
      rowCount: 3
    },
    text: "Metric\tActual\nTemperature\t10\nPressure\t20",
    type: "table"
  }],
  engine: "docling",
  mediaType: "application/pdf",
  pageCount: 1,
  status: "complete"
}), config, { sourceDisplayName: "measurements.pdf" });

const fieldEncoded = encodeKnowledgeNormalizedDocument(finalizeParsedDocument({
  blocks: [{
    assetIds: [],
    boundingBoxes: [],
    headingPath: ["Intake"],
    index: 0,
    isTable: false,
    languageHints: ["en"],
    page: 1,
    pageEnd: 1,
    readingOrder: 0,
    table: null,
    text: "Form notes.",
    type: "paragraph"
  }],
  engine: "docling",
  fieldGroups: [{
    boundingBoxes: [],
    cells: [
      {
        boundingBoxes: [], confidence: 0.98, id: 1, itemRef: "#/texts/0",
        label: "key", order: 0, originalText: "Actual pressure", text: "Actual pressure"
      },
      {
        boundingBoxes: [], confidence: 0.97, id: 2, itemRef: "#/texts/1",
        label: "value", order: 1, originalText: "20 kPa", text: "20 kPa"
      }
    ],
    confidence: 0.97,
    kind: "form",
    links: [{
      confidence: 0.97,
      label: "to_value",
      order: 0,
      sourceCellId: 1,
      targetCellId: 2
    }],
    page: 1,
    pageEnd: 1,
    readingOrder: 0,
    sourceRef: "#/form_items/0"
  }],
  mediaType: "application/pdf",
  pageCount: 1,
  status: "complete"
}), config, { sourceDisplayName: "intake.pdf" });

const fieldBoundaryEncoded = encodeKnowledgeNormalizedDocument(finalizeParsedDocument({
  blocks: [{
    assetIds: [],
    boundingBoxes: [],
    headingPath: ["Section A"],
    index: 0,
    isTable: false,
    languageHints: ["en"],
    page: 1,
    pageEnd: 1,
    readingOrder: 0,
    table: null,
    text: "Section A notes.",
    type: "paragraph"
  }, {
    assetIds: [],
    boundingBoxes: [],
    headingPath: ["Section B"],
    index: 1,
    isTable: false,
    languageHints: ["en"],
    page: 1,
    pageEnd: 1,
    readingOrder: 1,
    table: null,
    text: "Section B notes.",
    type: "paragraph"
  }],
  engine: "docling",
  fieldGroups: [{
    boundingBoxes: [],
    cells: [
      {
        boundingBoxes: [], confidence: 0.98, id: 1, itemRef: "#/texts/0",
        label: "key", order: 0, originalText: "Actual pressure", text: "Actual pressure"
      },
      {
        boundingBoxes: [], confidence: 0.97, id: 2, itemRef: "#/texts/1",
        label: "value", order: 1, originalText: "20 kPa", text: "20 kPa"
      }
    ],
    confidence: 0.97,
    kind: "form",
    links: [{
      confidence: 0.97,
      label: "to_value",
      order: 0,
      sourceCellId: 1,
      targetCellId: 2
    }],
    page: 1,
    pageEnd: 1,
    readingOrder: 1,
    sourceRef: "#/form_items/0"
  }],
  mediaType: "application/pdf",
  pageCount: 1,
  status: "complete"
}), config, { sourceDisplayName: "section-boundary-form.pdf" });

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

const structuredAnalysis = {
  columns: ["sum Revenue"],
  receipt: {
    formulaCellsUsed: 0,
    hiddenRowsExcluded: 0,
    inputRanges: [{ range: "B2:B3", role: "value", sheet: "Sales", sheetIndex: 0 }],
    operation: "aggregate",
    operationSummary: "sum Revenue",
    outputRows: 1,
    plan: {
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
    },
    rowsMatched: 2,
    rowsScanned: 2,
    warnings: []
  },
  rows: [[300]]
} as const;

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

const PASSAGE_CONTENT_HASH = createHash("sha256")
  .update("Maximum file size: 25 MB.")
  .digest("hex");
const STRUCTURED_PASSAGE_CONTENT_HASH = createHash("sha256")
  .update("Sales workbook passage")
  .digest("hex");

function defaultEvidence(): Record<string, unknown> {
  return {
    baseName: "Engineering handbook",
    contentHash: PASSAGE_CONTENT_HASH,
    contextBoundaries: null,
    documentId: "source-1",
    documentVersionId: "version-1",
    excerpt: "Maximum file size: 25 MB.",
    fileName: "policy.pdf",
    handle: "K1",
    headingPath: ["Policy", "Limits"],
    knowledgeBaseId: "profile-binding-1",
    locator: { internal: "private-source-locator-viewer-sentinel" },
    page: 2,
    passageId: "passage-1",
    provenance: [{
      source: {
        artifactId: "artifact-1",
        bindings: [
          { baseName: "Primary", bindingOrdinal: 0, knowledgeBaseId: "base-1" },
          {
            baseName: "Mirror",
            bindingOrdinal: 1,
            knowledgeBaseId: "private-secondary-base-viewer-sentinel"
          }
        ],
        primaryBindingOrdinal: 0,
        sourceId: "source-1",
        sourceVersionId: "version-1"
      }
    }],
    sourceArtifactId: "artifact-1",
    sourceId: "source-1",
    sourceName: "Upload policy",
    sourceVersionId: "version-1",
    sourceVersionNumber: 1,
    state: "available",
    textTruncated: false
  };
}

function defaultVersion() {
  return {
    artifacts: [{
      hierarchicalIndexes: [{
        passageIndexes: [{
          contentHash: PASSAGE_CONTENT_HASH,
          headingPath: ["Policy", "Limits"],
          page: 2,
          pageEnd: 2,
          sourceBlockEnd: 1,
          sourceBlockIds: [encoded.document.blocks[1]!.id],
          sourceBlockStart: 1
        }]
      }],
      id: "artifact-1",
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
      baseMemberships: [{
        knowledgeBaseId: "base-1",
        removedAt: new Date("2026-08-18T00:00:00Z")
      }],
      currentVersionId: "version-2",
      deletionRequestedAt: null,
      name: "Upload policy",
      ownerUserId: "user-1",
      trashedAt: null
    },
    versionNumber: 1
  };
}

function personalClient(input: Readonly<{
  accessKind?: "personal" | "project";
  assistantText?: string;
  baseOwnerUserId?: string;
  baseProvenance?: readonly Readonly<{
    indexGenerationId: string;
    knowledgeBaseId: string;
  }>[];
  baseVisible?: boolean;
  bindingOwnerUserId?: string;
  bindingTuple?: Readonly<{
    sourceArtifactId: string;
    sourceId: string;
    sourceVersionId: string;
  }>;
  baseTrashed?: boolean;
  bindingVisible?: boolean;
  deletedEvidenceFallback?: boolean;
  evidence?: Record<string, unknown> | null;
  evidenceRetrievalSessionId?: string;
  fullContextEvidence?: Record<string, unknown> | null;
  fullContextEvidenceCount?: number;
  groupIds?: readonly string[];
  manifestRetrievalSessionId?: string;
  projectSourceBindingVisible?: boolean;
  ragEvidence?: Record<string, unknown> | null;
  sourceDeletionRequested?: boolean;
  sourceTrashed?: boolean;
  toolLoopCheckpointRound?: number;
  versionVisible?: boolean;
}> = {}) {
  const evidence = input.evidence === undefined ? defaultEvidence() : input.evidence;
  const dispatchManifestItemFindFirst = vi.fn().mockResolvedValue(evidence
    ? {
        evidenceItem: {
          ...evidence,
          retrievalSessionId: input.evidenceRetrievalSessionId ?? "retrieval-session-1"
        },
        manifest: {
          retrievalSessionId: input.manifestRetrievalSessionId ?? "retrieval-session-1"
        }
      }
    : null);
  const deletedEvidenceFindFirst = vi.fn().mockImplementation((query: Readonly<{
    where?: Readonly<{ state?: string }>;
  }>) => {
    if (query.where?.state === "available") {
      return Promise.resolve(input.ragEvidence
        ? {
            ...input.ragEvidence,
            retrievalSessionId: input.evidenceRetrievalSessionId ?? "retrieval-session-1"
          }
        : null);
    }
    return Promise.resolve(input.deletedEvidenceFallback ? { handle: "K1" } : null);
  });
  const fullContextEvidence = input.fullContextEvidence ?? null;
  const fullContextEvidenceCount = input.fullContextEvidenceCount ?? 1;
  const fullContextMessage = fullContextEvidence
    ? JSON.stringify({
        citation: `[${String(fullContextEvidence.handle)}]`,
        exactExcerpt: fullContextEvidence.excerpt,
        fileName: fullContextEvidence.fileName,
        handle: fullContextEvidence.handle,
        sourceVersionNumber: fullContextEvidence.sourceVersionNumber,
        type: "source_evidence"
      })
    : "";
  const retrievalSessionFindFirst = vi.fn().mockResolvedValue(fullContextEvidence
    ? {
        _count: { evidenceItems: fullContextEvidenceCount },
        evidenceItems: [{
          ...fullContextEvidence,
          retrievalSessionId: input.evidenceRetrievalSessionId ?? "retrieval-session-1"
        }]
      }
    : null);
  const baseFindFirst = vi.fn().mockResolvedValue(input.baseVisible === false ? null : {
    name: "Engineering handbook",
    ownerUserId: input.baseOwnerUserId ?? "user-1",
    trashedAt: input.baseTrashed ? new Date("2026-08-21T00:00:00.000Z") : null
  });
  const version = defaultVersion();
  if (input.sourceDeletionRequested) {
    Object.assign(version.source, {
      deletionRequestedAt: new Date("2026-08-21T00:00:00.000Z")
    });
  }
  if (input.sourceTrashed) {
    Object.assign(version.source, {
      trashedAt: new Date("2026-08-21T00:00:00.000Z")
    });
  }
  const versionFindFirst = vi.fn().mockResolvedValue(
    input.versionVisible === false ? null : version
  );
  const bindingTuple = input.bindingTuple ?? {
    sourceArtifactId: "artifact-1",
    sourceId: "source-1",
    sourceVersionId: "version-1"
  };
  const bindingFindFirst = vi.fn().mockImplementation((query: Readonly<{
    where: Readonly<{
      modelRunId: string;
      sourceArtifactId: string;
      sourceId: string;
      sourceVersionId: string;
    }>;
  }>) => Promise.resolve(
    input.bindingVisible === false ||
      query.where.modelRunId !== "run-1" ||
      query.where.sourceArtifactId !== bindingTuple.sourceArtifactId ||
      query.where.sourceId !== bindingTuple.sourceId ||
      query.where.sourceVersionId !== bindingTuple.sourceVersionId
      ? null
      : {
          baseProvenance: input.baseProvenance ?? [{
            indexGenerationId: "generation-1",
            knowledgeBaseId: "base-1"
          }],
          profileBindingId: "profile-binding-1",
          source: { ownerUserId: input.bindingOwnerUserId ?? "user-1" },
          sourceVersionNumber: 1
        }
  ));
  const projectSourceBindingFindUnique = vi.fn().mockResolvedValue(
    input.projectSourceBindingVisible === false ? null : { projectId: "project-1" }
  );
  return {
    baseFindFirst,
    bindingFindFirst,
    deletedEvidenceFindFirst,
    dispatchManifestItemFindFirst,
    projectSourceBindingFindUnique,
    value: {
      chat: {
        findUnique: vi.fn().mockResolvedValue({
          archived: false,
          permanentDeletionAt: null,
          projectId: input.accessKind === "project" ? "project-1" : null,
          userId: input.accessKind === "project" ? null : "user-1"
        })
      },
      knowledgeBase: { findFirst: baseFindFirst },
      knowledgeEvidenceDispatchManifestItem: { findFirst: dispatchManifestItemFindFirst },
      knowledgeEvidenceItem: { findFirst: deletedEvidenceFindFirst },
      knowledgeRetrievalSession: { findFirst: retrievalSessionFindFirst },
      knowledgeRunSourceBinding: { findFirst: bindingFindFirst },
      knowledgeSourceVersion: { findFirst: versionFindFirst },
      modelRun: {
        findFirst: vi.fn().mockResolvedValue({
          assistantMessage: {
            content: {
              blocks: [{ text: input.assistantText ?? "Supported answer [K1]", type: "text" }]
            }
          },
          chatId: "chat-1",
          id: "run-1",
          normalizedRequest: fullContextEvidence
            ? {
                context: {
                  messages: [{
                    content: { blocks: [{ text: fullContextMessage, type: "text" }] },
                    id: "knowledge-evidence:v2",
                    purpose: "knowledge_evidence"
                  }]
                },
                knowledgeAnswering: {
                  evidenceCount: fullContextEvidenceCount,
                  route: "full_context_v1",
                  version: 1
                }
              }
            : null,
          toolLoopState: input.toolLoopCheckpointRound === undefined
            ? null
            : toolLoopCheckpoint({
                phase: "provider_running",
                providerContinuation: { responseId: "response-after-tools" },
                roundIndex: input.toolLoopCheckpointRound
              })
        })
      },
      project: {
        findUnique: vi.fn().mockResolvedValue({
          accessRevision: 1,
          grants: [{ group: null, groupId: null, role: "VIEWER", userId: "user-1" }],
          id: "project-1",
          instructionsRevision: 1,
          memoryRevision: 1,
          policyRevision: 1,
          status: "ACTIVE"
        })
      },
      projectKnowledgeSourceBinding: {
        findUnique: projectSourceBindingFindUnique
      },
      user: { findFirst: vi.fn().mockResolvedValue({ groups: [], id: "user-1" }) },
      userGroup: {
        findMany: vi.fn().mockResolvedValue(
          (input.groupIds ?? []).map((groupId) => ({ groupId }))
        )
      }
    },
    retrievalSessionFindFirst,
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
    const clientCitation = JSON.stringify(resolved?.citation);
    for (const privateId of [
      "artifact-1",
      "base-1",
      "source-1",
      "version-1",
      "private-source-locator-viewer-sentinel",
      "private-secondary-base-viewer-sentinel"
    ]) {
      expect(clientCitation).not.toContain(privateId);
    }
    expect(fixture.dispatchManifestItemFindFirst).toHaveBeenCalledWith({
      select: {
        evidenceItem: { select: expect.objectContaining({ handle: true }) },
        manifest: { select: { retrievalSessionId: true } }
      },
      where: {
        evidenceItem: {
          is: {
            handle: "K1",
            retrievalSession: { modelRunId: "run-1" }
          }
        },
        handle: "K1",
        manifest: {
          is: {
            modelRunId: "run-1",
            providerAttempt: {
              is: {
                modelRunId: "run-1",
                purpose: "answer",
                state: "settled"
              }
            },
            purgedAt: null,
            retrievalSession: { is: { modelRunId: "run-1" } }
          }
        }
      }
    });
  });

  it.each(["undispatched", "exclusion-only"])(
    "does not expose %s v2 evidence",
    async () => {
      const fixture = personalClient({ evidence: null });

      await expect(resolveKnowledgeCitationViewer(
        fixture.value as never,
        storage(),
        request
      )).resolves.toBeNull();
      expect(fixture.dispatchManifestItemFindFirst).toHaveBeenCalledOnce();
      expect(fixture.versionFindFirst).not.toHaveBeenCalled();
    }
  );

  it("resolves settled RAG evidence delivered before the final provider checkpoint", async () => {
    const fixture = personalClient({
      evidence: null,
      ragEvidence: defaultEvidence(),
      toolLoopCheckpointRound: 2
    });

    await expect(resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(),
      request
    )).resolves.toMatchObject({
      citation: { handle: "K1", state: "available" }
    });
    expect(fixture.deletedEvidenceFindFirst).toHaveBeenCalledWith({
      select: expect.objectContaining({ handle: true, retrievalSessionId: true }),
      where: {
        handle: "K1",
        operationLinks: {
          some: {
            knowledgeRun: {
              is: {
                modelRunId: "run-1",
                modelRunToolCall: {
                  is: {
                    modelRunId: "run-1",
                    roundIndex: { lt: 2 },
                    state: "complete",
                    toolName: "search_knowledge"
                  }
                }
              }
            }
          }
        },
        retrievalSession: {
          acceptedAt: { not: null },
          groundingResult: { isNot: null },
          modelRunId: "run-1",
          originalIntent: { equals: { kind: "tool_loop_v1" } },
          receiptHash: { not: null }
        },
        state: "available"
      }
    });
  });

  it("resolves legacy full-context evidence from its settled grounding receipt", async () => {
    const fixture = personalClient({
      evidence: null,
      fullContextEvidence: defaultEvidence()
    });

    await expect(resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(),
      request
    )).resolves.toMatchObject({
      citation: { handle: "K1", state: "available" }
    });
    expect(fixture.retrievalSessionFindFirst).toHaveBeenCalledWith({
      select: {
        _count: { select: { evidenceItems: true } },
        evidenceItems: {
          select: expect.objectContaining({ handle: true, retrievalSessionId: true }),
          take: 1,
          where: { handle: "K1", state: "available" }
        }
      },
      where: {
        acceptedAt: { not: null },
        groundingResult: { isNot: null },
        modelRunId: "run-1",
        originalIntent: { equals: { kind: "full_context_v1" } },
        receiptHash: { not: null }
      }
    });
  });

  it("fails closed when the manifest and evidence item belong to different retrieval sessions", async () => {
    const fixture = personalClient({
      evidenceRetrievalSessionId: "retrieval-session-evidence",
      manifestRetrievalSessionId: "retrieval-session-manifest"
    });

    await expect(resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(),
      request
    )).resolves.toBeNull();
    expect(fixture.versionFindFirst).not.toHaveBeenCalled();
  });

  it("opens only the exact original table row with its repeated header lineage", async () => {
    const block = rowEncoded.document.blocks[0]!;
    const context = createKnowledgeTableDocumentContext({
      blockId: block.id,
      cells: [
        { columnEnd: 0, columnStart: 0, text: "Pressure" },
        { columnEnd: 1, columnStart: 1, text: "20" }
      ],
      headerLineage: [
        { columnEnd: 0, columnStart: 0, rowIndex: 0, text: "Metric" },
        { columnEnd: 1, columnStart: 1, rowIndex: 0, text: "Actual" }
      ],
      rowIndex: 2
    });
    const excerpt = "Pressure\t20";
    const contentHash = createHash("sha256").update(excerpt).digest("hex");
    const fixture = personalClient({
      evidence: {
        ...defaultEvidence(),
        contentHash,
        contextBoundaries: { documentContext: context },
        excerpt,
        headingPath: ["Measurements"],
        page: 1
      }
    });
    fixture.versionFindFirst.mockResolvedValueOnce({
      ...defaultVersion(),
      artifacts: [{
        hierarchicalIndexes: [{
          passageIndexes: [{
            contentHash,
            headingPath: ["Measurements"],
            page: 1,
            pageEnd: 1,
            sourceBlockEnd: 0,
            sourceBlockIds: [block.id],
            sourceBlockStart: 0
          }]
        }],
        id: "artifact-1",
        normalizedTextByteSize: rowEncoded.body.byteLength,
        normalizedTextChecksum: rowEncoded.checksum,
        normalizedTextStorageKey: "normalized/measurements.json",
        state: "ready"
      }]
    });

    const resolved = await resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(rowEncoded.body),
      request
    );

    expect(resolved?.citation).toMatchObject({ blocks: [
      expect.objectContaining({
        relation: "target",
        table: expect.objectContaining({
          cells: [
            expect.objectContaining({ row: 0, text: "Metric" }),
            expect.objectContaining({ row: 0, text: "Actual" }),
            expect.objectContaining({ row: 2, text: "Pressure" }),
            expect.objectContaining({ row: 2, text: "20" })
          ],
          truncated: true
        }),
        text: "Metric\tActual\nPressure\t20"
      })
    ] });
    expect(JSON.stringify(resolved?.citation)).not.toContain("Temperature");
  });

  it("opens the complete original row for one overflow projection citation", async () => {
    const block = rowEncoded.document.blocks[0]!;
    const context = createKnowledgeTableDocumentContext({
      blockId: block.id,
      cells: [{ columnEnd: 1, columnStart: 1, text: "20" }],
      columnEnd: 1,
      columnStart: 1,
      headerLineage: [{ columnEnd: 1, columnStart: 1, rowIndex: 0, text: "Actual" }],
      projectionCount: 2,
      projectionIndex: 1,
      rowIndex: 2
    });
    const excerpt = "Actual\n20";
    const contentHash = createHash("sha256").update(excerpt).digest("hex");
    const fixture = personalClient({
      evidence: {
        ...defaultEvidence(),
        contentHash,
        contextBoundaries: { documentContext: context },
        excerpt,
        headingPath: ["Measurements"],
        page: 1
      }
    });
    fixture.versionFindFirst.mockResolvedValueOnce({
      ...defaultVersion(),
      artifacts: [{
        hierarchicalIndexes: [{
          passageIndexes: [{
            contentHash,
            headingPath: ["Measurements"],
            page: 1,
            pageEnd: 1,
            sourceBlockEnd: 0,
            sourceBlockIds: [block.id],
            sourceBlockStart: 0
          }]
        }],
        id: "artifact-1",
        normalizedTextByteSize: rowEncoded.body.byteLength,
        normalizedTextChecksum: rowEncoded.checksum,
        normalizedTextStorageKey: "normalized/measurements.json",
        state: "ready"
      }]
    });

    const resolved = await resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(rowEncoded.body),
      request
    );

    expect(resolved?.citation).toMatchObject({ blocks: [expect.objectContaining({
      table: expect.objectContaining({
        cells: [
          expect.objectContaining({ column: 0, row: 0, text: "Metric" }),
          expect.objectContaining({ column: 1, row: 0, text: "Actual" }),
          expect.objectContaining({ column: 0, row: 2, text: "Pressure" }),
          expect.objectContaining({ column: 1, row: 2, text: "20" })
        ],
        truncated: true
      }),
      text: "Metric\tActual\nPressure\t20"
    })] });
    expect(JSON.stringify(resolved?.citation)).not.toContain("Temperature");
  });

  it("opens an explicitly linked form pair without exposing graph identities", async () => {
    const group = fieldEncoded.document.fieldGroups[0]!;
    const context = createKnowledgeFieldContextSegments(group)[0]!.context;
    const excerpt = "Actual pressure\t20 kPa";
    const contentHash = createHash("sha256").update(excerpt).digest("hex");
    const fixture = personalClient({
      evidence: {
        ...defaultEvidence(),
        contentHash,
        contextBoundaries: { documentContext: context },
        excerpt,
        headingPath: ["Intake"],
        page: 1
      }
    });
    fixture.versionFindFirst.mockResolvedValueOnce({
      ...defaultVersion(),
      artifacts: [{
        hierarchicalIndexes: [{
          passageIndexes: [{
            contentHash,
            headingPath: ["Intake"],
            page: 1,
            pageEnd: 1,
            sourceBlockEnd: 0,
            sourceBlockIds: [group.id],
            sourceBlockStart: 0
          }]
        }],
        id: "artifact-1",
        normalizedTextByteSize: fieldEncoded.body.byteLength,
        normalizedTextChecksum: fieldEncoded.checksum,
        normalizedTextStorageKey: "normalized/intake.json",
        state: "ready"
      }]
    });

    const resolved = await resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(fieldEncoded.body),
      request
    );

    expect(resolved?.citation).toMatchObject({
      blocks: [
        {
          relation: "target",
          table: {
            cells: [
              expect.objectContaining({ column: 0, row: 0, text: "Actual pressure" }),
              expect.objectContaining({ column: 1, row: 0, text: "20 kPa" })
            ],
            columnCount: 2,
            rowCount: 1,
            truncated: false
          },
          text: excerpt,
          type: "table"
        },
        expect.objectContaining({ relation: "after", text: "Form notes." })
      ]
    });
    expect(JSON.stringify(resolved?.citation)).not.toContain(group.id);
    expect(JSON.stringify(resolved?.citation)).not.toContain("#/form_items/0");
  });

  it("attributes a form inserted before a new section to the preceding section", async () => {
    const group = fieldBoundaryEncoded.document.fieldGroups[0]!;
    const context = createKnowledgeFieldContextSegments(group)[0]!.context;
    const excerpt = "Actual pressure\t20 kPa";
    const contentHash = createHash("sha256").update(excerpt).digest("hex");
    const fixture = personalClient({
      evidence: {
        ...defaultEvidence(),
        contentHash,
        contextBoundaries: { documentContext: context },
        excerpt,
        headingPath: ["Section A"],
        page: 1
      }
    });
    fixture.versionFindFirst.mockResolvedValueOnce({
      ...defaultVersion(),
      artifacts: [{
        hierarchicalIndexes: [{
          passageIndexes: [{
            contentHash,
            headingPath: ["Section A"],
            page: 1,
            pageEnd: 1,
            sourceBlockEnd: 1,
            sourceBlockIds: [group.id],
            sourceBlockStart: 1
          }]
        }],
        id: "artifact-1",
        normalizedTextByteSize: fieldBoundaryEncoded.body.byteLength,
        normalizedTextChecksum: fieldBoundaryEncoded.checksum,
        normalizedTextStorageKey: "normalized/section-boundary-form.json",
        state: "ready"
      }]
    });

    const resolved = await resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(fieldBoundaryEncoded.body),
      request
    );

    expect(resolved?.citation.state).toBe("available");
    if (!resolved || resolved.citation.state !== "available") throw new Error("viewer unavailable");
    expect(resolved.citation.blocks.find((block) => block.relation === "target"))
      .toMatchObject({ headingPath: ["Section A"], text: excerpt });
  });

  it("reconstructs structured operation evidence from the immutable workbook artifact", async () => {
    const fixture = personalClient({
      bindingTuple: {
        sourceArtifactId: "artifact-sales",
        sourceId: "source-sales",
        sourceVersionId: "version-sales"
      },
      evidence: {
        baseName: "Finance",
        contentHash: STRUCTURED_PASSAGE_CONTENT_HASH,
        contextBoundaries: { structuredAnalysis },
        documentId: "source-sales",
        documentVersionId: "version-sales",
        excerpt: "Calculated sum Revenue: 300.",
        fileName: "sales.xlsx",
        handle: "K1",
        headingPath: ["Sales"],
        knowledgeBaseId: "profile-binding-1",
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
            contentHash: STRUCTURED_PASSAGE_CONTENT_HASH,
            headingPath: ["Sales"],
            page: 1,
            pageEnd: 1,
            sourceBlockEnd: 0,
            sourceBlockIds: [structuredEncoded.document.blocks[0]!.id],
            sourceBlockStart: 0
          }]
        }],
        id: "artifact-sales",
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
        baseMemberships: [{ knowledgeBaseId: "base-1", removedAt: null }],
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
      bindingTuple: {
        sourceArtifactId: "artifact-visual",
        sourceId: "source-visual",
        sourceVersionId: "version-visual"
      },
      evidence: {
        baseName: "Reports",
        contentHash: null,
        contextBoundaries: { visualAnalysis: analysis },
        documentId: "source-visual",
        documentVersionId: "version-visual",
        excerpt: "Visual evidence: Quarterly revenue",
        fileName: "chart.png",
        handle: "K1",
        headingPath: ["Results"],
        knowledgeBaseId: "profile-binding-1",
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
        id: "artifact-visual",
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
        baseMemberships: [{ knowledgeBaseId: "base-1", removedAt: null }],
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
      deletedEvidenceFallback: true,
      evidence: null
    });
    await expect(resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(),
      request
    )).resolves.toEqual({
      citation: { handle: "K1", state: "deleted" },
      original: null
    });
    expect(fixture.deletedEvidenceFindFirst).toHaveBeenCalledWith({
      select: { handle: true },
      where: {
        handle: "K1",
        retrievalSession: { modelRunId: "run-1" },
        state: "deleted"
      }
    });
    expect(fixture.versionFindFirst).not.toHaveBeenCalled();
  });

  it("does not turn an undispatched deleted item into a valid citation", async () => {
    const fixture = personalClient({
      assistantText: "Supported answer [K1]",
      deletedEvidenceFallback: true,
      evidence: null
    });

    await expect(resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(),
      { ...request, handle: "K2" }
    )).resolves.toBeNull();
    expect(fixture.deletedEvidenceFindFirst).not.toHaveBeenCalled();
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

  it("keeps accepted group-published evidence readable when the Base moves to Trash", async () => {
    const fixture = personalClient({
      baseOwnerUserId: "owner-2",
      baseTrashed: true,
      bindingOwnerUserId: "owner-2",
      groupIds: ["group-1"]
    });

    await expect(resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(),
      request
    )).resolves.toMatchObject({
      citation: { source: { statuses: expect.arrayContaining(["trash"]) }, state: "available" }
    });
    const query = fixture.baseFindFirst.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(query.where).not.toHaveProperty("trashedAt");
    expect(JSON.stringify(query.where.OR)).not.toContain("trashedAt");
  });

  it("keeps accepted Project Base evidence readable when the Base moves to Trash", async () => {
    const fixture = personalClient({
      accessKind: "project",
      baseOwnerUserId: "owner-2",
      baseTrashed: true,
      bindingOwnerUserId: "owner-2"
    });

    await expect(resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(),
      request
    )).resolves.toMatchObject({
      citation: { source: { statuses: expect.arrayContaining(["trash"]) }, state: "available" }
    });
    const query = fixture.baseFindFirst.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(query.where).toMatchObject({
      projectBindings: { some: { projectId: "project-1" } }
    });
    expect(query.where).not.toHaveProperty("trashedAt");
  });

  it("keeps a Project-bound direct Source readable in Trash but not during deletion", async () => {
    const trashed = personalClient({
      accessKind: "project",
      baseProvenance: [],
      bindingOwnerUserId: "owner-2",
      sourceTrashed: true
    });
    await expect(resolveKnowledgeCitationViewer(
      trashed.value as never,
      storage(),
      request
    )).resolves.toMatchObject({
      citation: { source: { statuses: expect.arrayContaining(["trash"]) }, state: "available" }
    });
    expect(trashed.baseFindFirst).not.toHaveBeenCalled();
    expect(trashed.projectSourceBindingFindUnique).toHaveBeenCalledOnce();

    const deleting = personalClient({
      accessKind: "project",
      baseProvenance: [],
      bindingOwnerUserId: "owner-2",
      sourceDeletionRequested: true,
      sourceTrashed: true
    });
    await expect(resolveKnowledgeCitationViewer(
      deleting.value as never,
      storage(),
      request
    )).resolves.toBeNull();
  });

  it("reauthorizes a direct personal Source without treating its profile binding as a Base", async () => {
    const fixture = personalClient({
      baseProvenance: [],
      evidence: {
        ...defaultEvidence(),
        baseName: null,
        knowledgeBaseId: "profile-binding-1"
      }
    });

    await expect(resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(),
      request
    )).resolves.toMatchObject({
      citation: {
        handle: "K1",
        source: { baseName: null, name: "Upload policy" },
        state: "available"
      }
    });
    expect(fixture.baseFindFirst).not.toHaveBeenCalled();
    expect(fixture.bindingFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        modelRunId: "run-1",
        readinessState: "ready",
        sourceArtifactId: "artifact-1",
        sourceId: "source-1",
        sourceVersionId: "version-1",
        tombstonedAt: null
      })
    }));
  });

  it("denies a direct personal Source owned by another user", async () => {
    const fixture = personalClient({
      baseProvenance: [],
      bindingOwnerUserId: "other-user"
    });

    await expect(resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(),
      request
    )).resolves.toBeNull();
    expect(fixture.baseFindFirst).not.toHaveBeenCalled();
    expect(fixture.versionFindFirst).not.toHaveBeenCalled();
  });

  it("does not fall back to block zero when the accepted passage is missing", async () => {
    const fixture = personalClient();
    const missingPassageVersion = defaultVersion();
    missingPassageVersion.artifacts[0]!.hierarchicalIndexes[0]!.passageIndexes = [];
    fixture.versionFindFirst.mockResolvedValueOnce(missingPassageVersion);
    const adapter = storage();

    await expect(resolveKnowledgeCitationViewer(
      fixture.value as never,
      adapter,
      request
    )).resolves.toBeNull();
    expect(adapter.getObject).not.toHaveBeenCalled();
  });

  it("selects the ready hierarchy that owns the accepted historical passage", async () => {
    const fixture = personalClient();
    fixture.versionFindFirst.mockImplementationOnce(async (query) => {
      const passageId = query.select.artifacts.select.hierarchicalIndexes.where
        .passageIndexes?.some?.id;
      const version = defaultVersion();
      version.artifacts[0]!.hierarchicalIndexes = passageId === "passage-1"
        ? version.artifacts[0]!.hierarchicalIndexes
        : [{ passageIndexes: [] }, ...version.artifacts[0]!.hierarchicalIndexes];
      return version;
    });

    await expect(resolveKnowledgeCitationViewer(
      fixture.value as never,
      storage(),
      request
    )).resolves.toMatchObject({ citation: { handle: "K1", state: "available" } });
    expect(fixture.versionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({
        artifacts: expect.objectContaining({
          select: expect.objectContaining({
            hierarchicalIndexes: expect.objectContaining({
              where: {
                passageIndexes: { some: { id: "passage-1" } },
                state: "ready"
              }
            })
          })
        })
      })
    }));
  });

  it("denies evidence when the accepted source version no longer matches", async () => {
    const fixture = personalClient();
    fixture.versionFindFirst.mockResolvedValueOnce({
      ...defaultVersion(),
      id: "version-other"
    });
    const adapter = storage();

    await expect(resolveKnowledgeCitationViewer(
      fixture.value as never,
      adapter,
      request
    )).resolves.toBeNull();
    expect(adapter.getObject).not.toHaveBeenCalled();
  });

  it("denies evidence whose artifact is not in the accepted run binding", async () => {
    const fixture = personalClient({
      evidence: {
        ...defaultEvidence(),
        sourceArtifactId: "artifact-other"
      }
    });
    const adapter = storage();

    await expect(resolveKnowledgeCitationViewer(
      fixture.value as never,
      adapter,
      request
    )).resolves.toBeNull();
    expect(fixture.versionFindFirst).not.toHaveBeenCalled();
    expect(adapter.getObject).not.toHaveBeenCalled();
  });

  it("denies evidence when the immutable passage content hash differs", async () => {
    const fixture = personalClient({
      evidence: {
        ...defaultEvidence(),
        contentHash: createHash("sha256").update("different passage").digest("hex")
      }
    });
    const adapter = storage();

    await expect(resolveKnowledgeCitationViewer(
      fixture.value as never,
      adapter,
      request
    )).resolves.toBeNull();
    expect(adapter.getObject).not.toHaveBeenCalled();
  });

  it("does not inspect evidence after current Project access is lost", async () => {
    const dispatchManifestItemFindFirst = vi.fn();
    const client = {
      chat: {
        findUnique: vi.fn().mockResolvedValue({
          archived: false,
          permanentDeletionAt: null,
          projectId: "project-1",
          userId: null
        })
      },
      knowledgeEvidenceDispatchManifestItem: { findFirst: dispatchManifestItemFindFirst },
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
    expect(dispatchManifestItemFindFirst).not.toHaveBeenCalled();
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

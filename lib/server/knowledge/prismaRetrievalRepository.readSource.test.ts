import { describe, expect, it, vi } from "vitest";
import type { ParsedDocumentBlock } from "../parsing";
import { finalizeParsedDocument } from "../parsing/assessment";
import {
  KNOWLEDGE_RESULT_VERSION,
  type KnowledgeAcceptedBinding,
  type KnowledgeRetrievalEvidence
} from "./retrievalTypes";
import {
  createKnowledgeTableDocumentContext,
  knowledgeTableRowId,
  type KnowledgeDocumentContextV1
} from "./documentContext";
import { createPrismaKnowledgeRetrievalStore } from "./prismaRetrievalRepository";
import { normalizeReadSourceRequest } from "./readSourceLocator";
import { decodeKnowledgeRetrievalEvidence, knowledgeToolResultText } from "./toolResult";
import { chunkKnowledgeDocument } from "./chunking";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from "./indexProfile";
import { encodeKnowledgeNormalizedDocument } from "./normalizedDocument";

const binding = {
  baseContentRevision: 1,
  baseName: "Reports",
  embeddingConnectionId: "connection-1",
  embeddingCredentialId: "credential-1",
  embeddingCredentialSource: "default",
  embeddingCredentialVersionId: "credential-version-1",
  embeddingExecutionSnapshot: {},
  embeddingProviderModelId: "embedding-1",
  includeWholeBase: true,
  indexedContentRevision: 1,
  indexGenerationId: "generation-1",
  knowledgeBaseId: "base-1",
  knowledgeBaseSnapshotId: "snapshot-1",
  ordinal: 0,
  selectedSourceIds: [],
  targetDimension: 1024,
  vectorSpaceFingerprint: "a".repeat(64)
} satisfies KnowledgeAcceptedBinding;

type TestAnchor = Readonly<{
  documentContext: KnowledgeDocumentContextV1 | null;
  headingPath: readonly string[];
  ordinal: number;
  page: number;
  sectionId: string;
  sourceBlockIds: readonly string[];
}>;

type TestPassage = TestAnchor & Readonly<{
  contentHash: string;
  contextPrefix: string;
  id: string;
  sourceName: string;
  text: string;
}>;

const defaultAnchor: TestAnchor = {
  documentContext: null,
  headingPath: ["Results"],
  ordinal: 4,
  page: 7,
  sectionId: "section-1",
  sourceBlockIds: []
};

const defaultPassage: TestPassage = {
  ...defaultAnchor,
  contentHash: "b".repeat(64),
  contextPrefix: "Evidence layout: table_row_v1\nSource: report.pdf",
  id: "passage-4",
  sourceName: "Dated report",
  text: "Metric\t35.4"
};

function testAnchor(value: Partial<TestAnchor> = {}): TestAnchor {
  return { ...defaultAnchor, ...value };
}

function testPassage(value: Partial<TestPassage> = {}): TestPassage {
  return { ...defaultPassage, ...value };
}

function producedTableRowPassages(
  headers: readonly string[],
  values: readonly string[]
): Readonly<{ passages: readonly TestPassage[]; rowId: string }> {
  const cells = [headers, values].flatMap((row, rowIndex) => row.map((text, column) => ({
    column,
    columnSpan: 1,
    row: rowIndex,
    rowSpan: 1,
    text
  })));
  const block: ParsedDocumentBlock = {
    assetIds: [],
    boundingBoxes: [],
    headingPath: ["Results"],
    index: 0,
    isTable: true,
    languageHints: ["en"],
    page: 7,
    pageEnd: 7,
    readingOrder: 0,
    table: { cells, columnCount: headers.length, rowCount: 2 },
    text: [headers, values].map((row) => row.join("\t")).join("\n"),
    type: "table"
  };
  const normalized = encodeKnowledgeNormalizedDocument(finalizeParsedDocument({
    blocks: [block],
    engine: "docling",
    mediaType: "application/pdf",
    pageCount: 7,
    status: "complete"
  }), {
    maxChunksPerDocument: 100,
    maxFileBytes: 1_000_000,
    maxNormalizedChars: 1_000_000,
    maxNormalizedObjectBytes: 4_000_000,
    maxPages: 100
  }, { layoutAwareTables: true, sourceDisplayName: "report.pdf" }).document;
  const projections = chunkKnowledgeDocument({
    document: normalized,
    maxChunks: 20,
    profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION
  }).filter((chunk) => chunk.documentContext?.locator.kind === "table_row_projection" &&
    chunk.documentContext.locator.rowIndex === 1);
  const firstLocator = projections[0]?.documentContext?.locator;
  if (firstLocator?.kind !== "table_row_projection") {
    throw new Error("missing_produced_table_row_projection");
  }
  return Object.freeze({
    passages: Object.freeze(projections.map((chunk, index) => testPassage({
      contentHash: chunk.contentHash,
      contextPrefix: chunk.contextPrefix,
      documentContext: chunk.documentContext,
      headingPath: chunk.headingPath,
      id: `produced-row-projection-${index}`,
      ordinal: 4 + index,
      page: chunk.page,
      sectionId: "section-1",
      sourceBlockIds: chunk.sourceBlockIds,
      text: chunk.text
    }))),
    rowId: firstLocator.rowId
  });
}

function client(input: Readonly<{
  anchor?: Partial<TestAnchor> | null;
  blockAnchors?: readonly Partial<TestAnchor>[];
  evidenceItem?: { page: number; passageId: string } | null;
  passages?: readonly Partial<TestPassage>[];
  rangeSections?: readonly Readonly<{
    headingPath: readonly string[];
    id?: string;
    passageStart: number;
  }>[];
  rowPassages?: readonly Partial<TestPassage>[];
  sections?: readonly { id?: string; page: number; passageStart: number }[];
}> = {}) {
  const passageFindFirst = vi.fn(async () => input.anchor === undefined
    ? defaultAnchor
    : input.anchor === null ? null : testAnchor(input.anchor));
  const passageFindMany = vi.fn(async (args?: {
    take?: number;
    where?: Record<string, unknown>;
  }) => {
    const where = args?.where;
    if (where && "documentContext" in where) {
      return (input.rowPassages ?? []).map(testPassage);
    }
    if (where && "sourceBlockIds" in where && !("ordinal" in where)) {
      return (input.blockAnchors ?? (input.anchor === null ? [] : [defaultAnchor]))
        .map(testAnchor);
    }
    return input.anchor === null
      ? []
      : (input.passages ?? [defaultPassage]).map(testPassage);
  });
  const sectionFindFirst = vi.fn(async () => input.anchor === null
    ? null
    : { id: "section-1", passageStart: 4 });
  const sectionFindMany = vi.fn(async (args?: { where?: Record<string, unknown> }) => {
    const headingPath = args?.where?.headingPath;
    const rangeLookup = typeof headingPath === "object" && headingPath !== null &&
      "has" in headingPath;
    const sections = rangeLookup
      ? input.rangeSections ?? (input.anchor === null
        ? []
        : [{ headingPath: ["Q1", "A1:B4"], id: "section-1", passageStart: 4 }])
      : input.sections ?? (input.anchor === null
        ? []
        : [{ id: "section-1", page: 7, passageStart: 4 }]);
    return sections.map((section, index) => ({
      id: section.id ?? `section-${index + 1}`,
      ...section
    }));
  });
  return {
    knowledgeArtifactSectionIndex: {
      findFirst: sectionFindFirst,
      findMany: sectionFindMany
    },
    knowledgeArtifactPassageIndex: {
      findFirst: passageFindFirst,
      findMany: passageFindMany
    },
    knowledgeEvidenceItem: { findFirst: vi.fn(async () => input.evidenceItem ?? null) },
    knowledgeSourceIndexArtifact: {
      findFirst: vi.fn(async (_query?: unknown) => ({
        hierarchicalIndexes: [{ id: "hierarchy-1" }],
        sourceVersion: {
          fileName: "05.03.2030-synthetic-report.pdf",
          id: "source-version-1",
          source: { name: "Dated report" },
          versionNumber: 1
        }
      }))
    },
    passageFindFirst,
    passageFindMany,
    sectionFindFirst,
    sectionFindMany
  };
}

function read(locator: string, direction: "after" | "around" | "before", window: number) {
  const request = normalizeReadSourceRequest({ direction, locator, window });
  if (!request) throw new Error("invalid_read_source_test_fixture");
  return request;
}

function persistedReadEvidence(): KnowledgeRetrievalEvidence {
  const normalized = read("page 7", "around", 3);
  const draft: KnowledgeRetrievalEvidence = {
    bases: [{
      baseContentRevision: 1,
      baseName: "Reports",
      candidateCount: 1,
      indexedContentRevision: 1,
      indexGenerationId: "generation-1",
      knowledgeBaseId: "base-1",
      ordinal: 0,
      state: "ready",
      targetDimension: 1024,
      vectorSpaceFingerprint: "a".repeat(64)
    }],
    budget: {
      operation: "read_source",
      stopReason: null,
      usage: {
        cumulativeCandidates: 1,
        estimatedCostMicros: 0,
        latencyMs: 2,
        operations: 4,
        queryEmbeddingCalls: 0,
        retrievedTokens: 4
      },
      version: 1
    },
    candidateCount: 1,
    candidateLimit: 40,
    durationMs: 2,
    embeddingExecutions: [],
    fusion: "rrf_k60",
    invocationOrdinal: 4,
    operation: "read_source",
    outcome: "complete",
    providerText: "pending",
    query: normalized.locator,
    read: {
      ...normalized,
      resolvedSource: {
        sourceAlias: "S1",
        sourceArtifactId: "artifact-1",
        sourceId: "source-1",
        sourceName: "Dated report",
        sourceVersionId: "source-version-1"
      },
      version: 1
    },
    resultLimit: 3,
    results: [{
      annRank: null,
      baseName: "Reports",
      bindingOrdinal: 0,
      chunkId: "passage-4",
      chunkIndex: 4,
      contentHash: "b".repeat(64),
      documentId: "source-1",
      documentVersionId: "source-version-1",
      documentVersionNumber: 1,
      fileName: "05.03.2030-synthetic-report.pdf",
      ftsRank: 1,
      ftsScore: 1,
      fusedScore: 1 / 61,
      handle: "K1",
      headingPath: ["Results"],
      includedText: "Metric\t35.4",
      includedTextBytes: 11,
      knowledgeBaseId: "base-1",
      layoutKind: "table_row",
      page: 7,
      sectionId: "section-1",
      sourceAlias: "S1",
      sourceArtifactId: "artifact-1",
      sourceName: "Dated report",
      sourceTextBytes: 11,
      textTruncated: false,
      vectorDistance: null,
      vectorScore: null
    }],
    scopeAliases: [
      { alias: "B1", kind: "base", label: "Reports" },
      { alias: "S1", kind: "source", label: "Dated report" }
    ],
    version: KNOWLEDGE_RESULT_VERSION
  };
  return { ...draft, providerText: knowledgeToolResultText(draft) };
}

function legacyPersistedReadEvidence(): KnowledgeRetrievalEvidence {
  const current = persistedReadEvidence();
  const { read: _read, ...withoutRead } = current;
  const draft = {
    ...withoutRead,
    budget: {
      operation: "read_source" as const,
      noveltyRatio: 1,
      stopReason: null,
      usage: {
        cumulativeCandidates: 1,
        estimatedCostMicros: 0,
        followUpOperations: 1,
        latencyMs: 2,
        lowNoveltyStreak: 0,
        operations: 4,
        queryEmbeddingCalls: 0,
        rerankerCalls: 0,
        retrievedTokens: 4,
        searchPhases: 2,
        subqueriesInCurrentPhase: 1
      },
      version: 1 as const
    },
    postRerankOrder: null,
    preRerankOrder: null,
    providerText: "pending",
    rerankerBinding: null,
    threshold: 0.01,
    version: 1 as const
  } satisfies KnowledgeRetrievalEvidence;
  return { ...draft, providerText: knowledgeToolResultText(draft) };
}

function persistedReadMissEvidence(): KnowledgeRetrievalEvidence {
  const current = persistedReadEvidence();
  const draft: KnowledgeRetrievalEvidence = {
    ...current,
    bases: current.bases.map((base) => ({ ...base, candidateCount: 0 })),
    budget: {
      operation: "read_source",
      stopReason: null,
      usage: {
        cumulativeCandidates: 0,
        estimatedCostMicros: 0,
        latencyMs: 2,
        operations: 4,
        queryEmbeddingCalls: 0,
        retrievedTokens: 0
      },
      version: 1
    },
    candidateCount: 0,
    outcome: "source_location_unavailable",
    providerText: "pending",
    results: []
  };
  return { ...draft, providerText: knowledgeToolResultText(draft) };
}

describe("Prisma Knowledge deterministic source read", () => {
  it("resolves a page inside one admitted Source and returns only a bounded neighbor window", async () => {
    const mocked = client();
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding,
      read: read("page 7", "around", 3),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(mocked.passageFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        indexArtifactId: "hierarchy-1",
        page: { lte: 7 },
        pageEnd: { gte: 7 }
      })
    }));
    expect(mocked.passageFindMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 3,
      where: {
        indexArtifactId: "hierarchy-1",
        ordinal: { gte: 3, lte: 5 },
        sectionId: "section-1"
      }
    }));
    expect(result).toMatchObject({
      bindingCount: 1,
      candidateCount: 1,
      passages: [{
        documentVersionId: "source-version-1",
        layoutKind: "table_row",
        page: 7,
        sourceArtifactId: "artifact-1",
        text: "Metric\t35.4"
      }]
    });
  });

  it("authorizes a direct Source through its canonical run binding without a Base snapshot", async () => {
    const mocked = client();
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    await store.readSource!({
      binding: {
        ...binding,
        executionScope: "profile",
        includeWholeBase: false,
        knowledgeBaseId: "profile-binding-1",
        knowledgeBaseSnapshotId: "profile-binding-1",
        profileRevisionId: "profile-revision-1",
        selectedSourceIds: ["source-1"]
      },
      read: read("page 7", "around", 3),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(mocked.knowledgeSourceIndexArtifact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          runSourceBindings: {
            some: expect.objectContaining({
              modelRun: { id: "run-1", userId: "user-1" },
              profileBindingId: "profile-binding-1",
              sourceArtifactId: "artifact-1",
              sourceId: "source-1"
            })
          }
        })
      })
    );
    expect(mocked.knowledgeSourceIndexArtifact.findFirst).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ snapshotSources: expect.anything() })
      })
    );
  });

  it("returns a successful empty lookup when the exact Source location is absent", async () => {
    const mocked = client({ anchor: null });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding,
      read: read("heading: Missing", "after", 2),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(result).toMatchObject({ candidateCount: 0, candidateCounts: { 0: 0 }, passages: [] });
    expect(mocked.passageFindMany).not.toHaveBeenCalled();
  });

  it("normalizes a displayed heading path but does not use a partial-heading fallback", async () => {
    const mocked = client({ anchor: null });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    await store.readSource!({
      binding,
      read: read("heading: Lab › Results", "around", 3),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(mocked.sectionFindMany).toHaveBeenCalledOnce();
    expect(mocked.sectionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 2,
      where: {
        headingPath: { equals: ["Lab", "Results"] },
        indexArtifactId: "hierarchy-1"
      }
    }));
  });

  it("resolves section identity to its first passage without semantic fallback", async () => {
    const mocked = client();
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const sectionId = `kis_${"a".repeat(40)}`;
    await store.readSource!({
      binding,
      read: read(`section:${sectionId}`, "around", 3),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(mocked.sectionFindFirst).toHaveBeenCalledWith({
      select: { id: true, passageStart: true },
      where: { id: sectionId, indexArtifactId: "hierarchy-1" }
    });
  });

  it("resolves an exact passage target inside one Source", async () => {
    const mocked = client();
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    await store.readSource!({
      binding,
      read: read(`passage:kip_${"b".repeat(40)}`, "after", 2),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(mocked.passageFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: `kip_${"b".repeat(40)}`, indexArtifactId: "hierarchy-1" }
    }));
    expect(mocked.knowledgeSourceIndexArtifact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          hierarchicalIndexes: expect.objectContaining({
            where: {
              passageIndexes: { some: { id: `kip_${"b".repeat(40)}` } },
              state: "ready"
            }
          })
        })
      })
    );
    expect(mocked.passageFindMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 2,
      where: {
        indexArtifactId: "hierarchy-1",
        ordinal: { gte: 4, lte: 5 },
        sectionId: "section-1"
      }
    }));
  });

  it("resolves a block only when its exact passage anchor is unique", async () => {
    const blockId = `b_${"c".repeat(24)}_12`;
    const mocked = client({ blockAnchors: [{ ordinal: 4, page: 7 }] });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding,
      read: read(`block:${blockId}`, "after", 2),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(mocked.passageFindMany).toHaveBeenNthCalledWith(1, {
      orderBy: { ordinal: "asc" },
      select: {
        documentContext: true,
        headingPath: true,
        ordinal: true,
        page: true,
        sectionId: true,
        sourceBlockIds: true
      },
      take: 2,
      where: {
        indexArtifactId: "hierarchy-1",
        sourceBlockIds: { has: blockId }
      }
    });
    expect(result.passages).toHaveLength(1);
  });

  it("fails closed when one block appears in multiple passages", async () => {
    const blockId = `b_${"d".repeat(24)}_13`;
    const mocked = client({
      blockAnchors: [{ ordinal: 4, page: 7 }, { ordinal: 5, page: 7 }]
    });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding,
      read: read(`block:${blockId}`, "around", 3),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(result).toMatchObject({ candidateCount: 0, passages: [] });
    expect(mocked.passageFindMany).toHaveBeenCalledOnce();
    expect(mocked.passageFindFirst).not.toHaveBeenCalled();
  });

  it("resolves one typed table-row locator to its complete ordered projection group", async () => {
    const blockId = `b_${"e".repeat(24)}_20`;
    const rowId = knowledgeTableRowId(blockId, 3);
    const first = createKnowledgeTableDocumentContext({
      blockId,
      cells: [{ columnEnd: 0, columnStart: 0, text: "Pressure" }],
      columnEnd: 0,
      columnStart: 0,
      headerLineage: [{ columnEnd: 0, columnStart: 0, rowIndex: 0, text: "Metric" }],
      projectionCount: 2,
      projectionIndex: 0,
      rowIndex: 3
    });
    const second = createKnowledgeTableDocumentContext({
      blockId,
      cells: [{ columnEnd: 1, columnStart: 1, text: "20" }],
      columnEnd: 1,
      columnStart: 1,
      headerLineage: [{ columnEnd: 1, columnStart: 1, rowIndex: 0, text: "Value" }],
      projectionCount: 2,
      projectionIndex: 1,
      rowIndex: 3
    });
    const mocked = client({
      rowPassages: [
        {
          documentContext: second,
          id: "row-projection-2",
          ordinal: 5,
          sourceBlockIds: [blockId],
          text: "Metric / Value\n20"
        },
        {
          documentContext: first,
          id: "row-projection-1",
          ordinal: 4,
          sourceBlockIds: [blockId],
          text: "Metric / Value\nPressure"
        }
      ]
    });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding,
      read: read(`row:${rowId}`, "around", 8),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(mocked.passageFindMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 9,
      where: {
        documentContext: { equals: rowId, path: ["locator", "rowId"] },
        indexArtifactId: "hierarchy-1"
      }
    }));
    expect(result.candidateCount).toBe(2);
    expect(result.passages.map((passage) => passage.documentContext?.locator)).toMatchObject([
      { kind: "table_row_projection", projectionIndex: 0, rowId },
      { kind: "table_row_projection", projectionIndex: 1, rowId }
    ]);
  });

  it.each([
    {
      headers: [
        "Subject", "Date", "Actual", "Reference", "Unit", "Target", "Threshold", "Comment"
      ],
      name: "wide multi-column row",
      values: Array.from({ length: 8 }, (_, column) =>
        `Value ${column} ${"word ".repeat(90).trim()}`)
    },
    {
      headers: ["Narrative"],
      name: "single oversized cell",
      values: [["42", ...Array.from({ length: 649 }, (_, index) => `value${index}`)]
        .join(" ")]
    }
  ])("accepts and orders a real producer projection group for a $name", async ({
    headers,
    values
  }) => {
    const produced = producedTableRowPassages(headers, values);
    const mocked = client({ rowPassages: [...produced.passages].reverse() });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding,
      read: read(`row:${produced.rowId}`, "around", 8),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(produced.passages.length).toBeGreaterThan(1);
    expect(result.candidateCount).toBe(produced.passages.length);
    expect(result.passages.map((passage) => passage.chunkId)).toEqual(
      produced.passages.map((passage) => passage.id)
    );
    expect(result.passages.map((passage) => passage.documentContext?.locator)).toMatchObject(
      produced.passages.map((passage) => ({
        kind: "table_row_projection",
        projectionIndex: passage.documentContext?.locator.kind === "table_row_projection"
          ? passage.documentContext.locator.projectionIndex
          : -1,
        rowId: produced.rowId
      }))
    );
  });

  it("resolves one atomic typed table row without widening to nearby passages", async () => {
    const blockId = `b_${"2".repeat(24)}_23`;
    const documentContext = createKnowledgeTableDocumentContext({
      blockId,
      cells: [
        { columnEnd: 0, columnStart: 0, text: "Pressure" },
        { columnEnd: 1, columnStart: 1, text: "20" }
      ],
      headerLineage: [{ columnEnd: 1, columnStart: 0, rowIndex: 0, text: "Metric / Value" }],
      rowIndex: 2
    });
    const rowId = knowledgeTableRowId(blockId, 2);
    const mocked = client({
      passages: [{ id: "unrelated-neighbor", ordinal: 3 }],
      rowPassages: [{
        documentContext,
        id: "atomic-row",
        sourceBlockIds: [blockId],
        text: "Pressure\t20"
      }]
    });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding,
      read: read(`row:${rowId}`, "around", 8),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(result.passages).toMatchObject([{
      chunkId: "atomic-row",
      documentContext: { locator: { kind: "table_row", rowId } },
      layoutKind: "table_row",
      text: "Pressure\t20"
    }]);
    expect(mocked.passageFindMany).toHaveBeenCalledOnce();
  });

  it("fails closed for an incomplete or over-limit table-row projection group", async () => {
    const blockId = `b_${"f".repeat(24)}_21`;
    const rowId = knowledgeTableRowId(blockId, 4);
    const projection = createKnowledgeTableDocumentContext({
      blockId,
      cells: [{ columnEnd: 0, columnStart: 0, text: "Only first projection" }],
      columnEnd: 0,
      columnStart: 0,
      headerLineage: [],
      projectionCount: 2,
      projectionIndex: 0,
      rowIndex: 4
    });
    const store = createPrismaKnowledgeRetrievalStore(client({
      rowPassages: [{ documentContext: projection, sourceBlockIds: [blockId] }]
    }) as never);
    const incomplete = await store.readSource!({
      binding,
      read: read(`row:${rowId}`, "around", 8),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });
    expect(incomplete).toMatchObject({ candidateCount: 0, passages: [] });

    const overLimitStore = createPrismaKnowledgeRetrievalStore(client({
      rowPassages: Array.from({ length: 9 }, (_, index) => ({
        documentContext: projection,
        id: `projection-${index}`,
        ordinal: index,
        sourceBlockIds: [blockId]
      }))
    }) as never);
    await expect(overLimitStore.readSource!({
      binding,
      read: read(`row:${rowId}`, "around", 8),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    })).resolves.toMatchObject({ candidateCount: 0, passages: [] });
  });

  it("constrains a typed table passage neighborhood to its structural block and section", async () => {
    const blockId = `b_${"1".repeat(24)}_22`;
    const documentContext = createKnowledgeTableDocumentContext({
      blockId,
      cells: [{ columnEnd: 0, columnStart: 0, text: "Pressure\t20" }],
      headerLineage: [],
      rowIndex: 1
    });
    const mocked = client({
      anchor: { documentContext, sourceBlockIds: [blockId] },
      passages: [{ documentContext, sourceBlockIds: [blockId] }]
    });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    await store.readSource!({
      binding,
      read: read(`passage:kip_${"b".repeat(40)}`, "around", 3),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(mocked.passageFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        indexArtifactId: "hierarchy-1",
        ordinal: { gte: 3, lte: 5 },
        sectionId: "section-1",
        sourceBlockIds: { has: blockId }
      }
    }));
  });

  it("resolves one unique containing structured region and keeps the read inside it", async () => {
    const headingPath = ["Q1", "A1:C10"];
    const mocked = client({
      passages: [
        { headingPath, id: "passage-4", ordinal: 4 },
        { headingPath, id: "passage-5", ordinal: 5 }
      ],
      rangeSections: [{ headingPath, id: "section-1", passageStart: 4 }]
    });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding,
      read: read("range:'Q1'!B2:B3", "after", 2),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(result.passages).toHaveLength(2);
    expect(mocked.sectionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { ordinal: "asc" },
      take: 129,
      where: {
        headingPath: { has: "Q1" },
        indexArtifactId: "hierarchy-1"
      }
    }));
    expect(mocked.passageFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        headingPath: { equals: headingPath },
        indexArtifactId: "hierarchy-1",
        ordinal: { gte: 4, lte: 5 },
        sectionId: "section-1"
      }
    }));
  });

  it("fails closed when a structured target has multiple containing regions", async () => {
    const mocked = client({
      rangeSections: [
        { headingPath: ["Q1", "A1:C10"], id: "section-1", passageStart: 4 },
        { headingPath: ["Q1", "B1:B10"], id: "section-2", passageStart: 8 }
      ]
    });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding,
      read: read("range:'Q1'!B2:B3", "around", 3),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(result).toMatchObject({ candidateCount: 0, passages: [] });
    expect(mocked.sectionFindMany).toHaveBeenCalledOnce();
    expect(mocked.passageFindFirst).not.toHaveBeenCalled();
    expect(mocked.passageFindMany).not.toHaveBeenCalled();
  });

  it("fails closed instead of deciding containment from a truncated region scan", async () => {
    const mocked = client({
      rangeSections: Array.from({ length: 129 }, (_, index) => ({
        headingPath: ["Q1", `A${index + 1}:B${index + 1}`],
        id: `section-${index}`,
        passageStart: index
      }))
    });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding,
      read: read("range:'Q1'!A1", "around", 3),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(result).toMatchObject({ candidateCount: 0, passages: [] });
    expect(mocked.sectionFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 129 }));
    expect(mocked.passageFindFirst).not.toHaveBeenCalled();
    expect(mocked.passageFindMany).not.toHaveBeenCalled();
  });

  it("binds an evidence handle to the same run and Source before reading neighbors", async () => {
    const mocked = client({ evidenceItem: { page: 7, passageId: "passage-4" } });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    await store.readSource!({
      binding,
      read: read("K4", "before", 2),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(mocked.knowledgeEvidenceItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        handle: "K4",
        retrievalSession: { modelRun: { id: "run-1", userId: "user-1" } },
        sourceArtifactId: "artifact-1",
        state: "available"
      }
    }));
    expect(mocked.passageFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "passage-4", indexArtifactId: "hierarchy-1" }
    }));
    expect(mocked.passageFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        indexArtifactId: "hierarchy-1",
        ordinal: { gte: 3, lte: 4 },
        sectionId: "section-1"
      }
    }));
  });

  it("selects the ready hierarchy that owns an accepted historical passage", async () => {
    const mocked = client({ evidenceItem: { page: 7, passageId: "passage-4" } });
    mocked.knowledgeSourceIndexArtifact.findFirst.mockImplementationOnce(async (query?: unknown) => {
      const passageId = (query as {
        select: { hierarchicalIndexes: { where: { passageIndexes?: { some?: { id?: string } } } } };
      } | undefined)?.select.hierarchicalIndexes.where.passageIndexes?.some?.id;
      return {
        hierarchicalIndexes: [{
          id: passageId === "passage-4" ? "hierarchy-old" : "hierarchy-new"
        }],
        sourceVersion: {
          fileName: "05.03.2030-synthetic-report.pdf",
          id: "source-version-1",
          source: { name: "Dated report" },
          versionNumber: 1
        }
      };
    });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);

    const result = await store.readSource!({
      binding,
      read: read("K4", "around", 1),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(mocked.knowledgeSourceIndexArtifact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          hierarchicalIndexes: expect.objectContaining({
            where: {
              passageIndexes: { some: { id: "passage-4" } },
              state: "ready"
            }
          })
        })
      })
    );
    expect(mocked.passageFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "passage-4", indexArtifactId: "hierarchy-old" }
    }));
    expect(result.candidateCount).toBe(1);
  });

  it("expands an evidence handle for one row projection to its complete row group", async () => {
    const blockId = `b_${"7".repeat(24)}_26`;
    const rowId = knowledgeTableRowId(blockId, 5);
    const first = createKnowledgeTableDocumentContext({
      blockId,
      cells: [{ columnEnd: 0, columnStart: 0, text: "Pressure" }],
      columnEnd: 0,
      columnStart: 0,
      headerLineage: [{ columnEnd: 0, columnStart: 0, rowIndex: 0, text: "Metric" }],
      projectionCount: 2,
      projectionIndex: 0,
      rowIndex: 5
    });
    const second = createKnowledgeTableDocumentContext({
      blockId,
      cells: [{ columnEnd: 1, columnStart: 1, text: "20" }],
      columnEnd: 1,
      columnStart: 1,
      headerLineage: [{ columnEnd: 1, columnStart: 1, rowIndex: 0, text: "Value" }],
      projectionCount: 2,
      projectionIndex: 1,
      rowIndex: 5
    });
    const mocked = client({
      anchor: {
        documentContext: second,
        ordinal: 5,
        sourceBlockIds: [blockId]
      },
      evidenceItem: { page: 7, passageId: "row-projection-2" },
      passages: [{ id: "unrelated-neighbor", ordinal: 3 }],
      rowPassages: [
        {
          documentContext: second,
          id: "row-projection-2",
          ordinal: 5,
          sourceBlockIds: [blockId],
          text: "Value\n20"
        },
        {
          documentContext: first,
          id: "row-projection-1",
          ordinal: 4,
          sourceBlockIds: [blockId],
          text: "Metric\nPressure"
        }
      ]
    });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding,
      read: read("K4", "around", 1),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(mocked.passageFindMany).toHaveBeenCalledOnce();
    expect(mocked.passageFindMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 9,
      where: {
        documentContext: { equals: rowId, path: ["locator", "rowId"] },
        indexArtifactId: "hierarchy-1"
      }
    }));
    expect(result).toMatchObject({
      candidateCount: 2,
      passages: [
        { chunkId: "row-projection-1", documentContext: { locator: { rowId } } },
        { chunkId: "row-projection-2", documentContext: { locator: { rowId } } }
      ]
    });
  });

  it("never falls back to an evidence page after its exact passage is gone", async () => {
    const mocked = client({
      anchor: null,
      evidenceItem: { page: 7, passageId: "deleted-passage" }
    });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding,
      read: read("K4", "around", 3),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(mocked.knowledgeEvidenceItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      select: { passageId: true }
    }));
    expect(mocked.passageFindFirst).toHaveBeenCalledOnce();
    expect(mocked.passageFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "deleted-passage", indexArtifactId: "hierarchy-1" }
    }));
    expect(mocked.passageFindMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ candidateCount: 0, passages: [] });
  });

  it("retains read-only support for a legacy evidence handle", async () => {
    const mocked = client({ evidenceItem: { page: 7, passageId: "passage-4" } });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    await store.readSource!({
      binding,
      read: read("K4.1", "around", 1),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(mocked.knowledgeEvidenceItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ handle: "K4.1" })
    }));
  });

  it("fails closed when an exact normalized heading is ambiguous inside the Source", async () => {
    const mocked = client({
      sections: [{ page: 3, passageStart: 2 }, { page: 7, passageStart: 4 }]
    });
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding,
      read: read("heading: Results", "around", 3),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(result).toMatchObject({ candidateCount: 0, passages: [] });
    expect(mocked.passageFindMany).not.toHaveBeenCalled();
  });

  it("rejects a Source outside an explicitly selected binding before repository lookup", async () => {
    const mocked = client();
    const store = createPrismaKnowledgeRetrievalStore(mocked as never);
    const result = await store.readSource!({
      binding: { ...binding, includeWholeBase: false, selectedSourceIds: ["source-2"] },
      read: read("page 7", "around", 3),
      runId: "run-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      userId: "user-1"
    });

    expect(result).toMatchObject({ candidateCount: 0, passages: [] });
    expect(mocked.knowledgeSourceIndexArtifact.findFirst).not.toHaveBeenCalled();
  });

  it("reconstructs an exact committed read receipt before recovery can repeat the read", async () => {
    const evidence = persistedReadEvidence();
    const findFirst = vi.fn(async () => ({
      baseEvidence: evidence.bases,
      budgetEvidence: evidence.budget,
      candidateCount: evidence.candidateCount,
      candidateLimit: evidence.candidateLimit,
      durationMs: evidence.durationMs,
      embeddingUsage: evidence.embeddingExecutions,
      failureCode: null,
      fusion: evidence.fusion,
      invocationOrdinal: evidence.invocationOrdinal,
      operation: evidence.operation,
      outcome: evidence.outcome,
      providerText: evidence.providerText,
      query: evidence.query,
      readReceipt: evidence.read,
      resultLimit: evidence.resultLimit,
      results: evidence.results
    }));
    const store = createPrismaKnowledgeRetrievalStore({
      knowledgeRun: { findFirst }
    } as never);

    await expect(store.loadReceipt!({
      modelRunToolCallId: "tool-call-4",
      runId: "run-1",
      userId: "user-1"
    })).resolves.toEqual(evidence);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        modelRun: { id: "run-1", userId: "user-1" },
        modelRunId: "run-1",
        modelRunToolCallId: "tool-call-4"
      }
    }));
  });

  it("reconstructs the selected Source identity for a committed empty read", async () => {
    const evidence = persistedReadMissEvidence();
    const store = createPrismaKnowledgeRetrievalStore({
      knowledgeRun: {
        findFirst: vi.fn(async () => ({
          baseEvidence: evidence.bases,
          budgetEvidence: evidence.budget,
          candidateCount: evidence.candidateCount,
          candidateLimit: evidence.candidateLimit,
          durationMs: evidence.durationMs,
          embeddingUsage: evidence.embeddingExecutions,
          failureCode: null,
          fusion: evidence.fusion,
          invocationOrdinal: evidence.invocationOrdinal,
          operation: evidence.operation,
          outcome: evidence.outcome,
          providerText: evidence.providerText,
          query: evidence.query,
          readReceipt: evidence.read,
          resultLimit: evidence.resultLimit,
          results: evidence.results
        }))
      }
    } as never);

    await expect(store.loadReceipt!({
      modelRunToolCallId: "tool-call-empty-read",
      runId: "run-1",
      userId: "user-1"
    })).resolves.toEqual(evidence);
  });

  it("keeps serialized legacy evidence readable without reinterpreting a cleaned row", async () => {
    const evidence = legacyPersistedReadEvidence();
    expect(decodeKnowledgeRetrievalEvidence(evidence)).toEqual(evidence);
    const store = createPrismaKnowledgeRetrievalStore({
      knowledgeRun: {
        findFirst: vi.fn(async () => ({
          baseEvidence: evidence.bases,
          budgetEvidence: evidence.budget,
          candidateCount: evidence.candidateCount,
          candidateLimit: evidence.candidateLimit,
          durationMs: evidence.durationMs,
          embeddingUsage: evidence.embeddingExecutions,
          failureCode: null,
          fusion: evidence.fusion,
          invocationOrdinal: evidence.invocationOrdinal,
          operation: evidence.operation,
          outcome: evidence.outcome,
          providerText: evidence.providerText,
          query: evidence.query,
          readReceipt: null,
          resultLimit: evidence.resultLimit,
          results: evidence.results
        }))
      }
    } as never);

    await expect(store.loadReceipt!({
      modelRunToolCallId: "tool-call-legacy",
      runId: "run-1",
      userId: "user-1"
    })).resolves.toBeNull();
  });

  it("fails closed when committed read provider text does not match structured evidence", async () => {
    const evidence = persistedReadEvidence();
    const store = createPrismaKnowledgeRetrievalStore({
      knowledgeRun: {
        findFirst: vi.fn(async () => ({
          baseEvidence: evidence.bases,
          budgetEvidence: evidence.budget,
          candidateCount: evidence.candidateCount,
          candidateLimit: evidence.candidateLimit,
          durationMs: evidence.durationMs,
          embeddingUsage: evidence.embeddingExecutions,
          failureCode: null,
          fusion: evidence.fusion,
          invocationOrdinal: evidence.invocationOrdinal,
          operation: evidence.operation,
          outcome: evidence.outcome,
          providerText: "tampered private evidence",
          query: evidence.query,
          readReceipt: evidence.read,
          resultLimit: evidence.resultLimit,
          results: evidence.results
        }))
      }
    } as never);

    await expect(store.loadReceipt!({
      modelRunToolCallId: "tool-call-4",
      runId: "run-1",
      userId: "user-1"
    })).resolves.toBeNull();
  });

  it("rejects legacy receipt writes before opening a persistence transaction", async () => {
    const current = persistedReadEvidence();
    const { read: _read, ...withoutRead } = current;
    const legacy = {
      ...withoutRead,
      version: 1 as const
    } satisfies KnowledgeRetrievalEvidence;
    const transaction = vi.fn();
    const store = createPrismaKnowledgeRetrievalStore({
      $transaction: transaction
    } as never);

    await expect(store.persistReceipt({
      evidence: legacy,
      modelRunToolCallId: "tool-call-legacy",
      runId: "run-1",
      userId: "user-1"
    })).rejects.toThrow("knowledge_legacy_receipt_write_forbidden");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects planner-era ranking fields on current receipt writes", async () => {
    const transaction = vi.fn();
    const store = createPrismaKnowledgeRetrievalStore({ $transaction: transaction } as never);

    await expect(store.persistReceipt({
      evidence: { ...persistedReadEvidence(), threshold: 0 },
      modelRunToolCallId: "tool-call-current-with-legacy-ranking",
      runId: "run-1",
      userId: "user-1"
    })).rejects.toThrow("knowledge_legacy_ranking_write_forbidden");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects the retired threshold outcome on current receipt writes", async () => {
    const transaction = vi.fn();
    const store = createPrismaKnowledgeRetrievalStore({ $transaction: transaction } as never);

    await expect(store.persistReceipt({
      evidence: { ...persistedReadEvidence(), outcome: "zero_above_threshold" },
      modelRunToolCallId: "tool-call-current-with-retired-outcome",
      runId: "run-1",
      userId: "user-1"
    })).rejects.toThrow("knowledge_legacy_outcome_write_forbidden");
    expect(transaction).not.toHaveBeenCalled();
  });
});

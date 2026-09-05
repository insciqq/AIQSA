import { describe, expect, it, vi } from "vitest";
import { embeddingModelPresets } from "../../domain/embeddingModels";
import type { ParsedDocumentBlock } from "../parsing";
import { finalizeParsedDocument } from "../parsing/assessment";
import { chunkKnowledgeDocument } from "./chunking";
import {
  buildKnowledgeHierarchicalIndex,
  KNOWLEDGE_HIERARCHICAL_COMPATIBLE_INDEX_VERSIONS,
  KNOWLEDGE_HIERARCHICAL_INDEX_VERSION,
  knowledgeExactNormalizedValue,
  knowledgeExactQueryValues
} from "./hierarchicalIndex";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from "./indexProfile";
import { encodeKnowledgeNormalizedDocument } from "./normalizedDocument";
import { executeKnowledgeRetrievalCore } from "./prismaRetrievalCore";
import { knowledgeHierarchicalLexicalSearchSql } from "./prismaHierarchicalRetrievalRepository";
import { createKnowledgeRerankStage } from "./rerankExecution";
import { KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER } from "./tokenizer/knowledgeTokenCounter";

/**
 * PRD section 16 multilingual verification matrix: one generic
 * language-neutral lexical path for every language, no script-based algorithm
 * switching, exact typed extraction preserved, Cyrillic never damaged by
 * normalization, technical terms and source identifiers untranslated, and the
 * reranker always receives the original query. Small synthetic fixtures only;
 * no scored corpora and no real provider relevance assertions.
 */
const MATRIX_QUERIES: ReadonlyArray<readonly [string, string]> = [
  ["ru", "условия расторжения договора аренды"],
  ["en", "termination clauses of the lease agreement"],
  ["uk", "умови розірвання договору оренди"],
  ["kk", "жалдау шартын бұзу талаптары"],
  ["sr", "услови раскида уговора о закупу"],
  ["mixed", "статус миграции Postgres кластера после failover в 2026-08-18"]
];

function sqlText(value: unknown): string {
  // Bound values are not part of the statement shape; collapse placeholder
  // arity (for example the exact-value unnest array) before comparing.
  return (value as { strings: readonly string[] }).strings.join("?")
    .replace(/ARRAY\[\?(?:,\?)*\]/gu, "ARRAY[?]");
}

async function capturedHybridSql(query: string): Promise<string> {
  const scopes = [{
    acceptedIndexArtifactIds: [],
    baseName: "Docs",
    bindingOrdinal: 0,
    eligibleRows: 0,
    indexGenerationId: "generation-0",
    knowledgeBaseId: "base-0",
    projectionComplete: true,
    targetDimension: 1_024
  }];
  const client = {
    $queryRaw: vi.fn()
      .mockResolvedValueOnce(scopes)
      .mockResolvedValueOnce([{ candidates: [], scopes }])
  };
  await executeKnowledgeRetrievalCore(client as never, {
    candidateLimit: 64,
    excludedOccurrenceKeys: [],
    query,
    resultLimit: 8,
    runId: "run-1",
    userId: "user-1",
    vectors: []
  });
  expect(client.$queryRaw).toHaveBeenCalledTimes(2);
  return sqlText(client.$queryRaw.mock.calls[1]![0]);
}

function block(
  index: number,
  text: string,
  input: Partial<ParsedDocumentBlock> = {}
): ParsedDocumentBlock {
  return {
    assetIds: [],
    boundingBoxes: [],
    headingPath: ["Раздел"],
    index,
    isTable: false,
    languageHints: [],
    page: 1,
    pageEnd: 1,
    readingOrder: index,
    table: null,
    text,
    type: "paragraph",
    ...input
  };
}

const parserConfig = {
  maxChunksPerDocument: 1_000,
  maxFileBytes: 1_000_000,
  maxNormalizedChars: 1_000_000,
  maxNormalizedObjectBytes: 4_000_000,
  maxPages: 1_000
};

function indexFor(languageHints: readonly string[], languages: readonly string[]) {
  const document = encodeKnowledgeNormalizedDocument(finalizeParsedDocument({
    blocks: [
      block(0, "Годовой отчёт Atlas", { headingPath: [], type: "title" }),
      block(1, "Контракт AX-2077 діє з 2026-08-18, сума 12500.50 EUR.", {
        languageHints: [...languageHints]
      })
    ],
    engine: "docling",
    languages: [...languages],
    mediaType: "application/pdf",
    pageCount: 1,
    status: "complete"
  }), parserConfig, { sourceDisplayName: "annual-report.pdf" }).document;
  const chunks = chunkKnowledgeDocument({
    document,
    maxChunks: 20,
    profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
    tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
  });
  return buildKnowledgeHierarchicalIndex({
    chunks,
    document,
    fileName: "annual-report.pdf",
    mimeType: "application/pdf",
    sourceArtifactId: "artifact-multilingual",
    sourceName: "Годовой отчёт Atlas",
    tags: []
  });
}

describe("multilingual generic lexical path", () => {
  it("emits one identical simple-config hybrid statement for every query language", async () => {
    const statements = await Promise.all(
      MATRIX_QUERIES.map(([, query]) => capturedHybridSql(query))
    );
    for (const statement of statements.slice(1)) {
      expect(statement).toBe(statements[0]);
    }
    const statement = statements[0]!;
    expect(statement).toContain("'simple'::regconfig");
    expect(statement).not.toContain("'english'::regconfig");
    expect(statement).not.toContain("'russian'::regconfig");
    expect(statement).not.toContain("languageConfig");
    expect(statement).not.toContain("englishSearchVector");
    expect(statement).not.toContain("russianSearchVector");
  });

  it("selects exactly one ready compatible hierarchical index per artifact", async () => {
    const statement = await capturedHybridSql("контракт AX-2077");
    expect(KNOWLEDGE_HIERARCHICAL_COMPATIBLE_INDEX_VERSIONS)
      .toEqual([3, KNOWLEDGE_HIERARCHICAL_INDEX_VERSION]);
    expect(statement).toContain('ORDER BY candidate_hierarchy."schemaVersion" DESC');
    expect(statement).toContain("LIMIT 1");
  });

  it("uses the same simple-config hierarchical lexical statement for every language", () => {
    const statements = MATRIX_QUERIES.map(([, query]) => sqlText(
      knowledgeHierarchicalLexicalSearchSql({
        level: "section",
        limit: 10,
        query,
        scope: { ownerUserId: "user-1", sourceArtifactIds: ["artifact-1"] }
      })
    ));
    for (const statement of statements.slice(1)) {
      expect(statement).toBe(statements[0]);
    }
    expect(statements[0]).toContain("'simple'::regconfig");
    expect(statements[0]).not.toContain("'english'::regconfig");
    expect(statements[0]).not.toContain("'russian'::regconfig");
    expect(statements[0]).toContain('ORDER BY source_artifact."id", hierarchy."schemaVersion" DESC');
  });

  it("extracts exact identifiers, dates, and numbers from any language", () => {
    expect(knowledgeExactQueryValues("Найди договор AX-2077 от 2026-08-18 на 12500.50"))
      .toEqual(expect.arrayContaining(["ax-2077", "2026-08-18", "12500.50"]));
    expect(knowledgeExactQueryValues("Знайдіть рахунок INV-2024-00317 від 15.03.2024"))
      .toEqual(expect.arrayContaining(["inv-2024-00317", "15.03.2024"]));
    expect(knowledgeExactQueryValues("Құжат QZ-99 бойынша 4200.50 сомасы"))
      .toEqual(expect.arrayContaining(["qz-99", "4200.50"]));
    expect(knowledgeExactQueryValues("Уговор SR-15 од 2025-01-01"))
      .toEqual(expect.arrayContaining(["sr-15", "2025-01-01"]));
    expect(knowledgeExactQueryValues("What is invoice.00491 worth in USD?"))
      .toEqual(expect.arrayContaining(["invoice.00491"]));
  });

  it("normalizes without damaging Cyrillic and strips hidden controls", () => {
    expect(knowledgeExactNormalizedValue("  Договір ДА-47  ")).toBe("договір да-47");
    expect(knowledgeExactNormalizedValue("Құжат ҚР-15")).toBe("құжат қр-15");
    expect(knowledgeExactNormalizedValue("Уговор ЂЏ-9")).toBe("уговор ђџ-9");
    const values = knowledgeExactQueryValues("\u0000\u0007 SAFE-2718 \u200b");
    expect(values).toContain("safe-2718");
    for (const value of values) {
      expect(value).not.toMatch(/[\u0000-\u001f\u007f\u200b]/u);
    }
  });

  it("derives identical passages and exact entries regardless of language hints", () => {
    const hinted = indexFor(["uk"], ["uk", "ru"]);
    const unhinted = indexFor([], []);
    expect(hinted.passages.map((passage) => passage.text))
      .toEqual(unhinted.passages.map((passage) => passage.text));
    expect(hinted.passages.map((passage) => passage.contextPrefix))
      .toEqual(unhinted.passages.map((passage) => passage.contextPrefix));
    expect(hinted.exactEntries.map((entry) => [entry.kind, entry.value]))
      .toEqual(unhinted.exactEntries.map((entry) => [entry.kind, entry.value]));
    expect(hinted.sections.map((section) => section.label))
      .toEqual(unhinted.sections.map((section) => section.label));
    // The hint stays available as display/diagnostics metadata only.
    expect(hinted.document.languages).toContain("uk");
    expect(unhinted.document.languages).not.toContain("uk");
  });

  it("keeps source and title identifiers untranslated and technical terms intact", () => {
    const index = indexFor(["ru"], ["ru"]);
    const titles = index.exactEntries
      .filter((entry) => entry.kind === "title")
      .map((entry) => entry.value);
    expect(titles).toContain("Годовой отчёт Atlas");
    const identifiers = index.exactEntries
      .filter((entry) => entry.kind === "identifier")
      .map((entry) => entry.value);
    expect(identifiers).toContain("AX-2077");
    expect(index.document.metadataText).toContain("annual-report.pdf");
  });

  it("passes the original query to the reranker without translation", async () => {
    const originalQuery = "условия расторжения договора аренды за 2026 год";
    const rerank = vi.fn(async (request: {
      documents: readonly { handle: string; text: string }[];
      query: string;
    }) => ({
      model: "qwen3-reranker-8b",
      provider: "openrouter",
      requestId: "req-1",
      scores: request.documents.map((document, index) => ({
        handle: document.handle,
        index,
        relevanceScore: 0.9 - index * 0.1
      })),
      usage: { inputTokens: null, searchUnits: null, totalTokens: null }
    }));
    const stage = createKnowledgeRerankStage({
      adapter: { rerank } as never,
      pin: {
        adapterVersion: "openrouter-rerank-v1",
        candidateFormatterVersion: 2,
        connectionSnapshotId: "connection-1",
        credentialSnapshotRef: "credential-1",
        policyVersion: 1,
        provider: "openrouter",
        providerModelId: "model-1",
        upstreamModelId: "qwen/qwen3-reranker-8b"
      },
      query: originalQuery
    });
    const result = await stage({
      candidates: [
        {
          chunkId: "chunk-ru",
          headingPath: ["Договоры"],
          sourceName: "Годовой отчёт.pdf",
          text: "Договор аренды расторгается за 30 дней."
        },
        {
          chunkId: "chunk-en",
          headingPath: ["Contracts"],
          sourceName: "annual-report.pdf",
          text: "The lease terminates with 30 days notice."
        }
      ]
    });
    expect(result.status).toBe("complete");
    expect(rerank).toHaveBeenCalledOnce();
    const request = rerank.mock.calls[0]![0];
    expect(request.query).toBe(originalQuery);
    expect(request.documents[0]!.text).toContain("Договор аренды расторгается");
    expect(request.documents[0]!.text).not.toMatch(/Source:|Location:|Evidence layout/u);
  });

  it("applies one private knowledge-base query instruction identically to every language", () => {
    const preset = embeddingModelPresets.find((entry) => entry.id === "qwen3-embedding-8b")!;
    expect(preset.queryInstructionTemplate).toBe(
      "Instruct: Retrieve evidence passages from a private document knowledge base " +
      "that best answer the query. Preserve exact names, identifiers, dates, " +
      "numbers, units, and constraints.\nQuery: {text}"
    );
    expect(preset.queryInstructionTemplate!.match(/\{text\}/gu)).toHaveLength(1);
    for (const [, query] of MATRIX_QUERIES) {
      const applied = preset.queryInstructionTemplate!.replace("{text}", () => query);
      // The instruction wraps the query verbatim; it never translates,
      // detects, or replaces it.
      expect(applied.endsWith(`Query: ${query}`)).toBe(true);
      expect(applied).toContain("private document knowledge base");
    }
  });
});

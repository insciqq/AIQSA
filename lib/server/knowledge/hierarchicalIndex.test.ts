import { describe, expect, it } from "vitest";
import type { ParsedDocumentBlock } from "../parsing";
import { finalizeParsedDocument } from "../parsing/assessment";
import { chunkKnowledgeDocument } from "./chunking";
import { createKnowledgeTableDocumentContext } from "./documentContext";
import {
  buildKnowledgeHierarchicalIndex,
  KNOWLEDGE_HIERARCHICAL_INDEX_VERSION,
  knowledgeExactNormalizedValue,
  knowledgeLexicalLanguage
} from "./hierarchicalIndex";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from "./indexProfile";
import { encodeKnowledgeNormalizedDocument } from "./normalizedDocument";

const config = {
  maxChunksPerDocument: 1_000,
  maxFileBytes: 1_000_000,
  maxNormalizedChars: 1_000_000,
  maxNormalizedObjectBytes: 4_000_000,
  maxPages: 1_000
};

function block(
  index: number,
  text: string,
  input: Partial<ParsedDocumentBlock> = {}
): ParsedDocumentBlock {
  return {
    assetIds: [],
    boundingBoxes: [],
    headingPath: ["Условия"],
    index,
    isTable: false,
    languageHints: ["ru"],
    page: 1,
    pageEnd: 1,
    readingOrder: index,
    table: null,
    text,
    type: "paragraph",
    ...input
  };
}

function fixture() {
  const document = encodeKnowledgeNormalizedDocument(finalizeParsedDocument({
    blocks: [
      block(0, "Руководство Atlas", {
        headingPath: [],
        languageHints: ["ru", "en"],
        type: "title"
      }),
      block(1, "Контракт AX20260842 действует с 2026-08-18. Стоимость 840000."),
      block(2, "Critical support remains available for seventy-two hours.", {
        headingPath: ["Support", "Window"],
        languageHints: ["en"],
        page: 2,
        pageEnd: 2
      })
    ],
    engine: "docling",
    languages: ["en", "ru"],
    mediaType: "application/pdf",
    pageCount: 2,
    status: "complete"
  }), config, { sourceDisplayName: "atlas-policy.pdf" }).document;
  const chunks = chunkKnowledgeDocument({
    document,
    maxChunks: 20,
    profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION
  });
  return { chunks, document };
}

describe("Knowledge hierarchical index derivation", () => {
  it("deterministically derives document, section, passage, and exact rows", () => {
    const { chunks, document } = fixture();
    const input = {
      chunks,
      description: "Governed retention and support policy",
      document,
      fileName: "atlas-policy.pdf",
      mimeType: "application/pdf",
      sourceArtifactId: "artifact-atlas-v1",
      sourceName: "Atlas policy",
      tags: ["retention", "contract"]
    } as const;
    const first = buildKnowledgeHierarchicalIndex(input);
    const second = buildKnowledgeHierarchicalIndex(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      derivationMode: "normalized_v2",
      schemaVersion: KNOWLEDGE_HIERARCHICAL_INDEX_VERSION,
      document: {
        documentType: "application/pdf",
        fileName: "atlas-policy.pdf",
        languageConfig: "mixed",
        pageCount: 2,
        sourceName: "Atlas policy",
        tags: ["retention", "contract"],
        title: "Руководство Atlas"
      }
    });
    expect(first.sections.map((section) => section.label)).toEqual([
      "Руководство Atlas",
      "Условия",
      "Window"
    ]);
    expect(first.passages.map((passage) => passage.sectionId)).toEqual(
      first.sections.map((section) => section.id)
    );
    expect(first.passages[1]).toMatchObject({
      languageConfig: "russian",
      page: 1,
      text: "Контракт AX20260842 действует с 2026-08-18. Стоимость 840000."
    });
    expect(first.passages[1]!.contextPrefix).toContain("Section: Условия");

    const values = (kind: (typeof first.exactEntries)[number]["kind"]) =>
      first.exactEntries.filter((entry) => entry.kind === kind).map((entry) => entry.value);
    expect(values("filename")).toEqual(["atlas-policy.pdf"]);
    expect(values("title")).toEqual([
      "Руководство Atlas",
      "Atlas policy"
    ]);
    expect(values("tag")).toEqual(["retention", "contract"]);
    expect(values("identifier")).toContain("AX20260842");
    expect(values("date")).toContain("2026-08-18");
    expect(values("number")).toContain("840000");
    expect(values("heading")).toEqual(expect.arrayContaining([
      "Условия",
      "Support",
      "Window",
      "Support › Window"
    ]));
    expect(first.checksum).toMatch(/^[0-9a-f]{64}$/u);
    expect(new Set(first.exactEntries.map((entry) => entry.id)).size)
      .toBe(first.exactEntries.length);
  });

  it("keeps legacy chunk fallback labeled and infers Russian without rewriting exact text", () => {
    const { chunks } = fixture();
    const russianChunk = chunks[1]!;
    const result = buildKnowledgeHierarchicalIndex({
      chunks: [{ ...russianChunk, index: 0 }],
      document: null,
      fileName: "архив.txt",
      mimeType: "text/plain",
      sourceArtifactId: "legacy-artifact",
      sourceName: "Архив"
    });

    expect(result.derivationMode).toBe("legacy_chunks");
    expect(result.document.languageConfig).toBe("russian");
    expect(result.passages[0]).toMatchObject({
      languageConfig: "russian",
      text: russianChunk.text
    });
  });

  it("preserves typed document context in schema v2 and seals it into the checksum", () => {
    const { chunks, document } = fixture();
    const context = createKnowledgeTableDocumentContext({
      blockId: "block-context-a",
      cells: [{ columnEnd: 0, columnStart: 0, text: "5.4" }],
      headerLineage: [{
        columnEnd: 0,
        columnStart: 0,
        rowIndex: 0,
        text: "Actual"
      }],
      rowIndex: 1
    });
    const alternateContext = createKnowledgeTableDocumentContext({
      blockId: "block-context-b",
      cells: [{ columnEnd: 0, columnStart: 0, text: "5.4" }],
      headerLineage: [{
        columnEnd: 0,
        columnStart: 0,
        rowIndex: 0,
        text: "Actual"
      }],
      rowIndex: 1
    });
    const build = (documentContext: typeof context) => buildKnowledgeHierarchicalIndex({
      chunks: [{ ...chunks[0]!, documentContext }, ...chunks.slice(1)],
      document,
      fileName: "atlas-policy.pdf",
      mimeType: "application/pdf",
      sourceArtifactId: "artifact-context-v2",
      sourceName: "Atlas policy"
    });

    const contextual = build(context);
    const alternate = build(alternateContext);

    expect(contextual.schemaVersion).toBe(2);
    expect(contextual.passages[0]!.documentContext).toEqual(context);
    expect(contextual.checksum).not.toBe(alternate.checksum);
    expect(contextual.passages[0]!.contentHash).toBe(alternate.passages[0]!.contentHash);

    expect(() => build({
      ...context,
      locator: { ...context.locator, rowId: "ktr_invalid" }
    } as never)).toThrowError(expect.objectContaining({
      code: "knowledge_hierarchical_index_input_invalid"
    }));
  });

  it("normalizes exact values without stemming identifiers and rejects malformed chunk plans", () => {
    expect(knowledgeExactNormalizedValue("  SAFE-2718  ")).toBe("safe-2718");
    expect(knowledgeLexicalLanguage(["ru", "en-US"], "ignored")).toBe("mixed");
    const { chunks, document } = fixture();
    expect(() => buildKnowledgeHierarchicalIndex({
      chunks: [{ ...chunks[0]!, index: 2 }],
      document,
      fileName: "invalid.pdf",
      mimeType: "application/pdf",
      sourceArtifactId: "invalid-artifact",
      sourceName: "Invalid"
    })).toThrowError(expect.objectContaining({
      code: "knowledge_hierarchical_index_input_invalid"
    }));
  });
});

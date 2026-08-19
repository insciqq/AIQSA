import { utils, write } from "xlsx";
import { parseSpreadsheetDocument } from "../parsing";
import { encodeKnowledgeNormalizedDocument } from "./normalizedDocument";
import type { KnowledgeExtractionConfig } from "./knowledgeExtractionConfig";
import {
  analyzeStructuredKnowledgeSources,
  type StructuredKnowledgeArtifactCandidate
} from "./structuredRetrieval";

const config: KnowledgeExtractionConfig = {
  maxChunksPerDocument: 1_000,
  maxFileBytes: 1_000_000,
  maxNormalizedChars: 1_000_000,
  maxNormalizedObjectBytes: 4_000_000,
  maxPages: 100
};

function encodedWorkbook(sourceName = "Quarterly Sales") {
  const sheet = utils.aoa_to_sheet([
    ["Region", "Revenue", "Note"],
    ["North", 100, "safe"],
    ["South", 200, "=HYPERLINK(\"https://invalid\")"]
  ]);
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, sheet, "Sales");
  const parsed = parseSpreadsheetDocument({
    bytes: write(workbook, { bookType: "xlsx", type: "buffer" }),
    fileName: "quarterly-sales.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  return encodeKnowledgeNormalizedDocument(parsed, config, { sourceDisplayName: sourceName });
}

function candidate(
  encoded: ReturnType<typeof encodedWorkbook>,
  overrides: Partial<StructuredKnowledgeArtifactCandidate> = {}
): StructuredKnowledgeArtifactCandidate {
  return {
    artifactId: "artifact-1",
    baseName: "Finance",
    bindingOrdinal: 0,
    documentId: "document-1",
    documentVersionId: "version-1",
    documentVersionNumber: 1,
    fileName: "quarterly-sales.xlsx",
    knowledgeBaseId: "base-1",
    normalizedTextByteSize: encoded.body.byteLength,
    normalizedTextChecksum: encoded.checksum,
    normalizedTextStorageKey: "normalized/quarterly-sales.json",
    sourceName: "Quarterly Sales",
    ...overrides
  };
}

function dependencies(encoded: ReturnType<typeof encodedWorkbook>) {
  return {
    config,
    loadAnchor: async () => ({
      contentHash: "a".repeat(64),
      headingPath: ["Sales"],
      id: "passage-1",
      ordinal: 0,
      sectionId: "section-1"
    }),
    storage: {
      getObject: async (storageKey: string) => ({
        body: encoded.body,
        contentType: "application/json",
        storageKey
      })
    }
  };
}

describe("structured Knowledge retrieval", () => {
  it("returns a cited calculation passage with a sanitized operation receipt", async () => {
    const encoded = encodedWorkbook();
    const result = await analyzeStructuredKnowledgeSources({
      candidates: [candidate(encoded)],
      ...dependencies(encoded),
      query: "Sum Revenue in Sales"
    });

    expect(result).toMatchObject({
      kind: "complete",
      passage: {
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        headingPath: ["Sales", "B2:B3"],
        page: 1,
        sourceArtifactId: "artifact-1",
        structuredAnalysis: {
          columns: ["sum Revenue"],
          rows: [[300]],
          receipt: {
            inputRanges: [{ range: "B2:B3", role: "value", sheet: "Sales" }],
            operation: "aggregate"
          }
        }
      }
    });
    if (result.kind !== "complete") throw new Error("expected complete result");
    expect(result.passage.text).toContain("Operation: sum Revenue");
    expect(result.passage.text).not.toContain("eval(");
  });

  it("keeps formula-like strings inert when rendering row evidence", async () => {
    const encoded = encodedWorkbook();
    const result = await analyzeStructuredKnowledgeSources({
      candidates: [candidate(encoded)],
      ...dependencies(encoded),
      query: "Show the Sales table column Note"
    });
    expect(result.kind).toBe("complete");
    if (result.kind === "complete") {
      expect(result.passage.text).toContain("'=HYPERLINK");
      expect(result.passage.structuredAnalysis?.receipt.formulaCellsUsed).toBe(0);
    }
  });

  it("asks for a source instead of combining two matching workbooks", async () => {
    const encoded = encodedWorkbook();
    const result = await analyzeStructuredKnowledgeSources({
      candidates: [
        candidate(encoded),
        candidate(encoded, {
          artifactId: "artifact-2",
          documentId: "document-2",
          documentVersionId: "version-2",
          fileName: "regional-sales.xlsx",
          normalizedTextStorageKey: "normalized/regional-sales.json",
          sourceName: "Regional Sales"
        })
      ],
      ...dependencies(encoded),
      query: "Sum Revenue in the Sales sheet"
    });

    expect(result).toMatchObject({
      kind: "needs_clarification",
      question: expect.stringContaining("Quarterly Sales")
    });
  });

  it("falls back to ordinary retrieval when integrity or citation anchoring is unavailable", async () => {
    const encoded = encodedWorkbook();
    const broken = await analyzeStructuredKnowledgeSources({
      candidates: [candidate(encoded, { normalizedTextChecksum: "0".repeat(64) })],
      ...dependencies(encoded),
      query: "Sum Revenue in Sales"
    });
    expect(broken).toEqual({ kind: "not_applicable" });

    const unanchored = await analyzeStructuredKnowledgeSources({
      candidates: [candidate(encoded)],
      ...dependencies(encoded),
      loadAnchor: async () => null,
      query: "Sum Revenue in Sales"
    });
    expect(unanchored).toEqual({ kind: "not_applicable" });
  });
});

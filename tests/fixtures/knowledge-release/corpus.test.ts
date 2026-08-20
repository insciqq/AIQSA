import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createKnowledgeReleaseCorpus,
  KNOWLEDGE_RELEASE_DOCUMENT_COUNT,
  KNOWLEDGE_RELEASE_STRUCTURED_FILE_NAME,
  KNOWLEDGE_RELEASE_STRUCTURED_ORDINAL,
  KNOWLEDGE_RELEASE_STRUCTURED_QUERY,
  type KnowledgeReleaseFormat
} from "../../../scripts/knowledge-release-corpus";
import { parseSpreadsheetDocument } from "../../../lib/server/parsing";
import { chunkKnowledgeDocument } from "../../../lib/server/knowledge/chunking";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from "../../../lib/server/knowledge/indexProfile";
import { encodeKnowledgeNormalizedDocument } from "../../../lib/server/knowledge/normalizedDocument";
import { executeStructuredPlan } from "../../../lib/server/knowledge/structuredData";
import { planStructuredDataQuery } from "../../../lib/server/knowledge/structuredPlanner";

const extractionConfig = Object.freeze({
  maxChunksPerDocument: 10_000,
  maxFileBytes: 50_000_000,
  maxNormalizedChars: 5_000_000,
  maxNormalizedObjectBytes: 20_000_000,
  maxPages: 2_000
});

describe("Knowledge Stage 8 release corpus", () => {
  it("creates 50 substantive mixed-format documents deterministically", () => {
    const first = createKnowledgeReleaseCorpus();
    const second = createKnowledgeReleaseCorpus();

    expect(first).toHaveLength(KNOWLEDGE_RELEASE_DOCUMENT_COUNT);
    expect(new Set(first.map(({ fileName }) => fileName))).toHaveLength(50);
    expect(first.map(({ format }) => format)).toEqual(expect.arrayContaining([
      "csv", "docx", "html", "markdown", "pdf", "pptx", "text", "xlsx"
    ]));
    expect(first.every(({ byteLength }) => byteLength >= 1_000)).toBe(true);
    expect(first.map(({ sha256 }) => sha256)).toEqual(second.map(({ sha256 }) => sha256));
    expect(first.every(({ bytes, sha256 }) =>
      createHash("sha256").update(bytes).digest("hex") === sha256
    )).toBe(true);
    expect(new Set(first.map(({ semanticTemplateFamily }) => semanticTemplateFamily)))
      .toHaveLength(8);

    const semanticAnchors = Object.freeze({
      csv: "event_id,observed_at",
      docx: "Requested change.",
      html: "Question: what evidence is sufficient?",
      markdown: "Decision context",
      pdf: "Assertion under review",
      pptx: "SLIDE 1",
      text: "08:05 INTAKE",
      xlsx: "Amount USD"
    } satisfies Readonly<Record<KnowledgeReleaseFormat, string>>);
    for (const [format, anchor] of Object.entries(semanticAnchors)) {
      expect(first.filter((document) => document.format === format).every((document) =>
        document.bytes.includes(Buffer.from(anchor, "utf8"))
      )).toBe(true);
    }

    expect(first.find(({ scenario }) => scenario === "cancel")?.bytes.toString("utf8"))
      .toContain("RELEASE_CANCEL_TARGET");
    expect(first.find(({ scenario }) => scenario === "retry")?.bytes.toString("utf8"))
      .toContain("RELEASE_RETRY_TARGET");
    expect(first.find(({ scenario }) => scenario === "fact")?.bytes.toString("utf8"))
      .toContain("retained for exactly 37 days");
    expect(first.find(({ scenario }) => scenario === "exact_identifier")?.bytes.toString("utf8"))
      .toContain("AX-2026-0842");
    expect(first.find(({ format }) => format === "pdf")?.bytes.subarray(0, 5).toString("ascii"))
      .toBe("%PDF-");
    expect(first.filter(({ format }) => ["docx", "pptx", "xlsx"].includes(format))
      .every(({ bytes }) => bytes.subarray(0, 2).toString("ascii") === "PK"))
      .toBe(true);
    for (const document of first.filter(({ format }) => format === "csv" || format === "xlsx")) {
      const parsed = parseSpreadsheetDocument({
        bytes: document.bytes,
        fileName: document.fileName,
        mimeType: document.mimeType
      });
      const normalized = encodeKnowledgeNormalizedDocument(parsed, extractionConfig);
      expect(() => chunkKnowledgeDocument({
        document: normalized.document,
        maxChunks: extractionConfig.maxChunksPerDocument,
        profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION
      })).not.toThrow();
    }
  });

  it("keeps the release workbook query deterministic and directly executable", () => {
    const document = createKnowledgeReleaseCorpus().find(({ ordinal }) =>
      ordinal === KNOWLEDGE_RELEASE_STRUCTURED_ORDINAL);
    if (!document) throw new Error("knowledge_release_structured_fixture_missing");
    expect(document.fileName).toBe(KNOWLEDGE_RELEASE_STRUCTURED_FILE_NAME);
    const workbook = parseSpreadsheetDocument({
      bytes: document.bytes,
      fileName: document.fileName,
      mimeType: document.mimeType
    }).workbook;
    if (!workbook) throw new Error("knowledge_release_structured_workbook_missing");
    const decision = planStructuredDataQuery(KNOWLEDGE_RELEASE_STRUCTURED_QUERY, workbook);
    expect(decision.status).toBe("ready");
    if (decision.status !== "ready") return;

    const result = executeStructuredPlan(workbook, decision.plan);
    expect(result).toMatchObject({
      columns: ["Record", "Date", "Evidence", "Amount USD"],
      receipt: {
        operation: "list_rows",
        operationSummary: "Listed 2 matching rows sorted by Amount USD",
        outputRows: 2
      },
      rows: [
        ["X48-30", "2026-08-11", "Checksum observation 48-30", 4_897.5],
        ["X48-29", "2026-08-10", "Checksum observation 48-29", 4_894.25]
      ]
    });
  });
});

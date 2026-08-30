import { describe, expect, it } from "vitest";
import {
  OPEN_RAG_STRATUM_POLICY,
  assertOpenRagPdfShape,
  buildOpenRagRunnerBundle,
  decodeOpenRagMetadata,
  selectOpenRagSlice
} from "./openRagSlice";

function fixture() {
  const queries: Record<string, unknown> = {};
  const qrels: Record<string, unknown> = {};
  const answers: Record<string, unknown> = {};
  const pdfUrls: Record<string, unknown> = {};
  let documentNumber = 1;
  let questionNumber = 1;

  for (const policy of OPEN_RAG_STRATUM_POLICY) {
    for (let documentIndex = 0; documentIndex < policy.documentCount; documentIndex += 1) {
      const docId = `2401.${String(documentNumber).padStart(5, "0")}v1`;
      documentNumber += 1;
      pdfUrls[docId] = `https://arxiv.org/pdf/${docId}`;
      for (let row = 0; row < 3; row += 1) {
        const id = `q-${String(questionNumber).padStart(4, "0")}`;
        questionNumber += 1;
        queries[id] = {
          query: `Question ${id}`,
          source: policy.source,
          type: policy.type
        };
        qrels[id] = { doc_id: docId, section_id: row };
        answers[id] = `Answer ${id}`;
      }
    }
  }
  for (let index = 0; index < 60; index += 1) {
    const docId = `2501.${String(index + 1).padStart(5, "0")}v1`;
    pdfUrls[docId] = `https://arxiv.org/pdf/${docId}`;
  }
  return { answers, pdfUrls, qrels, queries };
}

describe("Open RAG PDF diagnostic slice", () => {
  it("selects a deterministic 40-positive/60-negative, 100-question slice", () => {
    const raw = fixture();
    const first = selectOpenRagSlice(decodeOpenRagMetadata(raw));
    const reversed = Object.fromEntries(Object.entries(raw.queries).reverse());
    const second = selectOpenRagSlice(decodeOpenRagMetadata({
      ...raw,
      queries: reversed
    }));

    expect(first).toEqual(second);
    expect(first.documents).toHaveLength(100);
    expect(first.documents.filter(({ role }) => role === "positive")).toHaveLength(40);
    expect(first.documents.filter(({ role }) => role === "negative")).toHaveLength(60);
    expect(first.questions).toHaveLength(100);
    expect(new Set(first.questions.map(({ id }) => id))).toHaveLength(100);
    const counts = new Map<string, number>();
    for (const question of first.questions) {
      counts.set(question.docId, (counts.get(question.docId) ?? 0) + 1);
    }
    expect(counts.size).toBe(40);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);
    for (const policy of OPEN_RAG_STRATUM_POLICY) {
      expect(first.questions.filter((question) =>
        question.source === policy.source && question.type === policy.type))
        .toHaveLength(policy.questionCount);
    }
  });

  it("rejects mismatched query/answer/qrel key sets and non-arXiv URLs", () => {
    const raw = fixture();
    delete raw.answers[Object.keys(raw.answers)[0]!];
    expect(() => decodeOpenRagMetadata(raw))
      .toThrow("open_rag_metadata_key_set_invalid");

    const badUrl = fixture();
    const firstDoc = Object.keys(badUrl.pdfUrls)[0]!;
    badUrl.pdfUrls[firstDoc] = "https://example.com/not-the-pinned-pdf";
    expect(() => decodeOpenRagMetadata(badUrl))
      .toThrow("open_rag_pdf_url_invalid");
  });

  it("accepts only bounded PDF-shaped downloads", () => {
    expect(() => assertOpenRagPdfShape(Buffer.from("%PDF-1.7"), 8)).not.toThrow();
    expect(() => assertOpenRagPdfShape(Buffer.from("<html>"), 6))
      .toThrow("open_rag_pdf_invalid");
    expect(() => assertOpenRagPdfShape(Buffer.from("%PDF-"), 50_000_001))
      .toThrow("open_rag_pdf_invalid");
  });

  it("builds evaluator-only sidecars without changing the uploaded PDFs", () => {
    const manifest = selectOpenRagSlice(decodeOpenRagMetadata(fixture()));
    const bundle = buildOpenRagRunnerBundle(manifest);
    expect(Object.keys(bundle.aliases)).toHaveLength(100);
    expect(Object.keys(bundle.sidecars)).toHaveLength(100);
    expect(Object.values(bundle.questions.documents)
      .flatMap(({ cases }) => cases)).toHaveLength(100);
    expect(Object.values(bundle.questions.documents)
      .flatMap(({ cases }) => cases)
      .every(({ evaluationMode }) =>
        evaluationMode === "open_rag_reference_answer")).toBe(true);
    expect(Object.values(bundle.questions.documents)
      .every(({ cases }) => cases.length <= 3)).toBe(true);
  });
});

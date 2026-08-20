import { describe, expect, it } from "vitest";
import { assertKnowledgeIngestionReleaseGates } from "./ingestionRelease";

describe("Knowledge ingestion release evaluation", () => {
  it("passes every named aggregate ingestion gate through executable primitives", async () => {
    const report = await assertKnowledgeIngestionReleaseGates();

    expect(report.aggregateOnly).toBe(true);
    expect(report.gates.map((gate) => gate.name)).toEqual([
      "admission_accuracy",
      "classification_accuracy",
      "page_block_recall",
      "ocr_text_recall",
      "table_structure_accuracy",
      "heading_path_accuracy",
      "fallback_success",
      "truncation_disclosure",
      "locator_accuracy",
      "retry_isolation",
      "embedding_reuse",
      "purge_manifest_fence"
    ]);
    expect(report.gates.every((gate) => gate.rate === 1)).toBe(true);
    expect(report.unavailable).toEqual([expect.objectContaining({
      field: "destructive_payload_purge_latency_and_bytes"
    })]);
  });
});

import { describe, expect, it } from "vitest";
import {
  assertLongMemEvalQualificationDataset,
  decodeLongMemEvalQualificationManifest,
  loadLongMemEvalQualificationManifest
} from "../benchmarks/longmemeval/qualification";

describe("LongMemEval frozen qualification manifest", () => {
  it("loads the content-free blind 50 contract with all category quotas", async () => {
    const manifest = await loadLongMemEvalQualificationManifest("fu09-blind-50-v1");

    expect(manifest.runtime.systemModel).toEqual({
      provider: "codex-lb",
      reasoningEffort: "medium",
      upstreamModelId: "gpt-5.6-luna"
    });
    expect(manifest.selection.cases).toHaveLength(50);
    expect(manifest.selection.quotas).toEqual({
      "knowledge-update": 8,
      "multi-session": 9,
      "single-session-assistant": 8,
      "single-session-preference": 8,
      "single-session-user": 8,
      "temporal-reasoning": 9
    });
    expect(JSON.stringify(manifest)).not.toMatch(
      /"(?:answer|hypothesis|question)"\s*:/u
    );
  });

  it("binds every selected id to its frozen upstream category", async () => {
    const manifest = await loadLongMemEvalQualificationManifest("fu09-blind-50-v1");
    const metadata = manifest.selection.cases.map((entry) => ({ ...entry }));

    expect(() => assertLongMemEvalQualificationDataset(manifest, metadata))
      .not.toThrow();
    expect(() => assertLongMemEvalQualificationDataset(manifest, metadata.slice(1)))
      .toThrow("longmemeval_qualification_manifest_dataset_mismatch");
  });

  it("rejects selection drift even when the rest of the shape is valid", async () => {
    const manifest = await loadLongMemEvalQualificationManifest("fu09-blind-50-v1");
    const drifted = structuredClone(manifest);
    drifted.selection.cases[0]!.questionId = "different_id";

    expect(() => decodeLongMemEvalQualificationManifest(drifted))
      .toThrow("longmemeval_qualification_manifest_invalid");
  });
});

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

  it("freezes the reader-first reranker route and case concurrency two", async () => {
    const [legacy, prior, manifest] = await Promise.all([
      loadLongMemEvalQualificationManifest("fu09-blind-50-v1"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v1"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v2")
    ]);

    expect(manifest.runtime.caseConcurrency).toBe(2);
    expect(manifest.runtime.sessionConcurrency).toBe(16);
    expect(manifest.runtime.reranker).toEqual({
      policyVersion: "openrouter-reranker-route-v1",
      provider: "OpenRouter",
      route: [
        {
          relevanceScoreFloor: null,
          upstreamModelId: "voyageai/rerank-2.5"
        },
        {
          relevanceScoreFloor: null,
          upstreamModelId: "cohere/rerank-4-pro"
        },
        {
          relevanceScoreFloor: 0.01,
          upstreamModelId: "qwen/qwen3-reranker-8b"
        }
      ]
    });
    expect(manifest.selection).toEqual(legacy.selection);
    expect(manifest.selection).toEqual(prior.selection);
    expect(manifest.source.appCommit)
      .toBe("0f57ee307de10173b291984c58dc02b8b48580fe");
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

  it("rejects reader-first reranker route drift", async () => {
    const manifest = await loadLongMemEvalQualificationManifest(
      "fu2-reader-first-blind-50-v2"
    );
    if (manifest.id !== "fu2-reader-first-blind-50-v2") {
      throw new Error("reader_first_manifest_expected");
    }
    const drifted: unknown = {
      ...manifest,
      runtime: {
        ...manifest.runtime,
        reranker: {
          ...manifest.runtime.reranker,
          route: [...manifest.runtime.reranker.route].reverse()
        }
      }
    };

    expect(() => decodeLongMemEvalQualificationManifest(drifted))
      .toThrow();
  });
});

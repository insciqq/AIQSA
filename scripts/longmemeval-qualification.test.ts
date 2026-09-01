import { describe, expect, it } from "vitest";
import {
  assertLongMemEvalQualificationDataset,
  decodeLongMemEvalQualificationManifest,
  loadLongMemEvalQualificationManifest
} from "../benchmarks/longmemeval/qualification";
import { currentLongMemEvalQualificationRevision } from
  "../benchmarks/longmemeval/qualificationRevision";

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
    const [legacy, first, second, third, fourth, fifth, sixth, prior, manifest] =
      await Promise.all([
      loadLongMemEvalQualificationManifest("fu09-blind-50-v1"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v1"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v2"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v3"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v4"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v5"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v6"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v7"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v8")
    ]);
    if (manifest.id !== "fu2-reader-first-blind-50-v8") {
      throw new Error("reader_first_manifest_expected");
    }

    expect(manifest.runtime.caseConcurrency).toBe(2);
    expect(manifest.runtime.sessionConcurrency).toBe(16);
    expect(manifest.runtime.embedding).toEqual({
      provider: "OpenRouter",
      providerOrder: ["nebius", "deepinfra"],
      upstreamModelId: "qwen/qwen3-embedding-8b"
    });
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
    expect(manifest.runtime.evaluation).toMatchObject({
      failFast: true,
      mode: "per_case",
      model: "gpt-4o-2024-08-06"
    });
    expect(manifest.runtime.lexical).toEqual({
      backend: "OPENSEARCH",
      indexBuildId: "20260831-lme-v7-r2"
    });
    expect(manifest.selection).toEqual(legacy.selection);
    expect(manifest.selection).toEqual(first.selection);
    expect(manifest.selection).toEqual(second.selection);
    expect(manifest.selection).toEqual(third.selection);
    expect(manifest.selection).toEqual(fourth.selection);
    expect(manifest.selection).toEqual(fifth.selection);
    expect(manifest.selection).toEqual(sixth.selection);
    expect(manifest.selection).toEqual(prior.selection);
    expect(manifest.source.appCommit)
      .toBe("255d7de09305e15959ebd7803cfc2c5e8e540061");
    await expect(currentLongMemEvalQualificationRevision(process.cwd()))
      .resolves.toEqual({
        headCommit: manifest.source.appCommit,
        worktreeSha256: manifest.source.appWorktreeSha256
      });
  }, 15_000);

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
      "fu2-reader-first-blind-50-v8"
    );
    if (manifest.id !== "fu2-reader-first-blind-50-v8") {
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

  it("rejects reader-first embedding provider-order drift", async () => {
    const manifest = await loadLongMemEvalQualificationManifest(
      "fu2-reader-first-blind-50-v8"
    );
    if (manifest.id !== "fu2-reader-first-blind-50-v8") {
      throw new Error("reader_first_manifest_expected");
    }
    const drifted: unknown = {
      ...manifest,
      runtime: {
        ...manifest.runtime,
        embedding: {
          ...manifest.runtime.embedding,
          providerOrder: [...manifest.runtime.embedding.providerOrder].reverse()
        }
      }
    };

    expect(() => decodeLongMemEvalQualificationManifest(drifted))
      .toThrow();
  });
});

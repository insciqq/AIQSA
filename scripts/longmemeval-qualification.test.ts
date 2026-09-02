import { describe, expect, it } from "vitest";
import {
  LONGMEMEVAL_ACTIVE_QUALIFICATION_MANIFEST_IDS,
  assertLongMemEvalQualificationDataset,
  decodeLongMemEvalQualificationManifest,
  loadLongMemEvalQualificationManifest,
  longMemEvalEvaluationRequiresStop
} from "../benchmarks/longmemeval/qualification";
import { currentLongMemEvalQualificationRevision } from
  "../benchmarks/longmemeval/qualificationRevision";

describe("LongMemEval frozen qualification manifest", () => {
  it("continues after incorrect labels only when the manifest disables fail-fast", () => {
    expect(longMemEvalEvaluationRequiresStop(false, false)).toBe(false);
    expect(longMemEvalEvaluationRequiresStop(true, false)).toBe(true);
    expect(longMemEvalEvaluationRequiresStop(true, true)).toBe(false);
  });

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

  it("freezes the reader-first reranker route and fast-model matrix", async () => {
    const [legacy, first, second, third, fourth, fifth, sixth, prior, previous,
      luna, historicalDeepSeek, historicalGlm, historicalGemini,
      deepSeek, glm, gemini] =
      await Promise.all([
      loadLongMemEvalQualificationManifest("fu09-blind-50-v1"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v1"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v2"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v3"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v4"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v5"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v6"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v7"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v8"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v9"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v10"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v11"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v12"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v13"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v14"),
      loadLongMemEvalQualificationManifest("fu2-reader-first-blind-50-v15")
    ]);
    if (luna.id !== "fu2-reader-first-blind-50-v9") {
      throw new Error("reader_first_manifest_expected");
    }
    expect(LONGMEMEVAL_ACTIVE_QUALIFICATION_MANIFEST_IDS).toEqual([
      "fu2-reader-first-blind-50-v13",
      "fu2-reader-first-blind-50-v14",
      "fu2-reader-first-blind-50-v15"
    ]);

    expect(luna.runtime.caseConcurrency).toBe(2);
    expect(luna.runtime.sessionConcurrency).toBe(16);
    expect(luna.runtime.embedding).toEqual({
      provider: "OpenRouter",
      providerOrder: ["nebius", "deepinfra"],
      upstreamModelId: "qwen/qwen3-embedding-8b"
    });
    expect(luna.runtime.reranker).toEqual({
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
    expect(luna.runtime.evaluation).toMatchObject({
      failFast: true,
      mode: "per_case",
      model: "gpt-4o-2024-08-06"
    });
    expect(luna.runtime.lexical).toEqual({
      backend: "OPENSEARCH",
      indexBuildId: "20260831-lme-v7-r2"
    });
    expect(luna.selection).toEqual(legacy.selection);
    expect(luna.selection).toEqual(first.selection);
    expect(luna.selection).toEqual(second.selection);
    expect(luna.selection).toEqual(third.selection);
    expect(luna.selection).toEqual(fourth.selection);
    expect(luna.selection).toEqual(fifth.selection);
    expect(luna.selection).toEqual(sixth.selection);
    expect(luna.selection).toEqual(prior.selection);
    expect(luna.selection).toEqual(previous.selection);
    expect(luna.selection).toEqual(historicalDeepSeek.selection);
    expect(luna.selection).toEqual(historicalGlm.selection);
    expect(luna.selection).toEqual(historicalGemini.selection);
    expect(luna.source.appCommit)
      .toBe("3e4c098975130e2829c67973632d8eb51d4ca732");
    await expect(currentLongMemEvalQualificationRevision(process.cwd()))
      .resolves.toEqual({
        headCommit: deepSeek.source.appCommit,
        worktreeSha256: deepSeek.source.appWorktreeSha256
      });
    for (const manifest of [deepSeek, glm, gemini]) {
      expect(manifest.runtime.evaluation).toMatchObject({
        failFast: false,
        mode: "per_case",
        model: "gpt-4o-2024-08-06"
      });
      expect(manifest.runtime.memoryAdmission).toEqual({
        controlMaximumMs: 20_000,
        hardDeadlineMs: 26_000,
        queryResolverMaximumMs: 20_000,
        queryResolverSettlementReserveMs: 2_000,
        softDeadlineMs: 20_000,
        version: "memory-run-retrieval-admission-v54"
      });
    }
    expect([deepSeek, glm, gemini].map(({ runtime, selection }) => ({
      model: runtime.systemModel,
      selection
    }))).toEqual([
      {
        model: {
          dataCollection: "allow",
          provider: "OpenRouter",
          providerOrder: ["deepseek"],
          reasoningEffort: "medium",
          structuredOutputToolChoice: "auto",
          upstreamModelId: "deepseek/deepseek-v4-flash-0731"
        },
        selection: luna.selection
      },
      {
        model: {
          dataCollection: "deny",
          provider: "OpenRouter",
          providerOrder: ["z-ai/fp8"],
          reasoningEffort: "medium",
          structuredOutputToolChoice: "auto",
          upstreamModelId: "z-ai/glm-5.3-flash"
        },
        selection: luna.selection
      },
      {
        model: {
          dataCollection: "deny",
          provider: "OpenRouter",
          providerOrder: ["google-vertex/global"],
          reasoningEffort: "medium",
          structuredOutputToolChoice: "required",
          upstreamModelId: "google/gemini-3.7-flash"
        },
        selection: luna.selection
      }
    ]);
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
      "fu2-reader-first-blind-50-v9"
    );
    if (manifest.id !== "fu2-reader-first-blind-50-v9") {
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
      "fu2-reader-first-blind-50-v9"
    );
    if (manifest.id !== "fu2-reader-first-blind-50-v9") {
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

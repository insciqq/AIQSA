import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertKnowledgeSemanticCandidateFreezeManifest,
  assertKnowledgeSemanticCandidateResult,
  createKnowledgeSemanticCandidateFreezeManifest,
  createKnowledgeSemanticCandidateSetBinding,
  createKnowledgeSemanticEvaluationContractBinding,
  createKnowledgeSemanticGroundingCandidatePool,
  createKnowledgeSemanticGroundingCandidates,
  knowledgeSemanticCandidateInputContract,
  knowledgeSemanticCandidatePoolSha256,
  KNOWLEDGE_SEMANTIC_FROZEN_CORPUS_SHA256,
  KNOWLEDGE_SEMANTIC_FROZEN_POOL_SHA256
} from "./semanticGroundingCandidates";
import {
  auditKnowledgeSemanticArithmeticBindings
} from "./semanticGroundingArithmeticBinding";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function moduleSourceSha256(relativePath: string): string {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8")
    .replace(/\r\n?/gu, "\n")
    .trim();
  return createHash("sha256").update(source, "utf8").digest("hex");
}

describe("Knowledge semantic candidate pool", () => {
  it("freezes one label-free claim-neighborhood pool for every candidate", () => {
    const pool = createKnowledgeSemanticGroundingCandidatePool();

    expect(pool).toMatchObject({
      corpusSha256: KNOWLEDGE_SEMANTIC_FROZEN_CORPUS_SHA256,
      labelsExcludedFromPool: true,
      poolSha256: KNOWLEDGE_SEMANTIC_FROZEN_POOL_SHA256,
      samePoolForEveryCandidate: true,
      version: "knowledge-semantic-candidate-pool-v1"
    });
    expect(pool.entries).toHaveLength(681);
    expect(new Set(pool.entries.map((entry) => entry.documentFamily)).size).toBe(364);
    expect(new Set(pool.entries.map((entry) => entry.claimSha256)).size).toBe(681);
    expect(pool.entries.every((entry) => /^[a-f0-9]{64}$/u.test(entry.neighborhoodSha256)))
      .toBe(true);
    expect(pool.entries.flatMap((entry) => entry.evidencePackage.items)
      .every((entry) => entry.contentHash === null || /^[a-f0-9]{64}$/u.test(entry.contentHash)))
      .toBe(true);
    expect(pool.entries.filter((entry) => entry.slices.includes("no_answer")))
      .toHaveLength(70);
    expect(JSON.stringify(pool)).not.toContain('"labels"');
  });

  it("binds every derived-arithmetic claim to a production receipt", () => {
    const pool = createKnowledgeSemanticGroundingCandidatePool();
    const arithmeticEntries = pool.entries.filter((entry) => entry.arithmetic !== null);
    const audit = auditKnowledgeSemanticArithmeticBindings(arithmeticEntries.map((entry) => {
      if (!entry.arithmetic) throw new Error("arithmetic_binding_missing");
      return {
        binding: entry.arithmetic,
        claimSha256: entry.claimSha256,
        evidencePackage: entry.evidencePackage
      };
    }));

    expect(arithmeticEntries).toHaveLength(70);
    expect(pool.entries.every((entry) =>
      (entry.input.type === "derived_arithmetic") === (entry.arithmetic !== null))).toBe(true);
    expect(audit).toEqual({
      aggregateOnly: true,
      bindingVersion: "knowledge-semantic-arithmetic-binding-v1",
      contradictedByRecomputation: 33,
      failed: 0,
      passed: true,
      productionReceiptVersion: "knowledge-semantic-arithmetic-receipt-v1",
      productionVerifierUsed: true,
      receiptCount: 70,
      verified: 37
    });
    expect(arithmeticEntries[0]).toMatchObject({
      arithmetic: {
        receipt: {
          receiptSha256: "88aa99cbbdf5ef90629c52ea9d30e6f86eeca00208b950d91fca44660d71fff6"
        }
      },
      fixtureId: "dev-lark-en-arithmetic",
      ordinal: 1
    });
  });

  it("includes each arithmetic receipt digest in the frozen pool identity", () => {
    const pool = createKnowledgeSemanticGroundingCandidatePool();
    const arithmeticIndex = pool.entries.findIndex((entry) => entry.arithmetic !== null);
    const arithmeticEntry = pool.entries[arithmeticIndex];
    if (!arithmeticEntry?.arithmetic) throw new Error("arithmetic_binding_missing");
    const tamperedEntries = [...pool.entries];
    tamperedEntries[arithmeticIndex] = Object.freeze({
      ...arithmeticEntry,
      arithmetic: Object.freeze({
        ...arithmeticEntry.arithmetic,
        receipt: Object.freeze({
          ...arithmeticEntry.arithmetic.receipt,
          receiptSha256: "f".repeat(64)
        })
      })
    });

    expect(knowledgeSemanticCandidatePoolSha256({
      corpusSha256: pool.corpusSha256,
      entries: pool.entries
    })).toBe(KNOWLEDGE_SEMANTIC_FROZEN_POOL_SHA256);
    expect(knowledgeSemanticCandidatePoolSha256({
      corpusSha256: pool.corpusSha256,
      entries: tamperedEntries
    })).not.toBe(pool.poolSha256);
  });

  it("keeps evaluator identity, split, hashes, and receipts outside every executor input", () => {
    const pool = createKnowledgeSemanticGroundingCandidatePool();
    const forbiddenKeys = new Set([
      "arithmetic",
      "claimOrdinal",
      "claimSha256",
      "contentHash",
      "documentFamily",
      "evidencePackage",
      "fixtureId",
      "neighborhoodRule",
      "neighborhoodSha256",
      "neighborhoodVersion",
      "ordinal",
      "split"
    ]);
    const keys = (value: unknown): PropertyKey[] => {
      if (Array.isArray(value)) return value.flatMap(keys);
      if (typeof value !== "object" || value === null) return [];
      return Reflect.ownKeys(value).flatMap((key) => [key, ...keys(Reflect.get(value, key))]);
    };

    for (const entry of pool.entries) {
      expect(keys(entry.input).filter((key) =>
        typeof key === "string" && forbiddenKeys.has(key))).toEqual([]);
      expect(JSON.stringify(entry.input)).not.toContain(entry.fixtureId);
      expect(entry.input).not.toHaveProperty("arithmetic");
      expect(entry.input).not.toHaveProperty("evidencePackage");
      expect(entry.evidencePackage.items).toHaveLength(entry.input.evidence.length);
    }
    expect(knowledgeSemanticCandidateInputContract.evaluatorMetadataExcluded)
      .toContain("arithmetic");
  });

  it("keeps optional candidates typed unavailable without executing them", () => {
    const candidates = createKnowledgeSemanticGroundingCandidates();

    expect(candidates.map((candidate) => ({
      availability: candidate.availability,
      id: candidate.id,
      ...(candidate.availability === "unavailable" ? { reason: candidate.reason } : {})
    }))).toEqual([
      { availability: "available", id: "current_structural_fence_v4" },
      {
        availability: "unavailable",
        id: "local_multilingual_nli_v1",
        reason: "local_model_not_configured"
      },
      {
        availability: "unavailable",
        id: "system_model_semantic_v1",
        reason: "system_model_not_authorized"
      },
      {
        availability: "unavailable",
        id: "hybrid_semantic_v1",
        reason: "hybrid_component_unavailable"
      }
    ]);
  });

  it("binds the candidate-set digest to runner identity and threshold contract", () => {
    const pool = createKnowledgeSemanticGroundingCandidatePool();
    const baseline = createKnowledgeSemanticGroundingCandidates();
    const first = createKnowledgeSemanticCandidateSetBinding({
      candidates: baseline,
      corpusSha256: pool.corpusSha256,
      poolSha256: pool.poolSha256
    });
    const structural = baseline[0]!;
    if (structural.availability !== "available") throw new Error("structural_missing");
    const alteredLocal = {
      ...structural.executor,
      identity: { ...structural.executor.identity, revision: "different-frozen-revision" }
    };
    const altered = createKnowledgeSemanticGroundingCandidates({ local: alteredLocal });
    const second = createKnowledgeSemanticCandidateSetBinding({
      candidates: altered,
      corpusSha256: pool.corpusSha256,
      poolSha256: pool.poolSha256
    });
    expect(first.version).toBe("knowledge-semantic-candidates-v1");
    expect(first.evaluationContractSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.thresholdContractVersion).toBe("knowledge-semantic-threshold-v1");
    expect(first.thresholdScheduleSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.digest).not.toBe(first.digest);
  });

  it("binds both arithmetic implementations into the evaluator scorer digest", () => {
    const binding = createKnowledgeSemanticEvaluationContractBinding();

    expect(binding.scorerImplementationSha256).toBe(canonicalSha256({
      arithmeticBinding: moduleSourceSha256("./semanticGroundingArithmeticBinding.ts"),
      candidateBenchmark: moduleSourceSha256("./semanticGroundingBenchmark.ts"),
      deterministicScorer: moduleSourceSha256("./semanticGrounding.ts"),
      productionArithmetic: moduleSourceSha256(
        "../../lib/server/knowledge/semanticArithmetic.ts"
      ),
      releaseMetrics: moduleSourceSha256("./semanticGroundingReleaseMetrics.ts")
    }));
  });

  it("creates a label-free freeze bound to exact candidate order and runner revisions", () => {
    const pool = createKnowledgeSemanticGroundingCandidatePool();
    const candidates = createKnowledgeSemanticGroundingCandidates();
    const manifest = createKnowledgeSemanticCandidateFreezeManifest({ candidates, pool });

    expect(assertKnowledgeSemanticCandidateFreezeManifest({ candidates, manifest, pool }))
      .toEqual(manifest);
    expect(manifest).toMatchObject({
      aggregateOnly: true,
      artifactType: "knowledge_semantic_candidate_freeze",
      artifactVersion: "knowledge-semantic-candidate-freeze-v1",
      evaluationContract: {
        version: "knowledge-semantic-evaluation-contract-v2"
      },
      labelsIncluded: false,
      releaseMetrics: {
        gates: {
          citationPrecisionMinimum: 0.95,
          unsupportedSourceDerivedRateMaximum: 0.02
        },
        sampleMinimums: {
          claimScope: 30,
          sliceLanguage: 15
        },
        version: "knowledge-semantic-grounding-release-metrics-v1"
      },
      thresholdSchedule: [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]
    });
    expect(manifest.candidates.map((candidate) => candidate.id)).toEqual([
      "current_structural_fence_v4",
      "local_multilingual_nli_v1",
      "system_model_semantic_v1",
      "hybrid_semantic_v1"
    ]);
    expect(Object.values(manifest.evaluationContract).filter((value) =>
      typeof value === "string" && value !== manifest.evaluationContract.version)
      .every((value) => /^[a-f0-9]{64}$/u.test(value))).toBe(true);
    expect(manifest.candidates[0]).toMatchObject({
      implementation: {
        executorImplementationSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        protocolSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        responseSchemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        version: "knowledge-semantic-executor-contract-v1"
      }
    });
    expect(JSON.stringify(manifest)).not.toMatch(/"(?:answer|claim|evidence|labels|query|text)"/u);
  });

  it("rejects evaluator contract tampering even when the outer artifact is rehashed", () => {
    const pool = createKnowledgeSemanticGroundingCandidatePool();
    const candidates = createKnowledgeSemanticGroundingCandidates();
    const manifest = createKnowledgeSemanticCandidateFreezeManifest({ candidates, pool });
    const evaluationBody = {
      ...manifest.evaluationContract,
      gateContractSha256: "f".repeat(64)
    };
    const { digest: _oldEvaluationDigest, ...evaluationWithoutDigest } = evaluationBody;
    const evaluationContract = {
      ...evaluationWithoutDigest,
      digest: canonicalSha256(evaluationWithoutDigest)
    };
    const candidateSetBody = {
      candidates: manifest.candidates,
      corpusSha256: manifest.candidateSet.corpusSha256,
      evaluationContractSha256: evaluationContract.digest,
      poolSha256: manifest.candidateSet.poolSha256,
      thresholdContractVersion: manifest.candidateSet.thresholdContractVersion,
      thresholdScheduleSha256: manifest.candidateSet.thresholdScheduleSha256,
      version: manifest.candidateSet.version
    };
    const candidateSet = {
      ...manifest.candidateSet,
      digest: canonicalSha256(candidateSetBody),
      evaluationContractSha256: evaluationContract.digest
    };
    const { manifestSha256: _oldManifestDigest, ...manifestBody } = manifest;
    const tamperedBody = { ...manifestBody, candidateSet, evaluationContract };
    const tampered = { ...tamperedBody, manifestSha256: canonicalSha256(tamperedBody) };

    expect(() => assertKnowledgeSemanticCandidateFreezeManifest({
      candidates,
      manifest: tampered,
      pool
    })).toThrow("knowledge_semantic_freeze_manifest_implementation_mismatch");
  });

  it("rejects release-metric gate drift even when every enclosing digest is rehashed", () => {
    const pool = createKnowledgeSemanticGroundingCandidatePool();
    const candidates = createKnowledgeSemanticGroundingCandidates();
    const manifest = createKnowledgeSemanticCandidateFreezeManifest({ candidates, pool });
    const releaseMetrics = {
      ...manifest.releaseMetrics,
      gates: {
        ...manifest.releaseMetrics.gates,
        citationPrecisionMinimum: 0.5
      }
    };
    const { manifestSha256: _manifestSha256, ...body } = manifest;
    const tamperedBody = {
      ...body,
      releaseMetrics,
      releaseMetricsSha256: canonicalSha256(releaseMetrics)
    };

    expect(() => assertKnowledgeSemanticCandidateFreezeManifest({
      candidates,
      manifest: {
        ...tamperedBody,
        manifestSha256: canonicalSha256(tamperedBody)
      },
      pool
    })).toThrow("knowledge_semantic_freeze_manifest_invalid");
  });

  it("detects executable and declared protocol drift under an unchanged identity", () => {
    const pool = createKnowledgeSemanticGroundingCandidatePool();
    const local = createKnowledgeSemanticGroundingCandidates()[0]!;
    if (local.availability !== "available") throw new Error("structural_missing");
    const candidates = createKnowledgeSemanticGroundingCandidates({ local: local.executor });
    const manifest = createKnowledgeSemanticCandidateFreezeManifest({ candidates, pool });
    const behaviorDrift = Object.freeze({
      ...local.executor,
      async validate(input: Parameters<typeof local.executor.validate>[0]) {
        return local.executor.validate(input);
      }
    });
    expect(() => assertKnowledgeSemanticCandidateFreezeManifest({
      candidates: createKnowledgeSemanticGroundingCandidates({ local: behaviorDrift }),
      manifest,
      pool
    })).toThrow("knowledge_semantic_freeze_manifest_candidate_mismatch");

    const protocolDrift = Object.freeze({
      ...local.executor,
      contract: Object.freeze({
        ...local.executor.contract!,
        protocol: Object.freeze({ execution: "changed_without_revision" })
      })
    });
    expect(() => assertKnowledgeSemanticCandidateFreezeManifest({
      candidates: createKnowledgeSemanticGroundingCandidates({ local: protocolDrift }),
      manifest,
      pool
    })).toThrow("knowledge_semantic_freeze_manifest_candidate_mismatch");
    expect(createKnowledgeSemanticEvaluationContractBinding().digest)
      .toBe(manifest.evaluationContract.digest);
  });

  it("rejects manifest tampering, candidate reordering, and runner revision drift", () => {
    const pool = createKnowledgeSemanticGroundingCandidatePool();
    const candidates = createKnowledgeSemanticGroundingCandidates();
    const manifest = createKnowledgeSemanticCandidateFreezeManifest({ candidates, pool });
    const tampered = {
      ...manifest,
      candidateSet: { ...manifest.candidateSet, digest: "f".repeat(64) }
    };
    expect(() => assertKnowledgeSemanticCandidateFreezeManifest({
      candidates,
      manifest: tampered,
      pool
    })).toThrow("knowledge_semantic_freeze_manifest_digest_mismatch");

    const reordered = [candidates[1]!, candidates[0]!, candidates[2]!, candidates[3]!];
    expect(() => assertKnowledgeSemanticCandidateFreezeManifest({
      candidates: reordered,
      manifest,
      pool
    })).toThrow("knowledge_semantic_freeze_manifest_candidate_mismatch");

    const structural = candidates[0]!;
    if (structural.availability !== "available") throw new Error("structural_missing");
    const changedExecutor = Object.freeze({
      ...structural.executor,
      identity: Object.freeze({
        ...structural.executor.identity,
        revision: "ground-knowledge-answer-v4-revision-drift"
      })
    });
    const revisionDrift = createKnowledgeSemanticGroundingCandidates({ local: changedExecutor });
    expect(() => assertKnowledgeSemanticCandidateFreezeManifest({
      candidates: revisionDrift,
      manifest,
      pool
    })).toThrow("knowledge_semantic_freeze_manifest_candidate_mismatch");
  });

  it("rejects cross-neighborhood attribution and non-probability scores", () => {
    const entry = createKnowledgeSemanticGroundingCandidatePool().entries[0]!;
    const base = {
      attributableHandles: entry.input.citationHandles,
      costMicros: 0,
      decisionScores: {
        contradicted: 0,
        supported: 1,
        uncertain: 0,
        unsupported: 0
      },
      inputTokens: null,
      reasonFamily: "entailed" as const,
      usage: {
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        providerRequestCount: 0,
        reasoningTokens: 0,
        status: "not_used" as const,
        totalTokens: 0
      }
    };

    expect(() => assertKnowledgeSemanticCandidateResult(entry.input, base)).not.toThrow();
    expect(() => assertKnowledgeSemanticCandidateResult(entry.input, {
      ...base,
      attributableHandles: ["K999"]
    })).toThrow("knowledge_semantic_candidate_result_invalid");
    expect(() => assertKnowledgeSemanticCandidateResult(entry.input, {
      ...base,
      decisionScores: { ...base.decisionScores, supported: 0.8 }
    })).toThrow("knowledge_semantic_candidate_result_invalid");
  });
});

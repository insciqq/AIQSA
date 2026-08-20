import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { KnowledgeSemanticGroundingDecision } from "../../lib/server/knowledge/semanticGrounding";
import {
  assertKnowledgeSemanticCalibrationFreeze,
  assertKnowledgeSemanticCandidateBenchmarkSelectionEvidence,
  assertKnowledgeSemanticCandidateBenchmarkContract,
  assertKnowledgeSemanticFinalArtifactFreezeChain,
  runKnowledgeSemanticFinalPredictionFreeze,
  runKnowledgeSemanticCalibrationFreeze,
  runKnowledgeSemanticCandidateBenchmark
} from "./semanticGroundingBenchmark";
import {
  createKnowledgeSemanticCandidateFreezeManifest,
  createKnowledgeSemanticGroundingCandidatePool,
  createKnowledgeSemanticGroundingCandidates,
  type KnowledgeSemanticCandidateExecutor,
  type KnowledgeSemanticCandidateInput
} from "./semanticGroundingCandidates";
import { verifyKnowledgeSemanticArithmeticBinding } from
  "./semanticGroundingArithmeticBinding";
import type {
  KnowledgeSemanticGroundingImportedReviewEvidence
} from "./semanticGroundingReview";
import { KNOWLEDGE_H0_ANNOTATION_GUIDE } from "./h0AnnotationGuide";
import { knowledgeSemanticGroundingFixtures } from "./semanticGroundingFixtures";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function emptyConfusionMatrix() {
  return {
    contradicted: { contradicted: 0, supported: 0, uncertain: 0, unsupported: 0 },
    supported: { contradicted: 0, supported: 0, uncertain: 0, unsupported: 0 },
    uncertain: { contradicted: 0, supported: 0, uncertain: 0, unsupported: 0 },
    unsupported: { contradicted: 0, supported: 0, uncertain: 0, unsupported: 0 }
  } as const;
}

/** Test-only plumbing evidence reuses the existing generated labels. It is not
 * written as a review artifact and cannot satisfy the real human gate. */
function testOnlyImportedEvidence(
  reviewScope: "calibration" | "final" = "final",
  evaluationBindings: KnowledgeSemanticGroundingImportedReviewEvidence["evaluationBindings"] =
    reviewScope === "calibration"
      ? {
          calibrationFreezeManifestSha256: null,
          candidateFreezeManifestSha256: "a".repeat(64),
          finalPredictionFreezeManifestSha256: null
        }
      : {
          calibrationFreezeManifestSha256: "b".repeat(64),
          candidateFreezeManifestSha256: "a".repeat(64),
          finalPredictionFreezeManifestSha256: "c".repeat(64)
        }
): KnowledgeSemanticGroundingImportedReviewEvidence {
  const pool = createKnowledgeSemanticGroundingCandidatePool();
  const fixtures = new Map(knowledgeSemanticGroundingFixtures.map((fixture) =>
    [fixture.id, fixture] as const));
  const labels = pool.entries.filter((entry) => reviewScope === "calibration"
    ? entry.split === "calibration"
    : entry.split !== "calibration").map((entry) => {
    const fixture = fixtures.get(entry.fixtureId)!;
    const label = fixture.labels.find((candidate) => candidate.claimOrdinal === entry.ordinal)!;
    return Object.freeze({
      attributableHandles: label.attributableHandles,
      claimOrdinal: entry.ordinal,
      claimSha256: entry.claimSha256,
      decision: label.decision,
      fixtureId: entry.fixtureId,
      language: entry.language,
      neighborhoodSha256: entry.neighborhoodSha256,
      split: entry.split
    });
  });
  return Object.freeze({
    adjudicationComplete: true as const,
    adjudicationSha256: "3".repeat(64),
    annotationGuideVersion: KNOWLEDGE_H0_ANNOTATION_GUIDE.version,
    corpusSha256: pool.corpusSha256,
    evaluationBindings: Object.freeze({ ...evaluationBindings }),
    disagreement: Object.freeze({
      attributionDisagreementCount: 0,
      adjudicationRate: 0,
      categoryCounts: Object.freeze({
        citation_binding: 0,
        claim_segmentation: 0,
        materiality: 0,
        support_label: 0,
        temporal_context: 0
      }),
      decisionConfusionMatrix: emptyConfusionMatrix(),
      decisionDisagreementCount: 0,
      exactAgreementCount: labels.length,
      labelDistribution: Object.freeze({
        adjudicated: Object.freeze({ contradicted: 0, supported: labels.filter((label) =>
          label.decision === "supported").length, uncertain: 0, unsupported: 0 }),
        reviewerA: Object.freeze({ contradicted: 0, supported: labels.filter((label) =>
          label.decision === "supported").length, uncertain: 0, unsupported: 0 }),
        reviewerB: Object.freeze({ contradicted: 0, supported: labels.filter((label) =>
          label.decision === "supported").length, uncertain: 0, unsupported: 0 })
      }),
      rawExactAgreement: 1,
      reviewedClaimCount: labels.length
    }),
    independentAnnotatorCount: 2 as const,
    labelProvenance: "two_external_humans_adjudicated" as const,
    provenanceVerification: "self_attested_unverified" as const,
    labels: Object.freeze(labels),
    mappingSha256: "1".repeat(64),
    packetSha256: "2".repeat(64),
    poolSha256: pool.poolSha256,
    reviewerSubmissionSha256s: Object.freeze([
      "4".repeat(64),
      "5".repeat(64)
    ] as const),
    reviewScope,
    unresolvedMaterialDisagreements: 0 as const
  });
}

function decisionScores(decision: KnowledgeSemanticGroundingDecision) {
  return Object.freeze({
    contradicted: decision === "contradicted" ? 0.8 : 0.06666666666666667,
    supported: decision === "supported" ? 0.8 : 0.06666666666666667,
    uncertain: decision === "uncertain" ? 0.8 : 0.06666666666666667,
    unsupported: decision === "unsupported" ? 0.8 : 0.06666666666666667
  });
}

function oneHotDecisionScores(decision: KnowledgeSemanticGroundingDecision) {
  return Object.freeze({
    contradicted: Number(decision === "contradicted"),
    supported: Number(decision === "supported"),
    uncertain: Number(decision === "uncertain"),
    unsupported: Number(decision === "unsupported")
  });
}

function candidateInputKey(input: KnowledgeSemanticCandidateInput): string {
  return JSON.stringify(input);
}

function testOnlyBindingsByVisibleInput() {
  const pool = createKnowledgeSemanticGroundingCandidatePool();
  const fixtures = new Map(knowledgeSemanticGroundingFixtures.map((fixture) =>
    [fixture.id, fixture] as const));
  const bindings = new Map(pool.entries.map((entry) => [
    candidateInputKey(entry.input),
    Object.freeze({
      label: fixtures.get(entry.fixtureId)!.labels.find((label) =>
        label.claimOrdinal === entry.ordinal)!,
      split: entry.split
    })
  ] as const));
  if (bindings.size !== pool.entries.length) {
    throw new Error("test_only_candidate_input_collision");
  }
  return bindings;
}

function testOnlyOracleExecutor(): KnowledgeSemanticCandidateExecutor {
  const bindings = testOnlyBindingsByVisibleInput();
  return Object.freeze({
    identity: Object.freeze({
      authorization: "evaluation_only" as const,
      backend: "test-double",
      egress: "none" as const,
      executionClass: "test_double" as const,
      hardware: "cpu" as const,
      modelId: "semantic-oracle-test-only",
      profile: "semantic-oracle-test-only",
      provider: "local",
      resources: Object.freeze({
        cpuLogicalCores: 1,
        gpuDevice: null,
        scope: "isolated_runner" as const
      }),
      revision: "test-only",
      version: 1
    }),
    async validate(input) {
      const label = bindings.get(candidateInputKey(input))!.label;
      const selectedDecision = label.decision;
      return Object.freeze({
        attributableHandles: label.attributableHandles,
        costMicros: 0,
        decisionScores: decisionScores(selectedDecision),
        inputTokens: 10,
        reasonFamily: selectedDecision === "contradicted"
          ? "same_context_conflict" as const
          : selectedDecision === "unsupported"
            ? "not_supported" as const
            : selectedDecision === "uncertain"
              ? "insufficient_context" as const
              : "entailed" as const,
        resourceUsage: Object.freeze({
          peakGpuMemoryBytes: null,
          peakRssBytes: 100_000_000
        }),
        usage: Object.freeze({
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          inputTokens: 10,
          outputTokens: 1,
          providerRequestCount: 1,
          reasoningTokens: 0,
          status: "measured" as const,
          totalTokens: 11
        })
      });
    }
  });
}

function testOnlyArithmeticAdversary(): KnowledgeSemanticCandidateExecutor {
  const base = testOnlyOracleExecutor();
  return Object.freeze({
    ...base,
    identity: Object.freeze({
      ...base.identity,
      modelId: "semantic-arithmetic-adversary-test-only",
      profile: "semantic-arithmetic-adversary-test-only",
      revision: "arithmetic-adversary-test-only"
    }),
    async validate(input: KnowledgeSemanticCandidateInput) {
      const result = await base.validate(input);
      return input.type === "derived_arithmetic"
        ? Object.freeze({
            ...result,
            attributableHandles: Object.freeze([]),
            decisionScores: decisionScores("uncertain"),
            reasonFamily: "insufficient_context" as const
          })
        : result;
    }
  });
}

function wrongDecision(
  decision: KnowledgeSemanticGroundingDecision
): KnowledgeSemanticGroundingDecision {
  return decision === "supported" ? "unsupported" : "supported";
}

function testOnlySplitBiasedExecutor(input: Readonly<{
  correctOnHeldOut: boolean;
  identity: string;
}>): KnowledgeSemanticCandidateExecutor {
  const bindings = testOnlyBindingsByVisibleInput();
  return Object.freeze({
    identity: Object.freeze({
      authorization: "evaluation_only" as const,
      backend: "test-split-bias",
      egress: "none" as const,
      executionClass: "real_model" as const,
      hardware: "cpu" as const,
      modelId: `semantic-${input.identity}`,
      profile: `semantic-${input.identity}`,
      provider: "local",
      resources: Object.freeze({
        cpuLogicalCores: 1,
        gpuDevice: null,
        scope: "isolated_runner" as const
      }),
      revision: `test-${input.identity}`,
      version: 1
    }),
    async validate(candidateInput) {
      const binding = bindings.get(candidateInputKey(candidateInput))!;
      const label = binding.label;
      const heldOut = binding.split === "held_out";
      const calibration = binding.split === "calibration";
      const correct = calibration || heldOut === input.correctOnHeldOut;
      const decision = correct ? label.decision : wrongDecision(label.decision);
      return Object.freeze({
        attributableHandles: label.attributableHandles,
        costMicros: 0,
        decisionScores: decisionScores(decision),
        inputTokens: 1,
        reasonFamily: decision === "contradicted"
          ? "same_context_conflict" as const
          : decision === "unsupported"
            ? "not_supported" as const
            : decision === "uncertain"
              ? "insufficient_context" as const
              : "entailed" as const,
        resourceUsage: Object.freeze({
          peakGpuMemoryBytes: null,
          peakRssBytes: 1
        }),
        usage: Object.freeze({
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          inputTokens: 1,
          outputTokens: 1,
          providerRequestCount: 1,
          reasoningTokens: 0,
          status: "measured" as const,
          totalTokens: 2
        })
      });
    }
  });
}

async function testOnlyFrozenCalibration(
  local: KnowledgeSemanticCandidateExecutor
) {
  const pool = createKnowledgeSemanticGroundingCandidatePool();
  const candidates = createKnowledgeSemanticGroundingCandidates({ local });
  const candidateFreeze = createKnowledgeSemanticCandidateFreezeManifest({ candidates, pool });
  const labels = testOnlyImportedEvidence("calibration", {
    calibrationFreezeManifestSha256: null,
    candidateFreezeManifestSha256: candidateFreeze.manifestSha256,
    finalPredictionFreezeManifestSha256: null
  });
  const calibrationFreeze = await runKnowledgeSemanticCalibrationFreeze({
    candidateFreezeManifestSha256: candidateFreeze.manifestSha256,
    frozenCandidateSetDigest: candidateFreeze.candidateSet.digest,
    frozenThresholdScheduleSha256: candidateFreeze.candidateSet.thresholdScheduleSha256,
    labels,
    local
  });
  return { calibrationFreeze, candidateFreeze, candidates, pool };
}

function testOnlyFinalLabels(input: Readonly<{
  calibrationFreeze: Awaited<ReturnType<typeof runKnowledgeSemanticCalibrationFreeze>>;
  candidateFreeze: ReturnType<typeof createKnowledgeSemanticCandidateFreezeManifest>;
  finalPredictionFreeze: Awaited<ReturnType<typeof runKnowledgeSemanticFinalPredictionFreeze>>;
}>): KnowledgeSemanticGroundingImportedReviewEvidence {
  return testOnlyImportedEvidence("final", {
    calibrationFreezeManifestSha256: input.calibrationFreeze.manifestSha256,
    candidateFreezeManifestSha256: input.candidateFreeze.manifestSha256,
    finalPredictionFreezeManifestSha256: input.finalPredictionFreeze.manifestSha256
  });
}

async function testOnlyFrozenPredictions(input: Readonly<{
  calibrationFreeze: Awaited<ReturnType<typeof runKnowledgeSemanticCalibrationFreeze>>;
  candidateFreeze: ReturnType<typeof createKnowledgeSemanticCandidateFreezeManifest>;
  local?: KnowledgeSemanticCandidateExecutor;
  systemModel?: KnowledgeSemanticCandidateExecutor;
}>) {
  return runKnowledgeSemanticFinalPredictionFreeze({
    calibrationFreeze: input.calibrationFreeze,
    candidateFreezeManifest: input.candidateFreeze,
    candidateFreezeManifestSha256: input.candidateFreeze.manifestSha256,
    ...(input.local ? { local: input.local } : {}),
    ...(input.systemModel ? { systemModel: input.systemModel } : {})
  });
}

describe("Knowledge semantic candidate benchmark", () => {
  it("runs the structural baseline while keeping optional and human lanes unavailable", async () => {
    const report = await assertKnowledgeSemanticCandidateBenchmarkContract();

    expect(report).toMatchObject({
      aggregateOnly: true,
      blindedExecution: {
        finalPredictionsFrozenBeforeBlindLabels: false,
        releaseEvidenceEligible: false
      },
      blockingEligible: false,
      candidateSet: {
        frozen: false,
        thresholdContractFrozen: false,
        thresholdContractVersion: "knowledge-semantic-threshold-v1",
        version: "knowledge-semantic-candidates-v1"
      },
      contractValid: true,
      corpus: {
        arithmetic: {
          contradictedByRecomputation: 33,
          failed: 0,
          passed: true,
          productionVerifierUsed: true,
          receiptCount: 70,
          verified: 37
        },
        blindedReviewClaims: 256,
        blindedReviewSplitAvailable: true,
        calibrationClaims: 92,
        developmentClaims: 36,
        fixtureCount: 364,
        familyLeakage: false,
        heldOutClaims: 297,
        labelsExcludedFromCandidateInput: true,
        releaseEvidence: {
          automatedGateEligible: true,
          independentReviewGateEligible: true,
          releaseGateEligible: true,
          splitIntegrity: {
            normalizedTemplateFamilyCollisionCount: 0,
            normalizedTemplateFamilySplitDisjoint: true
          }
        },
        samePoolForEveryCandidate: true
      },
      humanReview: {
        adjudicationComplete: false,
        independentAnnotatorCount: 0,
        labelsStatus: "not_imported"
      },
      releaseGatePassed: false,
      selection: {
        reasonCodes: [
          "independent_semantic_labels_not_collected",
          "adjudication_not_completed",
          "candidate_set_not_frozen",
          "threshold_contract_not_frozen"
        ],
        selectedCandidateId: null,
        selectionEligible: false
      },
      semanticProof: false
    });
    expect(report.candidates.map((candidate) => [
      candidate.identity.id,
      candidate.executionStatus
    ])).toEqual([
      ["current_structural_fence_v4", "complete"],
      ["local_multilingual_nli_v1", "unavailable"],
      ["system_model_semantic_v1", "unavailable"],
      ["hybrid_semantic_v1", "unavailable"]
    ]);
    expect(report.candidates[0]).toMatchObject({
      cost: { status: "measured", totalMicros: 0 },
      egress: { disclosedInputBytes: 0, mode: "none" },
      outage: { fallbackReplay: "not_applicable", structuralFenceRemainsActive: true },
      recovery: { complexity: "pure_recompute" }
    });
    expect(JSON.stringify(report)).not.toMatch(
      /Atlas|Береста|SAFE-2718|held-en|held-ru|\[K1\]/u
    );
  });

  it("consumes a calibration-only freeze without recomputing calibration during final scoring", async () => {
    const local = testOnlyOracleExecutor();
    const frozen = await testOnlyFrozenCalibration(local);
    const finalPredictionFreeze = await testOnlyFrozenPredictions({ ...frozen, local });
    const labels = testOnlyFinalLabels({ ...frozen, finalPredictionFreeze });
    const report = await runKnowledgeSemanticCandidateBenchmark({
      calibrationFreeze: frozen.calibrationFreeze,
      candidateFreezeManifest: frozen.candidateFreeze,
      candidateFreezeManifestSha256: frozen.candidateFreeze.manifestSha256,
      finalPredictionFreeze,
      frozenCandidateSetDigest: frozen.candidateFreeze.candidateSet.digest,
      frozenThresholdScheduleSha256:
        frozen.candidateFreeze.candidateSet.thresholdScheduleSha256,
      labels,
      local
    });
    const localCandidate = report.candidates.find((candidate) =>
      candidate.identity.id === "local_multilingual_nli_v1");
    if (!localCandidate || localCandidate.executionStatus !== "complete" ||
      localCandidate.quality.status !== "measured_from_imported_human_labels") {
      throw new Error("expected_measured_local_candidate");
    }

    expect(localCandidate.quality).toMatchObject({
      calibration: {
        evaluatedClaims: 92,
        groundedAccuracy: 1,
        objective: "grounded_accuracy",
        selectedConfidenceMinimum: 0.8,
        split: "calibration",
        thresholdFrozenBeforeHeldOut: true
      },
      gatesPassed: false,
      heldOut: {
        attributableAccuracy: expect.any(Number),
        decisionAccuracy: expect.any(Number),
        groundedAccuracy: expect.any(Number),
        temporalFalseBlockers: 0,
        versionFalseBlockers: 0
      },
      scope: "blinded_review_only_after_calibration_threshold_freeze"
    });
    expect(localCandidate.quality.heldOut.byLanguage.en.count).toBeGreaterThan(0);
    expect(localCandidate.quality.heldOut.byLanguage.ru.count).toBeGreaterThan(0);
    expect(localCandidate.quality.blindedReview.overall).toMatchObject({ accuracy: 1, count: 256 });
    expect(Object.keys(localCandidate.quality.blindedReview.bySlice)).toHaveLength(17);
    expect(localCandidate.quality.heldOut.bySlice.contradiction.confusionMatrix)
      .toHaveProperty("contradicted.contradicted");
    expect(report.selection).toEqual({
      reasonCodes: [
        "human_provenance_not_verified",
        "no_candidate_passed_held_out_quality_gates"
      ],
      selectedCandidateId: null,
      selectionEligible: false
    });
    expect(report.semanticProof).toBe(false);
    expect(report.blockingEligible).toBe(false);
    expect(frozen.calibrationFreeze.candidates.find((candidate) =>
      candidate.candidateId === "local_multilingual_nli_v1")).toMatchObject({
      executionStatus: "complete",
      outputs: expect.arrayContaining([expect.objectContaining({
        claimSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        decisionScores: expect.objectContaining({ supported: expect.any(Number) })
      })])
    });
  });

  it("rejects calibration freeze tampering and runner revision drift", async () => {
    const local = testOnlyOracleExecutor();
    const frozen = await testOnlyFrozenCalibration(local);
    const calibrationLabels = testOnlyImportedEvidence("calibration", {
      calibrationFreezeManifestSha256: null,
      candidateFreezeManifestSha256: frozen.candidateFreeze.manifestSha256,
      finalPredictionFreezeManifestSha256: null
    });
    expect(() => assertKnowledgeSemanticCalibrationFreeze({
      candidateFreezeManifestSha256: frozen.candidateFreeze.manifestSha256,
      candidates: frozen.candidates,
      labels: new Map(calibrationLabels.labels.map((label) =>
        [`${label.fixtureId}:${label.claimOrdinal}`, label] as const)),
      manifest: {
        ...frozen.calibrationFreeze,
        manifestSha256: "f".repeat(64)
      },
      pool: frozen.pool
    })).toThrow("knowledge_semantic_calibration_freeze_digest_mismatch");

    const drifted = Object.freeze({
      ...local,
      identity: Object.freeze({ ...local.identity, revision: "drifted-revision" })
    });
    await expect(runKnowledgeSemanticCandidateBenchmark({
      calibrationFreeze: frozen.calibrationFreeze,
      candidateFreezeManifestSha256: frozen.candidateFreeze.manifestSha256,
      frozenCandidateSetDigest: frozen.candidateFreeze.candidateSet.digest,
      frozenThresholdScheduleSha256:
        frozen.candidateFreeze.candidateSet.thresholdScheduleSha256,
      local: drifted
    })).rejects.toThrow("knowledge_semantic_calibration_freeze_binding_mismatch");
  });

  it("selects by held-out only when development and blind rankings disagree", async () => {
    const local = testOnlySplitBiasedExecutor({
      correctOnHeldOut: true,
      identity: "held-winner"
    });
    const systemModel = testOnlySplitBiasedExecutor({
      correctOnHeldOut: false,
      identity: "blind-winner"
    });
    const pool = createKnowledgeSemanticGroundingCandidatePool();
    const candidates = createKnowledgeSemanticGroundingCandidates({ local, systemModel });
    const candidateFreeze = createKnowledgeSemanticCandidateFreezeManifest({ candidates, pool });
    const calibrationLabels = testOnlyImportedEvidence("calibration", {
      calibrationFreezeManifestSha256: null,
      candidateFreezeManifestSha256: candidateFreeze.manifestSha256,
      finalPredictionFreezeManifestSha256: null
    });
    const calibrationFreeze = await runKnowledgeSemanticCalibrationFreeze({
      candidateFreezeManifestSha256: candidateFreeze.manifestSha256,
      frozenCandidateSetDigest: candidateFreeze.candidateSet.digest,
      frozenThresholdScheduleSha256: candidateFreeze.candidateSet.thresholdScheduleSha256,
      labels: calibrationLabels,
      local,
      systemModel
    });
    const finalPredictionFreeze = await testOnlyFrozenPredictions({
      calibrationFreeze,
      candidateFreeze,
      local,
      systemModel
    });
    const originalLabels = testOnlyFinalLabels({
      calibrationFreeze,
      candidateFreeze,
      finalPredictionFreeze
    });
    const run = (labels: KnowledgeSemanticGroundingImportedReviewEvidence) =>
      runKnowledgeSemanticCandidateBenchmark({
        calibrationFreeze,
        candidateFreezeManifest: candidateFreeze,
        candidateFreezeManifestSha256: candidateFreeze.manifestSha256,
        finalPredictionFreeze,
        frozenCandidateSetDigest: candidateFreeze.candidateSet.digest,
        frozenThresholdScheduleSha256: candidateFreeze.candidateSet.thresholdScheduleSha256,
        labels,
        local,
        systemModel
      });
    const original = await run(originalLabels);
    const localReport = original.candidates.find((candidate) =>
      candidate.identity.id === "local_multilingual_nli_v1");
    const systemReport = original.candidates.find((candidate) =>
      candidate.identity.id === "system_model_semantic_v1");
    expect(localReport).toMatchObject({
      quality: { blindedReviewAcceptancePassed: false, heldOutGatesPassed: true }
    });
    expect(systemReport).toMatchObject({
      quality: {
        blindedReviewAcceptancePassed: false,
        blindedReviewQualityGatesPassed: true,
        heldOutGatesPassed: false
      }
    });
    expect(original.selection.selectedCandidateId).toBe("local_multilingual_nli_v1");
    if (!localReport || localReport.executionStatus !== "complete" ||
      localReport.quality.status !== "measured_from_imported_human_labels" ||
      !systemReport || systemReport.executionStatus !== "complete" ||
      systemReport.quality.status !== "measured_from_imported_human_labels") {
      throw new Error("expected_split_biased_quality_reports");
    }
    const forgedCandidates = original.candidates.map((candidate) =>
      candidate.identity.id === "system_model_semantic_v1"
        ? Object.freeze({
            ...systemReport,
            quality: Object.freeze({
              ...systemReport.quality,
              blindedReviewAcceptancePassed: true,
              gatesPassed: true,
              heldOutGatesPassed: true,
              provenanceVerification: "verified_external_humans" as const
            })
          })
        : candidate);
    const forgedReport = Object.freeze({
      ...original,
      blindedExecution: Object.freeze({
        ...original.blindedExecution,
        releaseEvidenceEligible: true
      }),
      candidates: Object.freeze(forgedCandidates),
      selection: Object.freeze({
        reasonCodes: Object.freeze([]),
        selectedCandidateId: "system_model_semantic_v1",
        selectionEligible: true
      }),
      semanticProof: true
    }) as typeof original;
    expect(canonicalSha256(forgedReport)).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => assertKnowledgeSemanticCandidateBenchmarkSelectionEvidence({
      calibrationFreeze,
      candidateFreeze,
      finalPredictionFreeze,
      humanTrust: original.humanReview.trust,
      labels: originalLabels,
      pool,
      report: forgedReport
    })).toThrow("knowledge_semantic_candidate_benchmark_selection_evidence_mismatch");

    const changedBlindLabels = Object.freeze({
      ...originalLabels,
      labels: Object.freeze(originalLabels.labels.map((label) => label.split === "blinded_review"
        ? Object.freeze({ ...label, decision: wrongDecision(label.decision) })
        : label))
    });
    const blindMutated = await run(changedBlindLabels);
    expect(blindMutated.selection.selectedCandidateId).toBe("local_multilingual_nli_v1");
    const mutatedLocal = blindMutated.candidates.find((candidate) =>
      candidate.identity.id === "local_multilingual_nli_v1");
    if (!mutatedLocal || mutatedLocal.executionStatus !== "complete" ||
      mutatedLocal.quality.status !== "measured_from_imported_human_labels") {
      throw new Error("expected_mutated_local_quality");
    }
    expect(mutatedLocal.quality.blindedReview.groundedAccuracy).toBeLessThan(1);
    expect(mutatedLocal.quality.heldOutGatesPassed).toBe(true);
  });

  it("rejects imported review evidence that is not bound to the exact frozen pool", async () => {
    await expect(runKnowledgeSemanticCandidateBenchmark({
      labels: {
        ...testOnlyImportedEvidence(),
        poolSha256: "f".repeat(64)
      }
    })).rejects.toThrow("knowledge_semantic_review_pool_mismatch");
  });

  it("replaces arithmetic model guesses with exact receipts before freezing outputs", async () => {
    const local = testOnlyArithmeticAdversary();
    const frozen = await testOnlyFrozenCalibration(local);
    const finalPredictionFreeze = await testOnlyFrozenPredictions({ ...frozen, local });
    const entries = frozen.pool.entries.filter((entry) => entry.split !== "calibration");
    const arithmeticEntries = entries.filter((entry) => entry.arithmetic !== null);
    const localFreeze = finalPredictionFreeze.candidates.find((candidate) =>
      candidate.candidateId === "local_multilingual_nli_v1");
    if (!localFreeze || localFreeze.executionStatus !== "complete") {
      throw new Error("expected_complete_arithmetic_adversary_freeze");
    }

    expect(arithmeticEntries).toHaveLength(70);
    for (const entry of arithmeticEntries) {
      const output = localFreeze.outputs[entries.indexOf(entry)]!;
      const verification = verifyKnowledgeSemanticArithmeticBinding({
        binding: entry.arithmetic!,
        claimSha256: entry.claimSha256,
        evidencePackage: entry.evidencePackage
      });
      const expectedDecision = verification.code === "verified"
        ? "supported"
        : "contradicted";
      expect(output).toMatchObject({
        attributableHandles: [entry.arithmetic!.plan.citationHandle],
        reasonFamily: "deterministic_receipt"
      });
      expect(output.decisionScores).toEqual(oneHotDecisionScores(expectedDecision));
    }
    expect(JSON.stringify(finalPredictionFreeze)).not.toMatch(
      /assertedOutput|operand_001|receiptSha256|specificationSha256/u
    );

    const firstArithmeticIndex = entries.findIndex((entry) => entry.arithmetic !== null);
    const tamperedOutputs = localFreeze.outputs.map((output, index) => index === firstArithmeticIndex
      ? Object.freeze({
          ...output,
          attributableHandles: Object.freeze([]),
          decisionScores: decisionScores("uncertain"),
          reasonFamily: "insufficient_context" as const
        })
      : output);
    const tamperedCandidates = finalPredictionFreeze.candidates.map((candidate) =>
      candidate.candidateId === localFreeze.candidateId
        ? Object.freeze({
            ...localFreeze,
            outputSha256: canonicalSha256(tamperedOutputs),
            outputs: Object.freeze(tamperedOutputs)
          })
        : candidate);
    const { manifestSha256: _ignored, ...body } = finalPredictionFreeze;
    const tamperedBody = { ...body, candidates: Object.freeze(tamperedCandidates) };
    const tampered = Object.freeze({
      ...tamperedBody,
      manifestSha256: canonicalSha256(tamperedBody)
    });
    expect(() => assertKnowledgeSemanticFinalArtifactFreezeChain({
      calibrationFreeze: frozen.calibrationFreeze,
      candidateFreeze: frozen.candidateFreeze,
      finalPredictionFreeze: tampered,
      pool: frozen.pool
    })).toThrow("knowledge_semantic_final_prediction_freeze_output_mismatch");
  });

  it("consumes the label-free artifact without executing a candidate after labels arrive", async () => {
    const base = testOnlyOracleExecutor();
    let calls = 0;
    const local: KnowledgeSemanticCandidateExecutor = Object.freeze({
      ...base,
      async validate(input) {
        calls += 1;
        return base.validate(input);
      }
    });
    const frozen = await testOnlyFrozenCalibration(local);
    const finalPredictionFreeze = await testOnlyFrozenPredictions({
      ...frozen,
      local
    });
    expect(assertKnowledgeSemanticFinalArtifactFreezeChain({
      calibrationFreeze: frozen.calibrationFreeze,
      candidateFreeze: frozen.candidateFreeze,
      finalPredictionFreeze,
      pool: frozen.pool
    }).finalPredictionFreeze).toEqual(finalPredictionFreeze);
    const labels = testOnlyFinalLabels({ ...frozen, finalPredictionFreeze });
    const callsBeforeScoring = calls;
    const report = await runKnowledgeSemanticCandidateBenchmark({
      calibrationFreeze: frozen.calibrationFreeze,
      candidateFreezeManifest: frozen.candidateFreeze,
      candidateFreezeManifestSha256: frozen.candidateFreeze.manifestSha256,
      finalPredictionFreeze,
      frozenCandidateSetDigest: frozen.candidateFreeze.candidateSet.digest,
      frozenThresholdScheduleSha256:
        frozen.candidateFreeze.candidateSet.thresholdScheduleSha256,
      labels,
      local
    });
    expect(calls).toBe(callsBeforeScoring);
    const derived = assertKnowledgeSemanticCandidateBenchmarkSelectionEvidence({
      calibrationFreeze: frozen.calibrationFreeze,
      candidateFreeze: frozen.candidateFreeze,
      finalPredictionFreeze,
      humanTrust: report.humanReview.trust,
      labels,
      pool: frozen.pool,
      report
    });
    expect(derived.selection).toEqual(report.selection);
    expect(calls).toBe(callsBeforeScoring);
    expect(report.blindedExecution).toMatchObject({
      finalPredictionsFrozenBeforeBlindLabels: true,
      reason: "final_predictions_frozen_without_labels"
    });
    await expect(runKnowledgeSemanticCandidateBenchmark({
      calibrationFreeze: frozen.calibrationFreeze,
      candidateFreezeManifest: frozen.candidateFreeze,
      candidateFreezeManifestSha256: frozen.candidateFreeze.manifestSha256,
      finalPredictionFreeze: {
        ...finalPredictionFreeze,
        manifestSha256: "f".repeat(64)
      },
      frozenCandidateSetDigest: frozen.candidateFreeze.candidateSet.digest,
      frozenThresholdScheduleSha256:
        frozen.candidateFreeze.candidateSet.thresholdScheduleSha256,
      labels,
      local
    })).rejects.toThrow("knowledge_semantic_final_prediction_freeze_digest_mismatch");

    const forgedCandidates = finalPredictionFreeze.candidates.map((candidate) =>
      candidate.candidateId === "local_multilingual_nli_v1"
        ? {
            candidateId: candidate.candidateId,
            candidateIdentity: candidate.candidateIdentity,
            executionStatus: "unavailable" as const,
            outputSha256: null,
            outputs: [] as const,
            reason: "local_model_not_configured" as const
          }
        : candidate);
    const { manifestSha256: _manifestSha256, ...manifestBody } = finalPredictionFreeze;
    const forgedBody = { ...manifestBody, candidates: forgedCandidates };
    const forgedFreeze = { ...forgedBody, manifestSha256: canonicalSha256(forgedBody) };
    expect(() => assertKnowledgeSemanticFinalArtifactFreezeChain({
      calibrationFreeze: frozen.calibrationFreeze,
      candidateFreeze: frozen.candidateFreeze,
      finalPredictionFreeze: forgedFreeze,
      pool: frozen.pool
    })).toThrow("knowledge_semantic_final_prediction_freeze_output_mismatch");
    await expect(runKnowledgeSemanticCandidateBenchmark({
      calibrationFreeze: frozen.calibrationFreeze,
      candidateFreezeManifest: frozen.candidateFreeze,
      candidateFreezeManifestSha256: frozen.candidateFreeze.manifestSha256,
      finalPredictionFreeze: forgedFreeze,
      frozenCandidateSetDigest: frozen.candidateFreeze.candidateSet.digest,
      frozenThresholdScheduleSha256:
        frozen.candidateFreeze.candidateSet.thresholdScheduleSha256,
      labels,
      local
    })).rejects.toThrow("knowledge_semantic_final_prediction_freeze_output_mismatch");
    expect(calls).toBe(callsBeforeScoring);
  });
});

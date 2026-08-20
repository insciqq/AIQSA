import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
  type KnowledgeEvidencePackage,
  type KnowledgeEvidencePackageItem
} from "./evidencePackage";
import {
  knowledgeSemanticConfidence,
  segmentKnowledgeSemanticClaims
} from "./semanticGrounding";
import {
  canonicalKnowledgeSemanticShadowDiagnosticV1,
  createKnowledgeSemanticLocalValidatorRequestV1,
  createKnowledgeSemanticShadowContentFreeMetricsV1,
  createKnowledgeSemanticShadowDiagnosticV1,
  createStructuralKnowledgeSemanticShadowDiagnosticV1,
  createUnavailableKnowledgeSemanticShadowDiagnosticV1,
  decodeKnowledgeSemanticShadowContentFreeMetricsV1,
  decodeKnowledgeSemanticShadowDiagnosticV1,
  hashKnowledgeSemanticShadowDiagnosticV1
} from "./semanticShadow";
import { createKnowledgeTableDocumentContext } from "./documentContext";
import type { KnowledgeSemanticValidatorDeploymentV1 } from "./knowledgeProfile";

const semanticDeployment: KnowledgeSemanticValidatorDeploymentV1 = Object.freeze({
  authorization: "profile_authorized",
  calibrationOutputSha256: "d".repeat(64),
  candidateId: "local_multilingual_nli_v1",
  candidateIdentitySha256: "a".repeat(64),
  candidateImplementationSha256: "b".repeat(64),
  egress: "local",
  executionClass: "real_model",
  finalOutputSha256: "e".repeat(64),
  profileId: "local-nli-v1",
  qualityEvidenceSha256: "f".repeat(64),
  recoveryMode: "deterministic_replay",
  selectionFreezeVersion: "knowledge-semantic-selection-freeze-v1",
  selectionManifestSha256: "c".repeat(64),
  semanticProof: true,
  validatorVersion: 4,
  version: 1
});

function item(ordinal: number, excerpt: string): KnowledgeEvidencePackageItem {
  return {
    baseName: "Synthetic semantic corpus",
    contentHash: String(ordinal).repeat(64).slice(0, 64),
    contextBoundaries: {
      expanded: false,
      excerptBytes: Buffer.byteLength(excerpt),
      sourceTextBytes: Buffer.byteLength(excerpt)
    },
    documentId: `semantic-document-${ordinal}`,
    documentVersionId: `semantic-document-version-${ordinal}`,
    excerpt,
    fileName: `semantic-${ordinal}.md`,
    handle: `K${ordinal}`,
    headingPath: ["Synthetic section"],
    id: `semantic-evidence-${ordinal}`,
    knowledgeBaseId: "semantic-base",
    locator: { page: ordinal },
    ordinal,
    passageId: `semantic-passage-${ordinal}`,
    provenance: [],
    sectionId: `semantic-section-${ordinal}`,
    sourceArtifactId: `semantic-artifact-${ordinal}`,
    sourceId: `semantic-source-${ordinal}`,
    sourceName: `Semantic source ${ordinal}`,
    sourceVersionId: `semantic-source-version-${ordinal}`,
    sourceVersionNumber: ordinal,
    state: "available",
    textTruncated: false
  };
}

function evidence(items: readonly KnowledgeEvidencePackageItem[]): KnowledgeEvidencePackage {
  return {
    citationContract: KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
    coverage: {
      expectedPassageCount: null,
      mode: "partial",
      namedTargets: [],
      verified: false
    },
    degradedFlags: [],
    items,
    originalIntent: { intent: "fact_lookup", query: "What does the policy say?" },
    readiness: { excludedResources: 0, readyBases: 1, readySources: items.length },
    runId: "semantic-run",
    scopeSnapshot: { mode: "explicit" },
    sessionId: "semantic-session",
    strategy: "focused",
    version: 2
  };
}

describe("Knowledge semantic shadow diagnostic", () => {
  it("projects only citation-local text to an injected local validator", () => {
    const source = evidence([
      item(1, "The selected policy retains exports for 30 days."),
      item(2, "PRIVATE UNRELATED EVIDENCE MUST NOT CROSS THE BOUNDARY.")
    ]);
    const request = createKnowledgeSemanticLocalValidatorRequestV1({
      answer: "Exports are retained for 30 days [K1].",
      deployment: semanticDeployment,
      evidence: source
    });
    const serialized = JSON.stringify(request);

    expect(request).toMatchObject({
      claims: [{
        citationHandles: ["K1"],
        evidence: [{
          excerpt: "The selected policy retains exports for 30 days.",
          handle: "K1"
        }]
      }],
      validator: semanticDeployment,
      version: 1
    });
    expect(serialized).not.toContain("PRIVATE UNRELATED");
    expect(serialized).not.toContain("semantic-evidence-1");
    expect(serialized).not.toContain("semantic-document-1");
    expect(serialized).not.toContain("semantic-session");
    expect(serialized).not.toContain("semantic-run");
  });

  it("seals a non-blocking, text-free structural baseline", () => {
    const source = evidence([item(1, "Staff may work remotely on Fridays.")]);
    const diagnostic = createStructuralKnowledgeSemanticShadowDiagnosticV1({
      answer: "Staff may work remotely on Fridays [K1]. Uncited claim.",
      evidence: source
    });

    expect(diagnostic).toMatchObject({
      blockingApplied: false,
      executionStatus: "complete",
      failureReasonCode: null,
      validator: {
        egress: "none",
        profileId: "structural-baseline-v1",
        semanticProof: false
      }
    });
    expect(diagnostic.claims.map(({ decision, reasonFamily }) => ({ decision, reasonFamily })))
      .toEqual([
        { decision: "uncertain", reasonFamily: "structural_baseline" },
        { decision: "unsupported", reasonFamily: "no_evidence" }
      ]);
    expect(JSON.stringify(diagnostic)).not.toContain("Staff may work remotely");
    expect(JSON.stringify(diagnostic)).not.toContain("Uncited claim");
    expect(decodeKnowledgeSemanticShadowDiagnosticV1(diagnostic)).toEqual(diagnostic);
    expect(hashKnowledgeSemanticShadowDiagnosticV1(diagnostic)).toBe(diagnostic.receiptHash);
    expect(canonicalKnowledgeSemanticShadowDiagnosticV1(diagnostic)).toContain(diagnostic.receiptHash);
    const metrics = createKnowledgeSemanticShadowContentFreeMetricsV1(diagnostic);
    expect(metrics).toMatchObject({
      blockingApplied: false,
      claimCount: 2,
      confidenceBucketCounts: { high: 1, unavailable: 1 },
      executionStatus: "complete",
      mode: "shadow",
      recommendedActionCounts: { retain: 0, review: 2 }
    });
    expect(decodeKnowledgeSemanticShadowContentFreeMetricsV1(metrics)).toEqual(metrics);
    expect(JSON.stringify(metrics)).not.toContain("semantic-run");
    expect(JSON.stringify(metrics)).not.toContain("semantic-session");
    expect(JSON.stringify(metrics)).not.toContain("K1");
    expect(JSON.stringify(metrics)).not.toContain(diagnostic.answerHash);
    expect(JSON.stringify(metrics)).not.toContain(diagnostic.evidenceReceiptHash);
  });

  it("degrades oversized citation neighborhoods before they can escape receipt bounds", () => {
    const items = Array.from({ length: 1_001 }, (_, index) =>
      item(index + 1, `Evidence ${index + 1}.`));
    const answer = `The sources agree ${items.map(({ handle }) => `[${handle}]`).join(" ")}.`;
    const source = evidence(items);
    const diagnostic = createStructuralKnowledgeSemanticShadowDiagnosticV1({ answer, evidence: source });

    expect(diagnostic).toMatchObject({
      claims: [],
      executionStatus: "unavailable",
      failureReasonCode: "citation_limit_exceeded",
      validator: { semanticProof: false }
    });
    expect(() => createKnowledgeSemanticLocalValidatorRequestV1({
      answer,
      deployment: semanticDeployment,
      evidence: source
    })).toThrow("knowledge_semantic_shadow_citation_limit");
    expect(decodeKnowledgeSemanticShadowDiagnosticV1(diagnostic)).toEqual(diagnostic);
  });

  it("degrades a large but structurally valid receipt before the database size ceiling", () => {
    const items = Array.from({ length: 1_000 }, (_, index) =>
      item(index + 1, `Evidence ${index + 1}.`));
    const citations = items.map(({ handle }) => `[${handle}]`).join(" ");
    const answer = Array.from({ length: 80 }, (_, index) =>
      `Independent statement ${index + 1} cites the same sources ${citations}.`).join(" ");
    const diagnostic = createStructuralKnowledgeSemanticShadowDiagnosticV1({
      answer,
      evidence: evidence(items)
    });

    expect(diagnostic).toMatchObject({
      claims: [],
      executionStatus: "unavailable",
      failureReasonCode: "diagnostic_size_exceeded",
      validator: { semanticProof: false }
    });
    expect(createKnowledgeSemanticShadowContentFreeMetricsV1(diagnostic)).toMatchObject({
      claimCount: 0,
      executionStatus: "unavailable",
      failureReasonCode: "diagnostic_size_exceeded"
    });
  });

  it("binds complete candidate predictions to the exact claim neighborhood", () => {
    const source = evidence([
      item(1, "The 2026 policy requires fourteen days."),
      item(2, "Unrelated source.")
    ]);
    const answer = "Version 2026 requires fourteen days [K1].";
    const [claim] = segmentKnowledgeSemanticClaims({ answer, evidence: source });
    const diagnostic = createKnowledgeSemanticShadowDiagnosticV1({
      answer,
      evidence: source,
      executionStatus: "complete",
      latencyMs: 12.5,
      predictions: [{
        attributableHandles: ["K1"],
        claimOrdinal: 1,
        confidence: 0.93,
        decision: "supported",
        reasonFamily: "entailed",
        validatorProfile: "local-nli-v1",
        validatorVersion: 4,
        version: 1
      }],
      usage: { estimatedCostMicros: 0, requests: 1 },
      validator: {
        egress: "local",
        profileId: "local-nli-v1",
        profileVersion: 4,
        semanticProof: true
      }
    });

    expect(claim?.type).toBe("versioned_fact");
    expect(diagnostic.claims[0]).toMatchObject({
      attributableHandles: ["K1"],
      citationHandles: ["K1"],
      decision: "supported",
      reasonFamily: "entailed"
    });
    expect(diagnostic.summary).toMatchObject({
      attributableClaimCount: 1,
      citationLocalClaimCount: 1,
      claimCount: 1,
      decisionCounts: { supported: 1 }
    });
    expect(knowledgeSemanticConfidence(0.000123)).toBe(0.000123);
    expect(knowledgeSemanticConfidence(1e-7)).toBeNull();
    expect(() => createKnowledgeSemanticShadowDiagnosticV1({
      answer,
      evidence: source,
      executionStatus: "complete",
      predictions: [{
        attributableHandles: ["K1"],
        claimOrdinal: 1,
        confidence: 1e-7,
        decision: "supported",
        reasonFamily: "entailed",
        validatorProfile: "local-nli-v1",
        validatorVersion: 4,
        version: 1
      }],
      validator: {
        egress: "local",
        profileId: "local-nli-v1",
        profileVersion: 4,
        semanticProof: true
      }
    })).toThrow("knowledge_semantic_shadow_prediction_invalid");
  });

  it("binds one unambiguous typed observation context without retaining its labels", () => {
    const excerpt = "Glucose | 2026-08-20 | 5.4 | mmol/L";
    const typedItem = {
      ...item(1, excerpt),
      contextBoundaries: {
        documentContext: createKnowledgeTableDocumentContext({
          blockId: "semantic-table",
          cells: [
            { columnEnd: 0, columnStart: 0, text: "Glucose" },
            { columnEnd: 1, columnStart: 1, text: "2026-08-20" },
            { columnEnd: 2, columnStart: 2, text: "5.4" },
            { columnEnd: 3, columnStart: 3, text: "mmol/L" }
          ],
          headerLineage: [
            { columnEnd: 0, columnStart: 0, rowIndex: 0, text: "Metric" },
            { columnEnd: 1, columnStart: 1, rowIndex: 0, text: "Date" },
            { columnEnd: 2, columnStart: 2, rowIndex: 0, text: "Actual" },
            { columnEnd: 3, columnStart: 3, rowIndex: 0, text: "Unit" }
          ],
          rowIndex: 1
        }),
        expanded: false,
        excerptBytes: Buffer.byteLength(excerpt),
        sourceTextBytes: Buffer.byteLength(excerpt)
      }
    } satisfies KnowledgeEvidencePackageItem;
    const source = evidence([typedItem]);
    const diagnostic = createStructuralKnowledgeSemanticShadowDiagnosticV1({
      answer: "Glucose actual was 5.4 mmol/L on 2026-08-20 [K1].",
      evidence: source
    });

    expect(diagnostic.claims[0]?.contextKeyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(diagnostic)).not.toContain("Glucose");
    expect(JSON.stringify(diagnostic)).not.toContain("mmol/L");

    const truncated = createStructuralKnowledgeSemanticShadowDiagnosticV1({
      answer: "Glucose actual was 5.4 mmol/L on 2026-08-20 [K1].",
      evidence: evidence([{ ...typedItem, textTruncated: true }])
    });
    expect(truncated.claims[0]?.contextKeyHash).toBeNull();
  });

  it("fails closed on cross-neighborhood attribution, tampering, and missing paid usage", () => {
    const source = evidence([item(1, "One."), item(2, "Two.")]);
    const answer = "One is stated [K1].";
    const prediction = {
      attributableHandles: ["K2"],
      claimOrdinal: 1,
      confidence: 0.9,
      decision: "supported",
      reasonFamily: "entailed",
      validatorProfile: "system-validator-v1",
      validatorVersion: 1,
      version: 1
    } as const;
    expect(() => createKnowledgeSemanticShadowDiagnosticV1({
      answer,
      evidence: source,
      executionStatus: "complete",
      predictions: [prediction],
      validator: {
        egress: "external",
        profileId: "system-validator-v1",
        profileVersion: 1,
        semanticProof: true
      }
    })).toThrow("knowledge_semantic_shadow_external_usage_missing");
    expect(() => createKnowledgeSemanticShadowDiagnosticV1({
      answer,
      evidence: source,
      executionStatus: "complete",
      predictions: [prediction],
      attemptId: "semantic-attempt-1",
      usage: {
        cacheWriteInputTokens: 0,
        cachedInputTokens: 0,
        estimatedCostMicros: 1_000,
        inputTokens: 20,
        outputTokens: 10,
        reasoningTokens: 0,
        requests: 1,
        totalTokens: 30
      },
      validator: {
        egress: "external",
        profileId: "system-validator-v1",
        profileVersion: 1,
        semanticProof: true
      }
    })).toThrow("knowledge_semantic_shadow_prediction_invalid");

    const baseline = createStructuralKnowledgeSemanticShadowDiagnosticV1({ answer, evidence: source });
    expect(decodeKnowledgeSemanticShadowDiagnosticV1({
      ...baseline,
      claims: baseline.claims.map((claim) => ({ ...claim, decision: "supported" }))
    })).toBeNull();
    expect(decodeKnowledgeSemanticShadowDiagnosticV1({ ...baseline, blockingApplied: true })).toBeNull();
  });

  it("represents unavailable candidates without pretending they produced a prediction", () => {
    const source = evidence([item(1, "One.")]);
    const diagnostic = createKnowledgeSemanticShadowDiagnosticV1({
      answer: "One is stated [K1].",
      evidence: source,
      executionStatus: "unavailable",
      failureReasonCode: "runner_not_configured",
      validator: {
        egress: "local",
        profileId: "local-nli-v1",
        profileVersion: 1,
        semanticProof: false
      }
    });

    expect(diagnostic.claims[0]).toMatchObject({
      attributableHandles: [],
      confidence: 0,
      decision: "uncertain",
      reasonFamily: "insufficient_context"
    });
    expect(diagnostic.executionStatus).toBe("unavailable");
    expect(decodeKnowledgeSemanticShadowDiagnosticV1(diagnostic)).toEqual(diagnostic);
  });

  it("seals a text-free failure receipt without invoking claim preparation", () => {
    const diagnostic = createUnavailableKnowledgeSemanticShadowDiagnosticV1({
      answer: "A provider answer which remains user-visible.",
      evidence: evidence([item(1, "Private source text.")]),
      executionStatus: "failed",
      failureReasonCode: "segmenter_failed",
      validator: {
        egress: "none",
        profileId: "structural-baseline-v1",
        profileVersion: 1,
        semanticProof: false
      }
    });

    expect(diagnostic).toMatchObject({
      blockingApplied: false,
      claims: [],
      executionStatus: "failed",
      failureReasonCode: "segmenter_failed"
    });
    expect(JSON.stringify(diagnostic)).not.toContain("provider answer");
    expect(JSON.stringify(diagnostic)).not.toContain("Private source text");
  });

  it("degrades a claim-limit overflow without changing or rejecting the answer", () => {
    const answer = Array.from({ length: 513 }, (_, index) =>
      `Synthetic claim number ${index + 1} remains uncited.`).join("\n");
    const diagnostic = createStructuralKnowledgeSemanticShadowDiagnosticV1({
      answer,
      evidence: evidence([])
    });

    expect(diagnostic).toMatchObject({
      blockingApplied: false,
      claims: [],
      executionStatus: "unavailable",
      failureReasonCode: "claim_limit_exceeded"
    });
  });
});

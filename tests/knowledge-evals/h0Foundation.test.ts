import { describe, expect, it } from "vitest";
import {
  assessKnowledgeH0Corpus,
  createKnowledgeH0CorpusManifest,
  KNOWLEDGE_H0_FROZEN_CORPUS_SHA256
} from "./h0Corpus";
import {
  knowledgeH0CorpusCapabilities,
  knowledgeH0CorpusDocumentSchema,
  knowledgeH0DatasetSplits
} from "./h0CorpusSchema";
import {
  KNOWLEDGE_H0_ANNOTATION_GUIDE,
  knowledgeH0AnnotationGuideSchema
} from "./h0AnnotationGuide";
import {
  KNOWLEDGE_H0_REFERENCE_ENVIRONMENT,
  knowledgeH0ReferenceEnvironmentSchema
} from "./h0ReferenceEnvironment";
import {
  KNOWLEDGE_H0_DECISION_REGISTRY,
  knowledgeH0DecisionRegistrySchema
} from "./h0DecisionRegistry";

describe("Knowledge hardening H0 evaluation foundation", () => {
  it("freezes a strict, content-safe 50-document manifest and family-separated splits", () => {
    const manifest = createKnowledgeH0CorpusManifest();
    const assessment = assessKnowledgeH0Corpus(manifest);

    expect(manifest.corpusSha256).toBe(KNOWLEDGE_H0_FROZEN_CORPUS_SHA256);
    expect(manifest.documents).toHaveLength(50);
    expect(new Set(manifest.documents.map((document) => document.id))).toHaveLength(50);
    expect(new Set(manifest.documents.map((document) => document.artifact.fileName))).toHaveLength(50);
    expect(manifest.documents.every((document) =>
      !document.contentSafety.privateOperatorDocuments &&
      !document.contentSafety.privateUserContent &&
      document.contentSafety.origin === "repository_generated"
    )).toBe(true);
    expect(assessment.documentFamilyLeakage).toBe(false);
    expect(assessment.semanticTemplateLeakage).toBe(false);
    expect(new Set(manifest.documents.map((document) =>
      document.semanticTemplateFamily
    ))).toHaveLength(8);
    expect(manifest.documents.filter((document) => document.artifact.format === "pdf")
      .every((document) => document.language === "en")).toBe(true);
    expect(manifest.documents.filter((document) => document.artifact.format !== "pdf")
      .every((document) => document.language === "mixed_en_ru")).toBe(true);
    expect(manifest.capabilities.map(({ id }) => id)).toEqual(knowledgeH0CorpusCapabilities);
    expect(Object.keys(assessment.splitCounts).sort()).toEqual([...knowledgeH0DatasetSplits].sort());
    expect(assessment.splitCounts).toEqual({
      blinded_review: 6,
      calibration: 12,
      development: 20,
      held_out: 12
    });
  });

  it("rejects unknown manifest fields and reports foundation gaps instead of release success", () => {
    const manifest = createKnowledgeH0CorpusManifest();
    const assessment = assessKnowledgeH0Corpus(manifest);
    const first = manifest.documents[0]!;
    const csvDocuments = manifest.documents.filter((document) =>
      document.artifact.format === "csv");
    const markdownDocuments = manifest.documents.filter((document) =>
      document.artifact.format === "markdown");

    expect(knowledgeH0CorpusDocumentSchema.safeParse({ ...first, unreviewed: true }).success)
      .toBe(false);
    expect(csvDocuments.every((document) =>
      !document.categories.includes("decimal_point") &&
      !document.categories.includes("lists") &&
      !document.categories.includes("prose")
    )).toBe(true);
    expect(markdownDocuments.every((document) =>
      document.categories.includes("decimal_point") &&
      document.categories.includes("lists") &&
      document.categories.includes("markdown_tables") &&
      document.categories.includes("prose")
    )).toBe(true);
    expect(assessment).toMatchObject({
      blockers: [
        "document_version_fixtures_missing",
        "required_category_coverage_incomplete",
        "scanned_binary_fixture_missing",
        "named_capability_gaps"
      ],
      releaseQualityEligible: false,
      semanticTemplateLeakage: false
    });
    expect(assessment.missingCategories).toEqual(expect.arrayContaining([
      "document_versions",
      "ocr_fragmentation",
      "pdf_tables",
      "wrong_handle_drafts"
    ]));
    expect(assessment.missingCapabilities).toEqual(expect.arrayContaining([
      { downstreamStage: "H1", id: "direct_unattached_source" },
      { downstreamStage: "H1", id: "multi_base_source_reuse" },
      { downstreamStage: "H4", id: "cross_document_references" },
      { downstreamStage: "H5", id: "document_versions" },
      { downstreamStage: "H5", id: "forms" },
      { downstreamStage: "H5", id: "scanned_binary" },
      { downstreamStage: "H8", id: "partial_readiness" }
    ]));
    expect(manifest.capabilities.filter(({ status }) => status === "covered")
      .map(({ id }) => id)).toEqual(expect.arrayContaining([
      "digital_binary",
      "digital_text",
      "english_content",
      "repeated_templates",
      "russian_content",
      "tables"
    ]));
  });

  it("freezes the independent annotation contract without self-attesting review", () => {
    expect(knowledgeH0AnnotationGuideSchema.safeParse(KNOWLEDGE_H0_ANNOTATION_GUIDE).success)
      .toBe(true);
    expect(KNOWLEDGE_H0_ANNOTATION_GUIDE).toMatchObject({
      independence: {
        implementationAgentMayCountAsIndependentReviewer: false,
        minimumAnnotatorsPerRepresentativeItem: 2
      },
      releaseEvidence: {
        completedIndependentAnnotationRounds: 0,
        eligible: false
      },
      status: "frozen_guide_unexecuted"
    });
    expect(knowledgeH0AnnotationGuideSchema.safeParse({
      ...KNOWLEDGE_H0_ANNOTATION_GUIDE,
      selfReviewed: true
    }).success).toBe(false);
  });

  it("freezes launch thresholds, runtime limits, and distinct vector provenance", () => {
    expect(knowledgeH0ReferenceEnvironmentSchema.safeParse(
      KNOWLEDGE_H0_REFERENCE_ENVIRONMENT
    ).success).toBe(true);
    expect(KNOWLEDGE_H0_REFERENCE_ENVIRONMENT).toMatchObject({
      benchmarkEnvironment: {
        appImage: "mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948",
        benchmarkEligible: false,
        nodeMajor: 24
      },
      latencyCostBudgets: {
        semanticValidator: {
          releaseBlockingEligible: false,
          status: "not_configured"
        }
      },
      thresholds: {
        grounding: {
          citationPrecisionMinimum: 0.95,
          unsupportedSourceClaimRateMaximum: 0.02
        },
        retrieval: { documentRecallAt10Minimum: 0.95 }
      },
      vectorProvenance: {
        oraclePlumbing: {
          kind: "source_oracle",
          releaseEmbeddingQualityEvidence: false
        },
        realEmbedding: {
          kind: "real_embedding",
          releaseEmbeddingQualityEvidence: false,
          status: "unavailable"
        }
      }
    });
    expect(knowledgeH0ReferenceEnvironmentSchema.safeParse({
      ...KNOWLEDGE_H0_REFERENCE_ENVIRONMENT,
      mutableThresholds: true
    }).success).toBe(false);
  });

  it("assigns every required architecture decision to a stage and durable owner", () => {
    expect(knowledgeH0DecisionRegistrySchema.safeParse(
      KNOWLEDGE_H0_DECISION_REGISTRY
    ).success).toBe(true);
    expect(KNOWLEDGE_H0_DECISION_REGISTRY.decisions).toHaveLength(10);
    expect(new Set(KNOWLEDGE_H0_DECISION_REGISTRY.decisions.map(({ id }) => id))).toHaveLength(10);
    expect(KNOWLEDGE_H0_DECISION_REGISTRY).toMatchObject({
      inactiveBehaviorDocumentedAsLive: false,
      version: "knowledge-hardening-decision-registry-v1"
    });
  });
});

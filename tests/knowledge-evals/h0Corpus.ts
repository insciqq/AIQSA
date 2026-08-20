import { createHash } from "node:crypto";
import {
  createKnowledgeReleaseCorpus,
  type KnowledgeReleaseFormat,
  type KnowledgeReleaseScenario
} from "../../scripts/knowledge-release-corpus";
import {
  knowledgeH0CorpusCapabilities,
  knowledgeH0CorpusCategories,
  knowledgeH0CorpusManifestSchema,
  type KnowledgeH0CorpusCapability,
  type KnowledgeH0CorpusCapabilityEntry,
  type KnowledgeH0CorpusCategory,
  type KnowledgeH0CorpusDocument,
  type KnowledgeH0CorpusManifest,
  type KnowledgeH0DatasetSplit
} from "./h0CorpusSchema";

export const KNOWLEDGE_H0_CORPUS_VERSION = "knowledge-hardening-h0-corpus-v1" as const;
export const KNOWLEDGE_H0_FROZEN_CORPUS_SHA256 =
  "9179d8912e7eb7f670affc0fbd4c3e67ac7cc0db45fe81b212d49b79cd3e5dcf" as const;

type FormatPolicy = Readonly<{
  documentFamily: `atlas-${string}-family-v1`;
  split: KnowledgeH0DatasetSplit;
  structure: "multi_section" | "multi_slide" | "tabular";
}>;

const formatPolicies: Readonly<Record<KnowledgeReleaseFormat, FormatPolicy>> = Object.freeze({
  csv: Object.freeze({
    documentFamily: "atlas-csv-ledger-family-v1",
    split: "calibration",
    structure: "tabular"
  }),
  docx: Object.freeze({
    documentFamily: "atlas-docx-report-family-v1",
    split: "held_out",
    structure: "multi_section"
  }),
  html: Object.freeze({
    documentFamily: "atlas-html-report-family-v1",
    split: "calibration",
    structure: "multi_section"
  }),
  markdown: Object.freeze({
    documentFamily: "atlas-markdown-record-family-v1",
    split: "development",
    structure: "multi_section"
  }),
  pdf: Object.freeze({
    documentFamily: "atlas-digital-pdf-family-v1",
    split: "held_out",
    structure: "multi_section"
  }),
  pptx: Object.freeze({
    documentFamily: "atlas-presentation-family-v1",
    split: "blinded_review",
    structure: "multi_slide"
  }),
  text: Object.freeze({
    documentFamily: "atlas-text-record-family-v1",
    split: "development",
    structure: "multi_section"
  }),
  xlsx: Object.freeze({
    documentFamily: "atlas-workbook-family-v1",
    split: "blinded_review",
    structure: "tabular"
  })
});

function categoriesFor(
  format: KnowledgeReleaseFormat,
  scenario: KnowledgeReleaseScenario,
  bytes: Buffer
): readonly KnowledgeH0CorpusCategory[] {
  const categories = new Set<KnowledgeH0CorpusCategory>([
    "direct_facts",
    "filenames_metadata"
  ]);
  if (["docx", "html", "markdown", "pdf", "pptx", "text"].includes(format)) {
    categories.add("prose");
  }
  if (format === "markdown" && /(?:^|\n)-\s/u.test(bytes.toString("utf8"))) {
    categories.add("lists");
  }
  if (format !== "csv") categories.add("decimal_point");
  if (format === "markdown") categories.add("markdown_tables");
  if (scenario === "exact_identifier") categories.add("exact_identifiers");
  if (scenario === "prompt_injection") categories.add("malicious_source_instructions");
  return Object.freeze([...categories]);
}

function languageFor(bytes: Buffer): "en" | "mixed_en_ru" | "ru" {
  const text = bytes.toString("utf8");
  const english = /[A-Za-z]/u.test(text);
  const russian = /[А-Яа-яЁё]/u.test(text);
  if (english && russian) return "mixed_en_ru";
  if (russian) return "ru";
  return "en";
}

function kindFor(format: KnowledgeReleaseFormat): "digital_binary" | "digital_text" {
  return ["docx", "pdf", "pptx", "xlsx"].includes(format)
    ? "digital_binary"
    : "digital_text";
}

function corpusSha256(documents: readonly Readonly<{
  byteLength: number;
  fileName: string;
  ordinal: number;
  sha256: string;
}>[]): string {
  return createHash("sha256")
    .update(documents.map((document) =>
      `${document.ordinal}:${document.fileName}:${document.sha256}:${document.byteLength}`
    ).join("\n"))
    .digest("hex");
}

function coveredCapability(
  id: KnowledgeH0CorpusCapability,
  documents: readonly KnowledgeH0CorpusDocument[]
): KnowledgeH0CorpusCapabilityEntry {
  if (documents.length === 0) throw new Error(`knowledge_h0_capability_evidence_missing:${id}`);
  return Object.freeze({
    downstreamStage: null,
    evidenceDocumentIds: documents.map((document) => document.id),
    id,
    status: "covered" as const
  });
}

function gapCapability(
  id: KnowledgeH0CorpusCapability,
  downstreamStage: "H1" | "H4" | "H5" | "H8"
): KnowledgeH0CorpusCapabilityEntry {
  const evidenceDocumentIds: [] = [];
  return Object.freeze({
    downstreamStage,
    evidenceDocumentIds,
    id,
    status: "gap" as const
  });
}

function corpusCapabilities(
  documents: readonly KnowledgeH0CorpusDocument[]
): readonly KnowledgeH0CorpusCapabilityEntry[] {
  const withLanguage = (language: "en" | "ru") => documents.filter((document) =>
    document.language === language || document.language === "mixed_en_ru");
  const repeated = documents.filter((document) =>
    documents.some((candidate) =>
      candidate.id !== document.id &&
      candidate.semanticTemplateFamily === document.semanticTemplateFamily));
  const capabilities: readonly KnowledgeH0CorpusCapabilityEntry[] = Object.freeze([
    coveredCapability("english_content", withLanguage("en")),
    coveredCapability("russian_content", withLanguage("ru")),
    gapCapability("scanned_binary", "H5"),
    coveredCapability("digital_binary", documents.filter((document) =>
      document.artifact.kind === "digital_binary")),
    coveredCapability("digital_text", documents.filter((document) =>
      document.artifact.kind === "digital_text")),
    coveredCapability("tables", documents.filter((document) =>
      ["csv", "html", "markdown", "xlsx"].includes(document.artifact.format))),
    gapCapability("forms", "H5"),
    gapCapability("document_versions", "H5"),
    coveredCapability("repeated_templates", repeated),
    gapCapability("cross_document_references", "H4"),
    gapCapability("multi_base_source_reuse", "H1"),
    gapCapability("direct_unattached_source", "H1"),
    gapCapability("partial_readiness", "H8")
  ]);
  if (new Set(capabilities.map(({ id }) => id)).size !== knowledgeH0CorpusCapabilities.length) {
    throw new Error("knowledge_h0_capability_manifest_incomplete");
  }
  return capabilities;
}

export function createKnowledgeH0CorpusManifest(): KnowledgeH0CorpusManifest {
  const generated = createKnowledgeReleaseCorpus();
  const documents: KnowledgeH0CorpusDocument[] = generated.map((document) => {
    const policy = formatPolicies[document.format];
    return {
      artifact: {
        byteLength: document.byteLength,
        fileName: document.fileName,
        format: document.format,
        generatedSha256: document.sha256,
        kind: kindFor(document.format),
        scanned: false
      },
      categories: [...categoriesFor(document.format, document.scenario, document.bytes)],
      contentSafety: {
        license: "AGPL-3.0-only",
        origin: "repository_generated",
        privateOperatorDocuments: false,
        privateUserContent: false
      },
      documentFamily: policy.documentFamily,
      id: `knowledge-h0-document-${String(document.ordinal).padStart(2, "0")}`,
      language: languageFor(document.bytes),
      ordinal: document.ordinal,
      semanticTemplateFamily: document.semanticTemplateFamily,
      split: policy.split,
      substantiveEvidence: {
        minimumByteContractSatisfied: true,
        structure: policy.structure
      }
    };
  });
  const actualCorpusSha256 = corpusSha256(generated);
  if (actualCorpusSha256 !== KNOWLEDGE_H0_FROZEN_CORPUS_SHA256) {
    throw new Error("knowledge_h0_frozen_corpus_digest_mismatch");
  }
  return knowledgeH0CorpusManifestSchema.parse({
    capabilities: corpusCapabilities(documents),
    corpusSha256: actualCorpusSha256,
    documents,
    generator: {
      contract: "knowledge-release-corpus-v1",
      path: "scripts/knowledge-release-corpus.ts"
    },
    splitPolicy: {
      assignmentUnit: "document_family",
      blindedReviewMayTuneModelsOrThresholds: false,
      calibrationMayTuneThresholds: true,
      developmentMayTuneImplementation: true,
      familyAssignmentsFrozen: true,
      heldOutMayTuneModelsOrThresholds: false
    },
    version: KNOWLEDGE_H0_CORPUS_VERSION
  });
}

export type KnowledgeH0CorpusAssessment = Readonly<{
  blockers: readonly (
    | "document_version_fixtures_missing"
    | "named_capability_gaps"
    | "required_category_coverage_incomplete"
    | "scanned_binary_fixture_missing"
    | "semantic_template_split_leakage"
  )[];
  coveredCategories: readonly KnowledgeH0CorpusCategory[];
  documentCount: number;
  documentFamilyLeakage: false;
  missingCapabilities: readonly Readonly<{
    downstreamStage: "H1" | "H4" | "H5" | "H8";
    id: KnowledgeH0CorpusCapability;
  }>[];
  missingCategories: readonly KnowledgeH0CorpusCategory[];
  releaseQualityEligible: false;
  semanticTemplateLeakage: boolean;
  splitCounts: Readonly<Record<KnowledgeH0DatasetSplit, number>>;
}>;

export function assessKnowledgeH0Corpus(
  manifest: KnowledgeH0CorpusManifest
): KnowledgeH0CorpusAssessment {
  const familySplits = new Map<string, Set<KnowledgeH0DatasetSplit>>();
  const semanticTemplateSplits = new Map<string, Set<KnowledgeH0DatasetSplit>>();
  const coveredCategories = new Set<KnowledgeH0CorpusCategory>();
  const splitCounts: Record<KnowledgeH0DatasetSplit, number> = {
    blinded_review: 0,
    calibration: 0,
    development: 0,
    held_out: 0
  };

  for (const document of manifest.documents) {
    const family = familySplits.get(document.documentFamily) ?? new Set();
    family.add(document.split);
    familySplits.set(document.documentFamily, family);
    const template = semanticTemplateSplits.get(document.semanticTemplateFamily) ?? new Set();
    template.add(document.split);
    semanticTemplateSplits.set(document.semanticTemplateFamily, template);
    document.categories.forEach((category) => coveredCategories.add(category));
    splitCounts[document.split] += 1;
  }
  if ([...familySplits.values()].some((splits) => splits.size !== 1)) {
    throw new Error("knowledge_h0_document_family_split_leakage");
  }
  const semanticTemplateLeakage = [...semanticTemplateSplits.values()]
    .some((splits) => splits.size > 1);

  const missingCategories = knowledgeH0CorpusCategories
    .filter((category) => !coveredCategories.has(category));
  const missingCapabilities = manifest.capabilities
    .filter((capability) => capability.status === "gap")
    .map((capability) => Object.freeze({
      downstreamStage: capability.downstreamStage,
      id: capability.id
    }));
  const blockers: KnowledgeH0CorpusAssessment["blockers"] = Object.freeze([
    "document_version_fixtures_missing",
    "required_category_coverage_incomplete",
    "scanned_binary_fixture_missing",
    ...(missingCapabilities.length > 0 ? ["named_capability_gaps" as const] : []),
    ...(semanticTemplateLeakage ? ["semantic_template_split_leakage" as const] : [])
  ]);
  return Object.freeze({
    blockers,
    coveredCategories: Object.freeze([...coveredCategories]),
    documentCount: manifest.documents.length,
    documentFamilyLeakage: false,
    missingCapabilities: Object.freeze(missingCapabilities),
    missingCategories: Object.freeze(missingCategories),
    releaseQualityEligible: false,
    semanticTemplateLeakage,
    splitCounts: Object.freeze(splitCounts)
  });
}

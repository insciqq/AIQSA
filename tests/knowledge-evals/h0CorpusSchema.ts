import { z } from "zod";

export const knowledgeH0DatasetSplits = [
  "development",
  "calibration",
  "held_out",
  "blinded_review"
] as const;

export const knowledgeH0CorpusCategories = [
  "direct_facts",
  "paraphrases",
  "multiple_citations",
  "temporal_series",
  "document_versions",
  "actual_vs_reference_ranges",
  "different_metrics_same_unit",
  "same_metric_unit_different_dates",
  "genuine_same_context_conflicts",
  "negation_modality",
  "derived_arithmetic",
  "prose",
  "lists",
  "markdown_tables",
  "pdf_tables",
  "ocr_fragmentation",
  "decimal_comma",
  "decimal_point",
  "filenames_metadata",
  "partial_readiness",
  "ambiguous_layouts",
  "deleted_sources",
  "malicious_source_instructions",
  "uncited_drafts",
  "wrong_handle_drafts",
  "correct_multi_source_comparisons",
  "exact_identifiers",
  "full_context",
  "exhaustive_search",
  "corpus_summary"
] as const;

export const knowledgeH0CorpusCapabilities = [
  "english_content",
  "russian_content",
  "scanned_binary",
  "digital_binary",
  "digital_text",
  "tables",
  "forms",
  "document_versions",
  "repeated_templates",
  "cross_document_references",
  "multi_base_source_reuse",
  "direct_unattached_source",
  "partial_readiness"
] as const;

export type KnowledgeH0CorpusCapability = (typeof knowledgeH0CorpusCapabilities)[number];
export type KnowledgeH0CorpusCategory = (typeof knowledgeH0CorpusCategories)[number];
export type KnowledgeH0DatasetSplit = (typeof knowledgeH0DatasetSplits)[number];

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const formatSchema = z.enum([
  "csv", "docx", "html", "markdown", "pdf", "pptx", "text", "xlsx"
]);
const documentIdSchema = z.string().regex(/^knowledge-h0-document-[0-9]{2}$/u);
const downstreamStageSchema = z.enum(["H1", "H4", "H5", "H8"]);

const knowledgeH0CoveredCapabilitySchema = z.strictObject({
  downstreamStage: z.null(),
  evidenceDocumentIds: z.array(documentIdSchema).min(1),
  id: z.enum(knowledgeH0CorpusCapabilities),
  status: z.literal("covered")
});

const knowledgeH0GapCapabilitySchema = z.strictObject({
  downstreamStage: downstreamStageSchema,
  evidenceDocumentIds: z.tuple([]),
  id: z.enum(knowledgeH0CorpusCapabilities),
  status: z.literal("gap")
});

export const knowledgeH0CorpusCapabilitySchema = z.discriminatedUnion("status", [
  knowledgeH0CoveredCapabilitySchema,
  knowledgeH0GapCapabilitySchema
]);

export const knowledgeH0CorpusDocumentSchema = z.strictObject({
  artifact: z.strictObject({
    byteLength: z.number().int().min(1_000),
    fileName: z.string().min(1),
    format: formatSchema,
    generatedSha256: sha256Schema,
    kind: z.enum(["digital_binary", "digital_text"]),
    scanned: z.boolean()
  }),
  categories: z.array(z.enum(knowledgeH0CorpusCategories)).min(1),
  contentSafety: z.strictObject({
    license: z.literal("AGPL-3.0-only"),
    origin: z.literal("repository_generated"),
    privateOperatorDocuments: z.literal(false),
    privateUserContent: z.literal(false)
  }),
  documentFamily: z.string().regex(/^atlas-[a-z0-9-]+-family-v1$/u),
  id: documentIdSchema,
  language: z.enum(["en", "ru", "mixed_en_ru"]),
  ordinal: z.number().int().min(1).max(50),
  semanticTemplateFamily: z.string()
    .regex(/^atlas-[a-z0-9-]+-semantic-template-v1$/u),
  split: z.enum(knowledgeH0DatasetSplits),
  substantiveEvidence: z.strictObject({
    minimumByteContractSatisfied: z.literal(true),
    structure: z.enum(["multi_section", "tabular", "multi_slide"])
  })
});

export const knowledgeH0CorpusManifestSchema = z.strictObject({
  capabilities: z.array(knowledgeH0CorpusCapabilitySchema)
    .length(knowledgeH0CorpusCapabilities.length),
  corpusSha256: sha256Schema,
  documents: z.array(knowledgeH0CorpusDocumentSchema).length(50),
  generator: z.strictObject({
    contract: z.literal("knowledge-release-corpus-v1"),
    path: z.literal("scripts/knowledge-release-corpus.ts")
  }),
  splitPolicy: z.strictObject({
    assignmentUnit: z.literal("document_family"),
    blindedReviewMayTuneModelsOrThresholds: z.literal(false),
    calibrationMayTuneThresholds: z.literal(true),
    developmentMayTuneImplementation: z.literal(true),
    familyAssignmentsFrozen: z.literal(true),
    heldOutMayTuneModelsOrThresholds: z.literal(false)
  }),
  version: z.literal("knowledge-hardening-h0-corpus-v1")
});

export type KnowledgeH0CorpusDocument = z.infer<typeof knowledgeH0CorpusDocumentSchema>;
export type KnowledgeH0CorpusCapabilityEntry = z.infer<
  typeof knowledgeH0CorpusCapabilitySchema
>;
export type KnowledgeH0CorpusManifest = z.infer<typeof knowledgeH0CorpusManifestSchema>;

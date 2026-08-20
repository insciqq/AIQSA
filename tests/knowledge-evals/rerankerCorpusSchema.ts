import { z } from "zod";

export const knowledgeRerankerDatasetSplits = [
  "development",
  "calibration",
  "held_out",
  "blinded_review"
] as const;

export const knowledgeRerankerLanguages = ["en", "ru"] as const;

export type KnowledgeRerankerDatasetSplit =
  (typeof knowledgeRerankerDatasetSplits)[number];
export type KnowledgeRerankerLanguage = (typeof knowledgeRerankerLanguages)[number];

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const safeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,127}$/u);

export const knowledgeRerankerCorpusPassageSchema = z.strictObject({
  contentSha256: sha256Schema,
  id: z.string().regex(/^kr-passage-[0-9]{3}$/u),
  ordinal: z.number().int().min(1).max(2),
  text: z.string().min(180).max(4_000)
});

export const knowledgeRerankerCorpusDocumentSchema = z.strictObject({
  contentSafety: z.strictObject({
    license: z.literal("AGPL-3.0-only"),
    origin: z.literal("repository_generated"),
    privateOperatorDocuments: z.literal(false),
    privateUserContent: z.literal(false)
  }),
  documentFamily: z.string().regex(/^kr-[a-z0-9-]+-family-v1$/u),
  id: z.string().regex(/^kr-document-[0-9]{2}$/u),
  language: z.enum(knowledgeRerankerLanguages),
  passages: z.array(knowledgeRerankerCorpusPassageSchema).length(2),
  semanticTemplateFamily: z.string().regex(/^kr-[a-z0-9-]+-template-v1$/u),
  split: z.enum(knowledgeRerankerDatasetSplits),
  title: z.string().min(8).max(160)
});

export const knowledgeRerankerCorpusQuerySchema = z.strictObject({
  contentSha256: sha256Schema,
  id: z.string().regex(/^kr-query-[0-9]{2}$/u),
  language: z.enum(knowledgeRerankerLanguages),
  queryFamily: z.string().regex(/^kr-[a-z0-9-]+-query-family-v1$/u),
  split: z.enum(knowledgeRerankerDatasetSplits),
  text: z.string().min(12).max(600)
});

export const knowledgeRerankerCorpusManifestSchema = z.strictObject({
  corpusSha256: sha256Schema,
  documents: z.array(knowledgeRerankerCorpusDocumentSchema).length(50),
  languages: z.tuple([z.literal("en"), z.literal("ru")]),
  queries: z.array(knowledgeRerankerCorpusQuerySchema).min(20).max(64),
  splitPolicy: z.strictObject({
    assignmentUnit: z.literal("document_and_query_family"),
    blindedReviewMayTuneModelsOrThresholds: z.literal(false),
    calibrationMayTuneThresholds: z.literal(true),
    developmentMayTuneImplementation: z.literal(true),
    familyAssignmentsFrozen: z.literal(true),
    heldOutMayTuneModelsOrThresholds: z.literal(false)
  }),
  version: z.literal("knowledge-reranker-corpus-v1")
});

export const knowledgeRerankerEmbeddingIdentitySchema = z.strictObject({
  approval: z.enum(["approved_candidate", "test_double_only"]),
  authorization: z.enum(["evaluation_only", "profile_authorized", "test_double"]),
  dimensions: z.number().int().min(1).max(32_768),
  egress: z.enum(["external", "none"]),
  executionClass: z.enum(["real_embedding", "test_double"]),
  modelId: z.string().min(1).max(512),
  provider: z.string().min(1).max(128),
  revision: z.string().min(1).max(256),
  vectorSpaceId: safeIdSchema
});

const candidatePoolEntrySchema = z.strictObject({
  cosineSimilarity: z.number().finite().min(-1).max(1),
  passageId: z.string().regex(/^kr-passage-[0-9]{3}$/u),
  rank: z.number().int().min(1).max(50)
});

const candidatePoolQuerySchema = z.strictObject({
  candidates: z.array(candidatePoolEntrySchema).min(1).max(50),
  queryId: z.string().regex(/^kr-query-[0-9]{2}$/u)
});

export const knowledgeRerankerCandidatePoolSchema = z.strictObject({
  candidateLimit: z.number().int().min(1).max(50),
  corpusSha256: sha256Schema,
  embedding: knowledgeRerankerEmbeddingIdentitySchema,
  noRelevanceDerivedSignals: z.literal(true),
  poolSha256: sha256Schema,
  qualityGateEligible: z.boolean(),
  queries: z.array(candidatePoolQuerySchema).min(1),
  samePoolForEveryCandidate: z.literal(true),
  version: z.literal("knowledge-reranker-candidate-pool-v1")
});

export type KnowledgeRerankerCorpusDocument = z.infer<
  typeof knowledgeRerankerCorpusDocumentSchema
>;
export type KnowledgeRerankerCorpusManifest = z.infer<
  typeof knowledgeRerankerCorpusManifestSchema
>;
export type KnowledgeRerankerCorpusPassage = z.infer<
  typeof knowledgeRerankerCorpusPassageSchema
>;
export type KnowledgeRerankerCorpusQuery = z.infer<
  typeof knowledgeRerankerCorpusQuerySchema
>;
export type KnowledgeRerankerEmbeddingIdentity = z.infer<
  typeof knowledgeRerankerEmbeddingIdentitySchema
>;
export type KnowledgeRerankerCandidatePool = z.infer<
  typeof knowledgeRerankerCandidatePoolSchema
>;

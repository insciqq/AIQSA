import { z } from "zod";

const annotationLabelSchema = z.strictObject({
  definition: z.string().min(20),
  id: z.enum(["supported", "unsupported", "contradicted", "uncertain"]),
  requiresCitationLocalEvidence: z.literal(true)
});

const reviewRubricSchema = z.strictObject({
  id: z.enum([
    "correctness",
    "completeness",
    "verifiability",
    "citation_usability",
    "no_answer_clarity",
    "temporal_version_handling",
    "technical_leakage",
    "supported_claim_preservation"
  ]),
  materialErrorCanBlockRelease: z.boolean(),
  scale: z.strictObject({ maximum: z.literal(5), minimum: z.literal(1) })
});

export const knowledgeH0AnnotationGuideSchema = z.strictObject({
  adjudication: z.strictObject({
    adjudicatorMustNotBeOriginalImplementationAgent: z.literal(true),
    preservePreAdjudicationLabels: z.literal(true),
    required: z.literal(true),
    unresolvedMaterialDisagreementBlocksRelease: z.literal(true)
  }),
  blindPacket: z.strictObject({
    hiddenFields: z.tuple([
      z.literal("candidate_identity"),
      z.literal("implementation_author"),
      z.literal("expected_label"),
      z.literal("split_mapping")
    ]),
    requiredArtifacts: z.tuple([
      z.literal("generated_answer"),
      z.literal("user_question"),
      z.literal("citation_viewer_artifact"),
      z.literal("source_local_evidence")
    ])
  }),
  claimLabels: z.array(annotationLabelSchema).length(4),
  disagreementReport: z.strictObject({
    categories: z.tuple([
      z.literal("claim_segmentation"),
      z.literal("support_label"),
      z.literal("citation_binding"),
      z.literal("temporal_context"),
      z.literal("materiality")
    ]),
    metrics: z.tuple([
      z.literal("raw_agreement"),
      z.literal("label_distribution"),
      z.literal("adjudication_rate")
    ]),
    required: z.literal(true)
  }),
  independence: z.strictObject({
    implementationAgentMayCountAsIndependentReviewer: z.literal(false),
    minimumAnnotatorsPerRepresentativeItem: z.literal(2),
    reviewersMustAnnotateBeforeAdjudication: z.literal(true)
  }),
  languages: z.tuple([z.literal("en"), z.literal("ru")]),
  releaseEvidence: z.strictObject({
    completedIndependentAnnotationRounds: z.literal(0),
    eligible: z.literal(false),
    reasonCodes: z.tuple([
      z.literal("independent_labels_not_collected"),
      z.literal("adjudication_not_completed"),
      z.literal("blinded_final_review_not_completed")
    ])
  }),
  reviewRubrics: z.array(reviewRubricSchema).length(8),
  status: z.literal("frozen_guide_unexecuted"),
  unit: z.literal("atomic_claim_with_source_local_context"),
  version: z.literal("knowledge-hardening-annotation-guide-v1")
});

export const KNOWLEDGE_H0_ANNOTATION_GUIDE = knowledgeH0AnnotationGuideSchema.parse({
  adjudication: {
    adjudicatorMustNotBeOriginalImplementationAgent: true,
    preservePreAdjudicationLabels: true,
    required: true,
    unresolvedMaterialDisagreementBlocksRelease: true
  },
  blindPacket: {
    hiddenFields: [
      "candidate_identity",
      "implementation_author",
      "expected_label",
      "split_mapping"
    ],
    requiredArtifacts: [
      "generated_answer",
      "user_question",
      "citation_viewer_artifact",
      "source_local_evidence"
    ]
  },
  claimLabels: [
    {
      definition: "Every material part of the claim follows from the cited source-local evidence.",
      id: "supported",
      requiresCitationLocalEvidence: true
    },
    {
      definition: "At least one material part of the claim is absent from the cited local evidence.",
      id: "unsupported",
      requiresCitationLocalEvidence: true
    },
    {
      definition: "The cited source-local evidence states an incompatible fact in the same context.",
      id: "contradicted",
      requiresCitationLocalEvidence: true
    },
    {
      definition: "Available source-local evidence is ambiguous or insufficient for a stable decision.",
      id: "uncertain",
      requiresCitationLocalEvidence: true
    }
  ],
  disagreementReport: {
    categories: [
      "claim_segmentation",
      "support_label",
      "citation_binding",
      "temporal_context",
      "materiality"
    ],
    metrics: ["raw_agreement", "label_distribution", "adjudication_rate"],
    required: true
  },
  independence: {
    implementationAgentMayCountAsIndependentReviewer: false,
    minimumAnnotatorsPerRepresentativeItem: 2,
    reviewersMustAnnotateBeforeAdjudication: true
  },
  languages: ["en", "ru"],
  releaseEvidence: {
    completedIndependentAnnotationRounds: 0,
    eligible: false,
    reasonCodes: [
      "independent_labels_not_collected",
      "adjudication_not_completed",
      "blinded_final_review_not_completed"
    ]
  },
  reviewRubrics: [
    { id: "correctness", materialErrorCanBlockRelease: true, scale: { maximum: 5, minimum: 1 } },
    { id: "completeness", materialErrorCanBlockRelease: true, scale: { maximum: 5, minimum: 1 } },
    { id: "verifiability", materialErrorCanBlockRelease: true, scale: { maximum: 5, minimum: 1 } },
    { id: "citation_usability", materialErrorCanBlockRelease: true, scale: { maximum: 5, minimum: 1 } },
    { id: "no_answer_clarity", materialErrorCanBlockRelease: true, scale: { maximum: 5, minimum: 1 } },
    { id: "temporal_version_handling", materialErrorCanBlockRelease: true, scale: { maximum: 5, minimum: 1 } },
    { id: "technical_leakage", materialErrorCanBlockRelease: true, scale: { maximum: 5, minimum: 1 } },
    { id: "supported_claim_preservation", materialErrorCanBlockRelease: true, scale: { maximum: 5, minimum: 1 } }
  ],
  status: "frozen_guide_unexecuted",
  unit: "atomic_claim_with_source_local_context",
  version: "knowledge-hardening-annotation-guide-v1"
});

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT,
  KNOWLEDGE_PROVIDER_ANSWER_MAX_CALLS,
  KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_REVIEW_DIRECTORY_PREFIX,
  assertProviderAnswerReviewArtifactChain,
  type ProviderAnswerOutputFreeze,
  type ProviderAnswerReviewMapping,
  type ProviderAnswerReviewPacket
} from "./providerAnswerEval";

export const KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEW_VERSION =
  "knowledge-provider-answer-release-review-v1" as const;
export const KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEWER_A_FILE =
  "release-reviewer-a-submission.json" as const;
export const KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEWER_B_FILE =
  "release-reviewer-b-submission.json" as const;
export const KNOWLEDGE_PROVIDER_ANSWER_RELEASE_ADJUDICATION_FILE =
  "release-adjudication.json" as const;

export const providerAnswerReleaseReviewDimensions = Object.freeze([
  "correctness",
  "completeness",
  "verifiability",
  "citation_usability",
  "no_answer_clarity",
  "temporal_version_handling",
  "technical_leakage",
  "supported_claim_preservation"
] as const);

const reviewDirectoryPattern = new RegExp(
  `^${KNOWLEDGE_PROVIDER_ANSWER_REVIEW_DIRECTORY_PREFIX}[A-Za-z0-9_-]{6,64}$`,
  "u"
);
const privateArtifactMaxBytes = 16 * 1024 * 1024;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const reviewIdSchema = z.string().min(1).max(256);
const dimensionSchema = z.enum(providerAnswerReleaseReviewDimensions);
const assessmentSchema = z.enum([
  "pass",
  "fail",
  "uncertain",
  "not_applicable_pre_h7"
]);
const materialClassificationSchema = z.enum(["none", "material"]);
const disagreementCategorySchema = z.enum([
  "dimension_assessment",
  "material_factual_error",
  "material_citation_error"
]);

const reviewBindingsSchema = z.strictObject({
  mappingSha256: sha256Schema,
  outputCount: z.literal(KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT),
  outputFreezeSha256: sha256Schema,
  packetSha256: sha256Schema
});

const reviewerSchema = z.strictObject({
  completedIndependently: z.literal(true),
  humanAttestation: z.literal("independent_external_human_release_review"),
  implementationAgent: z.literal(false),
  modelGeneratedDecisions: z.literal(false),
  principalSha256: sha256Schema,
  provenance: z.literal("external_human"),
  role: z.literal("independent_reviewer")
});

const adjudicatorSchema = z.strictObject({
  humanAttestation: z.literal("external_human_release_review_adjudication"),
  implementationAgent: z.literal(false),
  modelGeneratedDecisions: z.literal(false),
  principalSha256: sha256Schema,
  provenance: z.literal("external_human"),
  role: z.literal("adjudicator")
});

const dimensionDecisionSchema = z.strictObject({
  assessment: assessmentSchema,
  dimension: dimensionSchema
});

const outputDecisionSchema = z.strictObject({
  dimensions: z.array(dimensionDecisionSchema).length(
    providerAnswerReleaseReviewDimensions.length
  ),
  materialErrors: z.strictObject({
    citation: materialClassificationSchema,
    factual: materialClassificationSchema
  }),
  outputSha256: sha256Schema,
  reviewId: reviewIdSchema
});

const reviewerSubmissionBodySchema = z.strictObject({
  artifactType: z.literal("knowledge_provider_answer_release_reviewer_submission"),
  artifactVersion: z.literal(KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEW_VERSION),
  bindings: reviewBindingsSchema,
  decisions: z.array(outputDecisionSchema).min(1).max(KNOWLEDGE_PROVIDER_ANSWER_MAX_CALLS),
  reviewer: reviewerSchema,
  reviewerSlot: z.enum(["reviewer_a", "reviewer_b"])
});

export const providerAnswerReleaseReviewerSubmissionSchema =
  reviewerSubmissionBodySchema.extend({
    submissionSha256: sha256Schema
  });

const disagreementResolutionSchema = z.strictObject({
  categories: z.array(disagreementCategorySchema).min(1).max(3),
  reviewId: reviewIdSchema,
  resolved: z.literal(true)
});

const adjudicationBodySchema = z.strictObject({
  adjudicator: adjudicatorSchema,
  artifactType: z.literal("knowledge_provider_answer_release_adjudication"),
  artifactVersion: z.literal(KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEW_VERSION),
  bindings: reviewBindingsSchema,
  completed: z.literal(true),
  decisions: z.array(outputDecisionSchema).min(1).max(KNOWLEDGE_PROVIDER_ANSWER_MAX_CALLS),
  disagreementResolutions: z.array(disagreementResolutionSchema)
    .max(KNOWLEDGE_PROVIDER_ANSWER_MAX_CALLS),
  reviewerSubmissionSha256s: z.tuple([sha256Schema, sha256Schema]),
  unresolvedMaterialDisagreements: z.literal(0)
});

export const providerAnswerReleaseAdjudicationSchema = adjudicationBodySchema.extend({
  adjudicationSha256: sha256Schema
});

export type ProviderAnswerReleaseReviewDimension =
  typeof providerAnswerReleaseReviewDimensions[number];
export type ProviderAnswerReleaseDimensionAssessment = z.infer<typeof assessmentSchema>;
export type ProviderAnswerReleaseOutputDecision = z.infer<typeof outputDecisionSchema>;
export type ProviderAnswerReleaseReviewer = z.infer<typeof reviewerSchema>;
export type ProviderAnswerReleaseAdjudicator = z.infer<typeof adjudicatorSchema>;
export type ProviderAnswerReleaseReviewerSubmission = z.infer<
  typeof providerAnswerReleaseReviewerSubmissionSchema
>;
export type ProviderAnswerReleaseAdjudication = z.infer<
  typeof providerAnswerReleaseAdjudicationSchema
>;
export type ProviderAnswerReleaseDisagreementResolution = z.infer<
  typeof disagreementResolutionSchema
>;

export type ProviderAnswerReleaseReviewErrorCode =
  | "knowledge_provider_answer_release_adjudication_sources_invalid"
  | "knowledge_provider_answer_release_artifact_chain_invalid"
  | "knowledge_provider_answer_release_binding_invalid"
  | "knowledge_provider_answer_release_coverage_incomplete"
  | "knowledge_provider_answer_release_directory_invalid"
  | "knowledge_provider_answer_release_directory_unsafe"
  | "knowledge_provider_answer_release_disagreement_resolution_incomplete"
  | "knowledge_provider_answer_release_human_authorities_not_distinct"
  | "knowledge_provider_answer_release_material_classification_invalid"
  | "knowledge_provider_answer_release_private_artifact_invalid"
  | "knowledge_provider_answer_release_private_artifact_unsafe"
  | "knowledge_provider_answer_release_review_artifact_invalid";

export class ProviderAnswerReleaseReviewError extends Error {
  readonly code: ProviderAnswerReleaseReviewErrorCode;

  constructor(code: ProviderAnswerReleaseReviewErrorCode) {
    super(code);
    this.code = code;
    this.name = "ProviderAnswerReleaseReviewError";
  }
}

type OutputArtifacts = Readonly<{
  freeze: ProviderAnswerOutputFreeze;
  mapping: ProviderAnswerReviewMapping;
  packet: ProviderAnswerReviewPacket;
}>;

type OutputArtifactsInput = Readonly<{
  freeze: unknown;
  mapping: unknown;
  packet: unknown;
}>;

type ValidatedReleaseReview = Readonly<{
  adjudication: ProviderAnswerReleaseAdjudication;
  artifacts: OutputArtifacts;
  submissions: readonly [
    ProviderAnswerReleaseReviewerSubmission,
    ProviderAnswerReleaseReviewerSubmission
  ];
}>;

function fail(code: ProviderAnswerReleaseReviewErrorCode): never {
  throw new ProviderAnswerReleaseReviewError(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    fail("knowledge_provider_answer_release_review_artifact_invalid");
  }
  return serialized;
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validateOutputArtifacts(input: OutputArtifactsInput): OutputArtifacts {
  const chain: unknown = {
    freeze: input.freeze,
    mapping: input.mapping,
    packet: input.packet
  };
  try {
    assertProviderAnswerReviewArtifactChain(chain);
  } catch {
    fail("knowledge_provider_answer_release_artifact_chain_invalid");
  }
  if (chain.freeze.outputCount !== KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT ||
    chain.freeze.outputs.length !== chain.freeze.outputCount ||
    chain.packet.items.length !== chain.freeze.outputCount ||
    chain.mapping.entries.length !== chain.freeze.outputCount ||
    chain.mapping.entries.some((entry) => entry.status !== "complete") ||
    new Set(chain.mapping.entries.map((entry) => entry.provider)).size !== 1) {
    fail("knowledge_provider_answer_release_coverage_incomplete");
  }
  return chain;
}

function bindingsFor(artifacts: OutputArtifacts): z.infer<typeof reviewBindingsSchema> {
  return {
    mappingSha256: artifacts.mapping.mappingSha256,
    outputCount: KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT,
    outputFreezeSha256: artifacts.freeze.freezeSha256,
    packetSha256: artifacts.packet.packetSha256
  };
}

function parseReviewerSubmission(value: unknown): ProviderAnswerReleaseReviewerSubmission {
  let parsed: ProviderAnswerReleaseReviewerSubmission;
  try {
    parsed = providerAnswerReleaseReviewerSubmissionSchema.parse(value);
  } catch {
    fail("knowledge_provider_answer_release_review_artifact_invalid");
  }
  const { submissionSha256, ...body } = parsed;
  if (canonicalSha256(body) !== submissionSha256) {
    fail("knowledge_provider_answer_release_review_artifact_invalid");
  }
  return parsed;
}

function parseAdjudication(value: unknown): ProviderAnswerReleaseAdjudication {
  let parsed: ProviderAnswerReleaseAdjudication;
  try {
    parsed = providerAnswerReleaseAdjudicationSchema.parse(value);
  } catch {
    fail("knowledge_provider_answer_release_review_artifact_invalid");
  }
  const { adjudicationSha256, ...body } = parsed;
  if (canonicalSha256(body) !== adjudicationSha256) {
    fail("knowledge_provider_answer_release_review_artifact_invalid");
  }
  return parsed;
}

function dimensionMap(
  decision: ProviderAnswerReleaseOutputDecision
): ReadonlyMap<ProviderAnswerReleaseReviewDimension, ProviderAnswerReleaseDimensionAssessment> {
  return new Map(decision.dimensions.map(({ assessment, dimension }) => [
    dimension,
    assessment
  ]));
}

function assertMaterialClassification(
  decision: ProviderAnswerReleaseOutputDecision
): void {
  const dimensions = dimensionMap(decision);
  if (decision.materialErrors.factual === "material" &&
    dimensions.get("correctness") !== "fail") {
    fail("knowledge_provider_answer_release_material_classification_invalid");
  }
  if (decision.materialErrors.citation === "material" &&
    dimensions.get("verifiability") !== "fail" &&
    dimensions.get("citation_usability") !== "fail") {
    fail("knowledge_provider_answer_release_material_classification_invalid");
  }
}

function assertDecisionCoverage(
  decisions: readonly ProviderAnswerReleaseOutputDecision[],
  artifacts: OutputArtifacts
): void {
  if (decisions.length !== artifacts.freeze.outputCount) {
    fail("knowledge_provider_answer_release_coverage_incomplete");
  }
  for (let outputIndex = 0; outputIndex < artifacts.freeze.outputs.length; outputIndex += 1) {
    const expectedOutput = artifacts.freeze.outputs[outputIndex]!;
    const decision = decisions[outputIndex];
    if (!decision || decision.reviewId !== expectedOutput.reviewId ||
      decision.outputSha256 !== expectedOutput.outputSha256 ||
      decision.dimensions.length !== providerAnswerReleaseReviewDimensions.length) {
      fail("knowledge_provider_answer_release_coverage_incomplete");
    }
    for (let dimensionIndex = 0;
      dimensionIndex < providerAnswerReleaseReviewDimensions.length;
      dimensionIndex += 1) {
      const expectedDimension = providerAnswerReleaseReviewDimensions[dimensionIndex]!;
      const dimension = decision.dimensions[dimensionIndex];
      if (!dimension || dimension.dimension !== expectedDimension ||
        (dimension.assessment === "not_applicable_pre_h7" &&
          dimension.dimension !== "supported_claim_preservation")) {
        fail("knowledge_provider_answer_release_coverage_incomplete");
      }
    }
    assertMaterialClassification(decision);
  }
}

function assertSubmissionBinding(
  submission: ProviderAnswerReleaseReviewerSubmission,
  artifacts: OutputArtifacts
): void {
  if (!sameCanonical(submission.bindings, bindingsFor(artifacts))) {
    fail("knowledge_provider_answer_release_binding_invalid");
  }
  assertDecisionCoverage(submission.decisions, artifacts);
}

function expectedDisagreementResolutions(input: Readonly<{
  adjudicated: readonly ProviderAnswerReleaseOutputDecision[];
  first: readonly ProviderAnswerReleaseOutputDecision[];
  second: readonly ProviderAnswerReleaseOutputDecision[];
}>): ProviderAnswerReleaseDisagreementResolution[] {
  const resolutions: ProviderAnswerReleaseDisagreementResolution[] = [];
  for (let index = 0; index < input.adjudicated.length; index += 1) {
    const first = input.first[index]!;
    const second = input.second[index]!;
    const adjudicated = input.adjudicated[index]!;
    const categories: z.infer<typeof disagreementCategorySchema>[] = [];
    const dimensionShapes = [first, second, adjudicated].map(({ dimensions }) =>
      dimensions.map(({ assessment, dimension }) => ({ assessment, dimension })));
    if (!sameCanonical(dimensionShapes[0], dimensionShapes[1]) ||
      !sameCanonical(dimensionShapes[0], dimensionShapes[2])) {
      categories.push("dimension_assessment");
    }
    const factual = [first, second, adjudicated]
      .map((decision) => decision.materialErrors.factual);
    if (new Set(factual).size > 1) categories.push("material_factual_error");
    const citation = [first, second, adjudicated]
      .map((decision) => decision.materialErrors.citation);
    if (new Set(citation).size > 1) categories.push("material_citation_error");
    if (categories.length > 0) {
      resolutions.push({
        categories,
        resolved: true,
        reviewId: adjudicated.reviewId
      });
    }
  }
  return resolutions;
}

function validateReleaseReview(input: Readonly<{
  adjudication: unknown;
  freeze: unknown;
  mapping: unknown;
  packet: unknown;
  submissions: readonly [unknown, unknown];
}>): ValidatedReleaseReview {
  const artifacts = validateOutputArtifacts(input);
  const parsedSubmissions = input.submissions.map(parseReviewerSubmission) as [
    ProviderAnswerReleaseReviewerSubmission,
    ProviderAnswerReleaseReviewerSubmission
  ];
  const submissions = [...parsedSubmissions].sort((left, right) =>
    left.reviewerSlot.localeCompare(right.reviewerSlot)) as [
    ProviderAnswerReleaseReviewerSubmission,
    ProviderAnswerReleaseReviewerSubmission
  ];
  const adjudication = parseAdjudication(input.adjudication);
  if (submissions[0].reviewerSlot !== "reviewer_a" ||
    submissions[1].reviewerSlot !== "reviewer_b") {
    fail("knowledge_provider_answer_release_human_authorities_not_distinct");
  }
  const principals = [
    submissions[0].reviewer.principalSha256,
    submissions[1].reviewer.principalSha256,
    adjudication.adjudicator.principalSha256
  ];
  if (new Set(principals).size !== principals.length) {
    fail("knowledge_provider_answer_release_human_authorities_not_distinct");
  }
  for (const submission of submissions) assertSubmissionBinding(submission, artifacts);
  if (!sameCanonical(adjudication.bindings, bindingsFor(artifacts))) {
    fail("knowledge_provider_answer_release_binding_invalid");
  }
  assertDecisionCoverage(adjudication.decisions, artifacts);
  const expectedSubmissionSha256s = submissions.map(({ submissionSha256 }) =>
    submissionSha256) as [string, string];
  if (!sameCanonical(
    adjudication.reviewerSubmissionSha256s,
    expectedSubmissionSha256s
  )) {
    fail("knowledge_provider_answer_release_adjudication_sources_invalid");
  }
  const expectedResolutions = expectedDisagreementResolutions({
    adjudicated: adjudication.decisions,
    first: submissions[0].decisions,
    second: submissions[1].decisions
  });
  if (!sameCanonical(adjudication.disagreementResolutions, expectedResolutions)) {
    fail("knowledge_provider_answer_release_disagreement_resolution_incomplete");
  }
  return Object.freeze({ adjudication, artifacts, submissions });
}

/**
 * Seals decisions supplied by an external reviewer. It never infers, fills,
 * copies, or otherwise authors a review decision.
 */
export function createProviderAnswerReleaseReviewerSubmission(input: Readonly<{
  artifacts: OutputArtifactsInput;
  decisions: readonly ProviderAnswerReleaseOutputDecision[];
  reviewer: ProviderAnswerReleaseReviewer;
  reviewerSlot: "reviewer_a" | "reviewer_b";
}>): ProviderAnswerReleaseReviewerSubmission {
  const artifacts = validateOutputArtifacts(input.artifacts);
  let body: z.infer<typeof reviewerSubmissionBodySchema>;
  try {
    body = reviewerSubmissionBodySchema.parse({
      artifactType: "knowledge_provider_answer_release_reviewer_submission",
      artifactVersion: KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEW_VERSION,
      bindings: bindingsFor(artifacts),
      decisions: input.decisions,
      reviewer: input.reviewer,
      reviewerSlot: input.reviewerSlot
    });
  } catch {
    fail("knowledge_provider_answer_release_review_artifact_invalid");
  }
  const submission = parseReviewerSubmission({
    ...body,
    submissionSha256: canonicalSha256(body)
  });
  assertSubmissionBinding(submission, artifacts);
  return Object.freeze(submission);
}

/** Seals externally supplied adjudication; no decisions are synthesized. */
export function createProviderAnswerReleaseAdjudication(input: Readonly<{
  adjudicator: ProviderAnswerReleaseAdjudicator;
  artifacts: OutputArtifactsInput;
  decisions: readonly ProviderAnswerReleaseOutputDecision[];
  disagreementResolutions: readonly ProviderAnswerReleaseDisagreementResolution[];
  submissions: readonly [
    ProviderAnswerReleaseReviewerSubmission,
    ProviderAnswerReleaseReviewerSubmission
  ];
}>): ProviderAnswerReleaseAdjudication {
  const artifacts = validateOutputArtifacts(input.artifacts);
  const submissions = [...input.submissions].sort((left, right) =>
    left.reviewerSlot.localeCompare(right.reviewerSlot)) as [
    ProviderAnswerReleaseReviewerSubmission,
    ProviderAnswerReleaseReviewerSubmission
  ];
  for (const submission of submissions) {
    assertSubmissionBinding(parseReviewerSubmission(submission), artifacts);
  }
  let body: z.infer<typeof adjudicationBodySchema>;
  try {
    body = adjudicationBodySchema.parse({
      adjudicator: input.adjudicator,
      artifactType: "knowledge_provider_answer_release_adjudication",
      artifactVersion: KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEW_VERSION,
      bindings: bindingsFor(artifacts),
      completed: true,
      decisions: input.decisions,
      disagreementResolutions: input.disagreementResolutions,
      reviewerSubmissionSha256s: submissions.map(({ submissionSha256 }) => submissionSha256),
      unresolvedMaterialDisagreements: 0
    });
  } catch {
    fail("knowledge_provider_answer_release_review_artifact_invalid");
  }
  const adjudication = parseAdjudication({
    ...body,
    adjudicationSha256: canonicalSha256(body)
  });
  validateReleaseReview({
    adjudication,
    ...artifacts,
    submissions
  });
  return Object.freeze(adjudication);
}

export function providerAnswerReleaseReviewerSubmissionSha256(value: unknown): string {
  return parseReviewerSubmission(value).submissionSha256;
}

export function providerAnswerReleaseAdjudicationSha256(value: unknown): string {
  return parseAdjudication(value).adjudicationSha256;
}

/** Validates the frozen-output-to-adjudication chain without projecting labels. */
export function assertProviderAnswerReleaseReviewArtifacts(input: Readonly<{
  adjudication: unknown;
  freeze: unknown;
  mapping: unknown;
  packet: unknown;
  submissions: readonly [unknown, unknown];
}>): void {
  validateReleaseReview(input);
}

type AssessmentCounts = Readonly<Record<ProviderAnswerReleaseDimensionAssessment, number>>;

export type ProviderAnswerReleaseReviewReasonCode =
  | "citation_viewer_artifacts_not_persisted"
  | "dimension_failure_or_uncertainty"
  | "external_human_provenance_unverified"
  | "material_citation_error"
  | "material_factual_error"
  | "supported_claim_preservation_not_assessed_or_failed";

export type ProviderAnswerReleaseReviewReport = Readonly<{
  aggregateOnly: true;
  artifactBindings: Readonly<{
    adjudicationSha256: string;
    mappingSha256: string;
    outputFreezeSha256: string;
    packetSha256: string;
    reviewerSubmissionSha256s: readonly [string, string];
  }>;
  artifactVersion: typeof KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEW_VERSION;
  citationViewerArtifacts: Readonly<{
    allPersistedRoute: boolean;
    persistedRouteCount: number;
    syntheticProjectionCount: number;
    totalCount: number;
  }>;
  dimensions: Readonly<Record<ProviderAnswerReleaseReviewDimension, AssessmentCounts>>;
  disagreement: Readonly<{
    citationMaterialClassificationCount: number;
    dimensionAssessmentCount: number;
    factualMaterialClassificationCount: number;
    outputsRequiringAdjudication: number;
  }>;
  gates: Readonly<{
    citationViewerGatePassed: boolean;
    fullProductionReleaseEligible: false;
    humanProvenanceGatePassed: false;
    materialErrorGatePassed: boolean;
    outputReviewGatePassed: boolean;
    reasonCodes: readonly ProviderAnswerReleaseReviewReasonCode[];
    supportedClaimPreservation:
      | "failed_or_unresolved"
      | "not_applicable_pre_h7"
      | "passed";
  }>;
  materialErrors: Readonly<{
    citationOutputCount: number;
    factualOutputCount: number;
    outputCount: number;
  }>;
  privateContentIncluded: false;
  review: Readonly<{
    adjudicationComplete: true;
    adjudicatorCount: 1;
    allArtifactsFrozenBeforeReview: true;
    independentReviewerCount: 2;
    provenanceVerification: "self_attested_unverified";
    reviewedDimensionDecisionCount: number;
    reviewedOutputCount: number;
    unresolvedMaterialDisagreements: 0;
  }>;
}>;

function emptyAssessmentCounts(): Record<ProviderAnswerReleaseDimensionAssessment, number> {
  return {
    fail: 0,
    not_applicable_pre_h7: 0,
    pass: 0,
    uncertain: 0
  };
}

/**
 * Imports private externally authored decisions and returns only a bounded,
 * content-free aggregate. Per-output decisions and human principals are not
 * present in the returned value.
 */
export function importProviderAnswerReleaseReviewEvidence(input: Readonly<{
  adjudication: unknown;
  freeze: unknown;
  mapping: unknown;
  packet: unknown;
  submissions: readonly [unknown, unknown];
}>): ProviderAnswerReleaseReviewReport {
  const validated = validateReleaseReview(input);
  const dimensions = Object.fromEntries(providerAnswerReleaseReviewDimensions.map((dimension) => [
    dimension,
    emptyAssessmentCounts()
  ])) as Record<ProviderAnswerReleaseReviewDimension, Record<
    ProviderAnswerReleaseDimensionAssessment,
    number
  >>;
  for (const output of validated.adjudication.decisions) {
    for (const decision of output.dimensions) {
      dimensions[decision.dimension][decision.assessment] += 1;
    }
  }
  const factualOutputCount = validated.adjudication.decisions.filter((decision) =>
    decision.materialErrors.factual === "material").length;
  const citationOutputCount = validated.adjudication.decisions.filter((decision) =>
    decision.materialErrors.citation === "material").length;
  const materialOutputCount = validated.adjudication.decisions.filter((decision) =>
    decision.materialErrors.factual === "material" ||
    decision.materialErrors.citation === "material").length;
  const supported = dimensions.supported_claim_preservation;
  const supportedClaimPreservation = supported.pass === validated.artifacts.freeze.outputCount
    ? "passed" as const
    : supported.not_applicable_pre_h7 === validated.artifacts.freeze.outputCount
      ? "not_applicable_pre_h7" as const
      : "failed_or_unresolved" as const;
  const nonPassingApplicableDecisionCount = providerAnswerReleaseReviewDimensions
    .reduce((total, dimension) => total + dimensions[dimension].fail +
      dimensions[dimension].uncertain, 0);
  const materialErrorGatePassed = materialOutputCount === 0;
  const outputReviewGatePassed = materialErrorGatePassed &&
    nonPassingApplicableDecisionCount === 0 &&
    supportedClaimPreservation !== "failed_or_unresolved";
  const viewerArtifacts = validated.artifacts.packet.items.flatMap((item) =>
    item.citationViewerArtifacts);
  const persistedRouteCount = viewerArtifacts.filter((artifact) =>
    artifact.provenance === "persisted_route" && artifact.releaseEvidenceEligible).length;
  const syntheticProjectionCount = viewerArtifacts.filter((artifact) =>
    artifact.provenance === "synthetic_projection" && !artifact.releaseEvidenceEligible).length;
  const citationViewerGatePassed = persistedRouteCount === viewerArtifacts.length;
  const resolutionCategoryCount = (category: z.infer<typeof disagreementCategorySchema>) =>
    validated.adjudication.disagreementResolutions.filter((resolution) =>
      resolution.categories.includes(category)).length;
  const reasonCodes: ProviderAnswerReleaseReviewReasonCode[] = [];
  if (!citationViewerGatePassed) {
    reasonCodes.push("citation_viewer_artifacts_not_persisted");
  }
  if (nonPassingApplicableDecisionCount > 0) {
    reasonCodes.push("dimension_failure_or_uncertainty");
  }
  if (citationOutputCount > 0) reasonCodes.push("material_citation_error");
  if (factualOutputCount > 0) reasonCodes.push("material_factual_error");
  if (supportedClaimPreservation !== "passed") {
    reasonCodes.push("supported_claim_preservation_not_assessed_or_failed");
  }
  reasonCodes.push("external_human_provenance_unverified");
  const frozenDimensions = Object.freeze(Object.fromEntries(
    providerAnswerReleaseReviewDimensions.map((dimension) => [
      dimension,
      Object.freeze({ ...dimensions[dimension] })
    ])
  ) as Readonly<Record<ProviderAnswerReleaseReviewDimension, AssessmentCounts>>);
  return Object.freeze({
    aggregateOnly: true,
    artifactBindings: Object.freeze({
      adjudicationSha256: validated.adjudication.adjudicationSha256,
      mappingSha256: validated.artifacts.mapping.mappingSha256,
      outputFreezeSha256: validated.artifacts.freeze.freezeSha256,
      packetSha256: validated.artifacts.packet.packetSha256,
      reviewerSubmissionSha256s: Object.freeze([
        validated.submissions[0].submissionSha256,
        validated.submissions[1].submissionSha256
      ] as const)
    }),
    artifactVersion: KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEW_VERSION,
    citationViewerArtifacts: Object.freeze({
      allPersistedRoute: citationViewerGatePassed,
      persistedRouteCount,
      syntheticProjectionCount,
      totalCount: viewerArtifacts.length
    }),
    dimensions: frozenDimensions,
    disagreement: Object.freeze({
      citationMaterialClassificationCount: resolutionCategoryCount(
        "material_citation_error"
      ),
      dimensionAssessmentCount: resolutionCategoryCount("dimension_assessment"),
      factualMaterialClassificationCount: resolutionCategoryCount(
        "material_factual_error"
      ),
      outputsRequiringAdjudication:
        validated.adjudication.disagreementResolutions.length
    }),
    gates: Object.freeze({
      citationViewerGatePassed,
      fullProductionReleaseEligible: false,
      humanProvenanceGatePassed: false,
      materialErrorGatePassed,
      outputReviewGatePassed,
      reasonCodes: Object.freeze(reasonCodes),
      supportedClaimPreservation
    }),
    materialErrors: Object.freeze({
      citationOutputCount,
      factualOutputCount,
      outputCount: materialOutputCount
    }),
    privateContentIncluded: false,
    review: Object.freeze({
      adjudicationComplete: true,
      adjudicatorCount: 1,
      allArtifactsFrozenBeforeReview: true,
      independentReviewerCount: 2,
      provenanceVerification: "self_attested_unverified",
      reviewedDimensionDecisionCount:
        validated.artifacts.freeze.outputCount * providerAnswerReleaseReviewDimensions.length,
      reviewedOutputCount: validated.artifacts.freeze.outputCount,
      unresolvedMaterialDisagreements: 0
    })
  });
}

const reviewImportFiles = Object.freeze([
  KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEWER_A_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEWER_B_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_RELEASE_ADJUDICATION_FILE
].sort());

async function validateImportDirectory(reviewDirectory: string): Promise<void> {
  if (!reviewDirectory || !isAbsolute(reviewDirectory) ||
    resolve(reviewDirectory) !== reviewDirectory || dirname(reviewDirectory) !== "/tmp" ||
    !reviewDirectoryPattern.test(basename(reviewDirectory))) {
    fail("knowledge_provider_answer_release_directory_invalid");
  }
  try {
    const [details, canonical, entries] = await Promise.all([
      lstat(reviewDirectory),
      realpath(reviewDirectory),
      readdir(reviewDirectory)
    ]);
    const processUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!details.isDirectory() || details.isSymbolicLink() ||
      canonical !== reviewDirectory || (details.mode & 0o777) !== 0o700 ||
      (processUid !== null && details.uid !== processUid) ||
      !sameCanonical([...entries].sort(), reviewImportFiles)) {
      fail("knowledge_provider_answer_release_directory_unsafe");
    }
  } catch (error) {
    if (error instanceof ProviderAnswerReleaseReviewError) throw error;
    fail("knowledge_provider_answer_release_directory_unsafe");
  }
}

async function readPrivateJson(reviewDirectory: string, fileName: string): Promise<unknown> {
  const path = resolve(reviewDirectory, fileName);
  try {
    const details = await lstat(path);
    const processUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!details.isFile() || details.isSymbolicLink() || details.size < 2 ||
      details.size > privateArtifactMaxBytes || (details.mode & 0o777) !== 0o600 ||
      (processUid !== null && details.uid !== processUid)) {
      fail("knowledge_provider_answer_release_private_artifact_unsafe");
    }
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof ProviderAnswerReleaseReviewError) throw error;
    fail("knowledge_provider_answer_release_private_artifact_invalid");
  }
}

/** Reads only the exact owner-only output and human-review artifact set. */
export async function readProviderAnswerReleaseReviewEvidenceDirectory(
  reviewDirectory: string
): Promise<ProviderAnswerReleaseReviewReport> {
  await validateImportDirectory(reviewDirectory);
  const [freeze, mapping, packet, reviewerA, reviewerB, adjudication] = await Promise.all([
    readPrivateJson(reviewDirectory, KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE),
    readPrivateJson(reviewDirectory, KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE),
    readPrivateJson(reviewDirectory, KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE),
    readPrivateJson(reviewDirectory, KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEWER_A_FILE),
    readPrivateJson(reviewDirectory, KNOWLEDGE_PROVIDER_ANSWER_RELEASE_REVIEWER_B_FILE),
    readPrivateJson(reviewDirectory, KNOWLEDGE_PROVIDER_ANSWER_RELEASE_ADJUDICATION_FILE)
  ]);
  return importProviderAnswerReleaseReviewEvidence({
    adjudication,
    freeze,
    mapping,
    packet,
    submissions: [reviewerA, reviewerB]
  });
}

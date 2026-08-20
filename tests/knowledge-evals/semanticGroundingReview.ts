import { createHash, randomInt, randomUUID } from "node:crypto";
import { chmod, lstat, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  type KnowledgeEvidencePackage,
  type KnowledgeEvidencePackageItem
} from "../../lib/server/knowledge/evidencePackage";
import {
  KNOWLEDGE_SEMANTIC_GROUNDING_CONTRACT_VERSION,
  knowledgeSemanticGroundingDecisions,
  segmentKnowledgeSemanticClaims,
  type KnowledgeSemanticGroundingClaim,
  type KnowledgeSemanticGroundingDecision
} from "../../lib/server/knowledge/semanticGrounding";
import {
  createKnowledgeSemanticGroundingCandidatePool,
  type KnowledgeSemanticCandidatePool
} from "./semanticGroundingCandidates";
import { knowledgeSemanticGroundingFixtures } from "./semanticGroundingFixtures";
import { KNOWLEDGE_H0_ANNOTATION_GUIDE } from "./h0AnnotationGuide";

export const KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_VERSION =
  "knowledge-semantic-grounding-review-v3" as const;
export const KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_PACKET_FILE = "review-packet.json" as const;
export const KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_MAPPING_FILE = "review-mapping.json" as const;
export const KNOWLEDGE_SEMANTIC_GROUNDING_REVIEWER_A_FILE =
  "reviewer-a-submission.json" as const;
export const KNOWLEDGE_SEMANTIC_GROUNDING_REVIEWER_B_FILE =
  "reviewer-b-submission.json" as const;
export const KNOWLEDGE_SEMANTIC_GROUNDING_ADJUDICATION_FILE = "adjudication.json" as const;
export const KNOWLEDGE_SEMANTIC_GROUNDING_TRUST_EVIDENCE_FILE =
  "human-trust-evidence.json" as const;

const REVIEW_DIRECTORY_PATTERN =
  /^aiqsa-knowledge-semantic-review-[A-Za-z0-9_-]{6,64}$/u;
const REVIEW_ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const opaqueIdSchema = z.string().uuid();
const languageSchema = z.enum(["en", "ru"]);
const splitSchema = z.enum(["development", "calibration", "held_out", "blinded_review"]);
const reviewScopeSchema = z.enum(["calibration", "final"]);
const reviewEvaluationBindingsSchema = z.strictObject({
  calibrationFreezeManifestSha256: sha256Schema.nullable(),
  candidateFreezeManifestSha256: sha256Schema,
  finalPredictionFreezeManifestSha256: sha256Schema.nullable()
});
const decisionSchema = z.enum(knowledgeSemanticGroundingDecisions);
const claimTypeSchema = z.enum([
  "comparison",
  "coverage_claim",
  "derived_arithmetic",
  "explicit_inference",
  "general_knowledge",
  "non_factual",
  "source_fact",
  "source_summary",
  "temporal_observation",
  "versioned_fact"
]);
const sourceShapeSchema = z.enum(["list", "prose", "table_cell"]);
const neighborhoodRuleSchema = z.enum(["inline", "none", "table_cell", "table_row_inherited"]);
const disagreementCategorySchema = z.enum([
  "citation_binding",
  "claim_segmentation",
  "materiality",
  "support_label",
  "temporal_context"
]);

const humanReviewerSchema = z.strictObject({
  humanAttestation: z.literal("independent_human_semantic_review"),
  id: z.string().regex(/^human-reviewer-[A-Za-z0-9_-]{4,64}$/u),
  implementationAgent: z.literal(false),
  provenance: z.literal("external_human")
});

const reviewEvidenceSchema = z.strictObject({
  ambiguous: z.boolean(),
  baseName: z.string().nullable(),
  citationHandle: z.string().regex(/^K[1-9]\d{0,3}(?:\.[1-9]\d?)?$/u),
  contentHash: z.string().nullable(),
  contextBoundaries: z.unknown().nullable(),
  evidenceSha256: sha256Schema,
  excerpt: z.string().nullable(),
  headingPath: z.array(z.string()),
  locator: z.unknown().nullable(),
  locatorState: z.enum(["deleted", "invalid", "missing", "valid"]),
  reviewEvidenceId: opaqueIdSchema,
  sourceName: z.string().nullable(),
  sourceVersionNumber: z.number().int().min(1).nullable(),
  state: z.enum(["available", "deleted"]),
  textTruncated: z.boolean().nullable()
});

const reviewClaimShapeSchema = z.strictObject({
  answerEnd: z.number().int().nonnegative(),
  answerStart: z.number().int().nonnegative(),
  citationHandles: z.array(z.string()),
  context: z.array(z.string()),
  neighborhoodRule: neighborhoodRuleSchema,
  neighborhoodVersion: z.number().int().positive(),
  ordinal: z.number().int().positive(),
  sourceShape: sourceShapeSchema,
  text: z.string().min(1),
  type: claimTypeSchema,
  unknownCitationHandles: z.array(z.string())
});

const packetClaimSchema = z.strictObject({
  answerText: z.string().min(1),
  claim: reviewClaimShapeSchema,
  claimSha256: sha256Schema,
  coverage: z.strictObject({
    expectedPassageCount: z.number().int().nonnegative().nullable(),
    mode: z.enum(["partial", "verified_only"]),
    verified: z.boolean()
  }),
  evidence: z.array(reviewEvidenceSchema),
  language: languageSchema,
  neighborhoodSha256: sha256Schema,
  queryText: z.string().min(1),
  reviewClaimId: opaqueIdSchema
});

const reviewPacketSchema = z.strictObject({
  annotationGuideVersion: z.literal(KNOWLEDGE_H0_ANNOTATION_GUIDE.version),
  artifactType: z.literal("knowledge_semantic_grounding_blind_packet"),
  artifactVersion: z.literal(KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_VERSION),
  claimCount: z.number().int().positive(),
  contractVersion: z.literal(KNOWLEDGE_SEMANTIC_GROUNDING_CONTRACT_VERSION),
  corpusSha256: sha256Schema,
  evaluationCommitmentSha256: sha256Schema,
  instructions: z.strictObject({
    attribution: z.literal(
      "Select only opaque evidence ids from this claim's displayed neighborhood."
    ),
    decisions: z.tuple([
      z.literal("supported: the displayed neighborhood supports the material claim"),
      z.literal("unsupported: the displayed neighborhood does not support a material part"),
      z.literal("contradicted: displayed same-context evidence is incompatible with the claim"),
      z.literal("uncertain: ambiguity or insufficient displayed context prevents a stable decision")
    ]),
    independence: z.literal(
      "Complete this packet independently, without consulting another annotator or model output."
    ),
    scope: z.literal(
      "Judge only the marked claim and its displayed local neighborhood; treat omitted evidence as unavailable."
    )
  }),
  packetSha256: sha256Schema,
  poolSha256: sha256Schema,
  reviewScope: reviewScopeSchema,
  claims: z.array(packetClaimSchema).min(1)
});

const mappingEvidenceSchema = z.strictObject({
  evidenceSha256: sha256Schema,
  handle: z.string(),
  reviewEvidenceId: opaqueIdSchema
});

const mappingEntrySchema = z.strictObject({
  claimOrdinal: z.number().int().positive(),
  claimSha256: sha256Schema,
  documentFamilySha256: sha256Schema,
  evidence: z.array(mappingEvidenceSchema),
  fixtureId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u),
  language: languageSchema,
  neighborhoodSha256: sha256Schema,
  reviewClaimId: opaqueIdSchema,
  split: splitSchema
});

const reviewMappingSchema = z.strictObject({
  annotationGuideVersion: z.literal(KNOWLEDGE_H0_ANNOTATION_GUIDE.version),
  artifactType: z.literal("knowledge_semantic_grounding_review_mapping"),
  artifactVersion: z.literal(KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_VERSION),
  corpusSha256: sha256Schema,
  corpusVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u),
  entries: z.array(mappingEntrySchema).min(1),
  evaluationBindings: reviewEvaluationBindingsSchema,
  evaluationCommitmentSha256: sha256Schema,
  mappingSha256: sha256Schema,
  packetSha256: sha256Schema,
  poolSha256: sha256Schema,
  reviewScope: reviewScopeSchema
});

const reviewClaimDecisionSchema = z.strictObject({
  attributableEvidenceIds: z.array(opaqueIdSchema),
  decision: decisionSchema,
  reviewClaimId: opaqueIdSchema
});

export const knowledgeSemanticGroundingReviewerSubmissionSchema = z.strictObject({
  artifactType: z.literal("knowledge_semantic_grounding_reviewer_submission"),
  artifactVersion: z.literal(KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_VERSION),
  claims: z.array(reviewClaimDecisionSchema).min(1),
  corpusSha256: sha256Schema,
  packetSha256: sha256Schema,
  poolSha256: sha256Schema,
  reviewer: humanReviewerSchema
});

export const knowledgeSemanticGroundingAdjudicationSchema = z.strictObject({
  adjudicator: humanReviewerSchema,
  annotatorSubmissionSha256s: z.tuple([sha256Schema, sha256Schema]),
  artifactType: z.literal("knowledge_semantic_grounding_adjudication"),
  artifactVersion: z.literal(KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_VERSION),
  claims: z.array(reviewClaimDecisionSchema).min(1),
  completed: z.literal(true),
  corpusSha256: sha256Schema,
  disagreementResolutions: z.array(z.strictObject({
    categories: z.array(disagreementCategorySchema).min(1),
    reviewClaimId: opaqueIdSchema
  })),
  packetSha256: sha256Schema,
  poolSha256: sha256Schema,
  unresolvedMaterialDisagreements: z.literal(0)
});

export type KnowledgeSemanticGroundingReviewPacket = z.infer<typeof reviewPacketSchema>;
export type KnowledgeSemanticGroundingReviewMapping = z.infer<typeof reviewMappingSchema>;
export type KnowledgeSemanticGroundingReviewerSubmission = z.infer<
  typeof knowledgeSemanticGroundingReviewerSubmissionSchema
>;
export type KnowledgeSemanticGroundingAdjudication = z.infer<
  typeof knowledgeSemanticGroundingAdjudicationSchema
>;
export type KnowledgeSemanticGroundingReviewLanguage = z.infer<typeof languageSchema>;
export type KnowledgeSemanticGroundingReviewSplit = z.infer<typeof splitSchema>;
export type KnowledgeSemanticGroundingReviewScope = z.infer<typeof reviewScopeSchema>;

const reviewScopeSplits = Object.freeze({
  calibration: Object.freeze(["calibration"] as const),
  final: Object.freeze(["development", "held_out", "blinded_review"] as const)
});

function splitsForReviewScope(
  scope: KnowledgeSemanticGroundingReviewScope
): readonly KnowledgeSemanticGroundingReviewSplit[] {
  return reviewScopeSplits[scope];
}

function assertReviewEvaluationBindings(
  scope: KnowledgeSemanticGroundingReviewScope,
  bindings: z.infer<typeof reviewEvaluationBindingsSchema>
): void {
  const finalBindingsPresent = bindings.calibrationFreezeManifestSha256 !== null &&
    bindings.finalPredictionFreezeManifestSha256 !== null;
  if ((scope === "calibration" &&
      (bindings.calibrationFreezeManifestSha256 !== null ||
        bindings.finalPredictionFreezeManifestSha256 !== null)) ||
    (scope === "final" && !finalBindingsPresent)) {
    throw new Error("knowledge_semantic_review_evaluation_binding_invalid");
  }
}

export type KnowledgeSemanticGroundingReviewFixture = Readonly<{
  answer: string;
  documentFamily: string;
  evidence: KnowledgeEvidencePackage;
  id: string;
  language: KnowledgeSemanticGroundingReviewLanguage;
  split: KnowledgeSemanticGroundingReviewSplit;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

function shuffle<T>(values: readonly T[], randomIndex: (maximum: number) => number): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = randomIndex(index + 1);
    if (!Number.isSafeInteger(target) || target < 0 || target > index) {
      throw new Error("knowledge_semantic_review_random_index_invalid");
    }
    [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
  }
  return shuffled;
}

function claimShape(claim: KnowledgeSemanticGroundingClaim): z.infer<
  typeof reviewClaimShapeSchema
> {
  return {
    answerEnd: claim.answerEnd,
    answerStart: claim.answerStart,
    citationHandles: [...claim.citationHandles],
    context: [...claim.context],
    neighborhoodRule: claim.neighborhoodRule,
    neighborhoodVersion: claim.neighborhoodVersion,
    ordinal: claim.ordinal,
    sourceShape: claim.sourceShape,
    text: claim.text,
    type: claim.type,
    unknownCitationHandles: [...claim.unknownCitationHandles]
  };
}

function evidenceShape(
  item: KnowledgeEvidencePackageItem,
  locatorState: KnowledgeSemanticGroundingClaim["locatorStates"][number]["state"],
  reviewEvidenceId: string
): Omit<z.infer<typeof reviewEvidenceSchema>, "evidenceSha256"> {
  return {
    ambiguous: item.contextBoundaries?.layoutKind === "table_ambiguous" ||
      item.contextBoundaries?.layoutKind === "field_ambiguous",
    baseName: item.baseName,
    citationHandle: item.handle,
    contentHash: item.contentHash,
    contextBoundaries: item.contextBoundaries,
    excerpt: item.excerpt,
    headingPath: [...item.headingPath],
    locator: item.locator,
    locatorState,
    reviewEvidenceId,
    sourceName: item.sourceName,
    sourceVersionNumber: item.sourceVersionNumber,
    state: item.state,
    textTruncated: item.textTruncated
  };
}

function evidenceContentShape(
  evidence: Omit<z.infer<typeof reviewEvidenceSchema>, "evidenceSha256">
): unknown {
  const { reviewEvidenceId: _reviewEvidenceId, ...content } = evidence;
  return content;
}

function claimSha256(claim: z.infer<typeof reviewClaimShapeSchema>): string {
  return sha256(JSON.stringify({
    answerEnd: claim.answerEnd,
    answerStart: claim.answerStart,
    context: claim.context,
    ordinal: claim.ordinal,
    sourceShape: claim.sourceShape,
    text: claim.text,
    type: claim.type
  }));
}

function evidenceSha256(
  evidence: Omit<z.infer<typeof reviewEvidenceSchema>, "evidenceSha256">
): string {
  return canonicalSha256(evidenceContentShape(evidence));
}

function neighborhoodSha256(input: Readonly<{
  claim: z.infer<typeof reviewClaimShapeSchema>;
  evidence: readonly z.infer<typeof reviewEvidenceSchema>[];
}>): string {
  return sha256(JSON.stringify({
    citationHandles: input.claim.citationHandles,
    evidence: input.evidence.map((entry) => ({
      ambiguous: entry.ambiguous,
      contentHash: entry.contentHash,
      handle: entry.citationHandle,
      locatorState: entry.locatorState,
      state: entry.state,
      text: entry.excerpt
    })),
    neighborhoodRule: input.claim.neighborhoodRule,
    neighborhoodVersion: input.claim.neighborhoodVersion,
    unknownCitationHandles: input.claim.unknownCitationHandles
  }));
}

type PreparedClaim = Readonly<{
  claim: KnowledgeSemanticGroundingClaim;
  claimSha256: string;
  fixture: KnowledgeSemanticGroundingReviewFixture;
  neighborhoodSha256: string;
  packetEvidence: readonly z.infer<typeof reviewEvidenceSchema>[];
  reviewClaimId: string;
}>;

function assertUniqueOpaqueIds(prepared: readonly PreparedClaim[]): void {
  const claimIds = prepared.map((entry) => entry.reviewClaimId);
  const evidenceIds = prepared.flatMap((entry) =>
    entry.packetEvidence.map((evidence) => evidence.reviewEvidenceId));
  const allIds = [...claimIds, ...evidenceIds];
  if (new Set(allIds).size !== allIds.length) {
    throw new Error("knowledge_semantic_review_opaque_id_duplicate");
  }
}

export function createKnowledgeSemanticGroundingReviewArtifacts(input: Readonly<{
  candidatePool?: KnowledgeSemanticCandidatePool;
  corpusVersion: string;
  evaluationBindings: z.infer<typeof reviewEvaluationBindingsSchema>;
  fixtures: readonly KnowledgeSemanticGroundingReviewFixture[];
  randomId?: () => string;
  randomIndex?: (maximum: number) => number;
  reviewScope: KnowledgeSemanticGroundingReviewScope;
}>): Readonly<{
  mapping: KnowledgeSemanticGroundingReviewMapping;
  packet: KnowledgeSemanticGroundingReviewPacket;
}> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(input.corpusVersion) ||
    input.fixtures.length < 1) {
    throw new Error("knowledge_semantic_review_corpus_invalid");
  }
  const reviewScope = reviewScopeSchema.parse(input.reviewScope);
  const evaluationBindings = reviewEvaluationBindingsSchema.parse(input.evaluationBindings);
  assertReviewEvaluationBindings(reviewScope, evaluationBindings);
  const evaluationCommitmentSha256 = canonicalSha256({
    bindings: evaluationBindings,
    reviewScope
  });
  const includedSplits = new Set<KnowledgeSemanticGroundingReviewSplit>(
    splitsForReviewScope(reviewScope)
  );
  const selectedFixtures = input.fixtures.filter((fixture) => includedSplits.has(fixture.split));
  if (selectedFixtures.length < 1) {
    throw new Error("knowledge_semantic_review_scope_empty");
  }
  const fixtureIds = selectedFixtures.map((fixture) => fixture.id);
  if (new Set(fixtureIds).size !== fixtureIds.length) {
    throw new Error("knowledge_semantic_review_fixture_id_duplicate");
  }
  const randomId = input.randomId ?? randomUUID;
  const randomIndex = input.randomIndex ?? randomInt;
  const frozenCandidatePool = createKnowledgeSemanticGroundingCandidatePool();
  const candidatePool = input.candidatePool ?? frozenCandidatePool;
  if (candidatePool.corpusVersion !== input.corpusVersion ||
    candidatePool.corpusSha256 !== frozenCandidatePool.corpusSha256 ||
    candidatePool.poolSha256 !== frozenCandidatePool.poolSha256 ||
    !candidatePool.labelsExcludedFromPool || !candidatePool.samePoolForEveryCandidate) {
    throw new Error("knowledge_semantic_review_candidate_pool_invalid");
  }
  const poolEntries = new Map(candidatePool.entries.map((entry) => [
    `${entry.fixtureId}:${entry.ordinal}`,
    entry
  ]));
  if (poolEntries.size !== candidatePool.entries.length) {
    throw new Error("knowledge_semantic_review_candidate_pool_duplicate");
  }
  const prepared: PreparedClaim[] = [];
  for (const fixture of selectedFixtures) {
    languageSchema.parse(fixture.language);
    splitSchema.parse(fixture.split);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u.test(fixture.id) ||
      !fixture.answer.trim() || !fixture.documentFamily.trim()) {
      throw new Error("knowledge_semantic_review_fixture_invalid");
    }
    const claims = segmentKnowledgeSemanticClaims({
      answer: fixture.answer,
      evidence: fixture.evidence
    });
    if (claims.length < 1) throw new Error("knowledge_semantic_review_fixture_claims_missing");
    for (const claim of claims) {
      const poolEntry = poolEntries.get(`${fixture.id}:${claim.ordinal}`);
      if (!poolEntry || poolEntry.documentFamily !== fixture.documentFamily ||
        poolEntry.language !== fixture.language || poolEntry.split !== fixture.split ||
        poolEntry.input.query !== fixture.evidence.originalIntent.query) {
        throw new Error("knowledge_semantic_review_candidate_pool_mismatch");
      }
      const reviewClaimId = randomId();
      const shapedClaim = reviewClaimShapeSchema.parse(claimShape(claim));
      const shapedClaimSha256 = claimSha256(shapedClaim);
      const poolEvidenceByHandle = new Map(poolEntry.input.evidence.map((entry) => [
        entry.handle,
        entry
      ]));
      if (poolEvidenceByHandle.size !== poolEntry.input.evidence.length) {
        throw new Error("knowledge_semantic_review_candidate_pool_evidence_invalid");
      }
      const packetEvidence = poolEntry.evidencePackage.items.map((item) => {
        const poolEvidence = poolEvidenceByHandle.get(item.handle);
        if (!poolEvidence || poolEvidence.text !== item.excerpt ||
          poolEvidence.state !== item.state) {
          throw new Error("knowledge_semantic_review_candidate_pool_evidence_invalid");
        }
        const shaped = evidenceShape(item, poolEvidence.locatorState, randomId());
        return reviewEvidenceSchema.parse({
          ...shaped,
          evidenceSha256: evidenceSha256(shaped)
        });
      });
      if (packetEvidence.length !== poolEntry.input.evidence.length) {
        throw new Error("knowledge_semantic_review_candidate_pool_evidence_invalid");
      }
      const shapedNeighborhoodSha256 = neighborhoodSha256({
        claim: shapedClaim,
        evidence: packetEvidence
      });
      if (poolEntry.claimSha256 !== shapedClaimSha256 ||
        poolEntry.neighborhoodSha256 !== shapedNeighborhoodSha256) {
        throw new Error("knowledge_semantic_review_candidate_pool_hash_mismatch");
      }
      prepared.push(Object.freeze({
        claim,
        claimSha256: shapedClaimSha256,
        fixture,
        neighborhoodSha256: shapedNeighborhoodSha256,
        packetEvidence: Object.freeze(packetEvidence),
        reviewClaimId
      }));
    }
  }
  const expectedPoolEntries = candidatePool.entries.filter((entry) =>
    includedSplits.has(entry.split));
  if (prepared.length !== expectedPoolEntries.length) {
    throw new Error("knowledge_semantic_review_candidate_pool_coverage_incomplete");
  }
  assertUniqueOpaqueIds(prepared);
  const corpusSha256 = candidatePool.corpusSha256;
  const packetClaims = prepared.map((entry) => {
    const shapedClaim = reviewClaimShapeSchema.parse(claimShape(entry.claim));
    return packetClaimSchema.parse({
      answerText: entry.fixture.answer,
      claim: shapedClaim,
      claimSha256: entry.claimSha256,
      coverage: {
        expectedPassageCount: entry.fixture.evidence.coverage.expectedPassageCount,
        mode: entry.fixture.evidence.coverage.mode,
        verified: entry.fixture.evidence.coverage.verified
      },
      evidence: shuffle(entry.packetEvidence, randomIndex),
      language: entry.fixture.language,
      neighborhoodSha256: entry.neighborhoodSha256,
      queryText: entry.fixture.evidence.originalIntent.query,
      reviewClaimId: entry.reviewClaimId
    });
  });
  const packetBody = {
    annotationGuideVersion: KNOWLEDGE_H0_ANNOTATION_GUIDE.version,
    artifactType: "knowledge_semantic_grounding_blind_packet" as const,
    artifactVersion: KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_VERSION,
    claimCount: packetClaims.length,
    contractVersion: KNOWLEDGE_SEMANTIC_GROUNDING_CONTRACT_VERSION,
    corpusSha256,
    evaluationCommitmentSha256,
    poolSha256: candidatePool.poolSha256,
    reviewScope,
    instructions: {
      attribution:
        "Select only opaque evidence ids from this claim's displayed neighborhood." as const,
      decisions: [
        "supported: the displayed neighborhood supports the material claim",
        "unsupported: the displayed neighborhood does not support a material part",
        "contradicted: displayed same-context evidence is incompatible with the claim",
        "uncertain: ambiguity or insufficient displayed context prevents a stable decision"
      ] as const,
      independence:
        "Complete this packet independently, without consulting another annotator or model output." as const,
      scope:
        "Judge only the marked claim and its displayed local neighborhood; treat omitted evidence as unavailable." as const
    },
    claims: shuffle(packetClaims, randomIndex)
  };
  const packet = reviewPacketSchema.parse({
    ...packetBody,
    packetSha256: canonicalSha256(packetBody)
  });
  const mappingBody = {
    annotationGuideVersion: KNOWLEDGE_H0_ANNOTATION_GUIDE.version,
    artifactType: "knowledge_semantic_grounding_review_mapping" as const,
    artifactVersion: KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_VERSION,
    corpusSha256,
    corpusVersion: input.corpusVersion,
    entries: prepared.map((entry) => ({
      claimOrdinal: entry.claim.ordinal,
      claimSha256: entry.claimSha256,
      documentFamilySha256: sha256(entry.fixture.documentFamily),
      evidence: entry.packetEvidence.map((evidence) => ({
        evidenceSha256: evidence.evidenceSha256,
        handle: evidence.citationHandle,
        reviewEvidenceId: evidence.reviewEvidenceId
      })),
      fixtureId: entry.fixture.id,
      language: entry.fixture.language,
      neighborhoodSha256: entry.neighborhoodSha256,
      reviewClaimId: entry.reviewClaimId,
      split: entry.fixture.split
    })),
    evaluationBindings,
    evaluationCommitmentSha256,
    packetSha256: packet.packetSha256,
    poolSha256: candidatePool.poolSha256,
    reviewScope
  };
  const mapping = reviewMappingSchema.parse({
    ...mappingBody,
    mappingSha256: canonicalSha256(mappingBody)
  });
  return Object.freeze({ mapping, packet });
}

export async function validateKnowledgeSemanticGroundingReviewDirectory(
  reviewDirectory: string,
  requireEmpty = true
): Promise<string> {
  if (!reviewDirectory || !isAbsolute(reviewDirectory) ||
    resolve(reviewDirectory) !== reviewDirectory || dirname(reviewDirectory) !== "/tmp" ||
    !REVIEW_DIRECTORY_PATTERN.test(basename(reviewDirectory))) {
    throw new Error("knowledge_semantic_review_directory_invalid");
  }
  let details: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  let entries: string[];
  try {
    [details, canonical, entries] = await Promise.all([
      lstat(reviewDirectory),
      realpath(reviewDirectory),
      readdir(reviewDirectory)
    ]);
  } catch {
    throw new Error("knowledge_semantic_review_directory_unavailable");
  }
  const processUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!details.isDirectory() || details.isSymbolicLink() || canonical !== reviewDirectory ||
    (details.mode & 0o777) !== 0o700 ||
    processUid !== null && details.uid !== processUid) {
    throw new Error("knowledge_semantic_review_directory_unsafe");
  }
  if (requireEmpty && entries.length !== 0) {
    throw new Error("knowledge_semantic_review_directory_not_empty");
  }
  return reviewDirectory;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  await chmod(path, 0o600);
  const details = await stat(path);
  const processUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!details.isFile() || (details.mode & 0o777) !== 0o600 ||
    processUid !== null && details.uid !== processUid) {
    throw new Error("knowledge_semantic_review_artifact_permissions_invalid");
  }
}

export async function writeKnowledgeSemanticGroundingReviewArtifacts(input: Readonly<{
  candidatePool?: KnowledgeSemanticCandidatePool;
  corpusVersion: string;
  evaluationBindings: z.infer<typeof reviewEvaluationBindingsSchema>;
  fixtures: readonly KnowledgeSemanticGroundingReviewFixture[];
  randomId?: () => string;
  randomIndex?: (maximum: number) => number;
  reviewScope: KnowledgeSemanticGroundingReviewScope;
  reviewDirectory: string;
}>): Promise<Readonly<{
  mapping: KnowledgeSemanticGroundingReviewMapping;
  packet: KnowledgeSemanticGroundingReviewPacket;
}>> {
  const reviewDirectory = await validateKnowledgeSemanticGroundingReviewDirectory(
    input.reviewDirectory
  );
  const artifacts = createKnowledgeSemanticGroundingReviewArtifacts(input);
  await writePrivateJson(
    resolve(reviewDirectory, KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_PACKET_FILE),
    artifacts.packet
  );
  await writePrivateJson(
    resolve(reviewDirectory, KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_MAPPING_FILE),
    artifacts.mapping
  );
  return artifacts;
}

const reviewImportFiles = Object.freeze([
  KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_PACKET_FILE,
  KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_MAPPING_FILE,
  KNOWLEDGE_SEMANTIC_GROUNDING_REVIEWER_A_FILE,
  KNOWLEDGE_SEMANTIC_GROUNDING_REVIEWER_B_FILE,
  KNOWLEDGE_SEMANTIC_GROUNDING_ADJUDICATION_FILE
]);

async function readPrivateReviewJson(reviewDirectory: string, fileName: string): Promise<unknown> {
  const path = resolve(reviewDirectory, fileName);
  const details = await lstat(path);
  const processUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!details.isFile() || details.isSymbolicLink() || details.size < 2 ||
    details.size > REVIEW_ARTIFACT_MAX_BYTES || (details.mode & 0o777) !== 0o600 ||
    processUid !== null && details.uid !== processUid) {
    throw new Error("knowledge_semantic_review_artifact_permissions_invalid");
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("knowledge_semantic_review_artifact_invalid");
  }
}

function decisionMap(
  decisions: readonly z.infer<typeof reviewClaimDecisionSchema>[]
): Map<string, z.infer<typeof reviewClaimDecisionSchema>> {
  return new Map(decisions.map((decision) => [decision.reviewClaimId, decision]));
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index]);
}

function sameReviewDecision(
  left: z.infer<typeof reviewClaimDecisionSchema>,
  right: z.infer<typeof reviewClaimDecisionSchema>
): boolean {
  return left.decision === right.decision &&
    sameSet(left.attributableEvidenceIds, right.attributableEvidenceIds);
}

function assertCompleteDecisions(
  decisions: readonly z.infer<typeof reviewClaimDecisionSchema>[],
  mapping: KnowledgeSemanticGroundingReviewMapping,
  packet: KnowledgeSemanticGroundingReviewPacket
): void {
  const expected = new Map(mapping.entries.map((entry) => [
    entry.reviewClaimId,
    new Set(entry.evidence.map((evidence) => evidence.reviewEvidenceId))
  ]));
  const claims = new Map(packet.claims.map((claim) => [claim.reviewClaimId, claim]));
  const actual = decisionMap(decisions);
  if (actual.size !== decisions.length || actual.size !== expected.size) {
    throw new Error("knowledge_semantic_review_incomplete");
  }
  for (const [reviewClaimId, allowedEvidence] of expected) {
    const decision = actual.get(reviewClaimId);
    if (!decision ||
      new Set(decision.attributableEvidenceIds).size !== decision.attributableEvidenceIds.length ||
      decision.attributableEvidenceIds.some((id) => !allowedEvidence.has(id))) {
      throw new Error("knowledge_semantic_review_attribution_invalid");
    }
    if (decision.decision === "contradicted" &&
      decision.attributableEvidenceIds.length === 0) {
      throw new Error("knowledge_semantic_review_contradiction_unattributed");
    }
    if (decision.decision === "supported" &&
      (claims.get(reviewClaimId)?.claim.citationHandles.length ?? 0) > 0 &&
      decision.attributableEvidenceIds.length === 0) {
      throw new Error("knowledge_semantic_review_support_unattributed");
    }
  }
}

function assertPacketMappingBinding(
  packet: KnowledgeSemanticGroundingReviewPacket,
  mapping: KnowledgeSemanticGroundingReviewMapping,
  candidatePool: KnowledgeSemanticCandidatePool
): void {
  if (packet.reviewScope !== mapping.reviewScope) {
    throw new Error("knowledge_semantic_review_scope_mismatch");
  }
  assertReviewEvaluationBindings(packet.reviewScope, mapping.evaluationBindings);
  if (packet.evaluationCommitmentSha256 !== mapping.evaluationCommitmentSha256 ||
    packet.evaluationCommitmentSha256 !== canonicalSha256({
      bindings: mapping.evaluationBindings,
      reviewScope: mapping.reviewScope
    })) {
    throw new Error("knowledge_semantic_review_evaluation_binding_invalid");
  }
  const includedSplits = new Set<KnowledgeSemanticGroundingReviewSplit>(
    splitsForReviewScope(packet.reviewScope)
  );
  const expectedPoolEntries = candidatePool.entries.filter((entry) =>
    includedSplits.has(entry.split));
  const packetClaims = new Map(packet.claims.map((claim) => [claim.reviewClaimId, claim]));
  const poolEntries = new Map(candidatePool.entries.map((entry) => [
    `${entry.fixtureId}:${entry.ordinal}`,
    entry
  ]));
  const mappedPoolEntries = new Set<string>();
  const mappedReviewClaimIds = new Set<string>();
  const fixtures = new Map(knowledgeSemanticGroundingFixtures.map((fixture) => [
    fixture.id,
    fixture
  ]));
  const allPacketIds = packet.claims.flatMap((claim) => [
    claim.reviewClaimId,
    ...claim.evidence.map((evidence) => evidence.reviewEvidenceId)
  ]);
  if (packetClaims.size !== packet.claims.length || packet.claimCount !== packet.claims.length ||
    mapping.entries.length !== packet.claims.length ||
    poolEntries.size !== candidatePool.entries.length ||
    new Set(allPacketIds).size !== allPacketIds.length) {
    throw new Error("knowledge_semantic_review_binding_invalid");
  }
  for (const entry of mapping.entries) {
    const poolKey = `${entry.fixtureId}:${entry.claimOrdinal}`;
    const poolEntry = poolEntries.get(poolKey);
    const fixture = fixtures.get(entry.fixtureId);
    const packetClaim = packetClaims.get(entry.reviewClaimId);
    if (!poolEntry || !fixture || !packetClaim || mappedPoolEntries.has(poolKey) ||
      mappedReviewClaimIds.has(entry.reviewClaimId) ||
      entry.claimSha256 !== poolEntry.claimSha256 ||
      entry.neighborhoodSha256 !== poolEntry.neighborhoodSha256 ||
      entry.documentFamilySha256 !== sha256(poolEntry.documentFamily) ||
      entry.language !== poolEntry.language || entry.split !== poolEntry.split ||
      !includedSplits.has(entry.split) ||
      packetClaim.language !== entry.language ||
      packetClaim.queryText !== poolEntry.input.query ||
      packetClaim.answerText !== fixture.answer ||
      canonicalJson(packetClaim.coverage) !== canonicalJson({
        expectedPassageCount: fixture.evidence.coverage.expectedPassageCount,
        mode: fixture.evidence.coverage.mode,
        verified: fixture.evidence.coverage.verified
      }) || claimSha256(packetClaim.claim) !== packetClaim.claimSha256 ||
      packetClaim.claimSha256 !== entry.claimSha256 ||
      packetClaim.claim.answerStart >= packetClaim.claim.answerEnd ||
      packetClaim.answerText.slice(packetClaim.claim.answerStart, packetClaim.claim.answerEnd) !==
        packetClaim.claim.text) {
      throw new Error("knowledge_semantic_review_claim_binding_invalid");
    }
    mappedPoolEntries.add(poolKey);
    mappedReviewClaimIds.add(entry.reviewClaimId);
    const packetEvidence = new Map(packetClaim.evidence.map((evidence) => [
      evidence.reviewEvidenceId,
      evidence
    ]));
    if (packetEvidence.size !== packetClaim.evidence.length ||
      packetEvidence.size !== entry.evidence.length ||
      new Set(entry.evidence.map((evidence) => evidence.reviewEvidenceId)).size !==
        entry.evidence.length) {
      throw new Error("knowledge_semantic_review_evidence_binding_invalid");
    }
    const sourceItemByHandle = new Map(poolEntry.evidencePackage.items.map((item) => [
      item.handle,
      item
    ]));
    const locatorStateByHandle = new Map(poolEntry.input.evidence.map((evidence) => [
      evidence.handle,
      evidence.locatorState
    ]));
    for (const mappedEvidence of entry.evidence) {
      const evidence = packetEvidence.get(mappedEvidence.reviewEvidenceId);
      const sourceItem = sourceItemByHandle.get(mappedEvidence.handle);
      if (!evidence || !sourceItem) {
        throw new Error("knowledge_semantic_review_evidence_binding_invalid");
      }
      const { evidenceSha256: _digest, ...contentWithId } = evidence;
      const expectedEvidence = evidenceShape(
        sourceItem,
        locatorStateByHandle.get(sourceItem.handle) ?? "missing",
        evidence.reviewEvidenceId
      );
      if (evidenceSha256(contentWithId) !== evidence.evidenceSha256 ||
        evidenceSha256(expectedEvidence) !== evidence.evidenceSha256 ||
        evidence.evidenceSha256 !== mappedEvidence.evidenceSha256 ||
        evidence.citationHandle !== mappedEvidence.handle) {
        throw new Error("knowledge_semantic_review_evidence_binding_invalid");
      }
    }
    const orderedEvidence = entry.evidence.map((mappedEvidence) =>
      packetEvidence.get(mappedEvidence.reviewEvidenceId)!);
    const expectedNeighborhoodSha256 = neighborhoodSha256({
      claim: packetClaim.claim,
      evidence: orderedEvidence
    });
    if (expectedNeighborhoodSha256 !== packetClaim.neighborhoodSha256 ||
      packetClaim.neighborhoodSha256 !== entry.neighborhoodSha256) {
      throw new Error("knowledge_semantic_review_neighborhood_binding_invalid");
    }
  }
  if (mappedPoolEntries.size !== expectedPoolEntries.length ||
    mappedReviewClaimIds.size !== packet.claims.length) {
    throw new Error("knowledge_semantic_review_candidate_pool_coverage_incomplete");
  }
}

export function knowledgeSemanticGroundingReviewerSubmissionSha256(value: unknown): string {
  return canonicalSha256(knowledgeSemanticGroundingReviewerSubmissionSchema.parse(value));
}

export function knowledgeSemanticGroundingAdjudicationSha256(value: unknown): string {
  return canonicalSha256(knowledgeSemanticGroundingAdjudicationSchema.parse(value));
}

type DecisionConfusionMatrix = Readonly<Record<
  KnowledgeSemanticGroundingDecision,
  Readonly<Record<KnowledgeSemanticGroundingDecision, number>>
>>;

type DecisionDistribution = Readonly<Record<KnowledgeSemanticGroundingDecision, number>>;

export type KnowledgeSemanticGroundingImportedReviewEvidence = Readonly<{
  adjudicationComplete: true;
  adjudicationSha256: string;
  annotationGuideVersion: typeof KNOWLEDGE_H0_ANNOTATION_GUIDE.version;
  corpusSha256: string;
  evaluationBindings: Readonly<z.infer<typeof reviewEvaluationBindingsSchema>>;
  disagreement: Readonly<{
    attributionDisagreementCount: number;
    adjudicationRate: number;
    categoryCounts: Readonly<Record<z.infer<typeof disagreementCategorySchema>, number>>;
    decisionConfusionMatrix: DecisionConfusionMatrix;
    decisionDisagreementCount: number;
    exactAgreementCount: number;
    labelDistribution: Readonly<{
      adjudicated: DecisionDistribution;
      reviewerA: DecisionDistribution;
      reviewerB: DecisionDistribution;
    }>;
    rawExactAgreement: number;
    reviewedClaimCount: number;
  }>;
  independentAnnotatorCount: 2;
  labelProvenance: "two_external_humans_adjudicated";
  provenanceVerification: "self_attested_unverified";
  humanTrustEvidence?: unknown;
  labels: readonly Readonly<{
    attributableHandles: readonly string[];
    claimOrdinal: number;
    claimSha256: string;
    decision: KnowledgeSemanticGroundingDecision;
    fixtureId: string;
    language: KnowledgeSemanticGroundingReviewLanguage;
    neighborhoodSha256: string;
    split: KnowledgeSemanticGroundingReviewSplit;
  }>[];
  mappingSha256: string;
  packetSha256: string;
  poolSha256: string;
  reviewerSubmissionSha256s: readonly [string, string];
  reviewScope: KnowledgeSemanticGroundingReviewScope;
  unresolvedMaterialDisagreements: 0;
}>;

function confusionMatrix(
  left: ReadonlyMap<string, z.infer<typeof reviewClaimDecisionSchema>>,
  right: ReadonlyMap<string, z.infer<typeof reviewClaimDecisionSchema>>
): DecisionConfusionMatrix {
  return Object.freeze(Object.fromEntries(knowledgeSemanticGroundingDecisions.map((leftDecision) => [
    leftDecision,
    Object.freeze(Object.fromEntries(knowledgeSemanticGroundingDecisions.map((rightDecision) => [
      rightDecision,
      [...left.values()].filter((decision) =>
        decision.decision === leftDecision &&
        right.get(decision.reviewClaimId)?.decision === rightDecision).length
    ])))
  ])) as Record<
    KnowledgeSemanticGroundingDecision,
    Readonly<Record<KnowledgeSemanticGroundingDecision, number>>
  >);
}

function decisionDistribution(
  decisions: readonly z.infer<typeof reviewClaimDecisionSchema>[]
): DecisionDistribution {
  return Object.freeze(Object.fromEntries(knowledgeSemanticGroundingDecisions.map((decision) => [
    decision,
    decisions.filter((entry) => entry.decision === decision).length
  ])) as Record<KnowledgeSemanticGroundingDecision, number>);
}

/** Imports externally authored labels; it never creates or fills a human decision. */
export function importKnowledgeSemanticGroundingReviewEvidence(input: Readonly<{
  adjudication: unknown;
  mapping: unknown;
  packet: unknown;
  submissions: readonly [unknown, unknown];
}>): KnowledgeSemanticGroundingImportedReviewEvidence {
  const packet = reviewPacketSchema.parse(input.packet);
  const mapping = reviewMappingSchema.parse(input.mapping);
  const submissions = input.submissions.map((submission) =>
    knowledgeSemanticGroundingReviewerSubmissionSchema.parse(submission)) as [
      KnowledgeSemanticGroundingReviewerSubmission,
      KnowledgeSemanticGroundingReviewerSubmission
    ];
  const adjudication = knowledgeSemanticGroundingAdjudicationSchema.parse(input.adjudication);
  const { packetSha256, ...packetBody } = packet;
  const { mappingSha256, ...mappingBody } = mapping;
  if (canonicalSha256(packetBody) !== packetSha256 ||
    canonicalSha256(mappingBody) !== mappingSha256) {
    throw new Error("knowledge_semantic_review_artifact_digest_invalid");
  }
  const candidatePool = createKnowledgeSemanticGroundingCandidatePool();
  if (mapping.corpusVersion !== candidatePool.corpusVersion ||
    packet.corpusSha256 !== candidatePool.corpusSha256 ||
    packet.poolSha256 !== candidatePool.poolSha256) {
    throw new Error("knowledge_semantic_review_candidate_pool_mismatch");
  }
  if (mapping.packetSha256 !== packet.packetSha256 ||
    mapping.corpusSha256 !== packet.corpusSha256 ||
    mapping.poolSha256 !== packet.poolSha256 ||
    submissions.some((submission) =>
      submission.packetSha256 !== packet.packetSha256 ||
      submission.corpusSha256 !== packet.corpusSha256 ||
      submission.poolSha256 !== packet.poolSha256) ||
    adjudication.packetSha256 !== packet.packetSha256 ||
    adjudication.corpusSha256 !== packet.corpusSha256 ||
    adjudication.poolSha256 !== packet.poolSha256 ||
    mapping.reviewScope !== packet.reviewScope) {
    throw new Error("knowledge_semantic_review_binding_invalid");
  }
  if (submissions[0].reviewer.id === submissions[1].reviewer.id) {
    throw new Error("knowledge_semantic_review_annotators_not_distinct");
  }
  assertPacketMappingBinding(packet, mapping, candidatePool);
  submissions.forEach((submission) =>
    assertCompleteDecisions(submission.claims, mapping, packet));
  assertCompleteDecisions(adjudication.claims, mapping, packet);
  const reviewerSubmissionSha256s = submissions
    .map(knowledgeSemanticGroundingReviewerSubmissionSha256) as [string, string];
  const submissionHashes = [...reviewerSubmissionSha256s].sort();
  if (!sameSet(adjudication.annotatorSubmissionSha256s, submissionHashes)) {
    throw new Error("knowledge_semantic_review_adjudication_sources_invalid");
  }
  const orderedSubmissions = [...submissions].sort((left, right) =>
    left.reviewer.id.localeCompare(right.reviewer.id));
  const left = decisionMap(orderedSubmissions[0]!.claims);
  const right = decisionMap(orderedSubmissions[1]!.claims);
  const adjudicated = decisionMap(adjudication.claims);
  const resolutions = new Map(adjudication.disagreementResolutions.map((resolution) => [
    resolution.reviewClaimId,
    resolution
  ]));
  if (resolutions.size !== adjudication.disagreementResolutions.length ||
    adjudication.disagreementResolutions.some((resolution) =>
      new Set(resolution.categories).size !== resolution.categories.length)) {
    throw new Error("knowledge_semantic_review_disagreement_resolution_invalid");
  }
  let attributionDisagreementCount = 0;
  let decisionDisagreementCount = 0;
  let exactAgreementCount = 0;
  const expectedResolutionIds = new Set<string>();
  for (const [reviewClaimId, leftDecision] of left) {
    const rightDecision = right.get(reviewClaimId)!;
    const adjudicatedDecision = adjudicated.get(reviewClaimId)!;
    const sameDecision = leftDecision.decision === rightDecision.decision;
    const sameAttribution = sameSet(
      leftDecision.attributableEvidenceIds,
      rightDecision.attributableEvidenceIds
    );
    if (!sameDecision) decisionDisagreementCount += 1;
    if (!sameAttribution) attributionDisagreementCount += 1;
    if (sameDecision && sameAttribution) exactAgreementCount += 1;
    if (!sameReviewDecision(leftDecision, rightDecision) ||
      !sameReviewDecision(leftDecision, adjudicatedDecision)) {
      expectedResolutionIds.add(reviewClaimId);
    }
  }
  if (!sameSet([...resolutions.keys()], [...expectedResolutionIds])) {
    throw new Error("knowledge_semantic_review_disagreement_resolution_incomplete");
  }
  const categoryCounts = Object.freeze(Object.fromEntries(
    KNOWLEDGE_H0_ANNOTATION_GUIDE.disagreementReport.categories.map((category) => [
      category,
      [...resolutions.values()].filter((resolution) =>
        resolution.categories.includes(category)).length
    ])
  ) as Record<z.infer<typeof disagreementCategorySchema>, number>);
  const labels = mapping.entries.map((entry) => {
    const decision = adjudicated.get(entry.reviewClaimId)!;
    const handleByReviewId = new Map(entry.evidence.map((evidence) => [
      evidence.reviewEvidenceId,
      evidence.handle
    ]));
    return Object.freeze({
      attributableHandles: Object.freeze(decision.attributableEvidenceIds.map((id) =>
        handleByReviewId.get(id)!)),
      claimOrdinal: entry.claimOrdinal,
      claimSha256: entry.claimSha256,
      decision: decision.decision,
      fixtureId: entry.fixtureId,
      language: entry.language,
      neighborhoodSha256: entry.neighborhoodSha256,
      split: entry.split
    });
  });
  return Object.freeze({
    adjudicationComplete: true,
    adjudicationSha256: knowledgeSemanticGroundingAdjudicationSha256(adjudication),
    annotationGuideVersion: packet.annotationGuideVersion,
    corpusSha256: packet.corpusSha256,
    evaluationBindings: Object.freeze({ ...mapping.evaluationBindings }),
    disagreement: Object.freeze({
      attributionDisagreementCount,
      adjudicationRate: left.size === 0 ? 0 : resolutions.size / left.size,
      categoryCounts,
      decisionConfusionMatrix: confusionMatrix(left, right),
      decisionDisagreementCount,
      exactAgreementCount,
      labelDistribution: Object.freeze({
        adjudicated: decisionDistribution(adjudication.claims),
        reviewerA: decisionDistribution(orderedSubmissions[0]!.claims),
        reviewerB: decisionDistribution(orderedSubmissions[1]!.claims)
      }),
      rawExactAgreement: left.size === 0 ? 0 : exactAgreementCount / left.size,
      reviewedClaimCount: left.size
    }),
    independentAnnotatorCount: 2,
    labelProvenance: "two_external_humans_adjudicated" as const,
    provenanceVerification: "self_attested_unverified" as const,
    labels: Object.freeze(labels),
    mappingSha256: mapping.mappingSha256,
    packetSha256: packet.packetSha256,
    poolSha256: packet.poolSha256,
    reviewerSubmissionSha256s: Object.freeze(reviewerSubmissionSha256s),
    reviewScope: packet.reviewScope,
    unresolvedMaterialDisagreements: 0
  });
}

/** Reads only the exact owner-only artifact set from an allowlisted /tmp directory. */
export async function readKnowledgeSemanticGroundingReviewEvidenceDirectory(
  reviewDirectory: string
): Promise<KnowledgeSemanticGroundingImportedReviewEvidence> {
  await validateKnowledgeSemanticGroundingReviewDirectory(reviewDirectory, false);
  const entries = await readdir(reviewDirectory);
  const baseFilesPresent = reviewImportFiles.every((fileName) => entries.includes(fileName));
  const trustEvidencePresent = entries.includes(
    KNOWLEDGE_SEMANTIC_GROUNDING_TRUST_EVIDENCE_FILE
  );
  const expectedFileCount = reviewImportFiles.length + Number(trustEvidencePresent);
  if (!baseFilesPresent || entries.length !== expectedFileCount) {
    throw new Error("knowledge_semantic_review_directory_unsafe");
  }
  const [packet, mapping, first, second, adjudication] = await Promise.all(
    reviewImportFiles.map((fileName) => readPrivateReviewJson(reviewDirectory, fileName))
  );
  const imported = importKnowledgeSemanticGroundingReviewEvidence({
    adjudication,
    mapping,
    packet,
    submissions: [first, second]
  });
  if (!trustEvidencePresent) return imported;
  const humanTrustEvidence = await readPrivateReviewJson(
    reviewDirectory,
    KNOWLEDGE_SEMANTIC_GROUNDING_TRUST_EVIDENCE_FILE
  );
  return Object.freeze({
    ...imported,
    humanTrustEvidence
  });
}

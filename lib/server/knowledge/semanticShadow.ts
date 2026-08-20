import { createHash } from "node:crypto";
import {
  knowledgeEvidenceReceiptHash,
  type KnowledgeEvidencePackage
} from "./evidencePackage";
import {
  decodeKnowledgeDocumentContext,
  type KnowledgeDocumentObservationV1
} from "./documentContext";
import type { KnowledgeSemanticValidatorDeploymentV1 } from "./knowledgeProfile";
import {
  decodeKnowledgeSemanticGroundingPrediction,
  knowledgeSemanticConfidence,
  knowledgeSemanticClaimTypes,
  knowledgeSemanticGroundingDecisions,
  knowledgeSemanticReasonFamilies,
  segmentKnowledgeSemanticClaims,
  type KnowledgeSemanticClaimType,
  type KnowledgeSemanticGroundingClaim,
  type KnowledgeSemanticGroundingDecision,
  type KnowledgeSemanticGroundingPrediction,
  type KnowledgeSemanticLocatorState,
  type KnowledgeSemanticNeighborhoodRule,
  type KnowledgeSemanticReasonFamily,
  type KnowledgeSemanticSourceShape
} from "./semanticGrounding";

export const KNOWLEDGE_SEMANTIC_SHADOW_VERSION = 1 as const;
export const KNOWLEDGE_SEMANTIC_SHADOW_MAX_CLAIMS = 512 as const;
export const KNOWLEDGE_SEMANTIC_SHADOW_MAX_HANDLES_PER_CLAIM = 1_000 as const;
// Conservative JSON ceilings leave room for jsonb container overhead below
// the database's 4 MiB diagnostic and 64 KiB metrics limits.
export const KNOWLEDGE_SEMANTIC_SHADOW_MAX_DIAGNOSTIC_JSON_BYTES =
  2 * 1024 * 1024;
export const KNOWLEDGE_SEMANTIC_SHADOW_MAX_METRICS_JSON_BYTES = 32 * 1024;
export const KNOWLEDGE_SEMANTIC_CONTEXT_KEY_VERSION = 1 as const;
export const KNOWLEDGE_SEMANTIC_LOCAL_VALIDATOR_REQUEST_VERSION = 1 as const;

export const knowledgeSemanticShadowExecutionStatuses = Object.freeze([
  "complete",
  "failed",
  "unavailable"
] as const);

export const knowledgeSemanticShadowEgressModes = Object.freeze([
  "external",
  "local",
  "none"
] as const);

export type KnowledgeSemanticShadowExecutionStatus =
  typeof knowledgeSemanticShadowExecutionStatuses[number];
export type KnowledgeSemanticShadowEgressMode =
  typeof knowledgeSemanticShadowEgressModes[number];

export type KnowledgeSemanticShadowValidatorV1 = Readonly<{
  egress: KnowledgeSemanticShadowEgressMode;
  profileId: string;
  profileVersion: number;
  semanticProof: boolean;
}>;

/**
 * The only text-bearing boundary exposed to a deployed local semantic
 * validator. Every claim carries its citation-local neighborhood; database
 * identities, uncited Evidence items, and the complete answer are excluded.
 */
export type KnowledgeSemanticLocalValidatorRequestV1 = Readonly<{
  claims: readonly Readonly<{
    citationHandles: readonly string[];
    context: readonly string[];
    evidence: readonly Readonly<{
      excerpt: string | null;
      handle: string;
      state: "available" | "deleted";
      textTruncated: boolean | null;
    }>[];
    neighborhoodRule: KnowledgeSemanticNeighborhoodRule;
    ordinal: number;
    sourceShape: KnowledgeSemanticSourceShape;
    text: string;
    type: KnowledgeSemanticClaimType;
    unknownCitationHandles: readonly string[];
  }>[];
  validator: KnowledgeSemanticValidatorDeploymentV1;
  version: typeof KNOWLEDGE_SEMANTIC_LOCAL_VALIDATOR_REQUEST_VERSION;
}>;

/**
 * An injected executor for an already-selected local candidate. Implementations
 * must be deterministic and perform no external I/O. Runtime matches the full
 * frozen deployment identity before invoking it and calls it at most once per
 * finalization attempt.
 */
export type KnowledgeSemanticLocalValidatorExecutor = Readonly<{
  deployment: KnowledgeSemanticValidatorDeploymentV1;
  validate(input: Readonly<{
    request: KnowledgeSemanticLocalValidatorRequestV1;
    signal: AbortSignal;
  }>): Promise<readonly unknown[]>;
}>;

export function createKnowledgeSemanticLocalValidatorRequestV1(input: Readonly<{
  answer: string;
  deployment: KnowledgeSemanticValidatorDeploymentV1;
  evidence: KnowledgeEvidencePackage;
}>): KnowledgeSemanticLocalValidatorRequestV1 {
  const claims = segmentKnowledgeSemanticClaims(input);
  if (claims.length > KNOWLEDGE_SEMANTIC_SHADOW_MAX_CLAIMS) {
    throw new Error("knowledge_semantic_shadow_claim_limit");
  }
  if (!claimsWithinReceiptLimits(claims)) {
    throw new Error("knowledge_semantic_shadow_citation_limit");
  }
  return Object.freeze({
    claims: Object.freeze(claims.map((claim) => Object.freeze({
      citationHandles: Object.freeze([...claim.citationHandles]),
      context: Object.freeze([...claim.context]),
      evidence: Object.freeze(claim.evidenceItems.map((item) => Object.freeze({
        excerpt: item.excerpt,
        handle: item.handle,
        state: item.state,
        textTruncated: item.textTruncated
      }))),
      neighborhoodRule: claim.neighborhoodRule,
      ordinal: claim.ordinal,
      sourceShape: claim.sourceShape,
      text: claim.text,
      type: claim.type,
      unknownCitationHandles: Object.freeze([...claim.unknownCitationHandles])
    }))),
    validator: input.deployment,
    version: KNOWLEDGE_SEMANTIC_LOCAL_VALIDATOR_REQUEST_VERSION
  });
}

export type KnowledgeSemanticShadowUsageV1 = Readonly<{
  cacheWriteInputTokens: number | null;
  cachedInputTokens: number | null;
  estimatedCostMicros: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  requests: number;
  totalTokens: number | null;
}>;

export type KnowledgeSemanticShadowConfidenceBucket =
  | "high"
  | "low"
  | "medium"
  | "unavailable";
export type KnowledgeSemanticShadowRecommendedAction = "retain" | "review";

export const knowledgeSemanticShadowConfidenceBuckets = Object.freeze([
  "high", "low", "medium", "unavailable"
] as const satisfies readonly KnowledgeSemanticShadowConfidenceBucket[]);

export const knowledgeSemanticShadowRecommendedActions = Object.freeze([
  "retain", "review"
] as const satisfies readonly KnowledgeSemanticShadowRecommendedAction[]);

export type KnowledgeSemanticShadowClaimV1 = Readonly<{
  answerEnd: number;
  answerStart: number;
  attributableHandles: readonly string[];
  citationHandles: readonly string[];
  claimHash: string;
  confidence: number;
  confidenceBucket: KnowledgeSemanticShadowConfidenceBucket;
  contextKeyHash: string | null;
  decision: KnowledgeSemanticGroundingDecision;
  locatorStates: readonly Readonly<{
    handle: string;
    state: KnowledgeSemanticLocatorState;
  }>[];
  neighborhoodHash: string;
  neighborhoodRule: KnowledgeSemanticNeighborhoodRule;
  ordinal: number;
  reasonFamily: KnowledgeSemanticReasonFamily;
  recommendedAction: KnowledgeSemanticShadowRecommendedAction;
  sourceShape: KnowledgeSemanticSourceShape;
  type: KnowledgeSemanticClaimType;
  unknownCitationHandles: readonly string[];
  version: typeof KNOWLEDGE_SEMANTIC_SHADOW_VERSION;
}>;

export type KnowledgeSemanticShadowSummaryV1 = Readonly<{
  attributableClaimCount: number;
  citationLocalClaimCount: number;
  claimCount: number;
  claimTypeCounts: Readonly<Record<KnowledgeSemanticClaimType, number>>;
  decisionCounts: Readonly<Record<KnowledgeSemanticGroundingDecision, number>>;
}>;

export type KnowledgeSemanticShadowContentFreeMetricsV1 = Readonly<{
  attributableClaimCount: number;
  blockingApplied: false;
  citationLocalClaimCount: number;
  claimCount: number;
  claimTypeCounts: Readonly<Record<KnowledgeSemanticClaimType, number>>;
  confidenceBucketCounts: Readonly<Record<KnowledgeSemanticShadowConfidenceBucket, number>>;
  decisionCounts: Readonly<Record<KnowledgeSemanticGroundingDecision, number>>;
  egress: KnowledgeSemanticShadowEgressMode;
  executionStatus: KnowledgeSemanticShadowExecutionStatus;
  failureReasonCode: string | null;
  latencyMs: number | null;
  mode: "shadow";
  recommendedActionCounts: Readonly<Record<KnowledgeSemanticShadowRecommendedAction, number>>;
  semanticProof: boolean;
  usage: KnowledgeSemanticShadowUsageV1;
  validatorProfile: string;
  validatorVersion: number;
  version: typeof KNOWLEDGE_SEMANTIC_SHADOW_VERSION;
}>;

export type KnowledgeSemanticShadowDiagnosticV1 = Readonly<{
  answerHash: string;
  attemptId: string | null;
  blockingApplied: false;
  claims: readonly KnowledgeSemanticShadowClaimV1[];
  evidenceReceiptHash: string;
  executionStatus: KnowledgeSemanticShadowExecutionStatus;
  failureReasonCode: string | null;
  latencyMs: number | null;
  receiptHash: string;
  runId: string;
  sessionId: string;
  summary: KnowledgeSemanticShadowSummaryV1;
  usage: KnowledgeSemanticShadowUsageV1;
  validator: KnowledgeSemanticShadowValidatorV1;
  version: typeof KNOWLEDGE_SEMANTIC_SHADOW_VERSION;
}>;

type DiagnosticInput = Readonly<{
  answer: string;
  attemptId?: string | null;
  evidence: KnowledgeEvidencePackage;
  executionStatus: KnowledgeSemanticShadowExecutionStatus;
  failureReasonCode?: string | null;
  latencyMs?: number | null;
  predictions?: readonly unknown[];
  usage?: Partial<KnowledgeSemanticShadowUsageV1>;
  validator: KnowledgeSemanticShadowValidatorV1;
}>;

const lowercaseSha256 = /^[0-9a-f]{64}$/u;
const safeOpaqueId = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/u;
const safeProfile = /^[a-z0-9][a-z0-9_.-]{0,79}$/u;
const safeReason = /^[a-z0-9][a-z0-9_.-]{0,79}$/u;
const citationHandle = /^K[1-9]\d{0,3}(?:\.[1-9]\d?)?$/u;

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

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return expected.length === actual.length && expected.every((key, index) => key === actual[index]);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function uniqueStrings(
  value: unknown,
  maximum: number,
  validate: (entry: string) => boolean
): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximum ||
    value.some((entry) => typeof entry !== "string" || !validate(entry)) ||
    new Set(value).size !== value.length) return null;
  return Object.freeze([...(value as string[])]);
}

function validator(value: unknown): KnowledgeSemanticShadowValidatorV1 | null {
  if (!record(value) || !exactKeys(value, [
    "egress", "profileId", "profileVersion", "semanticProof"
  ]) || !knowledgeSemanticShadowEgressModes.includes(value.egress as KnowledgeSemanticShadowEgressMode) ||
    typeof value.profileId !== "string" || !safeProfile.test(value.profileId) ||
    !boundedInteger(value.profileVersion, 1, 10_000) || typeof value.semanticProof !== "boolean") {
    return null;
  }
  return Object.freeze({
    egress: value.egress as KnowledgeSemanticShadowEgressMode,
    profileId: value.profileId,
    profileVersion: value.profileVersion,
    semanticProof: value.semanticProof
  });
}

function usage(value: unknown): KnowledgeSemanticShadowUsageV1 | null {
  if (!record(value) || !exactKeys(value, [
    "cacheWriteInputTokens", "cachedInputTokens", "estimatedCostMicros", "inputTokens",
    "outputTokens", "reasoningTokens", "requests", "totalTokens"
  ]) || !boundedInteger(value.requests, 0, 10_000)) return null;
  for (const key of [
    "cacheWriteInputTokens", "cachedInputTokens", "inputTokens", "outputTokens",
    "reasoningTokens", "totalTokens"
  ] as const) {
    if (value[key] !== null && !boundedInteger(value[key], 0, 100_000_000)) return null;
  }
  if (value.estimatedCostMicros !== null &&
    !boundedInteger(value.estimatedCostMicros, 0, 1_000_000_000_000)) return null;
  return Object.freeze({
    cacheWriteInputTokens: value.cacheWriteInputTokens as number | null,
    cachedInputTokens: value.cachedInputTokens as number | null,
    estimatedCostMicros: value.estimatedCostMicros as number | null,
    inputTokens: value.inputTokens as number | null,
    outputTokens: value.outputTokens as number | null,
    reasoningTokens: value.reasoningTokens as number | null,
    requests: value.requests,
    totalTokens: value.totalTokens as number | null
  });
}

function claimHash(claim: KnowledgeSemanticGroundingClaim): string {
  return hash({
    answerEnd: claim.answerEnd,
    answerStart: claim.answerStart,
    citationHandles: claim.citationHandles,
    context: claim.context,
    ordinal: claim.ordinal,
    sourceShape: claim.sourceShape,
    text: claim.text,
    type: claim.type,
    unknownCitationHandles: claim.unknownCitationHandles,
    version: KNOWLEDGE_SEMANTIC_SHADOW_VERSION
  });
}

function neighborhoodHash(claim: KnowledgeSemanticGroundingClaim): string {
  return hash({
    citationHandles: claim.citationHandles,
    evidenceItems: claim.evidenceItems.map((item) => ({
      contentHash: item.contentHash,
      documentVersionId: item.documentVersionId,
      excerpt: item.excerpt,
      handle: item.handle,
      passageId: item.passageId,
      sourceArtifactId: item.sourceArtifactId,
      sourceVersionId: item.sourceVersionId,
      state: item.state,
      textTruncated: item.textTruncated
    })),
    locatorStates: claim.locatorStates,
    neighborhoodRule: claim.neighborhoodRule,
    neighborhoodVersion: claim.neighborhoodVersion,
    version: KNOWLEDGE_SEMANTIC_SHADOW_VERSION
  });
}

function canonicalContextValue(value: string | null): string | null {
  if (value === null) return null;
  const canonical = value.normalize("NFKC").replace(/\u2212/gu, "-")
    .toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
  return canonical || null;
}

function observationContextKey(
  observation: KnowledgeDocumentObservationV1
): Readonly<{
  date: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  metric: string | null;
  role: KnowledgeDocumentObservationV1["role"];
  subject: string | null;
  unit: string | null;
  version: typeof KNOWLEDGE_SEMANTIC_CONTEXT_KEY_VERSION;
}> | null {
  if (observation.ambiguityReasons.length > 0 || observation.normalizedValue === null ||
    observation.role === "header" || observation.role === "metadata") return null;
  const metric = canonicalContextValue(observation.metric);
  const subject = canonicalContextValue(observation.subject);
  if (metric === null && subject === null) return null;
  return Object.freeze({
    date: canonicalContextValue(observation.date),
    effectiveFrom: canonicalContextValue(observation.effectiveFrom),
    effectiveTo: canonicalContextValue(observation.effectiveTo),
    metric,
    role: observation.role,
    subject,
    unit: canonicalContextValue(observation.unit),
    version: KNOWLEDGE_SEMANTIC_CONTEXT_KEY_VERSION
  });
}

/**
 * Derives a value-independent semantic context identity only when every exact,
 * dispatched typed observation in the claim neighborhood resolves to one
 * unambiguous subject/metric/unit/role/temporal key. Multiple incompatible
 * keys, truncated excerpts, or ambiguous legacy evidence deliberately return
 * null rather than fabricating a shared contradiction context.
 */
export function knowledgeSemanticContextKeyHash(
  claim: KnowledgeSemanticGroundingClaim
): string | null {
  const keys: string[] = [];
  for (const item of claim.evidenceItems) {
    if (!item.contextBoundaries?.documentContext) continue;
    if (item.state !== "available" || item.excerpt === null || item.textTruncated) return null;
    const context = decodeKnowledgeDocumentContext(item.contextBoundaries.documentContext);
    if (!context || context.ambiguityReasons.length > 0 ||
      context.locator.kind === "field_ambiguous") return null;
    for (const observation of context.observations) {
      const key = observationContextKey(observation);
      if (key) keys.push(canonicalJson(key));
    }
  }
  const uniqueKeys = [...new Set(keys)];
  return uniqueKeys.length === 1 ? hash(JSON.parse(uniqueKeys[0]!)) : null;
}

function structuralPrediction(
  claim: KnowledgeSemanticGroundingClaim
): KnowledgeSemanticGroundingPrediction {
  const unavailable = claim.unknownCitationHandles.length > 0 ||
    claim.citationHandles.length > claim.evidenceItems.length ||
    claim.locatorStates.some(({ state }) => state !== "valid");
  const sourceClaim = !["explicit_inference", "general_knowledge", "non_factual"]
    .includes(claim.type);
  const noEvidence = sourceClaim && claim.citationHandles.length === 0;
  return Object.freeze({
    attributableHandles: Object.freeze([]),
    claimOrdinal: claim.ordinal,
    confidence: unavailable || noEvidence ? 1 : 0,
    decision: unavailable || noEvidence ? "unsupported" : "uncertain",
    reasonFamily: unavailable || noEvidence ? "no_evidence" : "structural_baseline",
    validatorProfile: "structural-baseline-v1",
    validatorVersion: 1,
    version: 1
  });
}

function unavailablePrediction(
  claim: KnowledgeSemanticGroundingClaim,
  validatorProfile: string,
  validatorVersion: number
): KnowledgeSemanticGroundingPrediction {
  return Object.freeze({
    attributableHandles: Object.freeze([]),
    claimOrdinal: claim.ordinal,
    confidence: 0,
    decision: "uncertain",
    reasonFamily: "insufficient_context",
    validatorProfile,
    validatorVersion,
    version: 1
  });
}

function claimReceipt(
  claim: KnowledgeSemanticGroundingClaim,
  prediction: KnowledgeSemanticGroundingPrediction
): KnowledgeSemanticShadowClaimV1 {
  return Object.freeze({
    answerEnd: claim.answerEnd,
    answerStart: claim.answerStart,
    attributableHandles: Object.freeze([...prediction.attributableHandles]),
    citationHandles: Object.freeze([...claim.citationHandles]),
    claimHash: claimHash(claim),
    confidence: prediction.confidence,
    confidenceBucket: confidenceBucket(prediction.confidence),
    contextKeyHash: knowledgeSemanticContextKeyHash(claim),
    decision: prediction.decision,
    locatorStates: Object.freeze(claim.locatorStates.map((entry) => Object.freeze({ ...entry }))),
    neighborhoodHash: neighborhoodHash(claim),
    neighborhoodRule: claim.neighborhoodRule,
    ordinal: claim.ordinal,
    reasonFamily: prediction.reasonFamily,
    recommendedAction: recommendedAction({ decision: prediction.decision, type: claim.type }),
    sourceShape: claim.sourceShape,
    type: claim.type,
    unknownCitationHandles: Object.freeze([...claim.unknownCitationHandles]),
    version: KNOWLEDGE_SEMANTIC_SHADOW_VERSION
  });
}

function claimsWithinReceiptLimits(
  claims: readonly KnowledgeSemanticGroundingClaim[]
): boolean {
  return claims.every((claim) =>
    claim.citationHandles.length <= KNOWLEDGE_SEMANTIC_SHADOW_MAX_HANDLES_PER_CLAIM &&
    claim.unknownCitationHandles.length <= KNOWLEDGE_SEMANTIC_SHADOW_MAX_HANDLES_PER_CLAIM &&
    claim.locatorStates.length <= KNOWLEDGE_SEMANTIC_SHADOW_MAX_HANDLES_PER_CLAIM);
}

function confidenceBucket(value: number): KnowledgeSemanticShadowConfidenceBucket {
  return value === 0
    ? "unavailable"
    : value >= 0.8
      ? "high"
      : value >= 0.5
        ? "medium"
        : "low";
}

function recommendedAction(input: Readonly<{
  decision: KnowledgeSemanticGroundingDecision;
  type: KnowledgeSemanticClaimType;
}>): KnowledgeSemanticShadowRecommendedAction {
  return input.decision === "supported" || input.type === "general_knowledge" ||
    input.type === "non_factual" ? "retain" : "review";
}

function emptyCounts<T extends string>(values: readonly T[]): Record<T, number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
}

function summary(claims: readonly KnowledgeSemanticShadowClaimV1[]): KnowledgeSemanticShadowSummaryV1 {
  const claimTypeCounts = emptyCounts(knowledgeSemanticClaimTypes);
  const decisionCounts = emptyCounts(knowledgeSemanticGroundingDecisions);
  for (const claim of claims) {
    claimTypeCounts[claim.type] += 1;
    decisionCounts[claim.decision] += 1;
  }
  return Object.freeze({
    attributableClaimCount: claims.filter((claim) => claim.attributableHandles.length > 0).length,
    citationLocalClaimCount: claims.filter((claim) => claim.citationHandles.length > 0).length,
    claimCount: claims.length,
    claimTypeCounts: Object.freeze(claimTypeCounts),
    decisionCounts: Object.freeze(decisionCounts)
  });
}

function normalizedUsage(value: DiagnosticInput["usage"]): KnowledgeSemanticShadowUsageV1 {
  return Object.freeze({
    cacheWriteInputTokens: value?.cacheWriteInputTokens ?? null,
    cachedInputTokens: value?.cachedInputTokens ?? null,
    estimatedCostMicros: value?.estimatedCostMicros ?? null,
    inputTokens: value?.inputTokens ?? null,
    outputTokens: value?.outputTokens ?? null,
    reasoningTokens: value?.reasoningTokens ?? null,
    requests: value?.requests ?? 0,
    totalTokens: value?.totalTokens ?? null
  });
}

function validateExecutionMetadata(input: DiagnosticInput): void {
  if (!knowledgeSemanticShadowExecutionStatuses.includes(input.executionStatus) ||
    !validator(input.validator) || !usage(normalizedUsage(input.usage)) ||
    input.evidence.runId.length < 1 || input.evidence.runId.length > 128 ||
    input.evidence.sessionId.length < 1 || input.evidence.sessionId.length > 128 ||
    input.attemptId !== undefined && input.attemptId !== null &&
      !safeOpaqueId.test(input.attemptId) ||
    input.answer.length > 2_000_000 ||
    input.latencyMs !== undefined && input.latencyMs !== null &&
      !boundedNumber(input.latencyMs, 0, 3_600_000)) {
    throw new Error("knowledge_semantic_shadow_input_invalid");
  }
  const reason = input.failureReasonCode ?? null;
  if ((input.executionStatus === "complete" && reason !== null) ||
    (input.executionStatus !== "complete" &&
      (typeof reason !== "string" || !safeReason.test(reason))) ||
    (input.executionStatus !== "complete" && input.validator.semanticProof)) {
    throw new Error("knowledge_semantic_shadow_execution_invalid");
  }
  const usageValue = normalizedUsage(input.usage);
  if (input.validator.egress === "external" && input.executionStatus === "complete" &&
    (usageValue.requests < 1 || usageValue.inputTokens === null ||
      usageValue.outputTokens === null || usageValue.totalTokens === null ||
      usageValue.cachedInputTokens === null || usageValue.cacheWriteInputTokens === null ||
      usageValue.reasoningTokens === null || usageValue.estimatedCostMicros === null ||
      input.attemptId === undefined || input.attemptId === null)) {
    throw new Error("knowledge_semantic_shadow_external_usage_missing");
  }
}

function sealDiagnostic(
  input: DiagnosticInput,
  claims: readonly KnowledgeSemanticShadowClaimV1[]
): KnowledgeSemanticShadowDiagnosticV1 {
  const body = Object.freeze({
    // Bind to the same raw final-answer bytes as KnowledgeGroundingResult.
    // The surrounding diagnostic still uses canonical JSON for its receipt.
    answerHash: hashText(input.answer),
    attemptId: input.attemptId ?? null,
    blockingApplied: false as const,
    claims: Object.freeze([...claims]),
    evidenceReceiptHash: knowledgeEvidenceReceiptHash(input.evidence),
    executionStatus: input.executionStatus,
    failureReasonCode: input.failureReasonCode ?? null,
    latencyMs: input.latencyMs ?? null,
    runId: input.evidence.runId,
    sessionId: input.evidence.sessionId,
    summary: summary(claims),
    usage: normalizedUsage(input.usage),
    validator: Object.freeze({ ...input.validator }),
    version: KNOWLEDGE_SEMANTIC_SHADOW_VERSION
  });
  const sealed = Object.freeze({ ...body, receiptHash: hash(body) });
  if (Buffer.byteLength(JSON.stringify(sealed), "utf8") >
      KNOWLEDGE_SEMANTIC_SHADOW_MAX_DIAGNOSTIC_JSON_BYTES ||
    !decodeKnowledgeSemanticShadowDiagnosticV1(sealed)) {
    throw new Error("knowledge_semantic_shadow_diagnostic_invalid");
  }
  return sealed;
}

/**
 * Seals a private, claim-local semantic shadow diagnostic. Raw claim and evidence
 * text are hashed into the receipt but deliberately not retained in the output.
 */
export function createKnowledgeSemanticShadowDiagnosticV1(
  input: DiagnosticInput
): KnowledgeSemanticShadowDiagnosticV1 {
  validateExecutionMetadata(input);
  const allClaims = segmentKnowledgeSemanticClaims({ answer: input.answer, evidence: input.evidence });
  const segmented = allClaims.length <= KNOWLEDGE_SEMANTIC_SHADOW_MAX_CLAIMS
    ? allClaims
    : input.executionStatus === "complete"
      ? null
      : Object.freeze([]);
  if (!segmented) {
    throw new Error("knowledge_semantic_shadow_claim_limit");
  }
  if (!claimsWithinReceiptLimits(segmented)) {
    throw new Error("knowledge_semantic_shadow_citation_limit");
  }
  const predictions = input.predictions ?? [];
  if (input.executionStatus === "complete" && predictions.length !== segmented.length ||
    input.executionStatus !== "complete" && predictions.length !== 0) {
    throw new Error("knowledge_semantic_shadow_prediction_count_invalid");
  }
  const decoded = segmented.map((claim, index) => {
    if (input.executionStatus !== "complete") {
      return unavailablePrediction(claim, input.validator.profileId, input.validator.profileVersion);
    }
    const prediction = decodeKnowledgeSemanticGroundingPrediction(claim, predictions[index]);
    if (!prediction || prediction.validatorProfile !== input.validator.profileId ||
      prediction.validatorVersion !== input.validator.profileVersion) {
      throw new Error("knowledge_semantic_shadow_prediction_invalid");
    }
    return prediction;
  });
  const claims = Object.freeze(segmented.map((claim, index) =>
    claimReceipt(claim, decoded[index]!)));
  return sealDiagnostic(input, claims);
}

/**
 * Creates a bounded outage/error receipt without running segmentation. This is
 * the non-blocking terminal used when even shadow preparation cannot safely run.
 */
export function createUnavailableKnowledgeSemanticShadowDiagnosticV1(input: Readonly<{
  answer: string;
  evidence: KnowledgeEvidencePackage;
  executionStatus?: "failed" | "unavailable";
  failureReasonCode: string;
  validator: KnowledgeSemanticShadowValidatorV1;
}>): KnowledgeSemanticShadowDiagnosticV1 {
  const completeInput: DiagnosticInput = {
    ...input,
    executionStatus: input.executionStatus ?? "unavailable",
    predictions: []
  };
  validateExecutionMetadata(completeInput);
  return sealDiagnostic(completeInput, Object.freeze([]));
}

/** A zero-egress baseline which records structure only and never claims entailment. */
export function createStructuralKnowledgeSemanticShadowDiagnosticV1(input: Readonly<{
  answer: string;
  evidence: KnowledgeEvidencePackage;
}>): KnowledgeSemanticShadowDiagnosticV1 {
  const claims = segmentKnowledgeSemanticClaims(input);
  if (claims.length > KNOWLEDGE_SEMANTIC_SHADOW_MAX_CLAIMS) {
    return createUnavailableKnowledgeSemanticShadowDiagnosticV1({
      ...input,
      failureReasonCode: "claim_limit_exceeded",
      validator: Object.freeze({
        egress: "none",
        profileId: "structural-baseline-v1",
        profileVersion: 1,
        semanticProof: false
      })
    });
  }
  if (!claimsWithinReceiptLimits(claims)) {
    return createUnavailableKnowledgeSemanticShadowDiagnosticV1({
      ...input,
      failureReasonCode: "citation_limit_exceeded",
      validator: Object.freeze({
        egress: "none",
        profileId: "structural-baseline-v1",
        profileVersion: 1,
        semanticProof: false
      })
    });
  }
  try {
    return createKnowledgeSemanticShadowDiagnosticV1({
      ...input,
      executionStatus: "complete",
      predictions: claims.map(structuralPrediction),
      validator: Object.freeze({
        egress: "none",
        profileId: "structural-baseline-v1",
        profileVersion: 1,
        semanticProof: false
      })
    });
  } catch (error) {
    if (!(error instanceof Error) ||
      error.message !== "knowledge_semantic_shadow_diagnostic_invalid") throw error;
    return createUnavailableKnowledgeSemanticShadowDiagnosticV1({
      ...input,
      failureReasonCode: "diagnostic_size_exceeded",
      validator: Object.freeze({
        egress: "none",
        profileId: "structural-baseline-v1",
        profileVersion: 1,
        semanticProof: false
      })
    });
  }
}

/** Explicit allowlist projection for logs/metrics; no private identity or hash is copied. */
export function createKnowledgeSemanticShadowContentFreeMetricsV1(
  value: KnowledgeSemanticShadowDiagnosticV1
): KnowledgeSemanticShadowContentFreeMetricsV1 {
  const diagnostic = decodeKnowledgeSemanticShadowDiagnosticV1(value);
  if (!diagnostic) throw new Error("knowledge_semantic_shadow_diagnostic_invalid");
  const confidenceBucketCounts = emptyCounts(knowledgeSemanticShadowConfidenceBuckets);
  const recommendedActionCounts = emptyCounts(knowledgeSemanticShadowRecommendedActions);
  for (const claim of diagnostic.claims) {
    confidenceBucketCounts[claim.confidenceBucket] += 1;
    recommendedActionCounts[claim.recommendedAction] += 1;
  }
  const metrics = Object.freeze({
    attributableClaimCount: diagnostic.summary.attributableClaimCount,
    blockingApplied: false,
    citationLocalClaimCount: diagnostic.summary.citationLocalClaimCount,
    claimCount: diagnostic.summary.claimCount,
    claimTypeCounts: Object.freeze({ ...diagnostic.summary.claimTypeCounts }),
    confidenceBucketCounts: Object.freeze(confidenceBucketCounts),
    decisionCounts: Object.freeze({ ...diagnostic.summary.decisionCounts }),
    egress: diagnostic.validator.egress,
    executionStatus: diagnostic.executionStatus,
    failureReasonCode: diagnostic.failureReasonCode,
    latencyMs: diagnostic.latencyMs,
    mode: "shadow",
    recommendedActionCounts: Object.freeze(recommendedActionCounts),
    semanticProof: diagnostic.validator.semanticProof,
    usage: Object.freeze({ ...diagnostic.usage }),
    validatorProfile: diagnostic.validator.profileId,
    validatorVersion: diagnostic.validator.profileVersion,
    version: KNOWLEDGE_SEMANTIC_SHADOW_VERSION
  });
  if (Buffer.byteLength(JSON.stringify(metrics), "utf8") >
      KNOWLEDGE_SEMANTIC_SHADOW_MAX_METRICS_JSON_BYTES ||
    !decodeKnowledgeSemanticShadowContentFreeMetricsV1(metrics)) {
    throw new Error("knowledge_semantic_shadow_metrics_invalid");
  }
  return metrics;
}

function decodeLocatorStates(value: unknown): KnowledgeSemanticShadowClaimV1["locatorStates"] | null {
  if (!Array.isArray(value) || value.length > 1_000) return null;
  const decoded: { handle: string; state: KnowledgeSemanticLocatorState }[] = [];
  for (const entry of value) {
    if (!record(entry) || !exactKeys(entry, ["handle", "state"]) ||
      typeof entry.handle !== "string" || !citationHandle.test(entry.handle) ||
      !["deleted", "invalid", "missing", "valid"].includes(String(entry.state))) return null;
    decoded.push({
      handle: entry.handle,
      state: entry.state as KnowledgeSemanticLocatorState
    });
  }
  if (new Set(decoded.map(({ handle }) => handle)).size !== decoded.length) return null;
  return Object.freeze(decoded.map((entry) => Object.freeze(entry)));
}

function decodeClaim(value: unknown): KnowledgeSemanticShadowClaimV1 | null {
  const confidence = record(value) ? knowledgeSemanticConfidence(value.confidence) : null;
  if (!record(value) || !exactKeys(value, [
    "answerEnd", "answerStart", "attributableHandles", "citationHandles", "claimHash",
    "confidence", "confidenceBucket", "contextKeyHash", "decision", "locatorStates",
    "neighborhoodHash", "neighborhoodRule", "ordinal", "reasonFamily", "recommendedAction",
    "sourceShape", "type", "unknownCitationHandles", "version"
  ]) || value.version !== KNOWLEDGE_SEMANTIC_SHADOW_VERSION ||
    !boundedInteger(value.ordinal, 1, KNOWLEDGE_SEMANTIC_SHADOW_MAX_CLAIMS) ||
    !boundedInteger(value.answerStart, 0, 2_000_000) ||
    !boundedInteger(value.answerEnd, Number(value.answerStart), 2_000_000) ||
    typeof value.claimHash !== "string" || !lowercaseSha256.test(value.claimHash) ||
    typeof value.neighborhoodHash !== "string" || !lowercaseSha256.test(value.neighborhoodHash) ||
    value.contextKeyHash !== null &&
      (typeof value.contextKeyHash !== "string" || !lowercaseSha256.test(value.contextKeyHash)) ||
    confidence === null ||
    !["high", "low", "medium", "unavailable"].includes(String(value.confidenceBucket)) ||
    !knowledgeSemanticGroundingDecisions.includes(value.decision as KnowledgeSemanticGroundingDecision) ||
    !knowledgeSemanticReasonFamilies.includes(value.reasonFamily as KnowledgeSemanticReasonFamily) ||
    !knowledgeSemanticClaimTypes.includes(value.type as KnowledgeSemanticClaimType) ||
    !["inline", "none", "table_cell", "table_row_inherited"].includes(
      String(value.neighborhoodRule)) ||
    !["retain", "review"].includes(String(value.recommendedAction)) ||
    !["list", "prose", "table_cell"].includes(String(value.sourceShape))) return null;
  const citationHandles = uniqueStrings(value.citationHandles, 1_000, (entry) => citationHandle.test(entry));
  const attributableHandles = uniqueStrings(
    value.attributableHandles, 1_000, (entry) => citationHandle.test(entry)
  );
  const unknownCitationHandles = uniqueStrings(
    value.unknownCitationHandles, 1_000,
    (entry) => entry.length > 0 && entry.length <= 18 && /^K/u.test(entry)
  );
  const locatorStates = decodeLocatorStates(value.locatorStates);
  if (!citationHandles || !attributableHandles || !unknownCitationHandles || !locatorStates ||
    attributableHandles.some((handle) => !citationHandles.includes(handle)) ||
    locatorStates.some(({ handle }) => !citationHandles.includes(handle)) ||
    value.confidenceBucket !== confidenceBucket(confidence) ||
    value.recommendedAction !== recommendedAction({
      decision: value.decision as KnowledgeSemanticGroundingDecision,
      type: value.type as KnowledgeSemanticClaimType
    })) return null;
  return Object.freeze({
    answerEnd: value.answerEnd,
    answerStart: value.answerStart,
    attributableHandles,
    citationHandles,
    claimHash: value.claimHash,
    confidence,
    confidenceBucket: value.confidenceBucket as KnowledgeSemanticShadowConfidenceBucket,
    contextKeyHash: value.contextKeyHash as string | null,
    decision: value.decision as KnowledgeSemanticGroundingDecision,
    locatorStates,
    neighborhoodHash: value.neighborhoodHash,
    neighborhoodRule: value.neighborhoodRule as KnowledgeSemanticNeighborhoodRule,
    ordinal: value.ordinal,
    reasonFamily: value.reasonFamily as KnowledgeSemanticReasonFamily,
    recommendedAction: value.recommendedAction as KnowledgeSemanticShadowRecommendedAction,
    sourceShape: value.sourceShape as KnowledgeSemanticSourceShape,
    type: value.type as KnowledgeSemanticClaimType,
    unknownCitationHandles,
    version: KNOWLEDGE_SEMANTIC_SHADOW_VERSION
  });
}

function decodeCountRecord<T extends string>(
  value: unknown,
  keys: readonly T[],
  maximum: number
): Readonly<Record<T, number>> | null {
  if (!record(value) || !exactKeys(value, keys)) return null;
  const result = {} as Record<T, number>;
  for (const key of keys) {
    if (!boundedInteger(value[key], 0, maximum)) return null;
    result[key] = value[key];
  }
  return Object.freeze(result);
}

function decodeSummary(value: unknown): KnowledgeSemanticShadowSummaryV1 | null {
  if (!record(value) || !exactKeys(value, [
    "attributableClaimCount", "citationLocalClaimCount", "claimCount",
    "claimTypeCounts", "decisionCounts"
  ]) || !boundedInteger(value.claimCount, 0, KNOWLEDGE_SEMANTIC_SHADOW_MAX_CLAIMS) ||
    !boundedInteger(value.attributableClaimCount, 0, Number(value.claimCount)) ||
    !boundedInteger(value.citationLocalClaimCount, 0, Number(value.claimCount))) return null;
  const claimTypeCounts = decodeCountRecord(
    value.claimTypeCounts, knowledgeSemanticClaimTypes, Number(value.claimCount)
  );
  const decisionCounts = decodeCountRecord(
    value.decisionCounts, knowledgeSemanticGroundingDecisions, Number(value.claimCount)
  );
  if (!claimTypeCounts || !decisionCounts ||
    Object.values(claimTypeCounts).reduce((total, count) => total + count, 0) !== value.claimCount ||
    Object.values(decisionCounts).reduce((total, count) => total + count, 0) !== value.claimCount) {
    return null;
  }
  return Object.freeze({
    attributableClaimCount: value.attributableClaimCount,
    citationLocalClaimCount: value.citationLocalClaimCount,
    claimCount: value.claimCount,
    claimTypeCounts,
    decisionCounts
  });
}

export function decodeKnowledgeSemanticShadowContentFreeMetricsV1(
  value: unknown
): KnowledgeSemanticShadowContentFreeMetricsV1 | null {
  if (!record(value) || !exactKeys(value, [
    "attributableClaimCount", "blockingApplied", "citationLocalClaimCount", "claimCount",
    "claimTypeCounts", "confidenceBucketCounts", "decisionCounts", "egress",
    "executionStatus", "failureReasonCode", "latencyMs", "mode", "recommendedActionCounts",
    "semanticProof", "usage", "validatorProfile", "validatorVersion", "version"
  ]) || value.version !== KNOWLEDGE_SEMANTIC_SHADOW_VERSION || value.mode !== "shadow" ||
    value.blockingApplied !== false ||
    !boundedInteger(value.claimCount, 0, KNOWLEDGE_SEMANTIC_SHADOW_MAX_CLAIMS) ||
    !boundedInteger(value.attributableClaimCount, 0, Number(value.claimCount)) ||
    !boundedInteger(value.citationLocalClaimCount, 0, Number(value.claimCount)) ||
    !knowledgeSemanticShadowEgressModes.includes(value.egress as KnowledgeSemanticShadowEgressMode) ||
    !knowledgeSemanticShadowExecutionStatuses.includes(
      value.executionStatus as KnowledgeSemanticShadowExecutionStatus
    ) || typeof value.semanticProof !== "boolean" ||
    typeof value.validatorProfile !== "string" || !safeProfile.test(value.validatorProfile) ||
    !boundedInteger(value.validatorVersion, 1, 10_000) ||
    value.latencyMs !== null && !boundedNumber(value.latencyMs, 0, 3_600_000)) return null;
  const reasonValid = value.executionStatus === "complete"
    ? value.failureReasonCode === null
    : typeof value.failureReasonCode === "string" && safeReason.test(value.failureReasonCode);
  const claimTypeCounts = decodeCountRecord(
    value.claimTypeCounts, knowledgeSemanticClaimTypes, Number(value.claimCount)
  );
  const decisionCounts = decodeCountRecord(
    value.decisionCounts, knowledgeSemanticGroundingDecisions, Number(value.claimCount)
  );
  const confidenceBucketCounts = decodeCountRecord(
    value.confidenceBucketCounts, knowledgeSemanticShadowConfidenceBuckets,
    Number(value.claimCount)
  );
  const recommendedActionCounts = decodeCountRecord(
    value.recommendedActionCounts, knowledgeSemanticShadowRecommendedActions,
    Number(value.claimCount)
  );
  const decodedUsage = usage(value.usage);
  const countMatches = (counts: Readonly<Record<string, number>> | null) => counts !== null &&
    Object.values(counts).reduce((total, count) => total + count, 0) === value.claimCount;
  if (!reasonValid || value.executionStatus !== "complete" && value.semanticProof ||
    !countMatches(claimTypeCounts) || !countMatches(decisionCounts) ||
    !countMatches(confidenceBucketCounts) || !countMatches(recommendedActionCounts) ||
    !decodedUsage || value.egress === "external" && value.executionStatus === "complete" &&
      (decodedUsage.requests < 1 || decodedUsage.inputTokens === null ||
        decodedUsage.outputTokens === null || decodedUsage.totalTokens === null ||
        decodedUsage.cachedInputTokens === null || decodedUsage.cacheWriteInputTokens === null ||
        decodedUsage.reasoningTokens === null || decodedUsage.estimatedCostMicros === null)) return null;
  return Object.freeze({
    attributableClaimCount: value.attributableClaimCount,
    blockingApplied: false,
    citationLocalClaimCount: value.citationLocalClaimCount,
    claimCount: value.claimCount,
    claimTypeCounts: claimTypeCounts!,
    confidenceBucketCounts: confidenceBucketCounts!,
    decisionCounts: decisionCounts!,
    egress: value.egress as KnowledgeSemanticShadowEgressMode,
    executionStatus: value.executionStatus as KnowledgeSemanticShadowExecutionStatus,
    failureReasonCode: value.failureReasonCode as string | null,
    latencyMs: value.latencyMs as number | null,
    mode: "shadow",
    recommendedActionCounts: recommendedActionCounts!,
    semanticProof: value.semanticProof,
    usage: decodedUsage,
    validatorProfile: value.validatorProfile,
    validatorVersion: value.validatorVersion,
    version: KNOWLEDGE_SEMANTIC_SHADOW_VERSION
  });
}

export function canonicalKnowledgeSemanticShadowDiagnosticV1(value: unknown): string | null {
  const decoded = decodeKnowledgeSemanticShadowDiagnosticV1(value);
  return decoded ? canonicalJson(decoded) : null;
}

export function hashKnowledgeSemanticShadowDiagnosticV1(value: unknown): string | null {
  const decoded = decodeKnowledgeSemanticShadowDiagnosticV1(value);
  return decoded?.receiptHash ?? null;
}

/** Strict storage/recovery decoder; malformed or internally inconsistent rows fail closed. */
export function decodeKnowledgeSemanticShadowDiagnosticV1(
  value: unknown
): KnowledgeSemanticShadowDiagnosticV1 | null {
  if (!record(value) || !exactKeys(value, [
    "answerHash", "attemptId", "blockingApplied", "claims", "evidenceReceiptHash",
    "executionStatus", "failureReasonCode", "latencyMs", "receiptHash", "runId", "sessionId",
    "summary", "usage", "validator", "version"
  ]) || value.version !== KNOWLEDGE_SEMANTIC_SHADOW_VERSION || value.blockingApplied !== false ||
    typeof value.answerHash !== "string" || !lowercaseSha256.test(value.answerHash) ||
    typeof value.evidenceReceiptHash !== "string" || !lowercaseSha256.test(value.evidenceReceiptHash) ||
    typeof value.receiptHash !== "string" || !lowercaseSha256.test(value.receiptHash) ||
    value.attemptId !== null &&
      (typeof value.attemptId !== "string" || !safeOpaqueId.test(value.attemptId)) ||
    typeof value.runId !== "string" || value.runId.length < 1 || value.runId.length > 128 ||
    typeof value.sessionId !== "string" || value.sessionId.length < 1 || value.sessionId.length > 128 ||
    !knowledgeSemanticShadowExecutionStatuses.includes(
      value.executionStatus as KnowledgeSemanticShadowExecutionStatus
    ) || value.latencyMs !== null && !boundedNumber(value.latencyMs, 0, 3_600_000) ||
    !Array.isArray(value.claims) || value.claims.length > KNOWLEDGE_SEMANTIC_SHADOW_MAX_CLAIMS) {
    return null;
  }
  const decodedValidator = validator(value.validator);
  const decodedUsage = usage(value.usage);
  const decodedClaims = value.claims.map(decodeClaim);
  const decodedSummary = decodeSummary(value.summary);
  const reasonValid = value.executionStatus === "complete"
    ? value.failureReasonCode === null
    : typeof value.failureReasonCode === "string" && safeReason.test(value.failureReasonCode);
  if (!decodedValidator || !decodedUsage || !decodedSummary ||
    decodedClaims.some((claim) => claim === null) || !reasonValid ||
    value.executionStatus !== "complete" && decodedValidator.semanticProof ||
    decodedClaims.some((claim, index) => claim!.ordinal !== index + 1) ||
    decodedSummary.claimCount !== decodedClaims.length) return null;
  const claims = Object.freeze(decodedClaims as KnowledgeSemanticShadowClaimV1[]);
  const expectedSummary = summary(claims);
  if (canonicalJson(expectedSummary) !== canonicalJson(decodedSummary)) return null;
  if (decodedValidator.egress === "external" && value.executionStatus === "complete" &&
    (decodedUsage.requests < 1 || decodedUsage.inputTokens === null ||
      decodedUsage.outputTokens === null || decodedUsage.totalTokens === null ||
      decodedUsage.cachedInputTokens === null || decodedUsage.cacheWriteInputTokens === null ||
      decodedUsage.reasoningTokens === null || decodedUsage.estimatedCostMicros === null ||
      value.attemptId === null)) return null;
  const body = {
    answerHash: value.answerHash,
    attemptId: value.attemptId as string | null,
    blockingApplied: false as const,
    claims,
    evidenceReceiptHash: value.evidenceReceiptHash,
    executionStatus: value.executionStatus as KnowledgeSemanticShadowExecutionStatus,
    failureReasonCode: value.failureReasonCode as string | null,
    latencyMs: value.latencyMs as number | null,
    runId: value.runId,
    sessionId: value.sessionId,
    summary: decodedSummary,
    usage: decodedUsage,
    validator: decodedValidator,
    version: KNOWLEDGE_SEMANTIC_SHADOW_VERSION
  };
  if (hash(body) !== value.receiptHash) return null;
  return Object.freeze({ ...body, receiptHash: value.receiptHash });
}

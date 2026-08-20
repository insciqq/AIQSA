import { z } from "zod";
import { KNOWLEDGE_GROUNDING_VERSION } from "../../lib/server/knowledge/grounding";
import {
  DEFAULT_KNOWLEDGE_BUDGET_POLICY,
  KNOWLEDGE_BUDGET_POLICY_VERSION
} from "../../lib/server/knowledge/knowledgeBudget";
import {
  KNOWLEDGE_CANDIDATE_LIMIT,
  KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES,
  KNOWLEDGE_QUERY_MAX_CHARACTERS,
  KNOWLEDGE_RESULT_LIMIT,
  KNOWLEDGE_SCOPE_MAX_BINDINGS,
  KNOWLEDGE_SCOPE_MAX_SOURCES,
  KNOWLEDGE_SCORE_THRESHOLD
} from "../../lib/server/knowledge/retrievalTypes";
import { KNOWLEDGE_H0_CORPUS_VERSION } from "./h0Corpus";

const finiteNonNegative = z.number().finite().nonnegative();
const rate = z.number().min(0).max(1);

export const knowledgeH0LaunchThresholdsSchema = z.strictObject({
  grounding: z.strictObject({
    citationHandleValidityMinimum: z.literal(1),
    citationPrecisionMinimum: z.literal(0.95),
    contradictionPrecisionMinimum: z.literal(0.95),
    contradictionRecallMinimum: z.literal(0.9),
    correctNoAnswerMinimum: z.literal(0.9),
    criticalNumericDateAttributionMinimum: z.literal(1),
    numericDateAttributionMinimum: z.literal(0.98),
    temporalVersionReferenceFalseBlockerMaximum: z.literal(0),
    unsupportedSourceClaimRateMaximum: z.literal(0.02)
  }),
  retrieval: z.strictObject({
    annRecallAt10RelativeToExactMinimum: z.literal(0.95),
    comparisonTargetCoverageMinimum: z.literal(1),
    documentRecallAt10Minimum: z.literal(0.95),
    exactIdentifierRecallMinimum: z.literal(0.99),
    passageSectionRecallAt10Minimum: z.literal(0.9),
    sourceDuplicateInflationMaximum: z.literal(0)
  }),
  samplePolicy: z.strictObject({
    englishAndRussianReportedSeparately: z.literal(true),
    insufficientSampleMayEnableBlocking: z.literal(false),
    thresholdsFrozenBeforeHeldOutRun: z.literal(true)
  }),
  structural: z.strictObject({
    duplicateSourceConflictFailureMaximum: z.literal(0),
    handleValidityMinimum: z.literal(1),
    modelHandleSourceMappingMinimum: z.literal(1),
    noCrossScopeLeakageMinimum: z.literal(1),
    operationOrdinalPolicyConsistencyMinimum: z.literal(1),
    providerManifestReplayConsistencyMinimum: z.literal(1),
    recoveryIdempotencyMinimum: z.literal(1)
  }),
  tableContext: z.strictObject({
    actualReferenceRoleAccuracyMinimum: z.literal(0.98),
    ambiguousLooseBlockJoinFalsePositiveMaximum: z.literal(0),
    arithmeticRecomputationMinimum: z.literal(1),
    recognizedRowIntegrityMinimum: z.literal(1)
  }),
  version: z.literal("knowledge-hardening-launch-thresholds-v1")
});

const activeRuntimeSchema = z.strictObject({
  groundingVersion: z.number().int().positive(),
  knowledgeBudget: z.strictObject({
    estimatedEmbeddingCostMicrosPerThousandTokens: finiteNonNegative,
    maxConsecutiveLowNoveltyOperations: finiteNonNegative,
    maxCumulativeCandidates: finiteNonNegative,
    maxEstimatedCostMicros: finiteNonNegative,
    maxFollowUpOperations: finiteNonNegative,
    maxLatencyMs: finiteNonNegative,
    maxOperations: finiteNonNegative,
    maxQueryEmbeddingCalls: finiteNonNegative,
    maxRerankerCalls: finiteNonNegative,
    maxRetrievedTokens: finiteNonNegative,
    maxSearchPhases: finiteNonNegative,
    maxSubqueriesPerPhase: finiteNonNegative,
    minNoveltyRatio: rate,
    version: z.number().int().positive()
  }),
  persistenceInvocationOrdinalMaximum: z.literal(256),
  retrieval: z.strictObject({
    candidateLimit: z.number().int().positive(),
    providerTextMaximumBytes: z.number().int().positive(),
    queryMaximumCharacters: z.number().int().positive(),
    resultLimit: z.number().int().positive(),
    scopeMaximumBindings: z.number().int().positive(),
    scopeMaximumSources: z.number().int().positive(),
    scoreThreshold: rate
  })
});

export const knowledgeH0ReferenceEnvironmentSchema = z.strictObject({
  activeRuntime: activeRuntimeSchema,
  benchmarkEnvironment: z.strictObject({
    appImage: z.literal(
      "mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948"
    ),
    appCpuLimit: z.literal(2),
    appMemoryBytes: z.literal(2_147_483_648),
    architecture: z.literal("linux_x86_64"),
    benchmarkEligible: z.literal(false),
    hostCpuModel: z.literal("unrecorded"),
    nodeMajor: z.literal(24),
    postgresImage: z.literal(
      "ghcr.io/insciqq/aiqsa-postgres:16.14-pgvector0.8.5@sha256:db8f80686e188be2abf9507d6a20d1cb230d47b1a4c8334cc7f076610b1d20ee"
    ),
    reasonCode: z.literal("host_hardware_and_real_embedding_profile_not_frozen"),
    topology: z.literal("disposable_compose")
  }),
  corpusVersion: z.literal(KNOWLEDGE_H0_CORPUS_VERSION),
  frozenAt: z.literal("2026-08-19"),
  latencyCostBudgets: z.strictObject({
    activeKnowledgeRun: z.strictObject({
      maxEstimatedCostMicros: finiteNonNegative,
      maxLatencyMilliseconds: finiteNonNegative,
      maxOperations: finiteNonNegative,
      maxRetrievedTokens: finiteNonNegative,
      source: z.literal("default_knowledge_budget_policy_v1")
    }),
    semanticValidator: z.strictObject({
      maxAdditionalProviderRequests: z.null(),
      maxCostMicros: z.null(),
      maxLatencyDeltaMilliseconds: z.null(),
      releaseBlockingEligible: z.literal(false),
      status: z.literal("not_configured")
    })
  }),
  thresholds: knowledgeH0LaunchThresholdsSchema,
  vectorProvenance: z.strictObject({
    oraclePlumbing: z.strictObject({
      approvedUses: z.tuple([
        z.literal("database_plumbing"),
        z.literal("scope_isolation"),
        z.literal("ann_exact_parity")
      ]),
      kind: z.literal("source_oracle"),
      modelIdentity: z.literal("knowledge-eval-embedding-v1"),
      releaseEmbeddingQualityEvidence: z.literal(false),
      status: z.literal("available")
    }),
    realEmbedding: z.strictObject({
      approvedCandidateProfileRevisionId: z.null(),
      kind: z.literal("real_embedding"),
      modelIdentity: z.null(),
      reasonCode: z.literal("approved_candidate_embedding_profile_not_frozen"),
      releaseEmbeddingQualityEvidence: z.literal(false),
      requiredForRelease: z.literal(true),
      status: z.literal("unavailable")
    })
  }),
  version: z.literal("knowledge-hardening-reference-environment-v1")
});

export const KNOWLEDGE_H0_REFERENCE_ENVIRONMENT =
  knowledgeH0ReferenceEnvironmentSchema.parse({
    activeRuntime: {
      groundingVersion: KNOWLEDGE_GROUNDING_VERSION,
      knowledgeBudget: { ...DEFAULT_KNOWLEDGE_BUDGET_POLICY },
      persistenceInvocationOrdinalMaximum: 256,
      retrieval: {
        candidateLimit: KNOWLEDGE_CANDIDATE_LIMIT,
        providerTextMaximumBytes: KNOWLEDGE_PROVIDER_TEXT_MAX_BYTES,
        queryMaximumCharacters: KNOWLEDGE_QUERY_MAX_CHARACTERS,
        resultLimit: KNOWLEDGE_RESULT_LIMIT,
        scopeMaximumBindings: KNOWLEDGE_SCOPE_MAX_BINDINGS,
        scopeMaximumSources: KNOWLEDGE_SCOPE_MAX_SOURCES,
        scoreThreshold: KNOWLEDGE_SCORE_THRESHOLD
      }
    },
    benchmarkEnvironment: {
      appImage: "mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948",
      appCpuLimit: 2,
      appMemoryBytes: 2_147_483_648,
      architecture: "linux_x86_64",
      benchmarkEligible: false,
      hostCpuModel: "unrecorded",
      nodeMajor: 24,
      postgresImage: "ghcr.io/insciqq/aiqsa-postgres:16.14-pgvector0.8.5@sha256:db8f80686e188be2abf9507d6a20d1cb230d47b1a4c8334cc7f076610b1d20ee",
      reasonCode: "host_hardware_and_real_embedding_profile_not_frozen",
      topology: "disposable_compose"
    },
    corpusVersion: KNOWLEDGE_H0_CORPUS_VERSION,
    frozenAt: "2026-08-19",
    latencyCostBudgets: {
      activeKnowledgeRun: {
        maxEstimatedCostMicros: DEFAULT_KNOWLEDGE_BUDGET_POLICY.maxEstimatedCostMicros,
        maxLatencyMilliseconds: DEFAULT_KNOWLEDGE_BUDGET_POLICY.maxLatencyMs,
        maxOperations: DEFAULT_KNOWLEDGE_BUDGET_POLICY.maxOperations,
        maxRetrievedTokens: DEFAULT_KNOWLEDGE_BUDGET_POLICY.maxRetrievedTokens,
        source: "default_knowledge_budget_policy_v1"
      },
      semanticValidator: {
        maxAdditionalProviderRequests: null,
        maxCostMicros: null,
        maxLatencyDeltaMilliseconds: null,
        releaseBlockingEligible: false,
        status: "not_configured"
      }
    },
    thresholds: {
      grounding: {
        citationHandleValidityMinimum: 1,
        citationPrecisionMinimum: 0.95,
        contradictionPrecisionMinimum: 0.95,
        contradictionRecallMinimum: 0.9,
        correctNoAnswerMinimum: 0.9,
        criticalNumericDateAttributionMinimum: 1,
        numericDateAttributionMinimum: 0.98,
        temporalVersionReferenceFalseBlockerMaximum: 0,
        unsupportedSourceClaimRateMaximum: 0.02
      },
      retrieval: {
        annRecallAt10RelativeToExactMinimum: 0.95,
        comparisonTargetCoverageMinimum: 1,
        documentRecallAt10Minimum: 0.95,
        exactIdentifierRecallMinimum: 0.99,
        passageSectionRecallAt10Minimum: 0.9,
        sourceDuplicateInflationMaximum: 0
      },
      samplePolicy: {
        englishAndRussianReportedSeparately: true,
        insufficientSampleMayEnableBlocking: false,
        thresholdsFrozenBeforeHeldOutRun: true
      },
      structural: {
        duplicateSourceConflictFailureMaximum: 0,
        handleValidityMinimum: 1,
        modelHandleSourceMappingMinimum: 1,
        noCrossScopeLeakageMinimum: 1,
        operationOrdinalPolicyConsistencyMinimum: 1,
        providerManifestReplayConsistencyMinimum: 1,
        recoveryIdempotencyMinimum: 1
      },
      tableContext: {
        actualReferenceRoleAccuracyMinimum: 0.98,
        ambiguousLooseBlockJoinFalsePositiveMaximum: 0,
        arithmeticRecomputationMinimum: 1,
        recognizedRowIntegrityMinimum: 1
      },
      version: "knowledge-hardening-launch-thresholds-v1"
    },
    vectorProvenance: {
      oraclePlumbing: {
        approvedUses: ["database_plumbing", "scope_isolation", "ann_exact_parity"],
        kind: "source_oracle",
        modelIdentity: "knowledge-eval-embedding-v1",
        releaseEmbeddingQualityEvidence: false,
        status: "available"
      },
      realEmbedding: {
        approvedCandidateProfileRevisionId: null,
        kind: "real_embedding",
        modelIdentity: null,
        reasonCode: "approved_candidate_embedding_profile_not_frozen",
        releaseEmbeddingQualityEvidence: false,
        requiredForRelease: true,
        status: "unavailable"
      }
    },
    version: "knowledge-hardening-reference-environment-v1"
  });

if (KNOWLEDGE_H0_REFERENCE_ENVIRONMENT.activeRuntime.knowledgeBudget.version !==
  KNOWLEDGE_BUDGET_POLICY_VERSION) {
  throw new Error("knowledge_h0_budget_policy_version_mismatch");
}

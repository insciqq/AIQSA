import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  writeFile
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { Client } from "pg";
import {
  Prisma,
  PrismaClient,
  type MemoryExecutionState,
  type MemoryJobKind,
  type MemoryJobState
} from "@prisma/client";
import { textMessageContent } from "../../lib/domain/content";
import { textFromContentBlocks } from "../../lib/domain/modelRunEvents";
import {
  MEMORY_CONTEXT_AGGREGATION_HARD_CAP_TOKENS,
  MEMORY_CONTEXT_AGGREGATION_TARGET_TOKENS,
  MEMORY_CONTEXT_COMPLEX_HARD_CAP_TOKENS,
  MEMORY_CONTEXT_COMPLEX_TARGET_TOKENS,
  MEMORY_CONTEXT_HARD_CAP_TOKENS,
  MEMORY_CONTEXT_PAST_CHAT_HARD_CAP_TOKENS,
  MEMORY_CONTEXT_PAST_CHAT_TARGET_TOKENS,
  MEMORY_CONTEXT_PACKER_VERSION,
  MEMORY_CONTEXT_TARGET_TOKENS,
  MEMORY_RETRIEVAL_FUSION_VERSION,
  MEMORY_RETRIEVAL_LANE_LIMITS,
  MEMORY_RETRIEVAL_MAX_AGGREGATION_HISTORY_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_AGGREGATION_PRE_FUSION_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_AGGREGATION_RANKED_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_PARALLEL_LANES,
  MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_RANKED_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_TARGETED_HISTORY_CANDIDATES,
  MEMORY_RETRIEVAL_PIPELINE_VERSION
} from "../../lib/domain/memory/retrieval/config";
import { RERANKER_ROUTE_POLICY_VERSION } from
  "../../lib/domain/rerankerModels";
import { createAdminMemoryEgressService } from
  "../../lib/server/admin/memory/egressService";
import {
  approvedRerankerDeploymentByProviderModelId,
  approvedRerankerDeployments
} from "../../lib/server/admin/providers/approvedRerankers";
import { createPrismaAuthSessionStore } from "../../lib/server/auth/prismaSessions";
import { createAuthSession } from "../../lib/server/auth/requestAuth";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { defaultMemoryExecutionAuthority } from
  "../../lib/server/memory/execution/defaultAuthority";
import { probeMemoryStructuredOutputAuthority } from
  "../../lib/server/memory/execution/structuredClassifier";
import {
  MEMORY_ITEM_EMBEDDING_VERSIONS,
  memoryItemEmbeddingGenerationMatchesPin
} from "../../lib/server/memory/embedding/contract";
import { probeCurrentMemoryEmbeddingPin } from
  "../../lib/server/memory/embedding/handler";
import { MEMORY_HISTORY_CHUNKING_VERSION } from
  "../../lib/server/memory/history/chunking";
import { MEMORY_HISTORY_CLASSIFICATION_VERSIONS } from
  "../../lib/server/memory/history/classifier";
import {
  MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION
} from "../../lib/server/memory/history/contract";
import { MEMORY_CONTEXTUAL_KEY_VERSIONS } from
  "../../lib/server/memory/history/contextualKeys";
import {
  MEMORY_CHAT_DIGEST_REBUILD_POLICY_VERSION,
  MEMORY_CHAT_DIGEST_VERSIONS
} from "../../lib/server/memory/history/digest";
import {
  MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
  MEMORY_RECALL_ROUND_PROJECTION_VERSION
} from "../../lib/server/memory/history/rounds";
import { MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION } from
  "../../lib/server/memory/history/segments";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from
  "../../lib/server/memory/history/sourceProjection";
import { MEMORY_TOOL_EVENT_PROJECTION_VERSION } from
  "../../lib/server/memory/history/toolEvents";
import { MEMORY_FACT_EXTRACTION_PIPELINE_VERSION } from
  "../../lib/server/memory/learning/extraction/contract";
import { createPrismaMemorySettingsRepository } from
  "../../lib/server/memory/persistence/settings";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_ANALYSIS_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION
} from "../../lib/server/memory/persistence/lexical";
import { createRerankerModelRoleResolver } from
  "../../lib/server/providerRuntime/rerankerModelRole";
import { normalizeProviderModelConfiguration } from
  "../../lib/server/providers/providerConfiguration";
import { createPrismaMemoryRebuildRepository } from
  "../../lib/server/memory/rebuild/repository";
import { parseMemoryRebuildJobFingerprint } from
  "../../lib/server/memory/rebuild/contract";
import { createMemoryRebuildService } from
  "../../lib/server/memory/rebuild/service";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from
  "../../lib/server/memory/retrieval/vector";
import {
  MEMORY_CONTROL_OPTIONAL_MAXIMUM_MS,
  MEMORY_INTERACTIVE_HARD_DEADLINE_MS,
  MEMORY_INTERACTIVE_SOFT_DEADLINE_MS,
  MEMORY_QUERY_RESOLVER_OPTIONAL_MAXIMUM_MS,
  MEMORY_QUERY_RESOLVER_SETTLEMENT_RESERVE_MS,
  MEMORY_RUN_RETRIEVAL_ADMISSION_VERSION
} from "../../lib/server/memory/retrieval/runAdmission";
import { MEMORY_SAFETY_LITE_POLICY_VERSION } from
  "../../lib/server/memory/safetyLite";
import { defaultMemorySourceMutationHooks } from
  "../../lib/server/memory/sourceHooks";
import {
  applyMemorySourceMutations,
  lockMemorySourceChat
} from "../../lib/server/memory/sourceState";
import { memorySynthesisSourceAuthorityPredicate } from
  "../../lib/server/memory/synthesis/eligibility";
import {
  MEMORY_SYNTHESIS_LOW_ACTIVITY_FALLBACK_MS,
  MEMORY_SYNTHESIS_MIN_ELIGIBLE_SOURCES,
  MEMORY_SYNTHESIS_POLICY_VERSION,
  MEMORY_SYNTHESIS_QUIET_PERIOD_MS
} from
  "../../lib/server/memory/synthesis/policy";
import { MEMORY_SYNTHESIS_VERSIONS } from
  "../../lib/server/memory/synthesis/provider";
import {
  loadMemorySynthesisScheduleStatus,
  reconcileMemorySynthesisWork
} from
  "../../lib/server/memory/synthesis/reconcile";
import {
  LONGMEMEVAL_EVALUATOR_SHA256,
  LONGMEMEVAL_MAX_CASE_CONCURRENCY,
  LONGMEMEVAL_MAX_SESSION_CONCURRENCY,
  LONGMEMEVAL_ORACLE_SHA256,
  LONGMEMEVAL_REPOSITORY_COMMIT,
  LONGMEMEVAL_S_SHA256,
  LONGMEMEVAL_SYSTEM_MODEL_RUNTIME,
  assertBenchmarkBaseUrl,
  assertBenchmarkDatabaseUrl,
  buildLongMemEvalBaselineManifest,
  decodeLongMemEvalDataset,
  decodeLongMemEvalProfile,
  decodeLongMemEvalSystemModelId,
  evaluateLongMemEvalComponentMetrics,
  longMemEvalEmbeddingBatchSizeDistribution,
  longMemEvalDocumentEmbeddingModelMismatch,
  longMemEvalExpectedUtilityModelIds,
  longMemEvalHybridRebuildFailureCode,
  longMemEvalLexicalCutoverHealthy,
  longMemEvalProfileManifest,
  longMemEvalProductMemoryPipelineComplete,
  longMemEvalQualificationGate,
  longMemEvalQuestionPrompt,
  longMemEvalSettledImportTurns,
  mapConcurrentOrdered,
  mapConcurrentOrderedWaves,
  parseLongMemEvalDate,
  resolveBenchmarkOutputDirectory,
  sanitizeLongMemEvalRetrievalAudit,
  selectLongMemEvalCases,
  type LongMemEvalCase,
  type LongMemEvalComponentMetrics,
  type LongMemEvalLearningEvidence,
  type LongMemEvalProfile,
  type LongMemEvalRetrievalAudit,
  type LongMemEvalSystemModelId
} from "./contract";
import { redactLongMemEvalDebugArtifact } from "./debug";
import { withLongMemEvalIdentitySetupRetry } from "./identitySetupRetry";
import {
  createLongMemEvalCheckpointRun,
  loadLongMemEvalCaseCheckpoints,
  resumeLongMemEvalCheckpointRun,
  writeLongMemEvalAnswersAtomic,
  writeLongMemEvalCaseCheckpoint,
  type LongMemEvalCaseCheckpoint,
  type LongMemEvalCheckpointOutcome
} from "./checkpoint";
import {
  readLongMemEvalCaseEvaluation,
  settleLongMemEvalCaseEvaluation,
  type LongMemEvalCaseEvaluation
} from "./caseEvaluation";
import {
  assertLongMemEvalQualificationDataset,
  decodeLongMemEvalQualificationManifestId,
  isLongMemEvalActiveQualificationManifest,
  loadLongMemEvalQualificationManifest,
  longMemEvalEvaluationRequiresStop,
  type LongMemEvalQualificationManifest,
  type LongMemEvalQualificationManifestId
} from "./qualification";
import { assertLongMemEvalQualificationRevision } from
  "./qualificationRevision";
import {
  LONGMEMEVAL_PREPARED_CASE_CACHE_VERSION,
  LONGMEMEVAL_PREPARED_CASE_EMAIL_SUFFIX,
  LONGMEMEVAL_PREPARED_CASE_IMPORT_VERSION,
  longMemEvalPreparedCaseAdvisoryKey,
  longMemEvalPreparedCaseBuildingEmail,
  longMemEvalPreparedCaseDisplayName,
  longMemEvalPreparedCaseFingerprint,
  longMemEvalPreparedCaseReadyFingerprint,
  longMemEvalPreparedCaseReadyEmail
} from "./preparedCaseCache";

const execFile = promisify(execFileCallback);
const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(benchmarkRoot, "../..");
const upstreamRoot = resolve(benchmarkRoot, ".upstream");
const datasetPath = resolve(upstreamRoot, "data/longmemeval_s_cleaned.json");
const oraclePath = resolve(upstreamRoot, "data/longmemeval_oracle.json");
const evaluatorPath = resolve(upstreamRoot, "src/evaluation/evaluate_qa.py");
const benchmarkEmailSuffix = "@longmemeval.benchmark.invalid";
const defaultQualificationSystemModelId = "gpt-5.6-luna" satisfies
  LongMemEvalSystemModelId;
const qualificationEmbeddingModelId = "qwen/qwen3-embedding-8b";
const qualificationEmbeddingProviderOrder = Object.freeze([
  "nebius",
  "deepinfra"
] as const);
const legacyQualificationRerankerModelId = "qwen/qwen3-reranker-8b";
const qualificationPrimaryRerankerDeployment = (() => {
  const deployment = approvedRerankerDeployments.find(({ preset }) => preset.default);
  if (!deployment) throw new Error("longmemeval_primary_reranker_missing");
  return deployment;
})();
const qualificationOperatorUserId = "00000000-0000-4000-8000-000000000001";
const qualificationMemoryJobParallelism = 8;
const qualificationMemoryJobPerUserParallelism = 4;

const openRouterQualificationSystemModelIds = new Set([
  "deepseek/deepseek-v4-flash-0731",
  "z-ai/glm-5.3-flash",
  "google/gemini-3.7-flash"
] satisfies readonly LongMemEvalSystemModelId[]);

function qualificationSystemModelRuntime(
  modelId: LongMemEvalSystemModelId
): (typeof LONGMEMEVAL_SYSTEM_MODEL_RUNTIME)[LongMemEvalSystemModelId] {
  return LONGMEMEVAL_SYSTEM_MODEL_RUNTIME[modelId];
}

function qualificationSystemModelFamily(
  modelId: LongMemEvalSystemModelId
): "openai_compatible" | "openrouter" {
  return openRouterQualificationSystemModelIds.has(modelId)
    ? "openrouter"
    : "openai_compatible";
}

function qualificationSystemModelReasoningEffort(
  modelId: LongMemEvalSystemModelId
): string {
  return qualificationSystemModelRuntime(modelId).reasoningEffort;
}

function qualificationSystemModelProviderOrder(
  modelId: LongMemEvalSystemModelId
): readonly string[] {
  return qualificationSystemModelRuntime(modelId).providerOrder;
}

type QualificationSystemModelDataCollection = "allow" | "deny" | null;
type QualificationStructuredOutputToolChoice = "auto" | "required";

function qualificationSystemModelDataCollection(
  modelId: LongMemEvalSystemModelId
): QualificationSystemModelDataCollection {
  return qualificationSystemModelRuntime(modelId).dataCollection;
}

function qualificationSystemModelStructuredOutputToolChoice(
  modelId: LongMemEvalSystemModelId
): QualificationStructuredOutputToolChoice {
  return qualificationSystemModelRuntime(modelId).structuredOutputToolChoice;
}

function configuredDataCollection(
  configuration: Readonly<Record<string, unknown>> | null | undefined
): QualificationSystemModelDataCollection {
  const defaultParams = configuration?.defaultParams;
  const provider = isRecord(defaultParams) && isRecord(defaultParams.provider)
    ? defaultParams.provider
    : null;
  const value = provider?.dataCollection ?? provider?.data_collection;
  return value === "allow" || value === "deny" ? value : null;
}

function configuredStructuredOutputToolChoice(
  configuration: Readonly<Record<string, unknown>> | null | undefined
): QualificationStructuredOutputToolChoice {
  const defaultParams = configuration?.defaultParams;
  const provider = isRecord(defaultParams) && isRecord(defaultParams.provider)
    ? defaultParams.provider
    : null;
  return provider?.structuredOutputToolChoice === "auto"
    ? "auto"
    : "required";
}

function qualificationSystemModelProvider(
  modelId: LongMemEvalSystemModelId
): string {
  return qualificationSystemModelRuntime(modelId).provider;
}
const activeMemoryRetrievalConfigurationBase = Object.freeze({
  aggregationContextHardCapTokens: MEMORY_CONTEXT_AGGREGATION_HARD_CAP_TOKENS,
  aggregationContextTargetTokens: MEMORY_CONTEXT_AGGREGATION_TARGET_TOKENS,
  aggregationHistoryCandidatesToReranker:
    MEMORY_RETRIEVAL_MAX_AGGREGATION_HISTORY_CANDIDATES,
  aggregationPreFusionCandidates:
    MEMORY_RETRIEVAL_MAX_AGGREGATION_PRE_FUSION_CANDIDATES,
  aggregationRankedCandidates: MEMORY_RETRIEVAL_MAX_AGGREGATION_RANKED_CANDIDATES,
  complexContextHardCapTokens: MEMORY_CONTEXT_COMPLEX_HARD_CAP_TOKENS,
  complexContextTargetTokens: MEMORY_CONTEXT_COMPLEX_TARGET_TOKENS,
  contextPackerVersion: MEMORY_CONTEXT_PACKER_VERSION,
  fusionVersion: MEMORY_RETRIEVAL_FUSION_VERSION,
  laneLimits: MEMORY_RETRIEVAL_LANE_LIMITS,
  maxParallelLanes: MEMORY_RETRIEVAL_MAX_PARALLEL_LANES,
  pipelineVersion: MEMORY_RETRIEVAL_PIPELINE_VERSION,
  pastChatContextHardCapTokens: MEMORY_CONTEXT_PAST_CHAT_HARD_CAP_TOKENS,
  pastChatContextTargetTokens: MEMORY_CONTEXT_PAST_CHAT_TARGET_TOKENS,
  rerankerRoutePolicyVersion: RERANKER_ROUTE_POLICY_VERSION,
  simpleContextHardCapTokens: MEMORY_CONTEXT_HARD_CAP_TOKENS,
  simpleContextTargetTokens: MEMORY_CONTEXT_TARGET_TOKENS,
  targetedContextHardCapTokens: MEMORY_CONTEXT_PAST_CHAT_HARD_CAP_TOKENS,
  targetedContextTargetTokens: MEMORY_CONTEXT_PAST_CHAT_TARGET_TOKENS,
  targetedHistoryCandidatesToReranker:
    MEMORY_RETRIEVAL_MAX_TARGETED_HISTORY_CANDIDATES,
  targetedPreFusionCandidates: MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES,
  targetedRankedCandidates: MEMORY_RETRIEVAL_MAX_RANKED_CANDIDATES
});
const terminalRunStatuses = new Set(["cancelled", "complete", "error"]);
const activeJobStates = new Set<MemoryJobState>([
  "CLAIMED",
  "QUEUED",
  "RETRYABLE_FAILED",
  "WAITING_FOR_EGRESS_CONSENT"
]);
const unsuccessfulJobStates = new Set<MemoryJobState>([
  "CANCELLED",
  "STALE",
  "TERMINAL_FAILED"
]);
const embeddingRoles = new Set([
  "MEMORY_DOCUMENT_EMBED",
  "MEMORY_QUERY_EMBED"
]);

type CliOptions = Readonly<{
  caseConcurrency: number;
  confirmPaid: boolean;
  debugMemory: boolean;
  forceDreamDiagnostic: boolean;
  indexTimeoutMs: number;
  onlineEvaluation: boolean;
  outputDirectory: string;
  profile: LongMemEvalProfile;
  qualificationManifestId: LongMemEvalQualificationManifestId | null;
  questionIds: readonly string[];
  resume: boolean;
  resumeCaseConcurrency: number | null;
  retryUnhealthy: boolean;
  runTimeoutMs: number;
  sampleSize: number;
  seed: string | undefined;
  sessionConcurrency: number;
  singleWave: boolean;
  systemModelId: LongMemEvalSystemModelId;
}>;

type BenchmarkRerankerRole = Readonly<{
  id: string;
  relevanceScoreFloor: number | null;
  upstreamModelId: string;
}>;

type QualificationRerankerRouteEntry = Readonly<{
  relevanceScoreFloor: number | null;
  upstreamModelId: string;
}>;

type ProviderRoles = Readonly<{
  reranker: BenchmarkRerankerRole;
  rerankerRoute: readonly BenchmarkRerankerRole[];
  system: Readonly<{
    connectionId: string;
    credentialId: string;
    dataCollection: QualificationSystemModelDataCollection;
    id: string;
    providerOrder: readonly string[];
    structuredOutputToolChoice: QualificationStructuredOutputToolChoice;
    upstreamModelId: LongMemEvalSystemModelId;
  }>;
  qwen: Readonly<{
    connectionId: string;
    id: string;
    providerOrder: readonly string[];
  }>;
}>;

type BenchmarkIdentity = Readonly<{
  cookie: string;
  sessionId: string;
  userId: string;
}>;

type ImportedHistory = Readonly<{
  assistantTurnsWithoutProductProvenance: number;
  automaticSettlements: number;
  chatIds: readonly string[];
  messages: number;
  syntheticAssistantSettlements: number;
}>;

type PreparedCaseCacheEvidence = Readonly<{
  cacheVersion: string;
  historyProjectionAuthority: "CACHED_PRIOR_SYSTEM_MODEL" | "CURRENT_SYSTEM_MODEL";
  hybridCacheHit: boolean;
  sourceBuildRecovered: boolean;
  sourceCacheHit: boolean;
  sourceCompatibilityPromoted: boolean;
  sourceFingerprint: string;
}>;

type PreparedCaseCacheRuntime = Readonly<{
  databaseUrl: string;
  migrationFingerprint: string;
}>;

type JobAggregate = Readonly<{
  attempts: number;
  kind: MemoryJobKind;
  maxAttemptCount: number;
  retries: number;
  state: MemoryJobState;
  count: number;
}>;

type ExecutionAggregate = Readonly<{
  costMicros: number;
  count: number;
  inputTokens: number;
  latencyClassCounts: Readonly<Record<string, number>>;
  outputTokens: number;
  peakConcurrency: number;
  role: string;
  state: MemoryExecutionState;
  totalTokens: number;
}>;

type CaseSummary = Readonly<{
  answer: Readonly<{
    costMicros: number;
    inputTokens: number;
    memoryContextTokens: number;
    memoryDegradationCode: string | null;
    memoryItems: number;
    memoryOutcome: string;
    outputTokens: number;
    runMs: number;
    totalTokens: number;
  }>;
  componentEvaluation: LongMemEvalComponentMetrics;
  embeddingBatchSizeDistribution: Readonly<Record<string, number>>;
  history: Readonly<{
    activeChunks: number;
    assistantTurnsWithoutProductProvenance: number;
    hybridEntries: number;
    hybridIndexMs: number;
    importMs: number;
    indexMs: number;
    jobs: readonly JobAggregate[];
    lexicalIndexMs: number;
    messages: number;
    sessions: number;
    syntheticAssistantSettlements: number;
  }>;
  learning: LongMemEvalLearningEvidence;
  preparedCase: PreparedCaseCacheEvidence | null;
  questionId: string;
  questionType: string;
  retrieval: LongMemEvalRetrievalAudit;
  utilityExecutions: readonly ExecutionAggregate[];
}>;

type CaseFailure = Readonly<{
  code: string;
  diagnostics?: CaseFailureDiagnostics;
  questionId: string;
  questionType: string;
}>;

type CaseFailureDiagnostics = Readonly<{
  jobs: readonly JobAggregate[];
  primaryCode: string;
  recentExecutionFailures: readonly Readonly<{
    errorCode: string;
    role: string;
    state: MemoryExecutionState;
  }>[];
  terminalJobs: readonly Readonly<{
    errorCode: string;
    kind: MemoryJobKind;
    state: MemoryJobState;
  }>[];
}>;

class LongMemEvalCaseFailure extends Error {
  constructor(readonly diagnostics: CaseFailureDiagnostics) {
    super(diagnostics.primaryCode);
    this.name = "LongMemEvalCaseFailure";
  }
}

function emit(event: string, details: Readonly<Record<string, unknown>> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

function positiveInteger(value: string | undefined, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(code);
  return parsed;
}

function boundedConcurrency(
  value: string | undefined,
  maximum: number,
  code: string
): number {
  const parsed = positiveInteger(value, code);
  if (parsed > maximum) throw new Error(code);
  return parsed;
}

function parseCli(argv: readonly string[]): CliOptions {
  let caseConcurrency = 2;
  let confirmPaid = false;
  let debugMemory = false;
  let forceDreamDiagnostic = false;
  let indexTimeoutMinutes = 45;
  let onlineEvaluation = false;
  let output = `results/${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`;
  let profile: LongMemEvalProfile = "official";
  let qualificationManifestId: LongMemEvalQualificationManifestId | null = null;
  let qualificationOverridePresent = false;
  const questionIds: string[] = [];
  let resume = false;
  let resumeCaseConcurrency: number | null = null;
  let retryUnhealthy = false;
  let runTimeoutMinutes = 15;
  let sampleSize = 1;
  let seed: string | undefined;
  let sessionConcurrency = 16;
  let singleWave = false;
  let systemModelId: LongMemEvalSystemModelId = defaultQualificationSystemModelId;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    switch (argument) {
      case "--case-concurrency":
        qualificationOverridePresent = true;
        caseConcurrency = boundedConcurrency(
          next,
          LONGMEMEVAL_MAX_CASE_CONCURRENCY,
          "longmemeval_case_concurrency_invalid"
        );
        index += 1;
        break;
      case "--confirm-paid":
        if (next !== "DISPOSABLE") throw new Error("longmemeval_paid_confirmation_invalid");
        confirmPaid = true;
        index += 1;
        break;
      case "--debug-memory":
        qualificationOverridePresent = true;
        debugMemory = true;
        break;
      case "--force-dream-diagnostic":
        qualificationOverridePresent = true;
        forceDreamDiagnostic = true;
        break;
      case "--index-timeout-minutes":
        qualificationOverridePresent = true;
        indexTimeoutMinutes = positiveInteger(next, "longmemeval_index_timeout_invalid");
        index += 1;
        break;
      case "--output":
        if (!next?.trim()) throw new Error("longmemeval_output_invalid");
        output = next;
        index += 1;
        break;
      case "--online-evaluation":
        qualificationOverridePresent = true;
        onlineEvaluation = true;
        break;
      case "--profile":
        qualificationOverridePresent = true;
        profile = decodeLongMemEvalProfile(next);
        index += 1;
        break;
      case "--qualification-manifest":
        if (qualificationManifestId !== null) {
          throw new Error("longmemeval_qualification_manifest_duplicate");
        }
        qualificationManifestId = decodeLongMemEvalQualificationManifestId(next);
        index += 1;
        break;
      case "--question-id":
        qualificationOverridePresent = true;
        if (!next?.trim()) throw new Error("longmemeval_question_id_invalid");
        questionIds.push(next.trim());
        index += 1;
        break;
      case "--resume":
        resume = true;
        break;
      case "--resume-case-concurrency":
        resumeCaseConcurrency = boundedConcurrency(
          next,
          LONGMEMEVAL_MAX_CASE_CONCURRENCY,
          "longmemeval_resume_case_concurrency_invalid"
        );
        index += 1;
        break;
      case "--retry-unhealthy":
        retryUnhealthy = true;
        break;
      case "--run-timeout-minutes":
        qualificationOverridePresent = true;
        runTimeoutMinutes = positiveInteger(next, "longmemeval_run_timeout_invalid");
        index += 1;
        break;
      case "--sample-size":
        qualificationOverridePresent = true;
        sampleSize = positiveInteger(next, "longmemeval_sample_size_invalid");
        index += 1;
        break;
      case "--seed":
        qualificationOverridePresent = true;
        if (!next?.trim()) throw new Error("longmemeval_seed_invalid");
        seed = next.trim();
        index += 1;
        break;
      case "--session-concurrency":
        qualificationOverridePresent = true;
        sessionConcurrency = boundedConcurrency(
          next,
          LONGMEMEVAL_MAX_SESSION_CONCURRENCY,
          "longmemeval_session_concurrency_invalid"
        );
        index += 1;
        break;
      case "--single-wave":
        singleWave = true;
        break;
      case "--system-model":
        qualificationOverridePresent = true;
        systemModelId = decodeLongMemEvalSystemModelId(next);
        index += 1;
        break;
      default:
        throw new Error(`longmemeval_argument_unknown:${argument ?? "missing"}`);
    }
  }
  if (!confirmPaid) throw new Error("longmemeval_paid_confirmation_required");
  if (qualificationManifestId && qualificationOverridePresent) {
    throw new Error("longmemeval_qualification_manifest_override_forbidden");
  }
  if (!resume && (resumeCaseConcurrency !== null || retryUnhealthy)) {
    throw new Error("longmemeval_resume_required");
  }
  if (forceDreamDiagnostic && profile !== "product") {
    throw new Error("longmemeval_dream_diagnostic_requires_product_profile");
  }
  return Object.freeze({
    caseConcurrency,
    confirmPaid,
    debugMemory,
    forceDreamDiagnostic,
    indexTimeoutMs: indexTimeoutMinutes * 60_000,
    onlineEvaluation,
    outputDirectory: resolveBenchmarkOutputDirectory(benchmarkRoot, output),
    profile,
    qualificationManifestId,
    questionIds: Object.freeze(questionIds),
    resume,
    resumeCaseConcurrency,
    retryUnhealthy,
    runTimeoutMs: runTimeoutMinutes * 60_000,
    sampleSize,
    seed,
    sessionConcurrency,
    singleWave,
    systemModelId
  });
}

function applyQualificationManifest(
  options: CliOptions,
  manifest: LongMemEvalQualificationManifest
): CliOptions {
  if (!isLongMemEvalActiveQualificationManifest(manifest.id)) {
    throw new Error("longmemeval_qualification_manifest_runtime_mismatch");
  }
  const systemRuntime = qualificationSystemModelRuntime(
    manifest.runtime.systemModel.upstreamModelId
  );
  const manifestRoute = qualificationManifestRerankerRoute(manifest);
  const activeRoute = approvedRerankerDeployments.map(({ preset }) => ({
    relevanceScoreFloor: preset.relevanceScoreFloor,
    upstreamModelId: preset.upstreamModelId
  }));
  const manifestSystemDataCollection = "dataCollection" in manifest.runtime.systemModel
    ? manifest.runtime.systemModel.dataCollection
    : null;
  const manifestStructuredOutputToolChoice =
    "structuredOutputToolChoice" in manifest.runtime.systemModel
      ? manifest.runtime.systemModel.structuredOutputToolChoice
      : "required";
  const manifestMemoryAdmission = "memoryAdmission" in manifest.runtime
    ? manifest.runtime.memoryAdmission
    : null;
  if (manifest.runtime.embedding.upstreamModelId !== qualificationEmbeddingModelId ||
    manifest.runtime.embedding.providerOrder.length !==
      qualificationEmbeddingProviderOrder.length ||
    manifest.runtime.embedding.providerOrder.some((provider, index) =>
      provider !== qualificationEmbeddingProviderOrder[index]) ||
    manifest.runtime.reranker.policyVersion !== RERANKER_ROUTE_POLICY_VERSION ||
    !qualificationRerankerRoutesMatch(manifestRoute, activeRoute) ||
    manifest.runtime.systemModel.provider !== systemRuntime.provider ||
    !("providerOrder" in manifest.runtime.systemModel) ||
    manifest.runtime.systemModel.providerOrder.length !==
      systemRuntime.providerOrder.length ||
    manifest.runtime.systemModel.providerOrder.some((provider, index) =>
      provider !== systemRuntime.providerOrder[index]) ||
    manifest.runtime.systemModel.reasoningEffort !==
      systemRuntime.reasoningEffort ||
    manifestSystemDataCollection !== systemRuntime.dataCollection ||
    manifestStructuredOutputToolChoice !==
      systemRuntime.structuredOutputToolChoice ||
    manifest.runtime.workerConcurrency.global !== qualificationMemoryJobParallelism ||
    manifest.runtime.workerConcurrency.perUser !==
      qualificationMemoryJobPerUserParallelism ||
    manifest.runtime.evaluation.mode !== "per_case" ||
    manifest.runtime.evaluation.failFast !== false ||
    manifest.runtime.evaluation.model !== "gpt-4o-2024-08-06" ||
    manifest.runtime.evaluation.scriptSha256 !== LONGMEMEVAL_EVALUATOR_SHA256 ||
    manifest.runtime.evaluation.oracleSha256 !== LONGMEMEVAL_ORACLE_SHA256 ||
    manifestMemoryAdmission === null ||
    manifestMemoryAdmission.controlMaximumMs !==
      MEMORY_CONTROL_OPTIONAL_MAXIMUM_MS ||
    manifestMemoryAdmission.hardDeadlineMs !==
      MEMORY_INTERACTIVE_HARD_DEADLINE_MS ||
    manifestMemoryAdmission.queryResolverMaximumMs !==
      MEMORY_QUERY_RESOLVER_OPTIONAL_MAXIMUM_MS ||
    manifestMemoryAdmission.queryResolverSettlementReserveMs !==
      MEMORY_QUERY_RESOLVER_SETTLEMENT_RESERVE_MS ||
    manifestMemoryAdmission.softDeadlineMs !==
      MEMORY_INTERACTIVE_SOFT_DEADLINE_MS ||
    manifestMemoryAdmission.version !== MEMORY_RUN_RETRIEVAL_ADMISSION_VERSION ||
    manifest.runtime.lexical.backend !== "OPENSEARCH" ||
    process.env.AIQSA_MEMORY_LEXICAL_BACKEND !== manifest.runtime.lexical.backend ||
    process.env.AIQSA_MEMORY_OPENSEARCH_INDEX_BUILD_ID !==
      manifest.runtime.lexical.indexBuildId) {
    throw new Error("longmemeval_qualification_manifest_runtime_mismatch");
  }
  return Object.freeze({
    ...options,
    caseConcurrency: options.resumeCaseConcurrency ?? manifest.runtime.caseConcurrency,
    debugMemory: manifest.runtime.debugMemory,
    forceDreamDiagnostic: manifest.runtime.forceDreamDiagnostic,
    indexTimeoutMs: manifest.runtime.indexTimeoutMinutes * 60_000,
    onlineEvaluation: true,
    profile: manifest.profile,
    questionIds: Object.freeze(
      manifest.selection.cases.map(({ questionId }) => questionId)
    ),
    runTimeoutMs: manifest.runtime.runTimeoutMinutes * 60_000,
    sampleSize: manifest.selection.cases.length,
    seed: manifest.selection.seed,
    sessionConcurrency: manifest.runtime.sessionConcurrency,
    systemModelId: manifest.runtime.systemModel.upstreamModelId
  });
}

function qualificationManifestRerankerRoute(
  manifest: LongMemEvalQualificationManifest
): readonly QualificationRerankerRouteEntry[] {
  if (manifest.id === "fu09-blind-50-v1") {
    return Object.freeze([Object.freeze({
      relevanceScoreFloor: null,
      upstreamModelId: legacyQualificationRerankerModelId
    })]);
  }
  return manifest.runtime.reranker.route;
}

function qualificationRerankerRoutesMatch(
  expected: readonly QualificationRerankerRouteEntry[],
  actual: readonly QualificationRerankerRouteEntry[]
): boolean {
  return expected.length === actual.length && expected.every((entry, index) => {
    const candidate = actual[index];
    return candidate?.upstreamModelId === entry.upstreamModelId &&
      candidate.relevanceScoreFloor === entry.relevanceScoreFloor;
  });
}

function assertQualificationResolvedRerankerRoute(
  manifest: LongMemEvalQualificationManifest,
  roles: ProviderRoles
): void {
  if (!qualificationRerankerRoutesMatch(
    qualificationManifestRerankerRoute(manifest),
    roles.rerankerRoute
  )) {
    throw new Error("longmemeval_qualification_manifest_runtime_mismatch");
  }
  if (isLongMemEvalActiveQualificationManifest(manifest.id) &&
    (roles.qwen.providerOrder.length !== manifest.runtime.embedding.providerOrder.length ||
      roles.qwen.providerOrder.some((provider, index) =>
        provider !== manifest.runtime.embedding.providerOrder[index]))) {
    throw new Error("longmemeval_qualification_manifest_runtime_mismatch");
  }
  if (isLongMemEvalActiveQualificationManifest(manifest.id)) {
    const systemRuntime = qualificationSystemModelRuntime(roles.system.upstreamModelId);
    if (roles.system.providerOrder.length !== systemRuntime.providerOrder.length ||
      roles.system.providerOrder.some((provider, index) =>
        provider !== systemRuntime.providerOrder[index]) ||
      roles.system.dataCollection !== systemRuntime.dataCollection ||
      roles.system.structuredOutputToolChoice !==
        systemRuntime.structuredOutputToolChoice ||
      manifest.runtime.systemModel.provider !== systemRuntime.provider ||
      manifest.runtime.systemModel.reasoningEffort !== systemRuntime.reasoningEffort ||
      ("dataCollection" in manifest.runtime.systemModel
        ? manifest.runtime.systemModel.dataCollection
        : null) !== systemRuntime.dataCollection ||
      ("structuredOutputToolChoice" in manifest.runtime.systemModel
        ? manifest.runtime.systemModel.structuredOutputToolChoice
        : "required") !== systemRuntime.structuredOutputToolChoice) {
      throw new Error("longmemeval_qualification_manifest_runtime_mismatch");
    }
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertUpstream(): Promise<void> {
  const [{ stdout: revision }, { stdout: status }, datasetHash, oracleHash, evaluatorHash] =
    await Promise.all([
      execFile("git", ["-C", upstreamRoot, "rev-parse", "HEAD"]),
      execFile("git", ["-C", upstreamRoot, "status", "--short", "--untracked-files=no"]),
      sha256File(datasetPath),
      sha256File(oraclePath),
      sha256File(evaluatorPath)
    ]);
  if (revision.trim() !== LONGMEMEVAL_REPOSITORY_COMMIT || status.trim() ||
    datasetHash !== LONGMEMEVAL_S_SHA256 ||
    oracleHash !== LONGMEMEVAL_ORACLE_SHA256 ||
    evaluatorHash !== LONGMEMEVAL_EVALUATOR_SHA256) {
    throw new Error("longmemeval_upstream_integrity_failed");
  }
}

async function loadDataset(): Promise<readonly LongMemEvalCase[]> {
  let bytes = await readFile(datasetPath);
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  bytes = Buffer.alloc(0);
  return decodeLongMemEvalDataset(parsed);
}

async function assertReferenceMetadata(
  dataset: readonly LongMemEvalCase[]
): Promise<void> {
  const references = decodeLongMemEvalDataset(
    JSON.parse(await readFile(oraclePath, "utf8")) as unknown
  );
  const metadata = (entry: LongMemEvalCase): string => JSON.stringify({
    answer: entry.answer,
    question: entry.question,
    questionId: entry.questionId,
    questionType: entry.questionType
  });
  const left = dataset.map(metadata).sort();
  const right = references.map(metadata).sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error("longmemeval_reference_metadata_mismatch");
  }
}

function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "longmemeval_case_failed";
  return /^[A-Za-z0-9_:-]{1,160}$/u.test(message)
    ? message
    : "longmemeval_case_failed";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeCheckpointCaseSummary(value: unknown): CaseSummary {
  if (!isRecord(value) || !isRecord(value.answer) ||
    typeof value.answer.memoryOutcome !== "string" ||
    (value.answer.memoryDegradationCode !== null &&
      (typeof value.answer.memoryDegradationCode !== "string" ||
        !/^[a-z0-9_]{1,64}$/u.test(value.answer.memoryDegradationCode))) ||
    typeof value.questionId !== "string" || typeof value.questionType !== "string" ||
    !isRecord(value.componentEvaluation) ||
    !isRecord(value.embeddingBatchSizeDistribution) || !isRecord(value.history) ||
    !isRecord(value.learning) || !isRecord(value.retrieval) ||
    (value.preparedCase !== null && !isRecord(value.preparedCase)) ||
    !Array.isArray(value.utilityExecutions)) {
    throw new Error("longmemeval_checkpoint_summary_invalid");
  }
  return value as CaseSummary;
}

function decodeCheckpointCaseFailure(value: unknown): CaseFailure {
  if (!isRecord(value) || typeof value.code !== "string" ||
    !/^[A-Za-z0-9_:-]{1,160}$/u.test(value.code) ||
    typeof value.questionId !== "string" || typeof value.questionType !== "string" ||
    (value.diagnostics !== undefined && !isRecord(value.diagnostics))) {
    throw new Error("longmemeval_checkpoint_failure_invalid");
  }
  return value as CaseFailure;
}

function checkpointOutcomeReason(summary: CaseSummary): string {
  if (summary.answer.memoryOutcome === "USED") return "memory_used";
  if (summary.answer.memoryDegradationCode) {
    return summary.answer.memoryDegradationCode;
  }
  if (summary.retrieval.reason) return summary.retrieval.reason;
  const outcome = summary.answer.memoryOutcome.toLowerCase();
  return /^[a-z0-9_]{1,64}$/u.test(outcome)
    ? `memory_outcome_${outcome}`
    : "memory_outcome_unhealthy";
}

function checkpointFailureReason(failure: CaseFailure): string {
  return failure.diagnostics?.primaryCode ?? failure.code;
}

function latestCheckpointOutcome(
  checkpoint: LongMemEvalCaseCheckpoint<CaseSummary, CaseFailure>
): LongMemEvalCheckpointOutcome<CaseSummary, CaseFailure> {
  const latest = checkpoint.attempts.at(-1);
  if (!latest) throw new Error("longmemeval_checkpoint_invalid");
  return latest.outcome;
}

function qualificationLexicalCutoverHealthy(
  summary: CaseSummary,
  required: boolean
): boolean {
  return !required || longMemEvalLexicalCutoverHealthy(summary.retrieval);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function withFailureCode<T>(
  code: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && /^longmemeval_[a-z0-9_:-]+$/u.test(error.message)) {
      throw error;
    }
    throw new Error(code);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await rename(temporaryPath, path);
}

function aggregateJobs(
  jobs: readonly Readonly<{
    attemptCount: number;
    kind: MemoryJobKind;
    state: MemoryJobState;
  }>[]
): readonly JobAggregate[] {
  const counts = new Map<string, JobAggregate>();
  for (const job of jobs) {
    const key = `${job.kind}:${job.state}`;
    const current = counts.get(key);
    counts.set(key, {
      attempts: (current?.attempts ?? 0) + job.attemptCount,
      count: (current?.count ?? 0) + 1,
      kind: job.kind,
      maxAttemptCount: Math.max(current?.maxAttemptCount ?? 0, job.attemptCount),
      retries: (current?.retries ?? 0) + Math.max(0, job.attemptCount - 1),
      state: job.state
    });
  }
  return [...counts.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.state.localeCompare(right.state));
}

function executionLatencyClass(
  startedAt: Date | null,
  completedAt: Date | null
): "FROM_1S_TO_5S" | "FROM_5S_TO_30S" | "GE_30S" | "LT_1S" | "UNKNOWN" {
  if (!startedAt || !completedAt || completedAt < startedAt) return "UNKNOWN";
  const durationMs = completedAt.getTime() - startedAt.getTime();
  if (durationMs < 1_000) return "LT_1S";
  if (durationMs < 5_000) return "FROM_1S_TO_5S";
  if (durationMs < 30_000) return "FROM_5S_TO_30S";
  return "GE_30S";
}

function aggregateExecutions(
  executions: readonly Readonly<{
    completedAt: Date | null;
    estimatedCostMicros: number | null;
    inputTokens: number | null;
    logicalRole: string;
    outputTokens: number | null;
    startedAt: Date | null;
    state: MemoryExecutionState;
    totalTokens: number | null;
  }>[]
): readonly ExecutionAggregate[] {
  const counts = new Map<string, ExecutionAggregate>();
  const timelines = new Map<
    string,
    Array<Readonly<{ at: number; delta: -1 | 1 }>>
  >();
  for (const execution of executions) {
    const key = `${execution.logicalRole}:${execution.state}`;
    const current = counts.get(key);
    const latencyClassCounts = { ...(current?.latencyClassCounts ?? {}) };
    const latencyClass = executionLatencyClass(execution.startedAt, execution.completedAt);
    latencyClassCounts[latencyClass] = (latencyClassCounts[latencyClass] ?? 0) + 1;
    counts.set(key, {
      costMicros: (current?.costMicros ?? 0) + (execution.estimatedCostMicros ?? 0),
      count: (current?.count ?? 0) + 1,
      inputTokens: (current?.inputTokens ?? 0) + (execution.inputTokens ?? 0),
      latencyClassCounts,
      outputTokens: (current?.outputTokens ?? 0) + (execution.outputTokens ?? 0),
      peakConcurrency: 0,
      role: execution.logicalRole,
      state: execution.state,
      totalTokens: (current?.totalTokens ?? 0) + (execution.totalTokens ?? 0)
    });
    if (execution.startedAt) {
      const timeline = timelines.get(key) ?? [];
      timeline.push({ at: execution.startedAt.getTime(), delta: 1 });
      if (execution.completedAt && execution.completedAt >= execution.startedAt) {
        timeline.push({
          at: Math.max(
            execution.completedAt.getTime(),
            execution.startedAt.getTime() + 1
          ),
          delta: -1
        });
      }
      timelines.set(key, timeline);
    }
  }
  const values = [...counts.entries()].map(([key, aggregate]) => {
    let active = 0;
    let peakConcurrency = 0;
    for (const event of (timelines.get(key) ?? []).sort((left, right) =>
      left.at - right.at || left.delta - right.delta)) {
      active += event.delta;
      peakConcurrency = Math.max(peakConcurrency, active);
    }
    return { ...aggregate, peakConcurrency };
  });
  return values.sort((left, right) =>
    left.role.localeCompare(right.role) || left.state.localeCompare(right.state));
}

async function assertDatabaseIdentity(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ database: string; role: string }>>(Prisma.sql`
    SELECT current_database() AS database, current_user AS role
  `);
  if (rows.length !== 1 || rows[0]?.database !== "aiqsa_memory_benchmark" ||
    rows[0]?.role !== "aiqsa_benchmark") {
    throw new Error("longmemeval_database_identity_mismatch");
  }
}

async function resolveProviderRoles(
  prisma: PrismaClient,
  systemModelId: LongMemEvalSystemModelId
): Promise<ProviderRoles> {
  const rerankerResolver = createRerankerModelRoleResolver(prisma);
  const [systemModels, systemPolicy, memorySettings, rerankerResolution] =
    await Promise.all([
    prisma.providerModel.findMany({
      select: {
        activeConfig: true,
        activeVersion: true,
        connection: {
          select: {
            defaultCredential: {
              select: { activeVersionId: true, enabled: true, id: true }
            }
          }
        },
        connectionId: true,
        id: true,
        modelId: true
      },
      where: {
        activeConfig: { not: Prisma.DbNull },
        activeVersion: { gt: 0 },
        connection: {
          enabled: true,
          family: qualificationSystemModelFamily(systemModelId)
        },
        enabled: true,
        modelClass: "answer",
        modelId: systemModelId
      }
    }),
    prisma.systemModelPolicy.findUnique({
      select: {
        providerModelId: true,
        reasoningEffort: true,
        rerankerProviderModelId: true
      },
      where: { id: "installation" }
    }),
    prisma.userMemorySettings.findUnique({
      select: { embeddingProviderModelId: true },
      where: { userId: qualificationOperatorUserId }
    }),
    rerankerResolver.resolve()
  ]);
  const qwen = memorySettings?.embeddingProviderModelId
    ? await prisma.providerModel.findUnique({
        select: {
          activeConfig: true,
          activeVersion: true,
          connection: { select: { enabled: true, family: true } },
          connectionId: true,
          enabled: true,
          id: true,
          modelClass: true,
          modelId: true
        },
        where: { id: memorySettings.embeddingProviderModelId }
      })
    : null;
  let qwenConfiguration: ReturnType<typeof normalizeProviderModelConfiguration> | null = null;
  try {
    qwenConfiguration = qwen?.activeConfig
      ? normalizeProviderModelConfiguration(qwen.activeConfig)
      : null;
  } catch {
    qwenConfiguration = null;
  }
  const qwenProviderOrder = qwenConfiguration?.openRouterRouting?.mode ===
    "only_selected"
    ? qwenConfiguration.openRouterRouting.providers
    : [];
  const system = systemModels[0];
  const systemCredential = system?.connection.defaultCredential;
  let systemConfiguration: ReturnType<typeof normalizeProviderModelConfiguration> | null = null;
  try {
    systemConfiguration = system?.activeConfig
      ? normalizeProviderModelConfiguration(system.activeConfig)
      : null;
  } catch {
    systemConfiguration = null;
  }
  const expectedSystemProviderOrder = qualificationSystemModelProviderOrder(systemModelId);
  const systemProviderOrder = systemConfiguration?.openRouterRouting?.mode ===
    "only_selected"
    ? systemConfiguration.openRouterRouting.providers
    : [];
  const expectedSystemReasoningEffort =
    qualificationSystemModelReasoningEffort(systemModelId);
  const expectedSystemDataCollection =
    qualificationSystemModelDataCollection(systemModelId);
  const systemDataCollection = configuredDataCollection(systemConfiguration);
  const expectedStructuredOutputToolChoice =
    qualificationSystemModelStructuredOutputToolChoice(systemModelId);
  const systemStructuredOutputToolChoice =
    configuredStructuredOutputToolChoice(systemConfiguration);
  if (systemModels.length !== 1 || !system || !systemCredential?.enabled ||
    !systemCredential.activeVersionId || !system.activeConfig ||
    system.activeVersion < 1 ||
    systemConfiguration?.modelClass !== "answer" ||
    (openRouterQualificationSystemModelIds.has(systemModelId)
      ? systemConfiguration.adapterKind !== "openrouter_chat_completions" ||
        systemConfiguration.openRouterRouting?.mode !== "only_selected"
      : systemConfiguration.adapterKind === "openrouter_chat_completions") ||
    systemProviderOrder.length !== expectedSystemProviderOrder.length ||
    systemProviderOrder.some((provider, index) =>
      provider !== expectedSystemProviderOrder[index]) ||
    systemDataCollection !== expectedSystemDataCollection ||
    systemStructuredOutputToolChoice !== expectedStructuredOutputToolChoice ||
    !qwen?.activeConfig ||
    qwen.activeVersion < 1 || !qwen.enabled || !qwen.connection.enabled ||
    qwen.connection.family !== "openrouter" || qwen.modelClass !== "embedding" ||
    qwen.modelId !== qualificationEmbeddingModelId ||
    qwenConfiguration?.embedding?.providerFamily !== "openrouter" ||
    qwenProviderOrder.length !== qualificationEmbeddingProviderOrder.length ||
    qwenProviderOrder.some((provider, index) =>
      provider !== qualificationEmbeddingProviderOrder[index]) ||
    systemPolicy?.providerModelId !== systemModels[0]?.id ||
    systemPolicy.reasoningEffort !== expectedSystemReasoningEffort ||
    systemPolicy.rerankerProviderModelId !==
      qualificationPrimaryRerankerDeployment.providerModelId ||
    !rerankerResolution.ok ||
    rerankerResolution.selectedProviderModelId !==
      qualificationPrimaryRerankerDeployment.providerModelId) {
    throw new Error("longmemeval_provider_roles_invalid");
  }
  const resolvedRerankerRoutes = rerankerResolution.routes ?? [{
    providerModelId: rerankerResolution.providerModelId,
    role: rerankerResolution.role
  }];
  let previousRoutePosition = -1;
  const rerankerRoute = resolvedRerankerRoutes.map(({ providerModelId, role }) => {
    const deployment = approvedRerankerDeploymentByProviderModelId(providerModelId);
    const routePosition = approvedRerankerDeployments.findIndex(
      (candidate) => candidate.providerModelId === providerModelId
    );
    if (!deployment || routePosition <= previousRoutePosition ||
      role.configuration.upstreamModelId !== deployment.preset.upstreamModelId) {
      throw new Error("longmemeval_reranker_route_invalid");
    }
    previousRoutePosition = routePosition;
    return Object.freeze({
      id: providerModelId,
      relevanceScoreFloor: deployment.preset.relevanceScoreFloor,
      upstreamModelId: deployment.preset.upstreamModelId
    });
  });
  const reranker = rerankerRoute[0];
  if (!reranker) throw new Error("longmemeval_reranker_route_invalid");
  const egress = await createAdminMemoryEgressService(prisma, {
    consentMode: "ADMIN"
  }).get();
  const destinations = new Set(egress.destinations
    .filter(({ state }) => state === "AVAILABLE")
    .map(({ id }) => id));
  if (egress.reviewRequired || !destinations.has("system_model") ||
    !destinations.has("embedding") ||
    !destinations.has("remote_reranker")) {
    throw new Error("longmemeval_memory_egress_not_ready");
  }
  return Object.freeze({
    reranker,
    rerankerRoute: Object.freeze(rerankerRoute),
    system: Object.freeze({
      connectionId: system.connectionId,
      credentialId: systemCredential.id,
      dataCollection: systemDataCollection,
      id: system.id,
      providerOrder: Object.freeze([...systemProviderOrder]),
      structuredOutputToolChoice: systemStructuredOutputToolChoice,
      upstreamModelId: decodeLongMemEvalSystemModelId(system.modelId)
    }),
    qwen: Object.freeze({
      connectionId: qwen.connectionId,
      id: qwen.id,
      providerOrder: Object.freeze([...qwenProviderOrder])
    })
  });
}

async function deleteBenchmarkUsers(prisma: PrismaClient): Promise<number> {
  const users = await prisma.user.findMany({
    select: { id: true },
    where: { email: { endsWith: benchmarkEmailSuffix } }
  });
  for (const user of users) {
    await prisma.user.delete({ where: { id: user.id } });
  }
  return users.length;
}

async function createBenchmarkIdentity(
  prisma: PrismaClient,
  roles: ProviderRoles,
  questionId: string,
  profile: LongMemEvalProfile,
  persistentIdentity?: Readonly<{ displayName: string; email: string }>
): Promise<BenchmarkIdentity> {
  const fullAccess = await prisma.group.findUnique({
    select: { id: true },
    where: { systemRole: "full_access" }
  });
  if (!fullAccess) throw new Error("longmemeval_full_access_group_missing");
  const userId = randomUUID();
  await withLongMemEvalIdentitySetupRetry(() => prisma.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        displayName: persistentIdentity?.displayName ?? `LongMemEval ${questionId}`,
        email: persistentIdentity?.email ??
          `${questionId}.${userId}${benchmarkEmailSuffix}`,
        id: userId,
        role: "user",
        status: "active"
      }
    });
    await provisionActiveUser(tx, {
      groups: [{ groupId: fullAccess.id, role: "member" }],
      userId
    });
    await tx.userSettings.update({
      data: { defaultProviderModelId: roles.system.id },
      where: { userId }
    });
    await tx.providerUserCredentialAssignment.create({
      data: {
        connectionId: roles.system.connectionId,
        credentialId: roles.system.credentialId,
        userId
      }
    });
  }));
  const settingsRepository = createPrismaMemorySettingsRepository(prisma);
  const configured = await withLongMemEvalIdentitySetupRetry(async () => {
    const settings = await settingsRepository.get(userId);
    return settingsRepository.patch(userId, {
      decayEnabled: false,
      embeddingDeploymentId: roles.qwen.id,
      expectedMemoryRevision: settings.memoryRevision,
      expectedSettingsRevision: settings.settingsRevision,
      learnAutomatically: profile === "product",
      referenceChatHistory: true,
      synthesisEnabled: profile === "product",
      useMemoryFacts: true
    });
  });
  if (configured.embeddingProviderModelId !== roles.qwen.id ||
    configured.learnAutomatically !== (profile === "product") ||
    configured.synthesisEnabled !== (profile === "product") ||
    !configured.referenceChatHistory ||
    !configured.useMemoryFacts) {
    throw new Error("longmemeval_memory_settings_invalid");
  }
  const session = await withLongMemEvalIdentitySetupRetry(() => createAuthSession({
    secureCookie: false,
    sessions: createPrismaAuthSessionStore(prisma),
    userId
  }));
  return Object.freeze({
    cookie: session.cookie.split(";", 1)[0]!,
    sessionId: session.sessionId,
    userId
  });
}

async function createBenchmarkSession(
  prisma: PrismaClient,
  userId: string
): Promise<BenchmarkIdentity> {
  await prisma.authSession.deleteMany({ where: { userId } });
  const session = await createAuthSession({
    secureCookie: false,
    sessions: createPrismaAuthSessionStore(prisma),
    userId
  });
  return Object.freeze({
    cookie: session.cookie.split(";", 1)[0]!,
    sessionId: session.sessionId,
    userId
  });
}

function forcedDreamBoundary(entry: LongMemEvalCase): Date {
  const earliest = Math.min(...entry.haystackDates.map((value) =>
    parseLongMemEvalDate(value).getTime()));
  if (!Number.isFinite(earliest) || earliest <= Number.MIN_SAFE_INTEGER) {
    throw new Error("longmemeval_dream_diagnostic_boundary_invalid");
  }
  return new Date(earliest - 1);
}

async function prepareForcedDreamDiagnostic(
  prisma: PrismaClient,
  userId: string,
  entry: LongMemEvalCase
): Promise<Date> {
  const [user, settings] = await Promise.all([
    prisma.user.findUnique({ select: { email: true }, where: { id: userId } }),
    prisma.userMemorySettings.findUnique({
      select: {
        lastSynthesisAt: true,
        synthesisEnabled: true,
        synthesisPolicyVersion: true
      },
      where: { userId }
    })
  ]);
  if (typeof user?.email !== "string" ||
    !user.email.endsWith(benchmarkEmailSuffix) || !settings?.synthesisEnabled ||
    settings.lastSynthesisAt !== null ||
    settings.synthesisPolicyVersion !== MEMORY_SYNTHESIS_POLICY_VERSION) {
    throw new Error("longmemeval_dream_diagnostic_owner_invalid");
  }
  const boundary = forcedDreamBoundary(entry);
  const updated = await prisma.userMemorySettings.updateMany({
    data: { synthesisEnabledAt: boundary },
    where: {
      lastSynthesisAt: null,
      synthesisEnabled: true,
      synthesisPolicyVersion: MEMORY_SYNTHESIS_POLICY_VERSION,
      userId
    }
  });
  if (updated.count !== 1) {
    throw new Error("longmemeval_dream_diagnostic_boundary_conflict");
  }
  emit("dream_diagnostic_boundary_prepared", {
    boundary: boundary.toISOString(),
    questionId: entry.questionId
  });
  return boundary;
}

type ImportedSession = Readonly<{
  activeLeafMessageId: string;
  assistantTurnsWithoutProductProvenance: number;
  automaticSettlement: Readonly<{
    assistantMessageId: string;
    runId: string;
  }> | null;
  chatId: string;
  messages: number;
  syntheticAssistantSettlements: number;
}>;

async function importSessionRows(
  prisma: PrismaClient,
  userId: string,
  entry: LongMemEvalCase,
  sessionIndex: number
): Promise<ImportedSession> {
  const officialTurns = entry.haystackSessions[sessionIndex]!;
  const importPlan = longMemEvalSettledImportTurns(officialTurns);
  const turns = importPlan.turns;
  const occurredAt = parseLongMemEvalDate(entry.haystackDates[sessionIndex]!);
  const chatId = randomUUID();
  const messages = turns.map((turn, turnIndex) => ({
    content: textMessageContent(turn.content) as Prisma.InputJsonValue,
    createdAt: new Date(occurredAt.getTime() + turnIndex),
    id: randomUUID(),
    modelId: turn.role === "assistant" ? "external-history" : null,
    parentMessageId: turnIndex === 0 ? null : undefined as string | null | undefined,
    provider: turn.role === "assistant" ? "longmemeval-import" : null,
    role: turn.role,
    status: "complete" as const,
    updatedAt: new Date(occurredAt.getTime() + turnIndex)
  }));
  for (let index = 1; index < messages.length; index += 1) {
    messages[index]!.parentMessageId = messages[index - 1]!.id;
  }
  const backedAssistantRuns = turns.flatMap((turn, index) =>
    turn.role === "assistant" && turns[index - 1]?.role === "user"
      ? [{ id: randomUUID(), index }]
      : []);
  await prisma.$transaction(async (tx) => {
    await withFailureCode("longmemeval_import_chat_create_failed", () =>
      tx.chat.create({
        data: {
          createdAt: occurredAt,
          id: chatId,
          memoryMode: "NORMAL",
          title: `LongMemEval ${entry.questionId} session ${sessionIndex + 1}`,
          updatedAt: occurredAt,
          userId
        }
      }));
    await withFailureCode("longmemeval_import_messages_create_failed", () =>
      tx.message.createMany({
        data: messages.map((message) => ({ ...message, chatId }))
      }));
    if (backedAssistantRuns.length > 0) {
      await withFailureCode("longmemeval_import_runs_create_failed", () =>
        tx.modelRun.createMany({
          data: backedAssistantRuns.map((run) => ({
            assistantMessageId: messages[run.index]!.id,
            chatId,
            createdAt: messages[run.index]!.createdAt,
            id: run.id,
            modelId: "external-history",
            normalizedRequest: {
              prompt: {
                baseline: {
                  source: "standard_chat",
                  timeZone: "UTC",
                  timeZoneSource: "client"
                }
              }
            },
            provider: "longmemeval-import",
            status: "complete",
            updatedAt: messages[run.index]!.updatedAt,
            userId,
            userMessageId: messages[run.index - 1]!.id
          }))
        }));
    }
  }, { timeout: 120_000 });
  const finalRun = backedAssistantRuns.find(({ index }) =>
    index === turns.length - 1) ?? null;
  return Object.freeze({
    activeLeafMessageId: messages.at(-1)!.id,
    assistantTurnsWithoutProductProvenance:
      officialTurns.filter((turn, index) =>
        turn.role === "assistant" && officialTurns[index - 1]?.role !== "user").length,
    automaticSettlement: finalRun === null
      ? null
      : Object.freeze({
          assistantMessageId: messages[finalRun.index]!.id,
          runId: finalRun.id
        }),
    chatId,
    messages: messages.length,
    syntheticAssistantSettlements: Number(importPlan.appendedAssistantSettlement)
  });
}

async function activateImportedSession(
  prisma: PrismaClient,
  userId: string,
  imported: ImportedSession,
  profile: LongMemEvalProfile
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const chat = await withFailureCode("longmemeval_import_chat_lock_failed", () =>
      lockMemorySourceChat(tx, {
        chatId: imported.chatId,
        lock: "UPDATE",
        personalOnly: true,
        userId
      }));
    if (!chat) throw new Error("longmemeval_import_chat_missing");
    await withFailureCode("longmemeval_import_source_mutation_failed", () =>
      applyMemorySourceMutations(tx, {
        chat,
        hooks: defaultMemorySourceMutationHooks,
        mutations: ["NORMAL_APPEND"],
        patch: { activeLeafMessageId: imported.activeLeafMessageId }
      }));
  }, { timeout: 120_000 });
  if (profile !== "product" || imported.automaticSettlement === null) return;
  await prisma.$transaction(async (tx) => {
    const chat = await withFailureCode("longmemeval_import_chat_lock_failed", () =>
      lockMemorySourceChat(tx, {
        chatId: imported.chatId,
        lock: "UPDATE",
        personalOnly: true,
        userId
      }));
    if (!chat) throw new Error("longmemeval_import_chat_missing");
    await withFailureCode("longmemeval_import_settlement_failed", () =>
      applyMemorySourceMutations(tx, {
        chat,
        hooks: defaultMemorySourceMutationHooks,
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: imported.automaticSettlement!.assistantMessageId,
          runId: imported.automaticSettlement!.runId,
          status: "complete"
        }
      }));
  }, { timeout: 120_000 });
}

async function importHistory(
  prisma: PrismaClient,
  userId: string,
  entry: LongMemEvalCase,
  concurrency: number,
  profile: LongMemEvalProfile
): Promise<ImportedHistory> {
  let completed = 0;
  const importedSessions = await mapConcurrentOrdered(
    entry.haystackSessions.map((_session, index) => index),
    concurrency,
    (index) => importSessionRows(prisma, userId, entry, index)
  );
  // Creating a chat takes a foreign-key key-share lock on the common User row,
  // while Memory source activation later takes an update lock on that same
  // row. Combining both operations in concurrent transactions creates a lock-
  // upgrade cycle in PostgreSQL. Keep row insertion parallel, then admit each
  // source through the ordinary lifecycle in a short ordered critical section.
  for (const imported of importedSessions) {
    await activateImportedSession(prisma, userId, imported, profile);
    completed += 1;
    if (completed % 10 === 0 || completed === entry.haystackSessions.length) {
      emit("history_import_progress", {
        importedSessions: completed,
        questionId: entry.questionId,
        totalSessions: entry.haystackSessions.length
      });
    }
  }
  return Object.freeze({
    assistantTurnsWithoutProductProvenance: importedSessions.reduce(
      (total, imported) => total + imported.assistantTurnsWithoutProductProvenance,
      0
    ),
    automaticSettlements: profile === "product"
      ? importedSessions.filter(({ automaticSettlement }) =>
          automaticSettlement !== null).length
      : 0,
    chatIds: Object.freeze(importedSessions.map(({ chatId }) => chatId)),
    messages: importedSessions.reduce((total, imported) => total + imported.messages, 0),
    syntheticAssistantSettlements: importedSessions.reduce(
      (total, imported) => total + imported.syntheticAssistantSettlements,
      0
    )
  });
}

function preparedCaseSourceFingerprint(input: Readonly<{
  entry: LongMemEvalCase;
  migrationFingerprint: string;
  profile: LongMemEvalProfile;
  roles: ProviderRoles;
}>): string {
  return longMemEvalPreparedCaseFingerprint({
    cacheVersion: LONGMEMEVAL_PREPARED_CASE_CACHE_VERSION,
    case: {
      haystackDates: input.entry.haystackDates,
      haystackSessionIds: input.entry.haystackSessionIds,
      haystackSessions: input.entry.haystackSessions,
      questionId: input.entry.questionId
    },
    datasetSha256: LONGMEMEVAL_S_SHA256,
    historyContract: {
      chatDigest: MEMORY_CHAT_DIGEST_VERSIONS,
      chatDigestPipeline: MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
      chatDigestRebuildPolicy: MEMORY_CHAT_DIGEST_REBUILD_POLICY_VERSION,
      chunking: MEMORY_HISTORY_CHUNKING_VERSION,
      classification: MEMORY_HISTORY_CLASSIFICATION_VERSIONS,
      contextualKey: MEMORY_CONTEXTUAL_KEY_VERSIONS,
      contextualKeyPolicy: MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
      historyPipeline: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
      importVersion: LONGMEMEVAL_PREPARED_CASE_IMPORT_VERSION,
      recallRound: MEMORY_RECALL_ROUND_PROJECTION_VERSION,
      recallRoundSegment: MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION,
      safetyLite: MEMORY_SAFETY_LITE_POLICY_VERSION,
      sourceProjection: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
      toolEvent: MEMORY_TOOL_EVENT_PROJECTION_VERSION
    },
    migrationFingerprint: input.migrationFingerprint,
    profile: input.profile,
    systemHistoryAuthority: {
      connectionId: input.roles.system.connectionId,
      credentialId: input.roles.system.credentialId,
      providerModelId: input.roles.system.id,
      upstreamModelId: input.roles.system.upstreamModelId
    }
  });
}

async function databaseMigrationFingerprint(prisma: PrismaClient): Promise<string> {
  const migrations = await prisma.$queryRaw<Array<{
    checksum: string;
    migrationName: string;
  }>>(Prisma.sql`
    SELECT "checksum", "migration_name" AS "migrationName"
    FROM "_prisma_migrations"
    WHERE "finished_at" IS NOT NULL
      AND "rolled_back_at" IS NULL
    ORDER BY "migration_name" ASC
  `);
  if (migrations.length === 0 || migrations.some(({ checksum, migrationName }) =>
    !checksum || !migrationName)) {
    throw new Error("longmemeval_migration_fingerprint_invalid");
  }
  return longMemEvalPreparedCaseFingerprint({ migrations, version: 1 });
}

async function withPreparedCaseLock<T>(
  databaseUrl: string,
  fingerprint: string,
  operation: () => Promise<T>
): Promise<T> {
  const [first, second] = longMemEvalPreparedCaseAdvisoryKey(fingerprint);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [
      first,
      second
    ]);
    locked = true;
    return await operation();
  } finally {
    try {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [
          first,
          second
        ]);
      }
    } finally {
      await client.end();
    }
  }
}

async function assertPreparedQueryIsolation(
  prisma: PrismaClient,
  userId: string,
  questionId: string
): Promise<void> {
  const [temporaryChats, excludedChats, activeRuns, activeAttempts] =
    await Promise.all([
      prisma.chat.count({ where: { memoryMode: "TEMPORARY", userId } }),
      prisma.chat.count({ where: { memoryMode: "EXCLUDED", userId } }),
      prisma.modelRun.count({
        where: {
          chat: { memoryMode: "EXCLUDED" },
          status: { notIn: ["cancelled", "complete", "error"] },
          userId
        }
      }),
      prisma.memoryRetrievalAttempt.count({
        where: {
          chatMemoryModeSnapshot: "EXCLUDED",
          state: { in: ["EXECUTING", "PENDING", "READY"] },
          userId
        }
      })
    ]);
  if (temporaryChats > 0 || activeRuns > 0 || activeAttempts > 0) {
    throw new Error("longmemeval_prepared_case_not_quiescent");
  }
  if (excludedChats > 0) {
    emit("prepared_case_query_isolated", {
      questionId,
      retainedTerminalChats: excludedChats
    });
  }
}

async function alignPreparedCaseIdentity(
  prisma: PrismaClient,
  input: Readonly<{
    displayName: string;
    email: string;
    allowSystemModelSwap?: boolean;
    roles: ProviderRoles;
    userId: string;
  }>
): Promise<void> {
  const allowSystemModelSwap = input.allowSystemModelSwap === true;
  const [user, userSettings, memorySettings, credentialAssignment] =
    await Promise.all([
      prisma.user.findUnique({
        select: { displayName: true, email: true, status: true },
        where: { id: input.userId }
      }),
      prisma.userSettings.findUnique({
        select: { defaultProviderModelId: true },
        where: { userId: input.userId }
      }),
      prisma.userMemorySettings.findUnique({
        select: {
          decayEnabled: true,
          embeddingProviderModelId: true,
          learnAutomatically: true,
          referenceChatHistory: true,
          synthesisEnabled: true,
          useMemoryFacts: true
        },
        where: { userId: input.userId }
      }),
      prisma.providerUserCredentialAssignment.findUnique({
        select: { credentialId: true },
        where: {
          connectionId_userId: {
            connectionId: input.roles.system.connectionId,
            userId: input.userId
          }
        }
      })
    ]);
  const systemModelAligned = userSettings?.defaultProviderModelId === input.roles.system.id;
  const credentialAligned = credentialAssignment?.credentialId ===
    input.roles.system.credentialId;
  if (user?.email !== input.email || user.displayName !== input.displayName ||
    user.status !== "active" ||
    !allowSystemModelSwap && (!systemModelAligned || !credentialAligned) ||
    !memorySettings ||
    memorySettings.decayEnabled || memorySettings.learnAutomatically ||
    !memorySettings.referenceChatHistory || memorySettings.synthesisEnabled ||
    !memorySettings.useMemoryFacts) {
    throw new Error("longmemeval_prepared_case_identity_invalid");
  }
  if (allowSystemModelSwap && (!systemModelAligned || !credentialAligned)) {
    await prisma.$transaction(async (tx) => {
      await tx.userSettings.updateMany({
        data: { defaultProviderModelId: input.roles.system.id },
        where: { userId: input.userId }
      });
      await tx.providerUserCredentialAssignment.upsert({
        create: {
          connectionId: input.roles.system.connectionId,
          credentialId: input.roles.system.credentialId,
          userId: input.userId
        },
        update: { credentialId: input.roles.system.credentialId },
        where: {
          connectionId_userId: {
            connectionId: input.roles.system.connectionId,
            userId: input.userId
          }
        }
      });
    });
  }
  if (memorySettings.embeddingProviderModelId === input.roles.qwen.id) return;
  const repository = createPrismaMemorySettingsRepository(prisma);
  const current = await repository.get(input.userId);
  const updated = await repository.patch(input.userId, {
    embeddingDeploymentId: input.roles.qwen.id,
    expectedMemoryRevision: current.memoryRevision,
    expectedSettingsRevision: current.settingsRevision
  });
  if (updated.embeddingProviderModelId !== input.roles.qwen.id) {
    throw new Error("longmemeval_prepared_case_embedding_alignment_failed");
  }
}

async function promotePreparedCaseIdentity(
  prisma: PrismaClient,
  input: Readonly<{
    currentDisplayName: string;
    currentEmail: string;
    displayName: string;
    email: string;
    userId: string;
  }>
): Promise<void> {
  const promoted = await prisma.user.updateMany({
    data: { displayName: input.displayName, email: input.email },
    where: {
      displayName: input.currentDisplayName,
      email: input.currentEmail,
      id: input.userId,
      status: "active"
    }
  });
  if (promoted.count !== 1) {
    throw new Error("longmemeval_prepared_case_identity_promotion_failed");
  }
}

async function loadPreparedHistory(
  prisma: PrismaClient,
  userId: string,
  entry: LongMemEvalCase
): Promise<ImportedHistory> {
  const chats = await prisma.chat.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      activeLeafMessageId: true,
      createdAt: true,
      id: true,
      memoryBranchGeneration: true,
      memoryMode: true,
      memorySourceRevision: true,
      messages: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          content: true,
          createdAt: true,
          id: true,
          modelId: true,
          parentMessageId: true,
          provider: true,
          role: true,
          status: true,
          updatedAt: true
        }
      },
      modelRuns: {
        select: {
          assistantMessageId: true,
          modelId: true,
          provider: true,
          status: true,
          userMessageId: true
        }
      },
      title: true
    },
    where: { memoryMode: "NORMAL", userId }
  });
  if (chats.length !== entry.haystackSessions.length ||
    chats.some(({ memoryMode }) => memoryMode !== "NORMAL")) {
    throw new Error("longmemeval_prepared_case_chat_set_invalid");
  }
  const byTitle = new Map(chats.map((chat) => [chat.title, chat]));
  if (byTitle.size !== chats.length) {
    throw new Error("longmemeval_prepared_case_chat_set_invalid");
  }
  const chatIds: string[] = [];
  let messages = 0;
  let assistantTurnsWithoutProductProvenance = 0;
  let syntheticAssistantSettlements = 0;
  for (let sessionIndex = 0;
    sessionIndex < entry.haystackSessions.length;
    sessionIndex += 1) {
    const officialTurns = entry.haystackSessions[sessionIndex]!;
    const plan = longMemEvalSettledImportTurns(officialTurns);
    const chat = byTitle.get(
      `LongMemEval ${entry.questionId} session ${sessionIndex + 1}`
    );
    const occurredAt = parseLongMemEvalDate(entry.haystackDates[sessionIndex]!);
    if (!chat || chat.createdAt.getTime() !== occurredAt.getTime() ||
      chat.memoryBranchGeneration !== 0 || chat.memorySourceRevision !== 1 ||
      chat.messages.length !== plan.turns.length ||
      chat.activeLeafMessageId !== chat.messages.at(-1)?.id) {
      throw new Error("longmemeval_prepared_case_chat_invalid");
    }
    for (let turnIndex = 0; turnIndex < plan.turns.length; turnIndex += 1) {
      const expected = plan.turns[turnIndex]!;
      const message = chat.messages[turnIndex]!;
      const expectedParent = turnIndex === 0
        ? null
        : chat.messages[turnIndex - 1]!.id;
      const expectedProvider = expected.role === "assistant"
        ? "longmemeval-import"
        : null;
      const expectedModel = expected.role === "assistant"
        ? "external-history"
        : null;
      if (message.role !== expected.role || message.status !== "complete" ||
        message.parentMessageId !== expectedParent ||
        message.provider !== expectedProvider || message.modelId !== expectedModel ||
        message.createdAt.getTime() !== occurredAt.getTime() + turnIndex ||
        message.updatedAt.getTime() !== occurredAt.getTime() + turnIndex ||
        textFromContentBlocks(message.content as { blocks?: unknown[] }) !==
          expected.content) {
        throw new Error("longmemeval_prepared_case_message_invalid");
      }
    }
    const expectedBackedRuns = plan.turns.flatMap((turn, index) =>
      turn.role === "assistant" && plan.turns[index - 1]?.role === "user"
        ? [{ assistantIndex: index, userIndex: index - 1 }]
        : []);
    if (chat.modelRuns.length !== expectedBackedRuns.length ||
      expectedBackedRuns.some(({ assistantIndex, userIndex }) =>
        !chat.modelRuns.some((run) =>
          run.assistantMessageId === chat.messages[assistantIndex]!.id &&
          run.userMessageId === chat.messages[userIndex]!.id &&
          run.modelId === "external-history" &&
          run.provider === "longmemeval-import" && run.status === "complete"))) {
      throw new Error("longmemeval_prepared_case_provenance_invalid");
    }
    chatIds.push(chat.id);
    messages += plan.turns.length;
    assistantTurnsWithoutProductProvenance += officialTurns.filter(
      (turn, index) => turn.role === "assistant" &&
        officialTurns[index - 1]?.role !== "user"
    ).length;
    syntheticAssistantSettlements += Number(plan.appendedAssistantSettlement);
  }
  return Object.freeze({
    assistantTurnsWithoutProductProvenance,
    automaticSettlements: 0,
    chatIds: Object.freeze(chatIds),
    messages,
    syntheticAssistantSettlements
  });
}

async function assertPreparedHistoryContractCompatibility(
  prisma: PrismaClient,
  userId: string
): Promise<void> {
  const [
    incompatibleCheckpoint,
    incompatibleChunk,
    incompatibleRound,
    incompatibleSegment,
    incompatibleToolEvent,
    incompatibleDigest,
    executionBindings
  ] = await Promise.all([
    prisma.chatMemoryCheckpoint.findFirst({
      select: { id: true },
      where: {
        pipelineVersion: { not: MEMORY_HISTORY_INDEX_PIPELINE_VERSION },
        userId
      }
    }),
    prisma.memoryRecallChunk.findFirst({
      select: { id: true },
      where: {
        OR: [
          { chunkingVersion: { not: MEMORY_HISTORY_CHUNKING_VERSION } },
          {
            sourceProjectionVersion: {
              not: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION
            }
          }
        ],
        state: "ACTIVE",
        userId
      }
    }),
    prisma.memoryRecallRound.findFirst({
      select: { id: true },
      where: {
        OR: [
          { projectionVersion: { not: MEMORY_RECALL_ROUND_PROJECTION_VERSION } },
          {
            sourceProjectionVersion: {
              not: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION
            }
          },
          {
            contextualKeyPolicyVersion: {
              not: MEMORY_CONTEXTUAL_KEY_POLICY_VERSION
            }
          }
        ],
        state: "ACTIVE",
        userId
      }
    }),
    prisma.memoryRecallRoundSegment.findFirst({
      select: { id: true },
      where: {
        OR: [
          {
            projectionVersion: {
              not: MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION
            }
          },
          {
            contextualKeyPolicyVersion: {
              not: MEMORY_CONTEXTUAL_KEY_POLICY_VERSION
            }
          }
        ],
        state: "ACTIVE",
        userId
      }
    }),
    prisma.memoryToolEvent.findFirst({
      select: { id: true },
      where: {
        projectionVersion: { not: MEMORY_TOOL_EVENT_PROJECTION_VERSION },
        state: "ACTIVE",
        userId
      }
    }),
    prisma.chatMemoryDigest.findFirst({
      select: { id: true },
      where: {
        OR: [
          { pipelineVersion: { not: MEMORY_CHAT_DIGEST_PIPELINE_VERSION } },
          {
            sourceProjectionVersion: {
              not: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION
            }
          },
          { rebuildPolicyVersion: null },
          {
            rebuildPolicyVersion: {
              not: MEMORY_CHAT_DIGEST_REBUILD_POLICY_VERSION
            }
          }
        ],
        state: "ACTIVE",
        userId
      }
    }),
    prisma.memoryExecutionBinding.findMany({
      select: {
        pipelineVersion: true,
        policyVersion: true,
        promptVersion: true,
        schemaVersion: true
      },
      where: {
        logicalRole: "MEMORY_HISTORY_CLASSIFY",
        state: "SUCCEEDED",
        userId
      }
    })
  ]);
  const executionVersions = [
    MEMORY_HISTORY_CLASSIFICATION_VERSIONS,
    MEMORY_CONTEXTUAL_KEY_VERSIONS,
    MEMORY_CHAT_DIGEST_VERSIONS
  ];
  const incompatibleBinding = executionBindings.some((binding) =>
    !executionVersions.some((versions) =>
      binding.pipelineVersion === versions.pipelineVersion &&
      binding.policyVersion === versions.policyVersion &&
      binding.promptVersion === versions.promptVersion &&
      binding.schemaVersion === versions.schemaVersion));
  if (incompatibleCheckpoint || incompatibleChunk || incompatibleRound ||
    incompatibleSegment || incompatibleToolEvent || incompatibleDigest ||
    incompatibleBinding) {
    throw new Error("longmemeval_prepared_case_history_contract_incompatible");
  }
}

/** A compatible model swap may reuse only a completely settled projection.
 * This prevents a provider change from attaching to a half-built history and
 * accidentally mixing old and new execution authority in one prepared user. */
async function assertPreparedHistorySettled(
  prisma: PrismaClient,
  userId: string,
  expectedChats: number
): Promise<void> {
  const [jobs, checkpoints] = await Promise.all([
    prisma.memoryJob.findMany({
      select: { kind: true, state: true },
      where: { userId }
    }),
    prisma.chatMemoryCheckpoint.findMany({
      select: { status: true },
      where: { userId }
    })
  ]);
  const historyJobs = jobs.filter(({ kind }) => kind === "INDEX_HISTORY");
  const unsettledJobs = jobs.some(({ state }) => activeJobStates.has(state));
  const failedHistory = historyJobs.some(({ state }) =>
    unsuccessfulJobStates.has(state));
  if (unsettledJobs || failedHistory || historyJobs.length !== expectedChats ||
    checkpoints.length !== expectedChats ||
    checkpoints.some(({ status }) => status !== "READY") ||
    historyJobs.some(({ state }) => state !== "SUCCEEDED")) {
    throw new Error("longmemeval_prepared_case_history_not_settled");
  }
}

async function loadReadyHybridIndex(
  prisma: PrismaClient,
  userId: string
): Promise<Readonly<{ activeChunks: number; hybridEntries: number }> | null> {
  const promotion = await createPrismaMemoryRebuildRepository(prisma)
    .promoteCompatibleActiveGeneration(userId);
  if (promotion.kind !== "already_current" && promotion.kind !== "promoted") {
    return null;
  }
  const pin = await probeCurrentMemoryEmbeddingPin(
    defaultMemoryExecutionAuthority,
    prisma,
    userId,
    MEMORY_ITEM_EMBEDDING_VERSIONS
  );
  const settings = await prisma.userMemorySettings.findUnique({
    select: { activeIndexGenerationId: true, memoryRevision: true },
    where: { userId }
  });
  if (!settings?.activeIndexGenerationId) return null;
  const [generation, activeJobs, activeChunks, entries] =
    await Promise.all([
      prisma.memoryIndexGeneration.findFirst({
        select: {
          chunkingVersion: true,
          contextualKeyPolicyVersion: true,
          embeddingConfigurationFingerprint: true,
          embeddingConnectionId: true,
          embeddingDimension: true,
          embeddingProviderModelId: true,
          id: true,
          indexedThroughMemoryRevision: true,
          indexMode: true,
          languageProfile: true,
          normalizationVersion: true,
          retrievalPipelineVersion: true,
          roundProjectionVersion: true,
          roundSegmentProjectionVersion: true,
          state: true,
          vectorSpaceFingerprint: true
        },
        where: {
          id: settings.activeIndexGenerationId,
          userId
        }
      }),
      prisma.memoryJob.count({
        where: { state: { in: [...activeJobStates] }, userId }
      }),
      prisma.memoryRecallChunk.count({ where: { state: "ACTIVE", userId } }),
      prisma.memorySearchEntry.findMany({
        select: { embeddingState: true },
        where: { indexGenerationId: settings.activeIndexGenerationId, userId }
      })
    ]);
  if (!generation || generation.state !== "ACTIVE" ||
    generation.indexedThroughMemoryRevision !== settings.memoryRevision ||
    generation.languageProfile !== MEMORY_LEXICAL_ANALYSIS_PROFILE ||
    generation.normalizationVersion !== MEMORY_LEXICAL_NORMALIZATION_VERSION ||
    generation.chunkingVersion !== MEMORY_LEXICAL_CHUNKING_VERSION ||
    generation.roundProjectionVersion !== MEMORY_RECALL_ROUND_PROJECTION_VERSION ||
    generation.roundSegmentProjectionVersion !==
      MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION ||
    generation.contextualKeyPolicyVersion !== MEMORY_CONTEXTUAL_KEY_POLICY_VERSION ||
    generation.retrievalPipelineVersion !== MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION ||
    !memoryItemEmbeddingGenerationMatchesPin(generation, pin) || activeJobs !== 0 ||
    activeChunks === 0 || entries.length === 0 ||
    entries.some(({ embeddingState }) => embeddingState !== "READY")) {
    return null;
  }
  return Object.freeze({ activeChunks, hybridEntries: entries.length });
}

async function sourceJobs(prisma: PrismaClient, userId: string) {
  return prisma.memoryJob.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { attemptCount: true, errorCode: true, kind: true, state: true },
    where: { userId }
  });
}

function diagnosticToken(value: string | null): string {
  return (value ?? "none")
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]+/gu, "_")
    .slice(0, 48) || "none";
}

async function countEligibleSynthesisSources(
  prisma: PrismaClient,
  userId: string
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(DISTINCT source_fact."id")::bigint AS count
    FROM "MemoryFactVersion" AS source_version
    INNER JOIN "MemoryFact" AS source_fact
      ON source_fact."userId" = source_version."userId"
     AND source_fact."id" = source_version."factId"
    INNER JOIN "MemoryScope" AS source_scope
      ON source_scope."userId" = source_fact."userId"
     AND source_scope."id" = source_fact."scopeId"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = source_version."userId"
    WHERE source_version."userId" = ${userId}
      AND ${memorySynthesisSourceAuthorityPredicate(userId)}
  `);
  const count = Number(rows[0]?.count ?? -1n);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("longmemeval_synthesis_source_count_invalid");
  }
  return count;
}

async function loadLearningEvidence(
  prisma: PrismaClient,
  userId: string,
  jobs: Awaited<ReturnType<typeof sourceJobs>>,
  expectedSettlements: number,
  automaticFactLearning: boolean
): Promise<LongMemEvalLearningEvidence> {
  const [
    versions,
    patterns,
    factExtractionBindings,
    synthesisBindings,
    synthesisExecutions,
    settings,
    eligibleSynthesisSources,
    synthesisSchedule
  ] = await Promise.all([
    prisma.memoryFactVersion.findMany({
      select: {
        id: true,
        safetyClassificationState: true
      },
      where: { modality: { not: "PATTERN" }, sourceMode: "AUTOMATIC", userId }
    }),
    prisma.memoryFactVersion.findMany({
      select: {
        id: true,
        safetyClassificationState: true
      },
      where: {
        modality: "PATTERN",
        sourceMode: "AUTOMATIC",
        state: "ACTIVE",
        systemTo: null,
        userId
      }
    }),
    prisma.memoryExecutionBinding.findMany({
      select: { id: true, memoryJobId: true },
      where: {
        logicalRole: "MEMORY_FACT_EXTRACT",
        ownerType: "JOB",
        pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
        state: "SUCCEEDED",
        userId
      }
    }),
    prisma.memoryExecutionBinding.findMany({
      select: { id: true, memoryJobId: true },
      where: {
        logicalRole: "MEMORY_SYNTHESIZE",
        state: "SUCCEEDED",
        userId
      }
    }),
    prisma.memorySynthesisExecution.findMany({
      select: {
        acceptedOutput: true,
        appliedAt: true,
        sourceBindings: true
      },
      where: { userId }
    }),
    prisma.userMemorySettings.findUniqueOrThrow({
      select: { lastSynthesisAt: true, synthesisEnabled: true },
      where: { userId }
    }),
    countEligibleSynthesisSources(prisma, userId),
    loadMemorySynthesisScheduleStatus(prisma, userId, new Date())
  ]);
  const versionIds = versions.map(({ id }) => id);
  const patternIds = patterns.map(({ id }) => id);
  const [
    assistantEvidence,
    directUserEvidence,
    factVersionRelations,
    synthesizedFromRelations
  ] = await Promise.all([
    versionIds.length === 0
      ? Promise.resolve(0)
      : prisma.memoryEvidence.count({
          where: {
            factVersionId: { in: versionIds },
            sourceRole: "assistant",
            userId
          }
        }),
    versionIds.length === 0
      ? Promise.resolve(0)
      : prisma.memoryEvidence.count({
          where: {
            factVersionId: { in: versionIds },
            sourceRole: "user",
            userId
          }
        }),
    versionIds.length === 0
      ? Promise.resolve(0)
      : prisma.memoryFactVersionRelation.count({
          where: {
            OR: [
              { sourceVersionId: { in: versionIds } },
              { targetVersionId: { in: versionIds } }
            ],
            userId
          }
        }),
    patternIds.length === 0
      ? Promise.resolve(0)
      : prisma.memoryFactVersionRelation.count({
          where: {
            kind: "SYNTHESIZED_FROM",
            sourceVersionId: { in: patternIds },
            userId
          }
        })
  ]);
  return Object.freeze({
    appliedSynthesisExecutions: synthesisExecutions.filter(({ appliedAt }) =>
      appliedAt !== null).length,
    assistantEvidence,
    automaticFactLearning,
    automaticFactVersions: versions.length,
    classifiedAutomaticFactVersions: versions.filter(({ safetyClassificationState }) =>
      safetyClassificationState === "CLASSIFIED").length,
    classifiedPatternVersions: patterns.filter(({ safetyClassificationState }) =>
      safetyClassificationState === "CLASSIFIED").length,
    directUserEvidence,
    eligibleSynthesisSources,
    expectedSettlements,
    extractionJobs: jobs.filter(({ kind }) => kind === "EXTRACT_FACTS").length,
    factVersionRelations,
    lastSynthesisAtRecorded: settings.lastSynthesisAt !== null,
    patternVersions: patterns.length,
    relationJobs: jobs.filter(({ kind }) => kind === "RESOLVE_FACT_RELATIONS").length,
    retainedSynthesisPayloads: synthesisExecutions.filter((execution) =>
      execution.acceptedOutput !== null || execution.sourceBindings !== null).length,
    successfulFactExtractionExecutions: factExtractionBindings.length,
    successfulFactExtractionJobs: new Set(factExtractionBindings.flatMap(
      ({ memoryJobId }) => memoryJobId ? [memoryJobId] : [])).size,
    successfulSynthesisExecutions: synthesisBindings.length,
    successfulSynthesisJobs: new Set(synthesisBindings.flatMap(
      ({ memoryJobId }) => memoryJobId ? [memoryJobId] : [])).size,
    synthesizedFromRelations,
    synthesisDue: synthesisSchedule.decision.due,
    synthesisEnabled: settings.synthesisEnabled,
    synthesisJobs: jobs.filter(({ kind }) => kind === "SYNTHESIZE_MEMORIES").length,
    synthesisScheduleReason: synthesisSchedule.decision.reason,
    synthesisThreshold: MEMORY_SYNTHESIS_MIN_ELIGIBLE_SOURCES
  });
}

async function waitForHistoryIndex(
  prisma: PrismaClient,
  userId: string,
  expectedChats: number,
  expectedAutomaticSettlements: number,
  profile: LongMemEvalProfile,
  timeoutMs: number,
  questionId: string
): Promise<LongMemEvalLearningEvidence> {
  const deadline = Date.now() + timeoutMs;
  let eligibleSynthesisSources: number | null = null;
  let nextProgressAt = 0;
  let quietProductObservations = 0;
  while (Date.now() < deadline) {
    const [jobs, checkpoints] = await Promise.all([
      sourceJobs(prisma, userId),
      prisma.chatMemoryCheckpoint.findMany({
        select: { lastErrorCode: true, status: true },
        where: { userId }
      })
    ]);
    const failures = jobs.filter(({ kind, state }) =>
      kind !== "EMBED_ITEMS" && kind !== "REBUILD_INDEX" &&
      unsuccessfulJobStates.has(state));
    const failedJob = failures[0];
    if (failedJob) {
      throw new Error([
        "longmemeval_history_job_failed",
        diagnosticToken(failedJob.kind),
        diagnosticToken(failedJob.state),
        diagnosticToken(failedJob.errorCode)
      ].join(":"));
    }
    const failedCheckpoint = checkpoints.find(({ status }) => status === "FAILED");
    if (failedCheckpoint) {
      throw new Error([
        "longmemeval_history_checkpoint_failed",
        diagnosticToken(failedCheckpoint.lastErrorCode)
      ].join(":"));
    }
    const historyJobs = jobs.filter(({ kind }) => kind === "INDEX_HISTORY");
    const learningJobs = jobs.filter(({ kind }) =>
      kind === "EXTRACT_FACTS" || kind === "CONSOLIDATE_CANDIDATE" ||
      kind === "VERIFY_CANDIDATE" || kind === "RESOLVE_FACT_RELATIONS" ||
      kind === "SYNTHESIZE_MEMORIES");
    if (profile === "official" && learningJobs.length > 0) {
      throw new Error("longmemeval_automatic_learning_not_disabled");
    }
    const extractionJobs = learningJobs.filter(({ kind }) =>
      kind === "EXTRACT_FACTS");
    const synthesisJobs = learningJobs.filter(({ kind }) =>
      kind === "SYNTHESIZE_MEMORIES");
    const ready = checkpoints.filter(({ status }) => status === "READY").length;
    const historyReady = historyJobs.length === expectedChats &&
      historyJobs.every(({ state }) => state === "SUCCEEDED") &&
      checkpoints.length === expectedChats && ready === expectedChats;
    if (profile === "official" && historyReady) {
      return loadLearningEvidence(prisma, userId, jobs, 0, false);
    }
    const productPipelineIdle = historyReady && expectedAutomaticSettlements > 0 &&
      extractionJobs.length === expectedAutomaticSettlements &&
      extractionJobs.every(({ state }) => state === "SUCCEEDED") &&
      jobs.every(({ state }) => !activeJobStates.has(state));
    quietProductObservations = productPipelineIdle
      ? quietProductObservations + 1
      : 0;
    if (quietProductObservations >= 3) {
      const evidence = await loadLearningEvidence(
        prisma,
        userId,
        jobs,
        expectedAutomaticSettlements,
        true
      );
      eligibleSynthesisSources = evidence.eligibleSynthesisSources;
      if (longMemEvalProductMemoryPipelineComplete(evidence)) {
        emit("product_memory_evidence", { ...evidence, questionId });
        return evidence;
      }
      if (evidence.synthesisDue && evidence.synthesisJobs === 0) {
        quietProductObservations = 0;
      } else {
        emit("product_memory_evidence", { ...evidence, questionId });
        throw new Error("longmemeval_product_memory_pipeline_incomplete");
      }
    }
    if (Date.now() >= nextProgressAt) {
      emit("history_index_progress", {
        activeJobs: jobs.filter(({ state }) => activeJobStates.has(state)).length,
        extractionJobs: extractionJobs.length,
        expectedExtractionJobs: expectedAutomaticSettlements,
        historyJobs: historyJobs.length,
        profile,
        questionId,
        readyChats: ready,
        synthesisEligibleSources: eligibleSynthesisSources,
        synthesisJobs: synthesisJobs.length,
        totalChats: expectedChats
      });
      nextProgressAt = Date.now() + 15_000;
    }
    await sleep(2_000);
  }
  throw new Error("longmemeval_history_index_timeout");
}

async function admitForcedDreamDiagnostic(
  prisma: PrismaClient,
  userId: string,
  questionId: string
): Promise<Readonly<{ reason: string; schedulerNow: Date }>> {
  const wallNow = new Date();
  let schedulerNow = new Date(
    wallNow.getTime() + MEMORY_SYNTHESIS_QUIET_PERIOD_MS + 1_000
  );
  let status = await loadMemorySynthesisScheduleStatus(
    prisma,
    userId,
    schedulerNow
  );
  if (!status.decision.due && status.decision.reason === "ACCUMULATING") {
    schedulerNow = new Date(
      wallNow.getTime() + MEMORY_SYNTHESIS_LOW_ACTIVITY_FALLBACK_MS + 1_000
    );
    status = await loadMemorySynthesisScheduleStatus(
      prisma,
      userId,
      schedulerNow
    );
  }
  if (!status.decision.due) {
    throw new Error(
      `longmemeval_dream_diagnostic_not_due:${diagnosticToken(status.decision.reason)}`
    );
  }
  await reconcileMemorySynthesisWork(
    prisma,
    schedulerNow,
    async (ownerId) => {
      await probeMemoryStructuredOutputAuthority({
        authority: defaultMemoryExecutionAuthority,
        client: prisma,
        role: "MEMORY_SYNTHESIZE",
        userId: ownerId,
        versions: MEMORY_SYNTHESIS_VERSIONS
      });
      return true;
    }
  );
  const synthesisJobs = await prisma.memoryJob.count({
    where: { kind: "SYNTHESIZE_MEMORIES", userId }
  });
  if (synthesisJobs < 1) {
    throw new Error("longmemeval_dream_diagnostic_no_valid_cluster");
  }
  emit("dream_diagnostic_admitted", {
    eligibleSources: status.activity?.eligibleSourceCount ?? 0,
    questionId,
    reason: status.decision.reason,
    schedulerNow: schedulerNow.toISOString()
  });
  return Object.freeze({
    reason: status.decision.reason,
    schedulerNow
  });
}

async function startHybridRebuild(
  prisma: PrismaClient,
  userId: string,
  qwenModelId: string
): Promise<string> {
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({
    select: { memoryRevision: true, settingsRevision: true },
    where: { userId }
  });
  const service = createMemoryRebuildService({
    probeEmbeddingPin: (ownerId) => probeCurrentMemoryEmbeddingPin(
      defaultMemoryExecutionAuthority,
      prisma,
      ownerId,
      MEMORY_ITEM_EMBEDDING_VERSIONS
    ),
    repository: createPrismaMemoryRebuildRepository(prisma)
  });
  const status = await service.start(userId, {
    embeddingDeploymentId: qwenModelId,
    expectedMemoryRevision: settings.memoryRevision,
    expectedSettingsRevision: settings.settingsRevision,
    operation: "REEMBED"
  });
  return status.jobId;
}

async function waitForHybridIndex(
  prisma: PrismaClient,
  userId: string,
  rebuildJobId: string,
  qwenModelId: string,
  timeoutMs: number,
  questionId: string
): Promise<Readonly<{ activeChunks: number; hybridEntries: number }>> {
  const rebuildJob = await prisma.memoryJob.findFirst({
    select: { idempotencyFingerprint: true },
    where: { id: rebuildJobId, kind: "REBUILD_INDEX", userId }
  });
  const rebuildIdentity = rebuildJob
    ? parseMemoryRebuildJobFingerprint(rebuildJob.idempotencyFingerprint)
    : null;
  if (!rebuildIdentity) throw new Error("longmemeval_hybrid_rebuild_failed");
  const targetGenerationId = rebuildIdentity.generationId;
  const deadline = Date.now() + timeoutMs;
  let nextProgressAt = 0;
  const rebuildRepository = createPrismaMemoryRebuildRepository(prisma);
  while (Date.now() < deadline) {
    const [
      settings,
      rebuildStatus,
      activeJobs,
      activeChunks,
      generation,
      entries,
      documentEmbeddings
    ] =
      await Promise.all([
        prisma.userMemorySettings.findUnique({
          select: { activeIndexGenerationId: true },
          where: { userId }
        }),
        rebuildRepository.status(userId, rebuildJobId),
        prisma.memoryJob.count({
          where: { state: { in: [...activeJobStates] }, userId }
        }),
        prisma.memoryRecallChunk.count({ where: { state: "ACTIVE", userId } }),
        prisma.memoryIndexGeneration.findFirst({
          select: {
            embeddingProviderModelId: true,
            id: true,
            indexMode: true,
            state: true
          },
          where: { id: targetGenerationId, userId }
        }),
        prisma.memorySearchEntry.findMany({
          select: { embeddingState: true },
          where: { indexGenerationId: targetGenerationId, userId }
        }),
        prisma.$queryRaw<Array<{ providerModelId: string | null }>>(Prisma.sql`
          SELECT execution."providerModelId"
          FROM "MemoryExecutionBinding" AS execution
          INNER JOIN "MemoryJob" AS job
            ON job."userId" = execution."userId"
           AND job."id" = execution."memoryJobId"
          WHERE execution."userId" = ${userId}
            AND execution."logicalRole" = 'MEMORY_DOCUMENT_EMBED'
            AND execution."state" = 'SUCCEEDED'::"MemoryExecutionState"
            AND job."kind" = 'EMBED_ITEMS'::"MemoryJobKind"
            AND (
              EXISTS (
                SELECT 1
                FROM "MemorySearchEntry" AS entry
                WHERE entry."userId" = job."userId"
                  AND entry."indexGenerationId" = ${targetGenerationId}
                  AND job."idempotencyFingerprint" LIKE
                    ('memory-item-embed-v1:' || entry."id" || ':%')
              )
              OR EXISTS (
                SELECT 1
                FROM "MemoryEmbeddingBatchItem" AS child
                WHERE child."userId" = job."userId"
                  AND child."memoryJobId" = job."id"
                  AND child."indexGenerationId" = ${targetGenerationId}
              )
            )
        `)
      ]);
    const rebuildFailureCode = longMemEvalHybridRebuildFailureCode(rebuildStatus);
    if (rebuildFailureCode) throw new Error(rebuildFailureCode);
    const rebuildState = rebuildStatus?.state ?? null;
    if ((generation && generation.embeddingProviderModelId !== qwenModelId) ||
      longMemEvalDocumentEmbeddingModelMismatch(
        documentEmbeddings.map(({ providerModelId }) => providerModelId),
        qwenModelId
      )) {
      throw new Error("longmemeval_embedding_model_mismatch");
    }
    if (settings?.activeIndexGenerationId === targetGenerationId &&
      generation?.state === "ACTIVE" && generation.indexMode === "HYBRID" &&
      rebuildState === "SUCCEEDED" && activeJobs === 0 &&
      activeChunks > 0 && entries.length > 0 &&
      entries.every(({ embeddingState }) => embeddingState === "READY") &&
      documentEmbeddings.length > 0) {
      return Object.freeze({ activeChunks, hybridEntries: entries.length });
    }
    if (Date.now() >= nextProgressAt) {
      emit("hybrid_index_progress", {
        activeJobs,
        embeddingExecutions: documentEmbeddings.length,
        indexMode: generation?.indexMode ?? null,
        questionId,
        readyEntries: entries.filter(({ embeddingState }) =>
          embeddingState === "READY").length,
        totalEntries: entries.length
      });
      nextProgressAt = Date.now() + 15_000;
    }
    await sleep(2_000);
  }
  throw new Error("longmemeval_hybrid_rebuild_timeout");
}

async function waitForOpenSearchProjection(
  prisma: PrismaClient,
  userId: string,
  timeoutMs: number,
  questionId: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let nextProgressAt = 0;
  while (Date.now() < deadline) {
    const settings = await prisma.userMemorySettings.findUnique({
      select: { activeIndexGenerationId: true, memoryRevision: true },
      where: { userId }
    });
    const generationId = settings?.activeIndexGenerationId;
    if (!settings || !generationId) {
      throw new Error("longmemeval_lexical_projection_authority_missing");
    }
    const [state, outstanding, blocked] = await Promise.all([
      prisma.memoryLexicalProjectionState.findFirst({
        select: {
          enqueuedThroughSequence: true,
          expectedContentFingerprint: true,
          expectedDocumentCount: true,
          projectedThroughRevision: true,
          projectionFingerprint: true,
          status: true,
          targetMemoryRevision: true,
          visibleContentFingerprint: true,
          visibleDocumentCount: true,
          visibleThroughSequence: true
        },
        where: { indexGenerationId: generationId, userId }
      }),
      prisma.memoryLexicalProjectionEvent.count({
        where: {
          indexGenerationId: generationId,
          state: { not: "SUCCEEDED" },
          userId
        }
      }),
      prisma.memoryLexicalProjectionEvent.count({
        where: {
          indexGenerationId: generationId,
          state: "BLOCKED_REQUIRES_ADMIN",
          userId
        }
      })
    ]);
    if (blocked > 0 || state?.status === "DEGRADED" || state?.status === "RETIRED") {
      throw new Error("longmemeval_lexical_projection_failed");
    }
    const contentMatches = state?.expectedContentFingerprint !== null &&
      state?.expectedContentFingerprint === state?.visibleContentFingerprint;
    const countsMatch = state?.expectedDocumentCount !== null &&
      state?.expectedDocumentCount === state?.visibleDocumentCount;
    if (state?.status === "READY" && outstanding === 0 &&
      state.targetMemoryRevision === settings.memoryRevision &&
      state.projectedThroughRevision === settings.memoryRevision &&
      state.enqueuedThroughSequence === state.visibleThroughSequence &&
      state.projectionFingerprint !== null && contentMatches && countsMatch) {
      return;
    }
    if (Date.now() >= nextProgressAt) {
      emit("lexical_projection_progress", {
        blocked,
        outstanding,
        questionId,
        status: state?.status ?? null
      });
      nextProgressAt = Date.now() + 15_000;
    }
    await sleep(2_000);
  }
  throw new Error("longmemeval_lexical_projection_timeout");
}

function requestHeaders(baseUrl: URL, cookie: string, json = false): HeadersInit {
  return {
    accept: json ? "application/json" : "text/event-stream",
    ...(json ? { "content-type": "application/json" } : {}),
    cookie,
    origin: baseUrl.origin,
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "AIQSA LongMemEval adapter"
  };
}

function boundedCatalogModelParams(
  defaults: Readonly<Record<string, unknown>>,
  maxOutputTokens: number
): Record<string, unknown> {
  // Catalog projections may use a provider-native alias such as `maxTokens`.
  // Send one canonical bounded value so run-param validation never sees two
  // conflicting aliases (the server canonicalizes it for the adapter).
  const params = { ...defaults };
  for (const key of [
    "maxOutputTokens",
    "maxTokens",
    "max_output_tokens",
    "max_tokens",
    "max_completion_tokens"
  ]) {
    delete params[key];
  }
  params.maxOutputTokens = maxOutputTokens;
  return params;
}

async function catalogSystemModel(
  baseUrl: URL,
  cookie: string,
  expectedModelId: string,
  expectedUpstreamModelId: LongMemEvalSystemModelId,
  expectedProviderId: string
): Promise<Readonly<{
  backgroundSupported: boolean;
  defaultParams: Readonly<Record<string, unknown>>;
  maxOutputTokens: number;
  modelId: string;
  provider: string;
  reasoningEffort: string;
}>> {
  const response = await fetch(new URL("/api/me/catalog", baseUrl), {
    cache: "no-store",
    headers: requestHeaders(baseUrl, cookie, true),
    redirect: "error"
  });
  if (!response.ok) throw new Error("longmemeval_catalog_request_failed");
  const body = await response.json() as unknown;
  const catalog = body && typeof body === "object" && "catalog" in body
    ? (body as { catalog?: unknown }).catalog
    : null;
  const models = catalog && typeof catalog === "object" &&
    Array.isArray((catalog as { models?: unknown }).models)
    ? (catalog as { models: unknown[] }).models
    : [];
  const candidates = models.filter((candidate): candidate is Record<string, unknown> =>
    typeof candidate === "object" && candidate !== null &&
    (candidate as { modelId?: unknown }).modelId === expectedModelId &&
    (candidate as { upstreamModelId?: unknown }).upstreamModelId ===
      expectedUpstreamModelId);
  if (candidates.length !== 1) throw new Error("longmemeval_system_catalog_invalid");
  const model = candidates[0]!;
  const controls = typeof model.parameterControls === "object" &&
    model.parameterControls !== null
    ? model.parameterControls as Record<string, unknown>
    : {};
  const maxTokens = typeof controls.maxOutputTokens === "object" &&
    controls.maxOutputTokens !== null
    ? controls.maxOutputTokens as Record<string, unknown>
    : {};
  const reasoning = typeof controls.reasoningEffort === "object" &&
    controls.reasoningEffort !== null
    ? controls.reasoningEffort as Record<string, unknown>
    : {};
  const background = typeof controls.background === "object" &&
    controls.background !== null
    ? controls.background as Record<string, unknown>
    : {};
  const maximum = typeof maxTokens.maxValue === "number" ? maxTokens.maxValue : 1024;
  const options = Array.isArray(reasoning.options)
    ? reasoning.options.filter((value): value is string => typeof value === "string")
    : [];
  const effort = options.includes("medium")
    ? "medium"
    : typeof reasoning.defaultValue === "string"
      ? reasoning.defaultValue
      : "medium";
  if (typeof model.provider !== "string" || typeof model.modelId !== "string" ||
    model.provider !== expectedProviderId) {
    throw new Error("longmemeval_system_catalog_invalid");
  }
  // The user catalog deliberately projects only UI-safe controls and omits
  // server-owned provider routing, privacy policy, and transport capability
  // markers. `resolveProviderRoles` has already decoded the active model
  // configuration and fail-closed on all three exact values; the persisted
  // execution bindings below prove which route actually handled the run.
  return Object.freeze({
    backgroundSupported: background.supported === true,
    defaultParams: typeof model.defaultParams === "object" && model.defaultParams !== null &&
      !Array.isArray(model.defaultParams)
      ? model.defaultParams as Readonly<Record<string, unknown>>
      : {},
    // The historical Luna qualification used a 1024-token cap. OpenRouter
    // reasoning models count hidden reasoning against that same completion
    // budget, which can leave a valid run with no answer text. Keep a bounded
    // transport cap, but allow the approved fast-model lane enough room to
    // finish its reasoning; this does not alter Memory retrieval or prompts.
    maxOutputTokens: Math.min(4096, maximum),
    modelId: model.modelId,
    provider: model.provider,
    reasoningEffort: effort
  });
}

async function drain(response: Response): Promise<void> {
  if (!response.body) throw new Error("longmemeval_run_stream_missing");
  const reader = response.body.getReader();
  while (!(await reader.read()).done) {
    // Consume the normal run stream without copying the answer into logs.
  }
}

async function runQuestion(
  prisma: PrismaClient,
  baseUrl: URL,
  identity: BenchmarkIdentity,
  roles: ProviderRoles,
  entry: LongMemEvalCase,
  timeoutMs: number
): Promise<Readonly<{
  debugLocator: Readonly<{
    memoryBindingId: string;
    modelRunId: string;
    retrievalAttemptId: string;
  }>;
  hypothesis: string;
  retrieval: LongMemEvalRetrievalAudit;
  summary: CaseSummary["answer"];
}>> {
  const model = await catalogSystemModel(
    baseUrl,
    identity.cookie,
    roles.system.id,
    roles.system.upstreamModelId,
    roles.system.connectionId
  );
  const chat = await prisma.chat.create({
    data: {
      defaultProviderModelId: roles.system.id,
      memoryMode: "EXCLUDED",
      title: `LongMemEval ${entry.questionId} question`,
      userId: identity.userId
    },
    select: { id: true }
  });
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(new URL(
      `/api/chats/${encodeURIComponent(chat.id)}/messages`,
      baseUrl
    ), {
      body: JSON.stringify({
        content: {
          blocks: [{
            text: longMemEvalQuestionPrompt(entry),
            type: "text"
          }]
        },
        expectedActiveLeafId: null,
        mcp: { mode: "off" },
        modelId: model.modelId,
        params: {
          ...boundedCatalogModelParams(model.defaultParams, model.maxOutputTokens),
          ...(model.backgroundSupported ? { background: false } : {}),
          maxOutputTokens: model.maxOutputTokens,
          reasoning: {
            ...(typeof model.defaultParams.reasoning === "object" &&
              model.defaultParams.reasoning !== null &&
              !Array.isArray(model.defaultParams.reasoning)
              ? model.defaultParams.reasoning as Record<string, unknown>
              : {}),
            effort: model.reasoningEffort
          },
          stream: true
        },
        provider: model.provider,
        searchPlan: { mode: "all_selected", optionIds: [] },
        timeZone: "UTC",
        tools: "none"
      }),
      cache: "no-store",
      headers: requestHeaders(baseUrl, identity.cookie, true),
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw new Error("longmemeval_run_request_failed");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as unknown;
    const code = body && typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string" &&
      /^[a-z0-9_]{1,80}$/u.test((body as { error: string }).error)
      ? (body as { error: string }).error
      : `http_${response.status}`;
    throw new Error(`longmemeval_run_rejected:${code}`);
  }
  await drain(response);
  const deadline = Date.now() + timeoutMs;
  let modelRun = await prisma.modelRun.findFirst({
    include: { assistantMessage: true },
    orderBy: { createdAt: "desc" },
    where: { chatId: chat.id, userId: identity.userId }
  });
  while ((!modelRun || !terminalRunStatuses.has(modelRun.status)) && Date.now() < deadline) {
    await sleep(1_000);
    modelRun = await prisma.modelRun.findFirst({
      include: { assistantMessage: true },
      orderBy: { createdAt: "desc" },
      where: { chatId: chat.id, userId: identity.userId }
    });
  }
  if (modelRun?.status !== "complete" ||
    modelRun.assistantMessage?.status !== "complete") {
    throw new Error("longmemeval_run_not_complete");
  }
  const hypothesis = textFromContentBlocks(
    modelRun.assistantMessage.content as { blocks?: unknown[] }
  ).trim();
  if (!hypothesis) throw new Error("longmemeval_answer_empty");
  const [answerBinding, memoryBinding] = await Promise.all([
    prisma.providerRunBinding.findUnique({
      select: { providerModelId: true },
      where: { modelRunId_bindingKey: { bindingKey: "answer", modelRunId: modelRun.id } }
    }),
    prisma.modelRunMemoryBinding.findUnique({
      select: {
        contextTokenCount: true,
        degradationCode: true,
        id: true,
        outcome: true,
        retrievalAttemptId: true
      },
      where: { modelRunId: modelRun.id }
    })
  ]);
  if (answerBinding?.providerModelId !== roles.system.id || !memoryBinding) {
    throw new Error("longmemeval_run_binding_invalid");
  }
  const memoryItems = await prisma.modelRunMemoryItem.count({
    where: { bindingId: memoryBinding.id, userId: identity.userId }
  });
  const retrievalAttempt = await prisma.memoryRetrievalAttempt.findUnique({
    select: { budgetSnapshot: true },
    where: { id: memoryBinding.retrievalAttemptId }
  });
  if (!retrievalAttempt) throw new Error("longmemeval_retrieval_audit_missing");
  return Object.freeze({
    debugLocator: Object.freeze({
      memoryBindingId: memoryBinding.id,
      modelRunId: modelRun.id,
      retrievalAttemptId: memoryBinding.retrievalAttemptId
    }),
    hypothesis,
    retrieval: sanitizeLongMemEvalRetrievalAudit(retrievalAttempt?.budgetSnapshot),
    summary: Object.freeze({
      costMicros: modelRun.estimatedCostMicros,
      inputTokens: modelRun.inputTokens,
      memoryContextTokens: memoryBinding.contextTokenCount,
      memoryDegradationCode: memoryBinding.degradationCode,
      memoryItems,
      memoryOutcome: memoryBinding.outcome,
      outputTokens: modelRun.outputTokens,
      runMs: Date.now() - startedAt,
      totalTokens: modelRun.totalTokens
    })
  });
}

async function loadPackedComponentEvaluation(
  prisma: PrismaClient,
  input: Readonly<{
    answerSessionIds: readonly string[];
    chatIds: readonly string[];
    haystackSessionIds: readonly string[];
    retrievalAttemptId: string;
    userId: string;
  }>
): Promise<LongMemEvalComponentMetrics> {
  const items = await prisma.memoryRetrievalAttemptItem.findMany({
    orderBy: { ordinal: "asc" },
    select: { ordinal: true, sourceChatIdSnapshot: true },
    where: { attemptId: input.retrievalAttemptId, userId: input.userId }
  });
  const candidates = items.flatMap((item) => {
    if (!item.sourceChatIdSnapshot) return [];
    const sessionIndex = input.chatIds.indexOf(item.sourceChatIdSnapshot);
    const sessionId = sessionIndex < 0
      ? null
      : input.haystackSessionIds[sessionIndex] ?? null;
    return sessionId ? [{
      evidenceHandle: `packed-${item.ordinal}`,
      sessionId
    }] : [];
  });
  return evaluateLongMemEvalComponentMetrics({
    answerSessionIds: input.answerSessionIds,
    candidates,
    k: 20
  });
}

function debugSessionReference(
  sourceChatId: string | null,
  chatIds: readonly string[],
  entry: LongMemEvalCase
): Readonly<{
  date: string;
  sessionId: string;
  sessionIndex: number;
}> | null {
  if (!sourceChatId) return null;
  const sessionIndex = chatIds.indexOf(sourceChatId);
  if (sessionIndex < 0) return null;
  return Object.freeze({
    date: entry.haystackDates[sessionIndex]!,
    sessionId: entry.haystackSessionIds[sessionIndex]!,
    sessionIndex
  });
}

async function writeMemoryDebugArtifact(
  prisma: PrismaClient,
  input: Readonly<{
    chatIds: readonly string[];
    entry: LongMemEvalCase;
    hypothesis: string;
    locator: Readonly<{
      memoryBindingId: string;
      modelRunId: string;
      retrievalAttemptId: string;
    }>;
    outputDirectory: string;
    userId: string;
  }>
): Promise<string> {
  const [
    attempt,
    attemptItems,
    memoryItems,
    digests,
    historyCheckpoints,
    historyJobs,
    historyChunks,
    historyExecutions,
    modelRun,
    answerBinding,
    retrievalExecutions
  ] = await Promise.all([
    prisma.memoryRetrievalAttempt.findUnique({
      select: {
        attemptOrdinal: true,
        boundedSafeQuerySnapshot: true,
        budgetSnapshot: true,
        degradationCode: true,
        errorCode: true,
        externalRolesUsed: true,
        id: true,
        outcome: true,
        preparedContextText: true,
        preparedContextTokenCount: true,
        state: true,
        utilityEgressMode: true
      },
      where: { id: input.locator.retrievalAttemptId }
    }),
    prisma.memoryRetrievalAttemptItem.findMany({
      orderBy: { ordinal: "asc" },
      select: {
        exactItemId: true,
        exactSafeText: true,
        featureSnapshot: true,
        itemType: true,
        laneRanks: true,
        ordinal: true,
        selectionReason: true,
        sourceChatIdSnapshot: true,
        sourceSnapshot: true,
        versionSnapshot: true
      },
      where: {
        attemptId: input.locator.retrievalAttemptId,
        userId: input.userId
      }
    }),
    prisma.modelRunMemoryItem.findMany({
      orderBy: { ordinal: "asc" },
      select: {
        exactItemId: true,
        featureSnapshot: true,
        finalScore: true,
        includedText: true,
        itemStateAtAdmission: true,
        itemType: true,
        laneRanks: true,
        ordinal: true,
        selectionReason: true,
        sourceChatIdSnapshot: true,
        sourceMessageIdsSnapshot: true
      },
      where: {
        bindingId: input.locator.memoryBindingId,
        userId: input.userId
      }
    }),
    prisma.chatMemoryDigest.findMany({
      orderBy: [{ occurredFrom: "asc" }, { id: "asc" }],
      select: {
        chatId: true,
        decisions: true,
        occurredFrom: true,
        occurredTo: true,
        openLoops: true,
        pipelineVersion: true,
        rebuildPolicyVersion: true,
        redactionState: true,
        safeDigestText: true,
        safetyClass: true,
        state: true,
        summary: true,
        topics: true,
        updateMode: true
      },
      where: { userId: input.userId }
    }),
    prisma.chatMemoryCheckpoint.findMany({
      orderBy: [{ chatId: "asc" }, { id: "asc" }],
      select: {
        branchGeneration: true,
        chatId: true,
        lastErrorCode: true,
        pipelineVersion: true,
        sourceRevision: true,
        status: true
      },
      where: { userId: input.userId }
    }),
    prisma.memoryJob.findMany({
      orderBy: [{ chatId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        attemptCount: true,
        chatId: true,
        errorCode: true,
        id: true,
        operationalCounters: true,
        pipelineVersion: true,
        stage: true,
        state: true
      },
      where: { kind: "INDEX_HISTORY", userId: input.userId }
    }),
    prisma.memoryRecallChunk.findMany({
      orderBy: [{ chatId: "asc" }, { chunkOrdinal: "asc" }, { id: "asc" }],
      select: {
        chatId: true,
        chunkOrdinal: true,
        chunkingVersion: true,
        redactionState: true,
        safetyClass: true,
        sourceProjectionVersion: true,
        state: true
      },
      where: { userId: input.userId }
    }),
    prisma.memoryExecutionBinding.findMany({
      orderBy: [{ memoryJobId: "asc" }, { ordinal: "asc" }, { id: "asc" }],
      select: {
        errorCode: true,
        logicalRole: true,
        memoryJobId: true,
        ordinal: true,
        pipelineVersion: true,
        promptVersion: true,
        state: true
      },
      where: { memoryJobId: { not: null }, userId: input.userId }
    }),
    prisma.modelRun.findFirst({
      select: {
        id: true,
        modelId: true,
        normalizedRequest: true,
        provider: true,
        status: true
      },
      where: { id: input.locator.modelRunId, userId: input.userId }
    }),
    prisma.providerRunBinding.findUnique({
      select: {
        bindingKey: true,
        connectionId: true,
        credentialSource: true,
        providerModelId: true,
        role: true
      },
      where: {
        modelRunId_bindingKey: {
          bindingKey: "answer",
          modelRunId: input.locator.modelRunId
        }
      }
    }),
    prisma.memoryExecutionBinding.findMany({
      orderBy: [{ ordinal: "asc" }, { id: "asc" }],
      select: {
        errorCode: true,
        inputTokens: true,
        logicalRole: true,
        ordinal: true,
        outputTokens: true,
        pipelineVersion: true,
        policyVersion: true,
        promptVersion: true,
        providerId: true,
        providerModelId: true,
        schemaVersion: true,
        state: true,
        totalTokens: true
      },
      where: {
        retrievalAttemptId: input.locator.retrievalAttemptId,
        userId: input.userId
      }
    })
  ]);
  if (!attempt || !modelRun || !answerBinding) {
    throw new Error("longmemeval_memory_debug_evidence_missing");
  }
  const withSession = <T extends { sourceChatIdSnapshot: string | null }>(item: T) => ({
    ...item,
    sourceSession: debugSessionReference(
      item.sourceChatIdSnapshot,
      input.chatIds,
      input.entry
    )
  });
  const artifactName = `memory-debug-${createHash("sha256")
    .update(input.entry.questionId)
    .digest("hex")
    .slice(0, 16)}.json`;
  await writeJsonAtomic(resolve(input.outputDirectory, artifactName),
    redactLongMemEvalDebugArtifact({
    answerBinding,
    attempt: {
      ...attempt,
      items: attemptItems.map(withSession)
    },
    chatDigests: digests.map((digest) => ({
      ...digest,
      sourceSession: debugSessionReference(digest.chatId, input.chatIds, input.entry)
    })),
    finalAnswer: input.hypothesis,
    finalMemoryItems: memoryItems.map(withSession),
    historyCheckpoints: historyCheckpoints.map((checkpoint) => ({
      ...checkpoint,
      sourceSession: debugSessionReference(checkpoint.chatId, input.chatIds, input.entry)
    })),
    historyChunks: historyChunks.map((chunk) => ({
      ...chunk,
      sourceSession: debugSessionReference(chunk.chatId, input.chatIds, input.entry)
    })),
    historyExecutions,
    historyJobs: historyJobs.map((job) => ({
      ...job,
      sourceSession: debugSessionReference(job.chatId, input.chatIds, input.entry)
    })),
    modelRun,
    question: input.entry.question,
    questionId: input.entry.questionId,
    retrievalExecutions,
    version: 3,
    warning: "Contains secret-screened benchmark Memory context. Keep this ignored 0600 artifact local."
  }));
  emit("memory_debug_written", {
    artifact: artifactName,
    questionId: input.entry.questionId
  });
  return artifactName;
}

async function writeDreamDiagnosticArtifact(
  prisma: PrismaClient,
  input: Readonly<{
    chatIds: readonly string[];
    entry: LongMemEvalCase;
    outputDirectory: string;
    phase: "post" | "pre";
    userId: string;
  }>
): Promise<string> {
  const facts = await prisma.memoryFact.findMany({
    orderBy: [{ category: "asc" }, { canonicalKey: "asc" }, { id: "asc" }],
    select: {
      canonicalKey: true,
      category: true,
      currentVersionId: true,
      dimensionKey: true,
      predicateKey: true,
      subjectKey: true
    },
    where: {
      currentVersionId: { not: null },
      state: "ACTIVE",
      userId: input.userId
    }
  });
  const versionIds = facts.flatMap(({ currentVersionId }) =>
    currentVersionId ? [currentVersionId] : []);
  const [versions, evidence, relations, executions, versionEntities] =
    await Promise.all([
    prisma.memoryFactVersion.findMany({
      orderBy: [{ modality: "asc" }, { displayText: "asc" }, { id: "asc" }],
      select: {
        confidence: true,
        directness: true,
        displayText: true,
        id: true,
        modality: true,
        observedAt: true,
        semanticAdjudication: true,
        structuredValue: true,
        synthesisDepth: true,
        synthesisGeneration: true
      },
      where: { id: { in: versionIds }, userId: input.userId }
    }),
    prisma.memoryEvidence.findMany({
      orderBy: [{ observedAt: "asc" }, { id: "asc" }],
      select: {
        chatId: true,
        factVersionId: true,
        observedAt: true,
        safeExcerpt: true,
        sourceRole: true,
        sourceType: true,
        stance: true
      },
      where: { factVersionId: { in: versionIds }, userId: input.userId }
    }),
    prisma.memoryFactVersionRelation.findMany({
      orderBy: [{ sourceVersionId: "asc" }, { targetVersionId: "asc" }],
      select: {
        confidence: true,
        kind: true,
        reasonCode: true,
        sourceEligibilityHash: true,
        sourceVersionId: true,
        targetVersionId: true
      },
      where: {
        kind: "SYNTHESIZED_FROM",
        sourceVersionId: { in: versionIds },
        targetVersionId: { in: versionIds },
        userId: input.userId
      }
    }),
    prisma.memorySynthesisExecution.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        acceptedOutput: true,
        appliedAt: true,
        sourceBindings: true,
        sourceSetFingerprint: true
      },
      where: { userId: input.userId }
    }),
    prisma.memoryFactVersionEntity.findMany({
      orderBy: [{ factVersionId: "asc" }, { role: "asc" }, { entityId: "asc" }],
      select: { entityId: true, factVersionId: true, role: true },
      where: { factVersionId: { in: versionIds }, userId: input.userId }
    })
  ]);
  const entities = await prisma.memoryEntity.findMany({
    orderBy: [{ entityType: "asc" }, { canonicalKey: "asc" }, { id: "asc" }],
    select: {
      canonicalKey: true,
      displayName: true,
      entityType: true,
      id: true
    },
    where: {
      id: { in: [...new Set(versionEntities.map(({ entityId }) => entityId))] },
      userId: input.userId
    }
  });
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const factByVersionId = new Map(facts.flatMap((fact) =>
    fact.currentVersionId ? [[fact.currentVersionId, fact] as const] : []));
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const evidenceByVersionId = new Map<string, typeof evidence>();
  for (const item of evidence) {
    const current = evidenceByVersionId.get(item.factVersionId) ?? [];
    evidenceByVersionId.set(item.factVersionId, [...current, item]);
  }
  const projectEvidence = (versionId: string) =>
    (evidenceByVersionId.get(versionId) ?? []).map((item) => ({
      observedAt: item.observedAt,
      safeExcerpt: item.safeExcerpt,
      sourceRole: item.sourceRole,
      sourceSession: debugSessionReference(item.chatId, input.chatIds, input.entry),
      sourceType: item.sourceType,
      stance: item.stance
    }));
  const projectFact = (versionId: string) => {
    const fact = factByVersionId.get(versionId);
    const version = versionById.get(versionId);
    if (!fact || !version) {
      throw new Error("longmemeval_dream_diagnostic_fact_projection_missing");
    }
    return {
      canonicalKey: fact.canonicalKey,
      category: fact.category,
      confidence: version.confidence,
      dimensionKey: fact.dimensionKey,
      directness: version.directness,
      entities: versionEntities
        .filter(({ factVersionId }) => factVersionId === versionId)
        .map(({ entityId, role }) => {
          const entity = entityById.get(entityId);
          if (!entity) {
            throw new Error("longmemeval_dream_diagnostic_entity_missing");
          }
          return {
            canonicalKey: entity.canonicalKey,
            displayName: entity.displayName,
            entityType: entity.entityType,
            role
          };
        }),
      evidence: projectEvidence(versionId),
      modality: version.modality,
      observedAt: version.observedAt,
      predicateKey: fact.predicateKey,
      semanticAdjudication: version.semanticAdjudication,
      statement: version.displayText,
      structuredValue: version.structuredValue,
      subjectKey: fact.subjectKey,
      synthesisDepth: version.synthesisDepth,
      synthesisGeneration: version.synthesisGeneration
    };
  };
  const patternVersions = versions.filter(({ modality }) => modality === "PATTERN");
  const directVersions = versions.filter(({ modality }) => modality !== "PATTERN");
  const artifactName = `dream-diagnostic-${input.phase}-${createHash("sha256")
    .update(input.entry.questionId)
    .digest("hex")
    .slice(0, 16)}.json`;
  await writeJsonAtomic(resolve(input.outputDirectory, artifactName),
    redactLongMemEvalDebugArtifact({
      directFacts: directVersions.map(({ id }) => projectFact(id)),
      patterns: patternVersions.map(({ id }) => ({
        ...projectFact(id),
        sources: relations
          .filter(({ sourceVersionId }) => sourceVersionId === id)
          .map((relation) => ({
            confidence: relation.confidence,
            fact: projectFact(relation.targetVersionId),
            reasonCode: relation.reasonCode,
            sourceEligibilityHash: relation.sourceEligibilityHash
          }))
      })),
      question: input.entry.question,
      questionId: input.entry.questionId,
      phase: input.phase,
      synthesisExecutions: executions.map((execution) => ({
        appliedAt: execution.appliedAt,
        recoveryOutputCleared: execution.acceptedOutput === null,
        recoverySourceBindingsCleared: execution.sourceBindings === null,
        sourceSetFingerprint: execution.sourceSetFingerprint
      })),
      version: 1,
      warning: "Contains secret-screened benchmark facts and Dream lineage. Keep this ignored 0600 artifact local."
    }));
  emit("dream_diagnostic_written", {
    artifact: artifactName,
    directFacts: directVersions.length,
    patterns: patternVersions.length,
    questionId: input.entry.questionId
  });
  return artifactName;
}

async function assertExecutionModels(
  prisma: PrismaClient,
  userId: string,
  roles: ProviderRoles,
  executionStartedAt: Date
): Promise<Readonly<{
  aggregates: readonly ExecutionAggregate[];
  embeddingBatchSizeDistribution: Readonly<Record<string, number>>;
}>> {
  const executions = await prisma.memoryExecutionBinding.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      completedAt: true,
      estimatedCostMicros: true,
      id: true,
      inputTokens: true,
      logicalRole: true,
      outputTokens: true,
      providerModelId: true,
      startedAt: true,
      state: true,
      totalTokens: true
    },
    where: { createdAt: { gte: executionStartedAt }, userId }
  });
  const successful = executions.filter(({ state }) => state === "SUCCEEDED");
  for (const execution of successful) {
    const expectedModelIds = longMemEvalExpectedUtilityModelIds({
      embeddingModelId: roles.qwen.id,
      logicalRole: execution.logicalRole,
      rerankerModelIds: roles.rerankerRoute.map(({ id }) => id),
      systemModelId: roles.system.id
    });
    if (!execution.providerModelId ||
      !expectedModelIds.includes(execution.providerModelId)) {
      throw new Error("longmemeval_utility_model_mismatch");
    }
  }
  const documentExecutionIds = successful.flatMap(({ id, logicalRole }) =>
    logicalRole === "MEMORY_DOCUMENT_EMBED" ? [id] : []);
  const documentBatches = documentExecutionIds.length === 0
    ? []
    : await prisma.memoryEmbeddingBatchItem.groupBy({
        _count: { _all: true },
        by: ["executionBindingId"],
        where: {
          executionBindingId: { in: documentExecutionIds },
          userId
        }
      });
  const embeddingBatchSizeDistribution =
    longMemEvalEmbeddingBatchSizeDistribution({
      documentBatches: documentBatches.map((batch) => ({
        executionBindingId: batch.executionBindingId!,
        itemCount: batch._count._all
      })),
      successfulExecutions: successful
    });
  return Object.freeze({
    aggregates: aggregateExecutions(executions),
    embeddingBatchSizeDistribution
  });
}

async function runCase(
  prisma: PrismaClient,
  baseUrl: URL,
  roles: ProviderRoles,
  entry: LongMemEvalCase,
  options: CliOptions,
  cacheRuntime: PreparedCaseCacheRuntime
): Promise<Readonly<{ hypothesis: string; summary: CaseSummary }>> {
  const cacheEnabled = options.profile === "official" &&
    !options.forceDreamDiagnostic;
  // The active fast-model matrix is an answer-time A/B over the already
  // prepared Luna projection.  It must fail closed if promotion cannot find
  // a settled compatible cache; silently falling through to buildFresh would
  // turn a no-reindex run into an expensive and incomparable reindex.
  const preparedCacheRequired = cacheEnabled &&
    options.qualificationManifestId !== null &&
    isLongMemEvalActiveQualificationManifest(options.qualificationManifestId);
  const sourceFingerprint = cacheEnabled
    ? preparedCaseSourceFingerprint({
        entry,
        migrationFingerprint: cacheRuntime.migrationFingerprint,
        profile: options.profile,
        roles
      })
    : null;

  const executeCase = async (): Promise<Readonly<{
    hypothesis: string;
    summary: CaseSummary;
  }>> => {
    let identity: BenchmarkIdentity | null = null;
    let preserveUser = false;
    const executionStartedAt = new Date(Date.now() - 1_000);
    let preparedCase: PreparedCaseCacheEvidence | null = null;
    try {
      let imported!: ImportedHistory;
      let learning!: LongMemEvalLearningEvidence;
      let hybrid!: Readonly<{ activeChunks: number; hybridEntries: number }>;
      let indexStartedAt!: number;
      let importCompletedAt!: number;
      let lexicalIndexCompletedAt!: number;
      let hybridIndexCompletedAt!: number;
      let sourceCacheHit = false;
      let sourceBuildRecovered = false;
      let sourceCompatibilityPromoted = false;
      let hybridCacheHit = false;
      let historyProjectionAuthority:
        PreparedCaseCacheEvidence["historyProjectionAuthority"] =
        "CURRENT_SYSTEM_MODEL";
      const buildFresh = async (persistent: Readonly<{
        buildingEmail: string;
        displayName: string;
        readyEmail: string;
      }> | null): Promise<void> => {
        identity = await withFailureCode(
          "longmemeval_identity_setup_failed",
          () => createBenchmarkIdentity(
            prisma,
            roles,
            entry.questionId,
            options.profile,
            persistent
              ? { displayName: persistent.displayName, email: persistent.buildingEmail }
              : undefined
          )
        );
        if (options.forceDreamDiagnostic) {
          await withFailureCode(
            "longmemeval_dream_diagnostic_boundary_failed",
            () => prepareForcedDreamDiagnostic(prisma, identity!.userId, entry)
          );
        }
        await withFailureCode(
          "longmemeval_catalog_preflight_failed",
          () => catalogSystemModel(
            baseUrl,
            identity!.cookie,
            roles.system.id,
            roles.system.upstreamModelId,
            roles.system.connectionId
          )
        );
        indexStartedAt = Date.now();
        imported = await withFailureCode(
          "longmemeval_history_import_failed",
          () => importHistory(
            prisma,
            identity!.userId,
            entry,
            options.sessionConcurrency,
            options.profile
          )
        );
        importCompletedAt = Date.now();
        learning = await withFailureCode(
          "longmemeval_history_index_failed",
          () => waitForHistoryIndex(
            prisma,
            identity!.userId,
            imported.chatIds.length,
            imported.automaticSettlements,
            options.profile,
            options.indexTimeoutMs,
            entry.questionId
          )
        );
        if (options.forceDreamDiagnostic) {
          await withFailureCode(
            "longmemeval_dream_diagnostic_artifact_failed",
            () => writeDreamDiagnosticArtifact(prisma, {
              chatIds: imported.chatIds,
              entry,
              outputDirectory: options.outputDirectory,
              phase: "pre",
              userId: identity!.userId
            })
          );
          if (learning.synthesisJobs === 0) {
            await withFailureCode(
              "longmemeval_dream_diagnostic_admission_failed",
              () => admitForcedDreamDiagnostic(
                prisma,
                identity!.userId,
                entry.questionId
              )
            );
            learning = await withFailureCode(
              "longmemeval_dream_diagnostic_pipeline_failed",
              () => waitForHistoryIndex(
                prisma,
                identity!.userId,
                imported.chatIds.length,
                imported.automaticSettlements,
                options.profile,
                options.indexTimeoutMs,
                entry.questionId
              )
            );
          }
          if (learning.synthesisJobs < 1 ||
            learning.successfulSynthesisJobs !== learning.synthesisJobs ||
            learning.appliedSynthesisExecutions !== learning.synthesisJobs) {
            throw new Error("longmemeval_dream_diagnostic_not_applied");
          }
          await withFailureCode(
            "longmemeval_dream_diagnostic_artifact_failed",
            () => writeDreamDiagnosticArtifact(prisma, {
              chatIds: imported.chatIds,
              entry,
              outputDirectory: options.outputDirectory,
              phase: "post",
              userId: identity!.userId
            })
          );
        }
        lexicalIndexCompletedAt = Date.now();
        const rebuildJobId = await withFailureCode(
          "longmemeval_hybrid_rebuild_start_failed",
          () => startHybridRebuild(prisma, identity!.userId, roles.qwen.id)
        );
        hybrid = await withFailureCode(
          "longmemeval_hybrid_index_failed",
          () => waitForHybridIndex(
            prisma,
            identity!.userId,
            rebuildJobId,
            roles.qwen.id,
            options.indexTimeoutMs,
            entry.questionId
          )
        );
        hybridIndexCompletedAt = Date.now();
        if (persistent) {
          const promoted = await prisma.user.updateMany({
            data: { email: persistent.readyEmail },
            where: { email: persistent.buildingEmail, id: identity.userId }
          });
          if (promoted.count !== 1) {
            throw new Error("longmemeval_prepared_case_promotion_failed");
          }
          preserveUser = true;
        }
      };

      if (sourceFingerprint) {
        const readyEmail = longMemEvalPreparedCaseReadyEmail(sourceFingerprint);
        const displayName = longMemEvalPreparedCaseDisplayName(
          entry.questionId,
          sourceFingerprint
        );
        let cachedUser = await prisma.user.findUnique({
          select: { id: true },
          where: { email: readyEmail }
        });
        if (cachedUser) {
          try {
            await assertPreparedQueryIsolation(
              prisma,
              cachedUser.id,
              entry.questionId
            );
            await assertPreparedHistorySettled(
              prisma,
              cachedUser.id,
              entry.haystackSessions.length
            );
            await alignPreparedCaseIdentity(prisma, {
              displayName,
              email: readyEmail,
              roles,
              userId: cachedUser.id
            });
            imported = await loadPreparedHistory(prisma, cachedUser.id, entry);
            learning = await waitForHistoryIndex(
              prisma,
              cachedUser.id,
              imported.chatIds.length,
              imported.automaticSettlements,
              options.profile,
              options.indexTimeoutMs,
              entry.questionId
            );
          } catch (error) {
            emit("prepared_case_source_invalid", {
              code: safeFailureCode(error),
              questionId: entry.questionId,
              sourceFingerprint
            });
            if (preparedCacheRequired) {
              throw new Error("longmemeval_prepared_case_cache_invalid");
            }
            await prisma.user.delete({ where: { id: cachedUser.id } });
            cachedUser = null;
          }
        }
        if (!cachedUser) {
          const buildingUsers = await prisma.user.findMany({
            orderBy: [{ createdAt: "desc" }, { id: "asc" }],
            select: { displayName: true, email: true, id: true },
            where: {
              displayName,
              email: {
                endsWith: LONGMEMEVAL_PREPARED_CASE_EMAIL_SUFFIX,
                startsWith: `building.${sourceFingerprint.slice(0, 12)}.`
              }
            }
          });
          for (const buildingUser of buildingUsers) {
            if (!buildingUser.email) continue;
            try {
              await assertPreparedQueryIsolation(
                prisma,
                buildingUser.id,
                entry.questionId
              );
              await assertPreparedHistorySettled(
                prisma,
                buildingUser.id,
                entry.haystackSessions.length
              );
              await assertPreparedHistoryContractCompatibility(
                prisma,
                buildingUser.id
              );
              await alignPreparedCaseIdentity(prisma, {
                displayName: buildingUser.displayName,
                email: buildingUser.email,
                allowSystemModelSwap: true,
                roles,
                userId: buildingUser.id
              });
              imported = await loadPreparedHistory(prisma, buildingUser.id, entry);
              learning = await waitForHistoryIndex(
                prisma,
                buildingUser.id,
                imported.chatIds.length,
                imported.automaticSettlements,
                options.profile,
                options.indexTimeoutMs,
                entry.questionId
              );
              await promotePreparedCaseIdentity(prisma, {
                currentDisplayName: buildingUser.displayName,
                currentEmail: buildingUser.email,
                displayName,
                email: readyEmail,
                userId: buildingUser.id
              });
              cachedUser = { id: buildingUser.id };
              sourceBuildRecovered = true;
              emit("prepared_case_build_recovered", {
                questionId: entry.questionId,
                sourceFingerprint
              });
              break;
            } catch (error) {
              emit("prepared_case_build_recovery_invalid", {
                code: safeFailureCode(error),
                questionId: entry.questionId
              });
            }
          }
        }
        if (!cachedUser) {
          const compatibleUsers = await prisma.user.findMany({
            orderBy: [{ createdAt: "desc" }, { id: "asc" }],
            select: { displayName: true, email: true, id: true },
            where: {
              displayName: { startsWith: `LongMemEval prepared ${entry.questionId} ` },
              email: { endsWith: LONGMEMEVAL_PREPARED_CASE_EMAIL_SUFFIX }
            }
          });
          for (const compatibleUser of compatibleUsers) {
            const legacyFingerprint = longMemEvalPreparedCaseReadyFingerprint({
              displayName: compatibleUser.displayName,
              email: compatibleUser.email,
              questionId: entry.questionId
            });
            if (!legacyFingerprint || legacyFingerprint === sourceFingerprint) continue;
            if (!compatibleUser.email) continue;
            try {
              await assertPreparedQueryIsolation(
                prisma,
                compatibleUser.id,
                entry.questionId
              );
              await assertPreparedHistorySettled(
                prisma,
                compatibleUser.id,
                entry.haystackSessions.length
              );
              await assertPreparedHistoryContractCompatibility(
                prisma,
                compatibleUser.id
              );
              await alignPreparedCaseIdentity(prisma, {
                displayName: compatibleUser.displayName,
                email: compatibleUser.email,
                allowSystemModelSwap: true,
                roles,
                userId: compatibleUser.id
              });
              imported = await loadPreparedHistory(prisma, compatibleUser.id, entry);
              learning = await waitForHistoryIndex(
                prisma,
                compatibleUser.id,
                imported.chatIds.length,
                imported.automaticSettlements,
                options.profile,
                options.indexTimeoutMs,
                entry.questionId
              );
              await promotePreparedCaseIdentity(prisma, {
                currentDisplayName: compatibleUser.displayName,
                currentEmail: compatibleUser.email,
                displayName,
                email: readyEmail,
                userId: compatibleUser.id
              });
              cachedUser = { id: compatibleUser.id };
              sourceCompatibilityPromoted = true;
              historyProjectionAuthority = "CACHED_PRIOR_SYSTEM_MODEL";
              emit("prepared_case_source_compatibility_promoted", {
                questionId: entry.questionId,
                sourceFingerprint
              });
              break;
            } catch (error) {
              emit("prepared_case_source_compatibility_invalid", {
                code: safeFailureCode(error),
                questionId: entry.questionId
              });
            }
          }
        }
        if (cachedUser) {
          sourceCacheHit = true;
          preserveUser = true;
          identity = await createBenchmarkSession(prisma, cachedUser.id);
          await withFailureCode(
            "longmemeval_catalog_preflight_failed",
            () => catalogSystemModel(
              baseUrl,
              identity!.cookie,
              roles.system.id,
              roles.system.upstreamModelId,
              roles.system.connectionId
            )
          );
          const preparedAt = Date.now();
          indexStartedAt = preparedAt;
          importCompletedAt = preparedAt;
          lexicalIndexCompletedAt = preparedAt;
          const readyHybrid = await loadReadyHybridIndex(prisma, cachedUser.id);
          if (readyHybrid) {
            hybrid = readyHybrid;
            hybridCacheHit = true;
          } else {
            if (preparedCacheRequired) {
              throw new Error("longmemeval_prepared_case_hybrid_cache_missing");
            }
            const rebuildJobId = await withFailureCode(
              "longmemeval_hybrid_rebuild_start_failed",
              () => startHybridRebuild(prisma, cachedUser!.id, roles.qwen.id)
            );
            hybrid = await withFailureCode(
              "longmemeval_hybrid_index_failed",
              () => waitForHybridIndex(
                prisma,
                cachedUser!.id,
                rebuildJobId,
                roles.qwen.id,
                options.indexTimeoutMs,
                entry.questionId
              )
            );
          }
          hybridIndexCompletedAt = Date.now();
        } else {
          if (preparedCacheRequired) {
            throw new Error("longmemeval_prepared_case_cache_missing");
          }
          const stale = await prisma.user.findMany({
            select: { id: true },
            where: {
              displayName,
              email: { endsWith: LONGMEMEVAL_PREPARED_CASE_EMAIL_SUFFIX }
            }
          });
          for (const user of stale) {
            await prisma.user.delete({ where: { id: user.id } });
          }
          await buildFresh({
            buildingEmail: longMemEvalPreparedCaseBuildingEmail(
              sourceFingerprint,
              randomUUID()
            ),
            displayName,
            readyEmail
          });
        }
        preparedCase = Object.freeze({
          cacheVersion: LONGMEMEVAL_PREPARED_CASE_CACHE_VERSION,
          historyProjectionAuthority,
          hybridCacheHit,
          sourceBuildRecovered,
          sourceCacheHit,
          sourceCompatibilityPromoted,
          sourceFingerprint
        });
        emit(sourceCacheHit ? "prepared_case_cache_hit" : "prepared_case_cache_miss", {
          hybridCacheHit,
          historyProjectionAuthority,
          questionId: entry.questionId,
          sourceBuildRecovered,
          sourceCompatibilityPromoted,
          sourceFingerprint
        });
      } else {
        await buildFresh(null);
      }
      if (!identity) throw new Error("longmemeval_identity_setup_failed");
      if (options.qualificationManifestId !== null &&
        isLongMemEvalActiveQualificationManifest(options.qualificationManifestId)) {
        await withFailureCode(
          "longmemeval_lexical_projection_failed",
          () => waitForOpenSearchProjection(
            prisma,
            identity!.userId,
            options.indexTimeoutMs,
            entry.questionId
          )
        );
      }
      const answer = await withFailureCode(
        "longmemeval_question_run_failed",
        () => runQuestion(
          prisma,
          baseUrl,
          identity!,
          roles,
          entry,
          options.runTimeoutMs
        )
      );
      const componentEvaluation = await withFailureCode(
        "longmemeval_component_evaluation_failed",
        () => loadPackedComponentEvaluation(prisma, {
          answerSessionIds: entry.answerSessionIds,
          chatIds: imported.chatIds,
          haystackSessionIds: entry.haystackSessionIds,
          retrievalAttemptId: answer.debugLocator.retrievalAttemptId,
          userId: identity!.userId
        })
      );
      if (options.debugMemory) {
        await withFailureCode(
          "longmemeval_memory_debug_failed",
          () => writeMemoryDebugArtifact(prisma, {
            chatIds: imported.chatIds,
            entry,
            hypothesis: answer.hypothesis,
            locator: answer.debugLocator,
            outputDirectory: options.outputDirectory,
            userId: identity!.userId
          })
        );
      }
      const [jobs, executionEvidence] = await withFailureCode(
        "longmemeval_evidence_audit_failed",
        () => Promise.all([
          sourceJobs(prisma, identity!.userId),
          assertExecutionModels(
            prisma,
            identity!.userId,
            roles,
            executionStartedAt
          )
        ])
      );
      return Object.freeze({
        hypothesis: answer.hypothesis,
        summary: Object.freeze({
          answer: answer.summary,
          componentEvaluation,
          embeddingBatchSizeDistribution:
            executionEvidence.embeddingBatchSizeDistribution,
          history: Object.freeze({
            activeChunks: hybrid.activeChunks,
            assistantTurnsWithoutProductProvenance:
              imported.assistantTurnsWithoutProductProvenance,
            hybridEntries: hybrid.hybridEntries,
            hybridIndexMs: hybridIndexCompletedAt - lexicalIndexCompletedAt,
            importMs: importCompletedAt - indexStartedAt,
            indexMs: hybridIndexCompletedAt - indexStartedAt,
            jobs: aggregateJobs(jobs),
            lexicalIndexMs: lexicalIndexCompletedAt - importCompletedAt,
            messages: imported.messages,
            sessions: imported.chatIds.length,
            syntheticAssistantSettlements: imported.syntheticAssistantSettlements
          }),
          learning,
          preparedCase,
          questionId: entry.questionId,
          questionType: entry.questionType,
          retrieval: answer.retrieval,
          utilityExecutions: executionEvidence.aggregates
        })
      });
    } catch (error) {
      if (!identity) throw error;
      const diagnostics = await Promise.all([
        sourceJobs(prisma, identity.userId),
        prisma.memoryExecutionBinding.findMany({
          orderBy: [{ createdAt: "desc" }, { ordinal: "desc" }],
          select: { errorCode: true, logicalRole: true, state: true },
          take: 20,
          where: {
            createdAt: { gte: executionStartedAt },
            state: { in: ["CANCELLED", "FAILED"] },
            userId: identity.userId
          }
        })
      ]).then(([jobs, failedExecutions]) => Object.freeze({
        jobs: aggregateJobs(jobs),
        primaryCode: safeFailureCode(error),
        recentExecutionFailures: Object.freeze(failedExecutions.map((execution) =>
          Object.freeze({
            errorCode: diagnosticToken(execution.errorCode),
            role: diagnosticToken(execution.logicalRole),
            state: execution.state
          }))),
        terminalJobs: Object.freeze(jobs
          .filter(({ state }) => unsuccessfulJobStates.has(state))
          .slice(0, 20)
          .map((job) => Object.freeze({
            errorCode: diagnosticToken(job.errorCode),
            kind: job.kind,
            state: job.state
          })))
      } satisfies CaseFailureDiagnostics)).catch(() => null);
      if (diagnostics) throw new LongMemEvalCaseFailure(diagnostics);
      throw error;
    } finally {
      if (identity) {
        if (preserveUser) {
          try {
            await assertPreparedQueryIsolation(
              prisma,
              identity.userId,
              entry.questionId
            );
          } finally {
            await prisma.authSession.deleteMany({ where: { id: identity.sessionId } });
          }
        } else {
          await prisma.user.delete({ where: { id: identity.userId } });
        }
      }
    }
  };

  return sourceFingerprint
    ? withPreparedCaseLock(cacheRuntime.databaseUrl, sourceFingerprint, executeCase)
    : executeCase();
}

function buildCheckpointIdentity(input: Readonly<{
  cacheRuntime: PreparedCaseCacheRuntime;
  evaluationFailFast: boolean;
  options: CliOptions;
  roles: ProviderRoles;
  selection: ReturnType<typeof selectLongMemEvalCases>;
}>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    benchmark: Object.freeze({
      datasetSha256: LONGMEMEVAL_S_SHA256,
      evaluatorSha256: LONGMEMEVAL_EVALUATOR_SHA256,
      oracleSha256: LONGMEMEVAL_ORACLE_SHA256,
      upstreamCommit: LONGMEMEVAL_REPOSITORY_COMMIT
    }),
    profile: input.options.profile,
    qualificationManifestId: input.options.qualificationManifestId,
    runtime: Object.freeze({
      debugMemory: input.options.debugMemory,
      embeddingModel: qualificationEmbeddingModelId,
      forceDreamDiagnostic: input.options.forceDreamDiagnostic,
      indexTimeoutMs: input.options.indexTimeoutMs,
      lexicalBackend: process.env.AIQSA_MEMORY_LEXICAL_BACKEND ?? "POSTGRES",
      lexicalIndexBuildId: process.env.AIQSA_MEMORY_OPENSEARCH_INDEX_BUILD_ID ?? null,
      onlineEvaluation: input.options.onlineEvaluation,
      evaluationFailFast: input.evaluationFailFast,
      memoryAdmission: Object.freeze({
        controlMaximumMs: MEMORY_CONTROL_OPTIONAL_MAXIMUM_MS,
        hardDeadlineMs: MEMORY_INTERACTIVE_HARD_DEADLINE_MS,
        queryResolverMaximumMs: MEMORY_QUERY_RESOLVER_OPTIONAL_MAXIMUM_MS,
        queryResolverSettlementReserveMs:
          MEMORY_QUERY_RESOLVER_SETTLEMENT_RESERVE_MS,
        softDeadlineMs: MEMORY_INTERACTIVE_SOFT_DEADLINE_MS,
        version: MEMORY_RUN_RETRIEVAL_ADMISSION_VERSION
      }),
      preparedCaseCache: Object.freeze({
        enabled: input.options.profile === "official" &&
          !input.options.forceDreamDiagnostic,
        migrationFingerprint: input.cacheRuntime.migrationFingerprint,
        version: LONGMEMEVAL_PREPARED_CASE_CACHE_VERSION
      }),
      rerankerRoute: Object.freeze(input.roles.rerankerRoute.map((role) =>
        Object.freeze({
          providerModelId: role.id,
          relevanceScoreFloor: role.relevanceScoreFloor,
          upstreamModelId: role.upstreamModelId
        }))),
      rerankerRoutePolicyVersion: RERANKER_ROUTE_POLICY_VERSION,
      runTimeoutMs: input.options.runTimeoutMs,
      systemModelProvider: qualificationSystemModelProvider(
        input.roles.system.upstreamModelId
      ),
      systemModelProviderOrder: input.roles.system.providerOrder,
      systemModelDataCollection: input.roles.system.dataCollection,
      systemModelStructuredOutputToolChoice:
        input.roles.system.structuredOutputToolChoice,
      systemModelReasoningEffort: qualificationSystemModelReasoningEffort(
        input.roles.system.upstreamModelId
      ),
      systemModel: input.roles.system.upstreamModelId
    }),
    selection: Object.freeze({
      cases: Object.freeze(input.selection.cases.map(({ questionId, questionType }) =>
        Object.freeze({ questionId, questionType }))),
      mode: input.selection.mode,
      seed: input.selection.seed
    }),
    version: 6
  });
}

async function main(): Promise<void> {
  loadEnvConfig(repositoryRoot, true, { error() {}, info() {} }, true);
  let options = parseCli(process.argv.slice(2));
  const appPort = positiveInteger(
    process.env.AIQSA_MEMORY_BENCHMARK_APP_PORT ?? "3137",
    "longmemeval_app_port_invalid"
  );
  const postgresPort = positiveInteger(
    process.env.AIQSA_MEMORY_BENCHMARK_POSTGRES_PORT ?? "55437",
    "longmemeval_postgres_port_invalid"
  );
  if (process.env.AIQSA_MEMORY_BENCHMARK_ACK !== "DISPOSABLE_PAID_LONGMEMEVAL" ||
    process.env.AIQSA_MEMORY_EGRESS_CONSENT_MODE !== "ADMIN") {
    throw new Error("longmemeval_disposable_authority_required");
  }
  const baseUrl = assertBenchmarkBaseUrl(
    process.env.AIQSA_MEMORY_BENCHMARK_BASE_URL ??
      `http://127.0.0.1:${appPort}/`,
    appPort
  );
  const databaseUrl = process.env.AIQSA_MEMORY_BENCHMARK_DATABASE_URL ?? "";
  assertBenchmarkDatabaseUrl(databaseUrl, postgresPort);
  await assertUpstream();
  const qualificationManifest = options.qualificationManifestId
    ? await loadLongMemEvalQualificationManifest(options.qualificationManifestId)
    : null;
  if (qualificationManifest) {
    if (!isLongMemEvalActiveQualificationManifest(qualificationManifest.id)) {
      throw new Error("longmemeval_qualification_manifest_runtime_mismatch");
    }
    options = applyQualificationManifest(options, qualificationManifest);
    await assertLongMemEvalQualificationRevision(repositoryRoot, {
      headCommit: qualificationManifest.source.appCommit,
      worktreeSha256: qualificationManifest.source.appWorktreeSha256
    });
  }
  const evaluationFailFast = qualificationManifest !== null &&
    "evaluation" in qualificationManifest.runtime
    ? qualificationManifest.runtime.evaluation.failFast
    : true;
  const allCases = await loadDataset();
  await assertReferenceMetadata(allCases);
  if (qualificationManifest) {
    assertLongMemEvalQualificationDataset(qualificationManifest, allCases);
  }
  await mkdir(resolve(benchmarkRoot, "results"), { mode: 0o700, recursive: true });
  const summaryPath = resolve(options.outputDirectory, "run-summary.json");
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await assertDatabaseIdentity(prisma);
    const cacheRuntime = Object.freeze({
      databaseUrl,
      migrationFingerprint: await databaseMigrationFingerprint(prisma)
    });
    const staleUsersRemoved = await deleteBenchmarkUsers(prisma);
    const roles = await resolveProviderRoles(prisma, options.systemModelId);
    if (qualificationManifest) {
      assertQualificationResolvedRerankerRoute(qualificationManifest, roles);
    }
    const selection = selectLongMemEvalCases(allCases, {
      ...(options.questionIds.length > 0
        ? { questionIds: options.questionIds }
        : { sampleSize: options.sampleSize }),
      ...(options.seed ? { seed: options.seed } : {})
    });
    const checkpointIdentity = buildCheckpointIdentity({
      cacheRuntime,
      evaluationFailFast,
      options,
      roles,
      selection
    });
    const checkpointManifest = options.resume
      ? await resumeLongMemEvalCheckpointRun({
          expectedIdentity: checkpointIdentity,
          outputDirectory: options.outputDirectory
        })
      : await createLongMemEvalCheckpointRun({
          identity: checkpointIdentity,
          outputDirectory: options.outputDirectory
        });
    const startedAt = new Date(checkpointManifest.startedAt);
    const loadedCheckpoints = await loadLongMemEvalCaseCheckpoints(
      options.outputDirectory,
      {
        failure: decodeCheckpointCaseFailure,
        summary: decodeCheckpointCaseSummary
      }
    );
    const selectedById = new Map(selection.cases.map((entry) => [
      entry.questionId,
      entry
    ]));
    for (const checkpoint of loadedCheckpoints.values()) {
      const selected = selectedById.get(checkpoint.questionId);
      if (!selected || selected.questionType !== checkpoint.questionType) {
        throw new Error("longmemeval_checkpoint_selection_mismatch");
      }
      for (const { outcome } of checkpoint.attempts) {
        const terminal = outcome.status === "COMPLETE" ? outcome.summary : outcome.failure;
        if (terminal.questionId !== checkpoint.questionId ||
          terminal.questionType !== checkpoint.questionType) {
          throw new Error("longmemeval_checkpoint_selection_mismatch");
        }
      }
    }
    const checkpoints = new Map(loadedCheckpoints);
    const caseEvaluations = new Map<string, LongMemEvalCaseEvaluation>();
    const lexicalCutoverRequired = qualificationManifest !== null &&
      isLongMemEvalActiveQualificationManifest(qualificationManifest.id);
    if (options.onlineEvaluation) {
      for (const entry of selection.cases) {
        const checkpoint = checkpoints.get(entry.questionId);
        const latest = checkpoint?.attempts.at(-1);
        if (!latest || latest.outcome.status !== "COMPLETE") continue;
        if (latest.outcome.summary.answer.memoryOutcome !== "USED") {
          if (options.retryUnhealthy) continue;
          emit("case_memory_unhealthy", {
            checkpointAttempt: latest.attempt,
            memoryOutcome: latest.outcome.summary.answer.memoryOutcome,
            questionId: entry.questionId
          });
          throw new Error("longmemeval_case_memory_unhealthy");
        }
        if (!qualificationLexicalCutoverHealthy(
          latest.outcome.summary,
          lexicalCutoverRequired
        )) {
          if (options.retryUnhealthy) continue;
          emit("case_lexical_cutover_unhealthy", {
            checkpointAttempt: latest.attempt,
            questionId: entry.questionId
          });
          throw new Error("longmemeval_case_lexical_cutover_unhealthy");
        }
        const evaluationInput = {
          attempt: latest.attempt,
          hypothesis: latest.outcome.hypothesis,
          outputDirectory: options.outputDirectory,
          questionId: entry.questionId
        };
        const existing = await readLongMemEvalCaseEvaluation(evaluationInput);
        if (existing) {
          caseEvaluations.set(entry.questionId, existing);
          continue;
        }
        const settled = await settleLongMemEvalCaseEvaluation(evaluationInput);
        caseEvaluations.set(entry.questionId, settled);
        emit("case_evaluated", {
          checkpointAttempt: latest.attempt,
          correct: settled.label,
          questionId: entry.questionId,
          recovered: true
        });
        if (longMemEvalEvaluationRequiresStop(
          evaluationFailFast,
          settled.label
        )) {
          throw new Error("longmemeval_case_incorrect");
        }
      }
    }
    const pendingCases = selection.cases.filter((entry) => {
      const checkpoint = checkpoints.get(entry.questionId);
      if (!checkpoint) return true;
      if (!options.retryUnhealthy) return false;
      const outcome = latestCheckpointOutcome(checkpoint);
      return outcome.status === "FAILED" || outcome.summary.answer.memoryOutcome !== "USED" ||
        !qualificationLexicalCutoverHealthy(
          outcome.summary,
          lexicalCutoverRequired
        );
    });
    emit("benchmark_start", {
      caseConcurrency: options.caseConcurrency,
      cases: selection.cases.length,
      debugMemory: options.debugMemory,
      forceDreamDiagnostic: options.forceDreamDiagnostic,
      onlineEvaluation: options.onlineEvaluation,
      preparedCaseCache: options.profile === "official" &&
        !options.forceDreamDiagnostic,
      profile: options.profile,
      remainingCases: pendingCases.length,
      resume: options.resume,
      retryUnhealthy: options.retryUnhealthy,
      selectionMode: selection.mode,
      sessionConcurrency: options.sessionConcurrency,
      singleWave: options.singleWave,
      systemModel: roles.system.upstreamModelId,
      staleUsersRemoved
    });
    const invocationCases = options.singleWave
      ? pendingCases.slice(0, options.caseConcurrency)
      : pendingCases;
    await mapConcurrentOrderedWaves(
      invocationCases,
      options.caseConcurrency,
      async (entry) => {
        emit("case_start", {
          forceDreamDiagnostic: options.forceDreamDiagnostic,
          profile: options.profile,
          questionId: entry.questionId,
          questionType: entry.questionType,
          sessions: entry.haystackSessions.length
        });
        let outcome: LongMemEvalCheckpointOutcome<CaseSummary, CaseFailure>;
        try {
          const result = await runCase(
            prisma,
            baseUrl,
            roles,
            entry,
            options,
            cacheRuntime
          );
          outcome = Object.freeze({
            hypothesis: result.hypothesis,
            reason: checkpointOutcomeReason(result.summary),
            status: "COMPLETE" as const,
            summary: result.summary
          });
        } catch (error) {
          const failure = Object.freeze({
            code: safeFailureCode(error),
            ...(error instanceof LongMemEvalCaseFailure
              ? { diagnostics: error.diagnostics }
              : {}),
            questionId: entry.questionId,
            questionType: entry.questionType
          });
          outcome = Object.freeze({
            failure,
            reason: checkpointFailureReason(failure),
            status: "FAILED" as const
          });
        }
        const checkpoint = await writeLongMemEvalCaseCheckpoint({
          execution: {
            caseConcurrency: options.caseConcurrency,
            origin: "LIVE",
            sessionConcurrency: options.sessionConcurrency
          },
          outcome,
          outputDirectory: options.outputDirectory,
          previous: checkpoints.get(entry.questionId),
          questionId: entry.questionId,
          questionType: entry.questionType
        });
        checkpoints.set(entry.questionId, checkpoint);
        const checkpointAttempt = checkpoint.attempts.length;
        if (outcome.status === "FAILED") {
          emit("case_failed", { ...outcome.failure, checkpointAttempt });
          throw new Error("longmemeval_case_runtime_failed");
        } else {
          emit("case_complete", {
            checkpointAttempt,
            memoryDegradationCode: outcome.summary.answer.memoryDegradationCode,
            memoryItems: outcome.summary.answer.memoryItems,
            memoryOutcome: outcome.summary.answer.memoryOutcome,
            questionId: entry.questionId,
            reason: outcome.reason,
            runTokens: outcome.summary.answer.totalTokens
          });
          if (outcome.summary.answer.memoryOutcome !== "USED") {
            emit("case_memory_unhealthy", {
              checkpointAttempt,
              memoryOutcome: outcome.summary.answer.memoryOutcome,
              questionId: entry.questionId
            });
            throw new Error("longmemeval_case_memory_unhealthy");
          }
          if (!qualificationLexicalCutoverHealthy(
            outcome.summary,
            lexicalCutoverRequired
          )) {
            emit("case_lexical_cutover_unhealthy", {
              checkpointAttempt,
              questionId: entry.questionId
            });
            throw new Error("longmemeval_case_lexical_cutover_unhealthy");
          }
          if (options.onlineEvaluation) {
            const evaluation = await settleLongMemEvalCaseEvaluation({
              attempt: checkpointAttempt,
              hypothesis: outcome.hypothesis,
              outputDirectory: options.outputDirectory,
              questionId: entry.questionId
            });
            caseEvaluations.set(entry.questionId, evaluation);
            emit("case_evaluated", {
              checkpointAttempt,
              correct: evaluation.label,
              questionId: entry.questionId,
              recovered: false
            });
            if (longMemEvalEvaluationRequiresStop(
              evaluationFailFast,
              evaluation.label
            )) {
              throw new Error("longmemeval_case_incorrect");
            }
          }
        }
        return checkpointAttempt;
      }
    );
    if (options.singleWave && invocationCases.length < pendingCases.length) {
      emit("benchmark_paused", {
        completedCases: selection.cases.length - pendingCases.length +
          invocationCases.length,
        completedThisInvocation: invocationCases.length,
        remainingCases: pendingCases.length - invocationCases.length
      });
      return;
    }
    const authoritativeCheckpoints = await loadLongMemEvalCaseCheckpoints(
      options.outputDirectory,
      {
        failure: decodeCheckpointCaseFailure,
        summary: decodeCheckpointCaseSummary
      }
    );
    const summaries: CaseSummary[] = [];
    const failures: CaseFailure[] = [];
    const answers: Readonly<{ hypothesis: string; questionId: string }>[] = [];
    for (const entry of selection.cases) {
      const checkpoint = authoritativeCheckpoints.get(entry.questionId);
      if (!checkpoint || checkpoint.questionType !== entry.questionType) {
        throw new Error("longmemeval_checkpoint_incomplete");
      }
      const outcome = latestCheckpointOutcome(checkpoint);
      if (outcome.status === "FAILED") {
        failures.push(outcome.failure);
      } else {
        summaries.push(outcome.summary);
        answers.push({ hypothesis: outcome.hypothesis, questionId: entry.questionId });
        if (options.onlineEvaluation) {
          const evaluation = await readLongMemEvalCaseEvaluation({
            attempt: checkpoint.attempts.length,
            hypothesis: outcome.hypothesis,
            outputDirectory: options.outputDirectory,
            questionId: entry.questionId
          });
          if (!evaluation) {
            throw new Error("longmemeval_case_evaluation_incomplete");
          }
          caseEvaluations.set(entry.questionId, evaluation);
        }
      }
    }
    await writeLongMemEvalAnswersAtomic(options.outputDirectory, answers);
    const checkpointAttempts = [...authoritativeCheckpoints.values()]
      .reduce((total, checkpoint) => total + checkpoint.attempts.length, 0);
    const recoveredCases = [...authoritativeCheckpoints.values()]
      .filter((checkpoint) => checkpoint.attempts.some(({ execution }) =>
        execution.origin === "RECOVERED")).length;
    const retriedCases = [...authoritativeCheckpoints.values()]
      .filter(({ attempts }) => attempts.length > 1).length;
    const completedAt = new Date();
    const qualification = longMemEvalQualificationGate({
      executionFailures: failures.length,
      memoryOutcomes: summaries.map(({ answer }) => answer.memoryOutcome)
    });
    const lexicalCutoverQualification = Object.freeze({
      passed: summaries.length > 0 && summaries.every((summary) =>
        qualificationLexicalCutoverHealthy(summary, lexicalCutoverRequired)),
      required: lexicalCutoverRequired
    });
    await writeJsonAtomic(summaryPath, {
      activeMemoryRetrievalConfiguration: {
        ...activeMemoryRetrievalConfigurationBase,
        automaticFactLearning: options.profile === "product",
        rerankerRoute: roles.rerankerRoute.map((role) => ({
          relevanceScoreFloor: role.relevanceScoreFloor,
          upstreamModelId: role.upstreamModelId
        }))
      },
      answerModel: {
        dataCollection: roles.system.dataCollection,
        provider: qualificationSystemModelProvider(roles.system.upstreamModelId),
        providerOrder: roles.system.providerOrder,
        reasoningEffort: qualificationSystemModelReasoningEffort(
          roles.system.upstreamModelId
        ),
        structuredOutputToolChoice: roles.system.structuredOutputToolChoice,
        upstreamModelId: roles.system.upstreamModelId
      },
      baseline: buildLongMemEvalBaselineManifest(selection),
      checkpointing: {
        attempts: checkpointAttempts,
        recoveredCases,
        resumed: options.resume,
        retriedCases,
        version: 1
      },
      completedAt: completedAt.toISOString(),
      dataset: {
        cases: allCases.length,
        file: "longmemeval_s_cleaned.json",
        sha256: LONGMEMEVAL_S_SHA256,
        split: "LongMemEval-S cleaned"
      },
      evaluator: {
        command: "evaluate_qa.py gpt-4o answers.jsonl longmemeval_oracle.json",
        executionFailuresCountedIncorrectByAdapter: true,
        referenceMetadataMatchesDataset: true,
        referenceSha256: LONGMEMEVAL_ORACLE_SHA256,
        sha256: LONGMEMEVAL_EVALUATOR_SHA256
      },
      dreamDiagnostic: options.forceDreamDiagnostic
        ? {
            enabled: true,
            optInBoundary: "backdated_before_earliest_unchanged_session",
            productPolicyChanged: false,
            schedulerClock: "advanced_to_first_product_due_point",
            scoring: "separate_non_official_diagnostic"
          }
        : { enabled: false },
      failures,
      memoryEmbeddingModel: {
        provider: "OpenRouter",
        providerOrder: roles.qwen.providerOrder,
        upstreamModelId: qualificationEmbeddingModelId
      },
      memoryAdmission: {
        controlMaximumMs: MEMORY_CONTROL_OPTIONAL_MAXIMUM_MS,
        hardDeadlineMs: MEMORY_INTERACTIVE_HARD_DEADLINE_MS,
        queryResolverMaximumMs: MEMORY_QUERY_RESOLVER_OPTIONAL_MAXIMUM_MS,
        queryResolverSettlementReserveMs:
          MEMORY_QUERY_RESOLVER_SETTLEMENT_RESERVE_MS,
        softDeadlineMs: MEMORY_INTERACTIVE_SOFT_DEADLINE_MS,
        version: MEMORY_RUN_RETRIEVAL_ADMISSION_VERSION
      },
      memoryRerankerModel: {
        mode: "dedicated_ordered_fallback",
        provider: "OpenRouter",
        route: roles.rerankerRoute.map((role, position) => ({
          position,
          relevanceScoreFloor: role.relevanceScoreFloor,
          upstreamModelId: role.upstreamModelId
        })),
        routePolicyVersion: RERANKER_ROUTE_POLICY_VERSION,
        upstreamModelId: roles.reranker.upstreamModelId
      },
      officialEvaluation: options.onlineEvaluation
        ? {
            correctCases: [...caseEvaluations.values()].filter(({ label }) => label)
              .length,
            evaluatedCases: caseEvaluations.size,
            failFast: evaluationFailFast,
            incorrectCases: [...caseEvaluations.values()].filter(({ label }) => !label)
              .map(({ questionId }) => questionId),
            model: "gpt-4o-2024-08-06",
            perCaseJournalVersion: 1,
            scriptSha256: LONGMEMEVAL_EVALUATOR_SHA256,
            unchanged: true
          }
        : null,
      profile: longMemEvalProfileManifest(options.profile),
      preparedCaseCache: {
        buildRecoveries: summaries.filter(({ preparedCase }) =>
          preparedCase?.sourceBuildRecovered).length,
        cachedPriorSystemModel: summaries.filter(({ preparedCase }) =>
          preparedCase?.historyProjectionAuthority ===
          "CACHED_PRIOR_SYSTEM_MODEL").length,
        compatibilityPromotions: summaries.filter(({ preparedCase }) =>
          preparedCase?.sourceCompatibilityPromoted).length,
        enabled: options.profile === "official" && !options.forceDreamDiagnostic,
        hybridHits: summaries.filter(({ preparedCase }) =>
          preparedCase?.hybridCacheHit).length,
        migrationFingerprint: cacheRuntime.migrationFingerprint,
        sourceHits: summaries.filter(({ preparedCase }) =>
          preparedCase?.sourceCacheHit).length,
        version: LONGMEMEVAL_PREPARED_CASE_CACHE_VERSION
      },
      qualificationManifest: qualificationManifest !== null &&
          isLongMemEvalActiveQualificationManifest(qualificationManifest.id)
        ? {
            appCommit: qualificationManifest.source.appCommit,
            appWorktreeSha256: qualificationManifest.source.appWorktreeSha256,
            id: qualificationManifest.id,
            questionIdDigest: qualificationManifest.selection.questionIdDigest,
            runtimeOverride: options.resumeCaseConcurrency === null
              ? null
              : { caseConcurrency: options.caseConcurrency },
            version: qualificationManifest.version
          }
        : null,
      qualification,
      lexicalCutoverQualification,
      results: summaries,
      selection: {
        mode: selection.mode,
        questionIds: selection.cases.map(({ questionId }) => questionId),
        seed: selection.seed
      },
      startedAt: startedAt.toISOString(),
      upstreamCommit: LONGMEMEVAL_REPOSITORY_COMMIT,
      version: 17,
      workerConcurrency: {
        case: options.caseConcurrency,
        memoryJobs: qualificationMemoryJobParallelism,
        memoryJobsPerUser: qualificationMemoryJobPerUserParallelism,
        sessionImport: options.sessionConcurrency
      }
    });
    emit("benchmark_complete", {
      completed: summaries.length,
      correct: options.onlineEvaluation
        ? [...caseEvaluations.values()].filter(({ label }) => label).length
        : null,
      degradedMemoryOutcomes: qualification.degradedMemoryOutcomes,
      failed: failures.length,
      incorrect: options.onlineEvaluation
        ? [...caseEvaluations.values()].filter(({ label }) => !label).length
        : null,
      outputDirectory: options.outputDirectory,
      qualificationPassed: qualification.passed &&
        lexicalCutoverQualification.passed,
      unhealthyMemoryOutcomes: qualification.unhealthyMemoryOutcomes
    });
    if (summaries.length === 0 || failures.length > 0) {
      throw new Error("longmemeval_qualification_incomplete");
    }
    if (!qualification.passed) {
      throw new Error("longmemeval_qualification_memory_unhealthy");
    }
    if (!lexicalCutoverQualification.passed) {
      throw new Error("longmemeval_qualification_lexical_cutover_unhealthy");
    }
    if (options.onlineEvaluation &&
      [...caseEvaluations.values()].some(({ label }) => !label)) {
      throw new Error("longmemeval_qualification_oracle_misses");
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${safeFailureCode(error)}\n`);
  process.exitCode = 1;
});

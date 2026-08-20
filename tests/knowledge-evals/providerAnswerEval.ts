import { createHash, randomInt, randomUUID } from "node:crypto";
import { chmod, lstat, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { defaultProviderModels, type CatalogAdapterKind } from "../../lib/domain/catalog";
import { sumTokenUsage, type NormalizedTokenUsage } from "../../lib/domain/usage";
import type { ModelRunUsage } from "../../lib/domain/modelRunEvents";
import { knowledgeCitationHandlesFromText } from "../../lib/contracts/knowledge";
import {
  decodeKnowledgeCitationViewer,
  type KnowledgeCitationViewer
} from "../../lib/contracts/knowledgeCitations";
import {
  automaticKnowledgeEvidenceMessage,
  unavailableKnowledgeEvidenceMessage,
  withAutomaticKnowledgeEvidence
} from "../../lib/server/knowledge/automaticEvidence";
import { groundKnowledgeAnswer, type KnowledgeGroundingResult } from "../../lib/server/knowledge/grounding";
import {
  knowledgeEvidenceReceiptHash,
  type KnowledgeEvidencePackage,
  type KnowledgeEvidencePackageItem
} from "../../lib/server/knowledge/evidencePackage";
import type { KnowledgePlannerPlan, KnowledgePlannerSubquery } from "../../lib/server/knowledge/planner";
import {
  KNOWLEDGE_RESULT_VERSION,
  type KnowledgeRetrievalEvidence
} from "../../lib/server/knowledge/retrievalTypes";
import { knowledgeToolResultContent, knowledgeToolResultText } from "../../lib/server/knowledge/toolResult";
import type { ProviderExecutionSnapshot } from "../../lib/server/providers/runtimeFactory";
import type { ProviderRunRequest } from "../../lib/server/providers/types";
import type { ToolExecutionResult } from "../../lib/server/tools/types";
import {
  KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION,
  knowledgeSemanticGroundingFixtures,
  type KnowledgeSemanticGroundingLanguage
} from "./semanticGroundingFixtures";

export const KNOWLEDGE_PROVIDER_ANSWER_EVAL_VERSION = "knowledge-provider-answer-eval-v2";
export const KNOWLEDGE_PROVIDER_ANSWER_REVIEW_VERSION = "knowledge-provider-answer-review-v2";
export const KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT = 8;
export const KNOWLEDGE_PROVIDER_ANSWER_MAX_CALLS = 24;
export const KNOWLEDGE_PROVIDER_ANSWER_MAX_OUTPUT_TOKENS = 256;
export const KNOWLEDGE_PROVIDER_ANSWER_TIMEOUT_MS = 30_000;
export const KNOWLEDGE_PROVIDER_ANSWER_REVIEW_DIRECTORY_PREFIX =
  "aiqsa-knowledge-provider-review-";
export const KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE = "review-packet.json";
export const KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE = "review-mapping.json";
export const KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE = "output-freeze.json";

const MAX_CAPTURED_ANSWER_BYTES = 32 * 1024;
const REVIEW_DIRECTORY_PATTERN =
  /^aiqsa-knowledge-provider-review-[A-Za-z0-9_-]{6,64}$/u;
const SYSTEM_INSTRUCTION = [
  "Answer the user's question using only the private Knowledge evidence inserted immediately before the user message.",
  "Follow the evidence message's citation, conflict, version, timeline, and insufficiency rules.",
  "Be concise, answer in the user's language, and do not mention this evaluation."
].join(" ");

const selectedCaseIds = Object.freeze([
  "blind-release-en-direct-list-polar-fieldwork-records",
  "blind-release-ru-direct-list-textile-production-records",
  "blind-release-en-no-answer-museum-conservation-missing-records",
  "blind-release-ru-no-answer-wildfire-response-missing-records",
  "blind-release-en-coverage-conflict-hatchery-cohorts-coverage",
  "blind-release-ru-coverage-conflict-telecom-outages-coverage",
  "blind-release-en-dated-table-pharma-packaging-observations",
  "blind-release-ru-version-reference-urban-transit-actual-reference"
] as const);

type SelectedCaseId = typeof selectedCaseIds[number];

export type ProviderAnswerExpectedBehavior =
  | "answer_from_evidence"
  | "disclose_conflict"
  | "honest_no_answer"
  | "timeline_comparison"
  | "version_comparison";

type ReviewDimension =
  | "citation_usability"
  | "completeness"
  | "correctness"
  | "no_answer_clarity"
  | "supported_claim_preservation"
  | "technical_leakage"
  | "temporal_version_handling"
  | "verifiability";

const releaseReviewDimensions = Object.freeze([
  "correctness",
  "completeness",
  "verifiability",
  "citation_usability",
  "no_answer_clarity",
  "temporal_version_handling",
  "technical_leakage",
  "supported_claim_preservation"
] as const satisfies readonly ReviewDimension[]);

const caseReviewContract: Readonly<Record<SelectedCaseId, Readonly<{
  expectedBehavior: ProviderAnswerExpectedBehavior;
  query: string;
  reviewDimensions: readonly ReviewDimension[];
}>>> = Object.freeze({
  "blind-release-en-coverage-conflict-hatchery-cohorts-coverage": Object.freeze({
    expectedBehavior: "disclose_conflict",
    query: "Do all selected sources agree that the screen-cleaning round is complete, and do they confirm that the vaccination-tray inspection passed?",
    reviewDimensions: releaseReviewDimensions
  }),
  "blind-release-en-no-answer-museum-conservation-missing-records": Object.freeze({
    expectedBehavior: "honest_no_answer",
    query: "What was the frame maker's childhood address?",
    reviewDimensions: releaseReviewDimensions
  }),
  "blind-release-en-direct-list-polar-fieldwork-records": Object.freeze({
    expectedBehavior: "answer_from_evidence",
    query: "Which two facts are recorded in the polar research field log?",
    reviewDimensions: releaseReviewDimensions
  }),
  "blind-release-en-dated-table-pharma-packaging-observations": Object.freeze({
    expectedBehavior: "timeline_comparison",
    query: "Compare the two dated carton rejection rate readings for pharmaceutical packaging batch record.",
    reviewDimensions: releaseReviewDimensions
  }),
  "blind-release-ru-coverage-conflict-telecom-outages-coverage": Object.freeze({
    expectedBehavior: "disclose_conflict",
    query: "Подтверждают ли выбранные источники, что аудит пломб шкафа завершён и что проверка резервного маршрута прошла?",
    reviewDimensions: releaseReviewDimensions
  }),
  "blind-release-ru-no-answer-wildfire-response-missing-records": Object.freeze({
    expectedBehavior: "honest_no_answer",
    query: "Какой марки были сапоги первого патруля?",
    reviewDimensions: releaseReviewDimensions
  }),
  "blind-release-ru-direct-list-textile-production-records": Object.freeze({
    expectedBehavior: "answer_from_evidence",
    query: "Какие два факта указаны в производственной карте текстильной фабрики?",
    reviewDimensions: releaseReviewDimensions
  }),
  "blind-release-ru-version-reference-urban-transit-actual-reference": Object.freeze({
    expectedBehavior: "version_comparison",
    query: "Каковы фактическое значение и референсный интервал зазора дверного порога в редакции 2048?",
    reviewDimensions: releaseReviewDimensions
  })
});

export type ProviderAnswerEvalCase = Readonly<{
  evidence: KnowledgeEvidencePackage;
  expectedBehavior: ProviderAnswerExpectedBehavior;
  id: SelectedCaseId;
  language: KnowledgeSemanticGroundingLanguage;
  query: string;
  reviewDimensions: readonly ReviewDimension[];
}>;

export type ProviderAnswerEvalProfile = Readonly<{
  adapterKind: CatalogAdapterKind;
  apiRoot: string;
  capabilities: ProviderRunRequest["modelCapabilities"];
  credentialEnvironmentName: "ANTHROPIC_API_KEY" | "GEMINI_API_KEY" | "OPENAI_API_KEY";
  modelId: "claude-sonnet-5" | "gemini-3.6-flash" | "gpt-5.5";
  params: Readonly<Record<string, unknown>>;
  provider: "anthropic" | "gemini" | "openai";
}>;

export type ProviderAnswerEvalCliOptions = Readonly<{
  executePaid: true;
  provider: ProviderAnswerEvalProfile["provider"] | null;
  reviewDirectory: string;
}>;

export type ProviderAnswerCallResult = Readonly<{
  answer: string;
  usage: ModelRunUsage;
}>;

export type ProviderAnswerCallFailureCode =
  | "provider_answer_invalid"
  | "provider_call_failed"
  | "provider_call_timeout"
  | "provider_credential_missing"
  | "provider_http_error"
  | "provider_network_error"
  | "provider_protocol_error"
  | "provider_response_too_large"
  | "provider_tool_call_unexpected";

export class ProviderAnswerCallFailure extends Error {
  readonly failureCode: ProviderAnswerCallFailureCode;
  readonly httpStatus: number | null;

  constructor(
    failureCode: ProviderAnswerCallFailureCode,
    httpStatus: number | null = null
  ) {
    super(failureCode);
    this.failureCode = failureCode;
    this.httpStatus = typeof httpStatus === "number" &&
      Number.isSafeInteger(httpStatus) &&
      httpStatus >= 100 &&
      httpStatus <= 599
      ? httpStatus
      : null;
    this.name = "ProviderAnswerCallFailure";
  }
}

export type ProviderAnswerCallInput = Readonly<{
  profile: ProviderAnswerEvalProfile;
  request: ProviderRunRequest;
  signal: AbortSignal;
  timeoutMs: typeof KNOWLEDGE_PROVIDER_ANSWER_TIMEOUT_MS;
}>;

export type ProviderAnswerExecutor = (
  input: ProviderAnswerCallInput
) => Promise<ProviderAnswerCallResult>;

type ProviderAggregate = Readonly<{
  attemptedCalls: number;
  automatedGrounding: Readonly<{
    averageCitationCoverage: number | null;
    averageCitationPrecision: number | null;
    issueCounts: Readonly<Record<string, number>>;
    outcomes: Readonly<Record<string, number>>;
  }>;
  completedCalls: number;
  estimatedCostMicros: number | null;
  failedCalls: number;
  failureDiagnostics: Readonly<{
    byCode: Readonly<Partial<Record<ProviderAnswerCallFailureCode, number>>>;
    byHttpStatus: Readonly<Record<string, number>>;
  }>;
  latencyMs: Readonly<{ p50: number | null; p95: number | null }>;
  modelId: ProviderAnswerEvalProfile["modelId"];
  provider: ProviderAnswerEvalProfile["provider"];
  skippedCalls: number;
  usage: NormalizedTokenUsage;
}>;

export type ProviderAnswerEvalReport = Readonly<{
  constraints: Readonly<{
    maxCalls: typeof KNOWLEDGE_PROVIDER_ANSWER_MAX_CALLS;
    maxOutputTokensPerCall: typeof KNOWLEDGE_PROVIDER_ANSWER_MAX_OUTPUT_TOKENS;
    plannedCalls: number;
    sequentialCalls: true;
    timeoutMsPerCall: typeof KNOWLEDGE_PROVIDER_ANSWER_TIMEOUT_MS;
  }>;
  corpus: Readonly<{
    caseCount: typeof KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT;
    corpusVersion: typeof KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION;
    languages: Readonly<{ en: 4; ru: 4 }>;
    reviewSplit: "blinded_review";
    slice: "bounded_bilingual_release_review";
  }>;
  execution: Readonly<{
    attemptedCalls: number;
    completedCalls: number;
    failedCalls: number;
    paidExecutionAuthorized: true;
    skippedCalls: number;
  }>;
  limitations: readonly string[];
  providers: readonly ProviderAggregate[];
  reportVersion: typeof KNOWLEDGE_PROVIDER_ANSWER_EVAL_VERSION;
  review: Readonly<{
    artifactsFrozenBeforeReview: true;
    citationViewerProvenance: "synthetic_projection";
    citationViewerReleaseEligible: false;
    independence: "operator_delegated_agent_review_not_independent";
    mappingSha256: string;
    outputFreezeSha256: string;
    packetItemCount: number;
    packetSha256: string;
    releaseEligibility: Readonly<{
      eligible: false;
      reasonCodes: readonly [
        "independent_human_review_not_completed",
        "synthetic_citation_viewer_projection"
      ];
    }>;
    reviewComplete: false;
    semanticReleaseProof: false;
  }>;
  status: "failed" | "review_required";
}>;

export type ProviderAnswerEvalErrorCode =
  | "knowledge_provider_answer_eval_arguments_invalid"
  | "knowledge_provider_answer_eval_execution_not_authorized"
  | "knowledge_provider_answer_eval_profile_contract_invalid"
  | "knowledge_provider_answer_eval_review_directory_invalid"
  | "knowledge_provider_answer_eval_review_directory_not_empty"
  | "knowledge_provider_answer_eval_review_directory_permissions_invalid"
  | "knowledge_provider_answer_eval_review_artifact_invalid"
  | "knowledge_provider_answer_eval_review_write_failed";

export class ProviderAnswerEvalError extends Error {
  readonly code: ProviderAnswerEvalErrorCode;

  constructor(code: ProviderAnswerEvalErrorCode) {
    super(code);
    this.code = code;
    this.name = "ProviderAnswerEvalError";
  }
}

function profileFromCatalog(input: Readonly<{
  adapterKind: CatalogAdapterKind;
  apiRoot: string;
  credentialEnvironmentName: ProviderAnswerEvalProfile["credentialEnvironmentName"];
  modelId: ProviderAnswerEvalProfile["modelId"];
  params: Readonly<Record<string, unknown>>;
  provider: ProviderAnswerEvalProfile["provider"];
}>): ProviderAnswerEvalProfile {
  const template = defaultProviderModels.find((candidate) =>
    candidate.provider === input.provider && candidate.modelId === input.modelId);
  if (
    !template ||
    template.adapterKind !== input.adapterKind ||
    template.upstreamModelId !== input.modelId ||
    template.providerFamily !== input.provider ||
    template.contextWindow === null
  ) {
    throw new ProviderAnswerEvalError(
      "knowledge_provider_answer_eval_profile_contract_invalid"
    );
  }
  return Object.freeze({
    ...input,
    capabilities: Object.freeze({
      ...template.capabilities,
      contextWindow: template.contextWindow
    })
  });
}

export function providerAnswerEvalProfiles(): readonly ProviderAnswerEvalProfile[] {
  const profiles = [
    profileFromCatalog({
      adapterKind: "openai_responses_native",
      apiRoot: "https://api.openai.com/v1",
      credentialEnvironmentName: "OPENAI_API_KEY",
      modelId: "gpt-5.5",
      params: Object.freeze({
        background: false,
        manualContextReplay: true,
        maxOutputTokens: KNOWLEDGE_PROVIDER_ANSWER_MAX_OUTPUT_TOKENS,
        reasoning: Object.freeze({ effort: "none", summary: "none" }),
        store: false,
        stream: false,
        temperature: 0
      }),
      provider: "openai"
    }),
    profileFromCatalog({
      adapterKind: "anthropic_messages",
      apiRoot: "https://api.anthropic.com/v1",
      credentialEnvironmentName: "ANTHROPIC_API_KEY",
      modelId: "claude-sonnet-5",
      params: Object.freeze({
        maxTokens: KNOWLEDGE_PROVIDER_ANSWER_MAX_OUTPUT_TOKENS,
        outputConfig: Object.freeze({ effort: "low" }),
        thinking: Object.freeze({ budgetTokens: 0, enabled: true, type: "adaptive" })
      }),
      provider: "anthropic"
    }),
    profileFromCatalog({
      adapterKind: "gemini_interactions_native",
      apiRoot: "https://generativelanguage.googleapis.com/v1",
      credentialEnvironmentName: "GEMINI_API_KEY",
      modelId: "gemini-3.6-flash",
      params: Object.freeze({
        maxTokens: KNOWLEDGE_PROVIDER_ANSWER_MAX_OUTPUT_TOKENS,
        reasoning: Object.freeze({ effort: "minimal" }),
        stream: false
      }),
      provider: "gemini"
    })
  ] as const;
  if (profiles.length * KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT !==
    KNOWLEDGE_PROVIDER_ANSWER_MAX_CALLS) {
    throw new ProviderAnswerEvalError(
      "knowledge_provider_answer_eval_profile_contract_invalid"
    );
  }
  return Object.freeze(profiles);
}

export function providerAnswerEvalExecutionSnapshot(
  profile: ProviderAnswerEvalProfile
): ProviderExecutionSnapshot {
  return {
    connection: {
      allowPrivateNetwork: false,
      apiRoot: profile.apiRoot,
      authenticationMode: "bearer",
      responseTimeoutMs: KNOWLEDGE_PROVIDER_ANSWER_TIMEOUT_MS
    },
    connectionDisplayName: `${profile.provider} provider answer evaluation`,
    connectionId: `provider-answer-eval-${profile.provider}-connection`,
    credentialId: `provider-answer-eval-${profile.provider}-credential`,
    credentialVersionId: `provider-answer-eval-${profile.provider}-credential-version`,
    model: {
      adapterKind: profile.adapterKind,
      answerSelectable: true,
      capabilities: profile.capabilities,
      defaultParams: { ...profile.params },
      modelClass: "answer",
      upstreamModelId: profile.modelId
    },
    modelDisplayName: profile.modelId,
    providerFamily: profile.provider,
    providerModelId: `provider-answer-eval-${profile.provider}-model`,
    version: 1
  };
}

export function providerAnswerEvalCases(): readonly ProviderAnswerEvalCase[] {
  const byId = new Map(knowledgeSemanticGroundingFixtures.map((fixture) => [fixture.id, fixture]));
  const cases = selectedCaseIds.map((id) => {
    const fixture = byId.get(id);
    const review = caseReviewContract[id];
    if (!fixture || fixture.split !== "blinded_review" || !review) {
      throw new ProviderAnswerEvalError(
        "knowledge_provider_answer_eval_profile_contract_invalid"
      );
    }
    return Object.freeze({
      evidence: fixture.evidence,
      expectedBehavior: review.expectedBehavior,
      id,
      language: fixture.language,
      query: review.query,
      reviewDimensions: review.reviewDimensions
    });
  });
  const languageCounts = cases.reduce((counts, candidate) => {
    counts[candidate.language] += 1;
    return counts;
  }, { en: 0, ru: 0 });
  const documentFamilies = selectedCaseIds.map((id) => byId.get(id)?.documentFamily);
  if (
    cases.length !== KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT ||
    languageCounts.en !== 4 ||
    languageCounts.ru !== 4 ||
    new Set(cases.map(({ id }) => id)).size !== cases.length ||
    documentFamilies.some((family) => !family) ||
    new Set(documentFamilies).size !== cases.length
  ) {
    throw new ProviderAnswerEvalError(
      "knowledge_provider_answer_eval_profile_contract_invalid"
    );
  }
  return Object.freeze(cases);
}

export function parseProviderAnswerEvalCli(argv: readonly string[]): ProviderAnswerEvalCliOptions {
  let executePaid = false;
  let provider: ProviderAnswerEvalProfile["provider"] | null = null;
  let reviewDirectory: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--execute-paid") {
      if (executePaid) {
        throw new ProviderAnswerEvalError(
          "knowledge_provider_answer_eval_arguments_invalid"
        );
      }
      executePaid = true;
      continue;
    }
    if (argument === "--review-dir") {
      if (reviewDirectory !== null || index + 1 >= argv.length) {
        throw new ProviderAnswerEvalError(
          "knowledge_provider_answer_eval_arguments_invalid"
        );
      }
      reviewDirectory = argv[index + 1]!;
      index += 1;
      continue;
    }
    if (argument === "--provider") {
      const value = argv[index + 1];
      if (provider !== null ||
        (value !== "openai" && value !== "anthropic" && value !== "gemini")) {
        throw new ProviderAnswerEvalError(
          "knowledge_provider_answer_eval_arguments_invalid"
        );
      }
      provider = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--provider=")) {
      const value = argument.slice("--provider=".length);
      if (provider !== null ||
        (value !== "openai" && value !== "anthropic" && value !== "gemini")) {
        throw new ProviderAnswerEvalError(
          "knowledge_provider_answer_eval_arguments_invalid"
        );
      }
      provider = value;
      continue;
    }
    if (argument.startsWith("--review-dir=")) {
      if (reviewDirectory !== null) {
        throw new ProviderAnswerEvalError(
          "knowledge_provider_answer_eval_arguments_invalid"
        );
      }
      reviewDirectory = argument.slice("--review-dir=".length);
      continue;
    }
    throw new ProviderAnswerEvalError("knowledge_provider_answer_eval_arguments_invalid");
  }
  if (!executePaid) {
    throw new ProviderAnswerEvalError(
      "knowledge_provider_answer_eval_execution_not_authorized"
    );
  }
  if (!reviewDirectory) {
    throw new ProviderAnswerEvalError("knowledge_provider_answer_eval_arguments_invalid");
  }
  return { executePaid: true, provider, reviewDirectory };
}

export async function validateProviderAnswerReviewDirectory(
  reviewDirectory: string
): Promise<string> {
  if (
    !reviewDirectory ||
    !isAbsolute(reviewDirectory) ||
    resolve(reviewDirectory) !== reviewDirectory ||
    dirname(reviewDirectory) !== "/tmp" ||
    !REVIEW_DIRECTORY_PATTERN.test(basename(reviewDirectory))
  ) {
    throw new ProviderAnswerEvalError(
      "knowledge_provider_answer_eval_review_directory_invalid"
    );
  }
  try {
    const [linkStatus, canonical] = await Promise.all([
      lstat(reviewDirectory),
      realpath(reviewDirectory)
    ]);
    if (
      canonical !== reviewDirectory ||
      linkStatus.isSymbolicLink() ||
      !linkStatus.isDirectory() ||
      (typeof process.getuid === "function" && linkStatus.uid !== process.getuid())
    ) {
      throw new ProviderAnswerEvalError(
        "knowledge_provider_answer_eval_review_directory_invalid"
      );
    }
    if ((linkStatus.mode & 0o777) !== 0o700) {
      throw new ProviderAnswerEvalError(
        "knowledge_provider_answer_eval_review_directory_permissions_invalid"
      );
    }
    if ((await readdir(reviewDirectory)).length !== 0) {
      throw new ProviderAnswerEvalError(
        "knowledge_provider_answer_eval_review_directory_not_empty"
      );
    }
  } catch (error) {
    if (error instanceof ProviderAnswerEvalError) throw error;
    throw new ProviderAnswerEvalError(
      "knowledge_provider_answer_eval_review_directory_invalid"
    );
  }
  return reviewDirectory;
}

function plannerSubquery(caseDefinition: ProviderAnswerEvalCase): KnowledgePlannerSubquery {
  return {
    exactTerms: [],
    lanes: ["semantic", "lexical"],
    ordinal: 0,
    purpose: "answer",
    query: caseDefinition.query,
    targetNames: []
  };
}

function plannerPlan(caseDefinition: ProviderAnswerEvalCase): KnowledgePlannerPlan {
  const subquery = plannerSubquery(caseDefinition);
  return {
    automaticRetrieval: true,
    coverage: {
      expectedPassageCount: caseDefinition.evidence.coverage.expectedPassageCount,
      mode: caseDefinition.evidence.coverage.mode,
      namedTargets: caseDefinition.evidence.coverage.namedTargets
    },
    evidenceMode: "fuller",
    intent: caseDefinition.evidence.originalIntent.intent,
    originalQuery: caseDefinition.query,
    rewrite: { exactTerms: [], query: caseDefinition.query },
    status: "ready",
    strategy: caseDefinition.evidence.strategy,
    subqueries: [subquery],
    version: 1
  };
}

function opaqueEvaluationCaseId(caseDefinition: ProviderAnswerEvalCase): string {
  return createHash("sha256")
    .update(`${KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION}\u0000${caseDefinition.id}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}

function retrievalEvidence(caseDefinition: ProviderAnswerEvalCase): KnowledgeRetrievalEvidence {
  const availableItems = caseDefinition.evidence.items.filter((item) =>
    item.state === "available" && typeof item.excerpt === "string");
  const opaqueCaseId = opaqueEvaluationCaseId(caseDefinition);
  const knowledgeBaseId = `review-base-${opaqueCaseId}`;
  const results: KnowledgeRetrievalEvidence["results"] = availableItems.map((item, index) => {
    const excerpt = item.excerpt!;
    const ordinal = index + 1;
    return {
      annRank: ordinal,
      baseName: "Review corpus",
      bindingOrdinal: 0,
      chunkId: `review-chunk-${opaqueCaseId}-${ordinal}`,
      chunkIndex: index,
      confidence: 1,
      ...(item.contentHash ? { contentHash: item.contentHash } : {}),
      documentId: `review-document-${opaqueCaseId}-${ordinal}`,
      documentVersionId: `review-version-${opaqueCaseId}-${ordinal}`,
      documentVersionNumber: item.sourceVersionNumber ?? 1,
      fileName: `review-source-${ordinal}.md`,
      ftsRank: ordinal,
      ftsScore: 1,
      fusedScore: 2 / (61 + index),
      handle: item.handle,
      headingPath: item.headingPath,
      includedText: excerpt,
      includedTextBytes: Buffer.byteLength(excerpt, "utf8"),
      knowledgeBaseId,
      ...(item.contextBoundaries?.layoutKind
        ? { layoutKind: item.contextBoundaries.layoutKind }
        : {}),
      page: item.locator?.page ?? 1,
      sectionId: `review-section-${opaqueCaseId}-${ordinal}`,
      sourceAlias: `S${ordinal}`,
      sourceArtifactId: `review-artifact-${opaqueCaseId}-${ordinal}`,
      sourceName: `Review source ${ordinal}`,
      sourceTextBytes: item.contextBoundaries?.sourceTextBytes ??
        Buffer.byteLength(excerpt, "utf8"),
      textTruncated: item.textTruncated ?? false,
      vectorDistance: 0.1,
      vectorScore: 0.9
    };
  });
  const draft: KnowledgeRetrievalEvidence = {
    bases: [{
      baseContentRevision: 1,
      baseName: "Review corpus",
      candidateCount: results.length,
      indexedContentRevision: 1,
      indexGenerationId: `review-index-${opaqueCaseId}`,
      knowledgeBaseId,
      ordinal: 0,
      state: "ready",
      targetDimension: 1024,
      vectorSpaceFingerprint: "a".repeat(64)
    }],
    candidateCount: results.length,
    candidateLimit: 40,
    durationMs: 0,
    embeddingExecutions: [{
      bindingOrdinals: [0],
      durationMs: 0,
      inputTokens: 0,
      modelId: "generated-semantic-benchmark-embedding",
      provider: "synthetic",
      providerModelId: "generated-semantic-benchmark-embedding-model",
      requestId: null,
      status: "complete",
      totalTokens: 0
    }],
    fusion: "rrf_k60",
    invocationOrdinal: 1,
    outcome: "complete",
    postRerankOrder: null,
    preRerankOrder: null,
    providerText: "pending",
    query: caseDefinition.query,
    rerankerBinding: null,
    resultLimit: 8,
    results,
    scopeAliases: availableItems.map((_item, index) => ({
      alias: `S${index + 1}`,
      kind: "source" as const,
      label: `Review source ${index + 1}`
    })),
    threshold: 0.01,
    version: KNOWLEDGE_RESULT_VERSION
  };
  return { ...draft, providerText: knowledgeToolResultText(draft) };
}

function retrievalToolResult(value: KnowledgeRetrievalEvidence): ToolExecutionResult {
  return {
    callId: "knowledge-planner-v1-1",
    content: knowledgeToolResultContent(value),
    name: "retrieve_knowledge",
    rawPreview: {
      knowledgeResultVersion: KNOWLEDGE_RESULT_VERSION,
      knowledgeRetrieval: value,
      providerCall: true
    },
    status: "complete"
  };
}

export function buildProviderAnswerEvalRequest(
  profile: ProviderAnswerEvalProfile,
  caseDefinition: ProviderAnswerEvalCase
): ProviderRunRequest {
  const plan = plannerPlan(caseDefinition);
  const opaqueCaseId = opaqueEvaluationCaseId(caseDefinition);
  const knowledgeBaseId = `review-base-${opaqueCaseId}`;
  const request: ProviderRunRequest = {
    attachmentIds: [],
    attachments: [],
    chatId: `knowledge-provider-answer-eval-${opaqueCaseId}`,
    content: { blocks: [{ text: caseDefinition.query, type: "text" }] },
    context: {
      messages: [{
        content: { blocks: [{ text: caseDefinition.query, type: "text" }] },
        id: "current-user-message",
        role: "user"
      }],
      mode: "branch_path"
    },
    forceNonStreaming: true,
    knowledgePlan: {
      baseIds: [knowledgeBaseId],
      mode: "explicit",
      sourceIds: [],
      version: 1
    },
    knowledgePlanner: plan,
    modelCapabilities: profile.capabilities,
    modelId: profile.modelId,
    parallelToolCalls: false,
    params: { ...profile.params },
    prompt: { developer: null, system: SYSTEM_INSTRUCTION },
    provider: profile.provider,
    searchPlan: { mode: "all_selected", options: [] },
    toolChoice: "none",
    toolMode: "none",
    tools: []
  };
  const message = caseDefinition.evidence.items.some((item) =>
    item.state === "available" && typeof item.excerpt === "string")
    ? automaticKnowledgeEvidenceMessage({
        branches: [{
          result: retrievalToolResult(retrievalEvidence(caseDefinition)),
          subquery: plan.subqueries[0]!
        }],
        plan,
        request
      })
    : unavailableKnowledgeEvidenceMessage();
  return withAutomaticKnowledgeEvidence(request, message);
}

function stableNumber(value: number): number {
  return Number(value.toFixed(6));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return record(value) && Object.keys(value).sort().join("\u0000") ===
    [...keys].sort().join("\u0000");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new ProviderAnswerEvalError(
      "knowledge_provider_answer_eval_review_artifact_invalid"
    );
  }
  return serialized;
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function reviewMimeType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".csv")) return "text/csv";
  return "text/plain";
}

/**
 * Projects the exact provider-visible evidence item through the same bounded,
 * client-safe citation-viewer contract used by the product. The release
 * packet deliberately carries this projection in addition to the local
 * excerpt: a raw evidence row is not proof that the cited material is usable
 * in the viewer reviewers are asked to judge.
 */
function citationViewerArtifact(
  item: KnowledgeEvidencePackageItem,
  displayOrdinal: number
): KnowledgeCitationViewer {
  if (item.state === "deleted") return { handle: item.handle, state: "deleted" };
  const excerpt = item.excerpt;
  const page = item.locator?.page;
  const fileName = item.fileName;
  const sourceName = item.sourceName;
  const versionNumber = item.sourceVersionNumber;
  if (!excerpt || !page || page < 1 || !fileName || !sourceName || !versionNumber) {
    throw new ProviderAnswerEvalError(
      "knowledge_provider_answer_eval_review_artifact_invalid"
    );
  }
  const boundingBoxes = (item.locator?.blockCoordinates ?? []).map((box) => ({
    bottom: box.y + box.height,
    coordinateOrigin: "top_left" as const,
    left: box.x,
    page: box.page,
    right: box.x + box.width,
    top: box.y
  }));
  const candidate: KnowledgeCitationViewer = {
    blocks: [{
      boundingBoxes,
      headingPath: [...item.headingPath],
      pageEnd: page,
      pageStart: page,
      relation: "target",
      table: null,
      text: excerpt,
      type: "paragraph"
    }],
    excerpt,
    excerptTruncated: item.textTruncated ?? false,
    handle: item.handle,
    headingPath: [...item.headingPath],
    locator: { boundingBoxes, pageEnd: page, pageStart: page },
    originalKind: null,
    source: {
      baseName: item.baseName,
      fileName: `review-source-${displayOrdinal}.md`,
      mimeType: reviewMimeType(fileName),
      name: sourceName,
      statuses: [],
      versionNumber
    },
    state: "available",
    visual: null,
    workbook: null
  };
  const decoded = decodeKnowledgeCitationViewer(candidate);
  if (!decoded) {
    throw new ProviderAnswerEvalError(
      "knowledge_provider_answer_eval_review_artifact_invalid"
    );
  }
  return decoded;
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? null;
}

function shuffle<T>(values: readonly T[], randomIndex: (maximum: number) => number): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = randomIndex(index + 1);
    if (!Number.isSafeInteger(target) || target < 0 || target > index) {
      throw new ProviderAnswerEvalError(
        "knowledge_provider_answer_eval_review_write_failed"
      );
    }
    [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
  }
  return shuffled;
}

async function boundedProviderCall(
  executor: ProviderAnswerExecutor,
  input: Omit<ProviderAnswerCallInput, "signal" | "timeoutMs">
): Promise<ProviderAnswerCallResult> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new ProviderAnswerCallFailure("provider_call_timeout"));
    }, KNOWLEDGE_PROVIDER_ANSWER_TIMEOUT_MS);
    timeout.unref?.();
  });
  try {
    return await Promise.race([
      executor({
        ...input,
        signal: controller.signal,
        timeoutMs: KNOWLEDGE_PROVIDER_ANSWER_TIMEOUT_MS
      }),
      timeoutPromise
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type CompletedCall = Readonly<{
  answer: string;
  caseDefinition: ProviderAnswerEvalCase;
  grounding: KnowledgeGroundingResult;
  latencyMs: number;
  profile: ProviderAnswerEvalProfile;
  reviewId: string;
  usage: ModelRunUsage;
}>;

type FailedCall = Readonly<{
  caseId: SelectedCaseId;
  failureCode: ProviderAnswerCallFailureCode;
  httpStatus: number | null;
  latencyMs: number;
  modelId: ProviderAnswerEvalProfile["modelId"];
  provider: ProviderAnswerEvalProfile["provider"];
}>;

type SkippedCall = Readonly<{
  caseId: SelectedCaseId;
  modelId: ProviderAnswerEvalProfile["modelId"];
  provider: ProviderAnswerEvalProfile["provider"];
}>;

function providerAggregates(
  profiles: readonly ProviderAnswerEvalProfile[],
  completed: readonly CompletedCall[],
  failed: readonly FailedCall[],
  skipped: readonly SkippedCall[]
): ProviderAggregate[] {
  return profiles.map((profile) => {
    const successful = completed.filter((call) => call.profile.provider === profile.provider);
    const failures = failed.filter((call) => call.provider === profile.provider);
    const skippedCalls = skipped.filter((call) => call.provider === profile.provider).length;
    const failureCodes: Partial<Record<ProviderAnswerCallFailureCode, number>> = {};
    const failureHttpStatuses: Record<string, number> = {};
    for (const failure of failures) {
      failureCodes[failure.failureCode] = (failureCodes[failure.failureCode] ?? 0) + 1;
      if (failure.httpStatus !== null) {
        const status = String(failure.httpStatus);
        failureHttpStatuses[status] = (failureHttpStatuses[status] ?? 0) + 1;
      }
    }
    const issueCounts: Record<string, number> = {};
    const outcomes: Record<string, number> = {};
    for (const call of successful) {
      outcomes[call.grounding.outcome] = (outcomes[call.grounding.outcome] ?? 0) + 1;
      for (const code of call.grounding.diagnostics.issueCodes) {
        issueCounts[code] = (issueCounts[code] ?? 0) + 1;
      }
    }
    const estimatedCosts = successful.flatMap(({ usage }) =>
      typeof usage.estimatedCostMicros === "number" &&
      Number.isFinite(usage.estimatedCostMicros)
        ? [usage.estimatedCostMicros]
        : []);
    const average = (values: readonly number[]) => values.length > 0
      ? stableNumber(values.reduce((total, value) => total + value, 0) / values.length)
      : null;
    const latencies = [
      ...successful.map(({ latencyMs }) => latencyMs),
      ...failures.map(({ latencyMs }) => latencyMs)
    ];
    return {
      attemptedCalls: successful.length + failures.length,
      automatedGrounding: {
        averageCitationCoverage: average(successful.map((call) =>
          call.grounding.diagnostics.citationCoverage)),
        averageCitationPrecision: average(successful.map((call) =>
          call.grounding.diagnostics.citationPrecision)),
        issueCounts,
        outcomes
      },
      completedCalls: successful.length,
      estimatedCostMicros: estimatedCosts.length > 0
        ? stableNumber(estimatedCosts.reduce((total, value) => total + value, 0))
        : null,
      failedCalls: failures.length,
      failureDiagnostics: {
        byCode: failureCodes,
        byHttpStatus: failureHttpStatuses
      },
      latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
      modelId: profile.modelId,
      provider: profile.provider,
      skippedCalls,
      usage: sumTokenUsage(successful.map(({ usage }) => usage))
    };
  });
}

type ReviewSourceLocalEvidence = Readonly<{
  baseName: string | null;
  contentHash: string | null;
  contextBoundaries: KnowledgeEvidencePackageItem["contextBoundaries"];
  excerpt: string | null;
  handle: string;
  headingPath: readonly string[];
  locator: KnowledgeEvidencePackageItem["locator"];
  sourceName: string | null;
  sourceVersionNumber: number | null;
  state: KnowledgeEvidencePackageItem["state"];
  textTruncated: boolean | null;
}>;

export type ProviderAnswerCitationViewerArtifact =
  | Readonly<{
      provenance: "persisted_route";
      releaseEvidenceEligible: true;
      viewer: KnowledgeCitationViewer;
    }>
  | Readonly<{
      provenance: "synthetic_projection";
      releaseEvidenceEligible: false;
      viewer: KnowledgeCitationViewer;
    }>;

export type ProviderAnswerReviewPacket = Readonly<{
  artifactType: "knowledge_answer_review_packet";
  artifactVersion: typeof KNOWLEDGE_PROVIDER_ANSWER_REVIEW_VERSION;
  identityBlinding: Readonly<{
    candidateIdentityHidden: true;
    caseIdentityHidden: true;
    expectedBehaviorHidden: true;
    implementationAuthorHidden: true;
    splitMappingHidden: true;
  }>;
  items: readonly Readonly<{
    answer: string;
    citationViewerArtifacts: readonly ProviderAnswerCitationViewerArtifact[];
    evidenceReceiptSha256: string;
    language: KnowledgeSemanticGroundingLanguage;
    outputSha256: string;
    query: string;
    reviewDimensions: readonly ReviewDimension[];
    reviewId: string;
    sourceLocalEvidence: readonly ReviewSourceLocalEvidence[];
  }>[];
  packetSha256: string;
  reviewContract: Readonly<{
    decisionValues: readonly ["pass", "fail", "uncertain"];
    independence: "independent_human_attestation_required";
    requiredDimensions: readonly ReviewDimension[];
  }>;
}>;

export type ProviderAnswerReviewMapping = Readonly<{
  artifactType: "knowledge_answer_review_mapping";
  artifactVersion: typeof KNOWLEDGE_PROVIDER_ANSWER_REVIEW_VERSION;
  corpusVersion: typeof KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION;
  entries: readonly (
    | Readonly<{
        automatedGrounding: Readonly<{
          citationCoverage: number;
          citationPrecision: number;
          issueCodes: readonly string[];
          outcome: KnowledgeGroundingResult["outcome"];
          repairCount: number;
        }>;
        caseId: SelectedCaseId;
        expectedBehavior: ProviderAnswerExpectedBehavior;
        language: KnowledgeSemanticGroundingLanguage;
        latencyMs: number;
        modelId: ProviderAnswerEvalProfile["modelId"];
        outputSha256: string;
        provider: ProviderAnswerEvalProfile["provider"];
        reviewId: string;
        status: "complete";
        usage: ModelRunUsage;
      }>
    | Readonly<{
        caseId: SelectedCaseId;
        failureCode: ProviderAnswerCallFailureCode;
        httpStatus: number | null;
        latencyMs: number;
        modelId: ProviderAnswerEvalProfile["modelId"];
        provider: ProviderAnswerEvalProfile["provider"];
        reviewId: null;
        status: "failed";
      }>
    | Readonly<{
        caseId: SelectedCaseId;
        modelId: ProviderAnswerEvalProfile["modelId"];
        provider: ProviderAnswerEvalProfile["provider"];
        reviewId: null;
        status: "skipped_after_provider_failure";
      }>
  )[];
  mappingSha256: string;
  packetSha256: string;
  reviewSplit: "blinded_review";
}>;

export type ProviderAnswerOutputFreeze = Readonly<{
  artifactType: "knowledge_answer_output_freeze";
  artifactVersion: typeof KNOWLEDGE_PROVIDER_ANSWER_REVIEW_VERSION;
  corpusVersion: typeof KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION;
  freezeSha256: string;
  mappingSha256: string;
  outputCount: number;
  outputs: readonly Readonly<{
    outputSha256: string;
    reviewId: string;
  }>[];
  packetSha256: string;
  reviewSplit: "blinded_review";
}>;

type ProviderAnswerReviewPacketItem = ProviderAnswerReviewPacket["items"][number];

function invalidReviewArtifact(): never {
  throw new ProviderAnswerEvalError(
    "knowledge_provider_answer_eval_review_artifact_invalid"
  );
}

function sha256Value(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function packetItemBody(
  item: ProviderAnswerReviewPacketItem
): Omit<ProviderAnswerReviewPacketItem, "outputSha256"> {
  const { outputSha256: _outputSha256, ...body } = item;
  return body;
}

/**
 * Verifies the complete pre-review chain. A reviewer submission can safely
 * pin `freezeSha256`; that one value commits the generated outputs, their
 * product-shape citation viewers, the blinded packet, and the private
 * provider/case mapping.
 */
type ProviderAnswerReviewArtifactChain = Readonly<{
  freeze: ProviderAnswerOutputFreeze;
  mapping: ProviderAnswerReviewMapping;
  packet: ProviderAnswerReviewPacket;
}>;

function assertProviderAnswerReviewArtifactChainInternal(
  input: ProviderAnswerReviewArtifactChain
): void {
  const { freeze, mapping, packet } = input;
  const { packetSha256, ...packetBody } = packet;
  const { mappingSha256, ...mappingBody } = mapping;
  const { freezeSha256, ...freezeBody } = freeze;
  if (
    !exactKeys(packet, [
      "artifactType", "artifactVersion", "identityBlinding", "items", "packetSha256",
      "reviewContract"
    ]) ||
    !exactKeys(packet.identityBlinding, [
      "candidateIdentityHidden", "caseIdentityHidden", "expectedBehaviorHidden",
      "implementationAuthorHidden", "splitMappingHidden"
    ]) ||
    !exactKeys(packet.reviewContract, [
      "decisionValues", "independence", "requiredDimensions"
    ]) ||
    !exactKeys(mapping, [
      "artifactType", "artifactVersion", "corpusVersion", "entries", "mappingSha256",
      "packetSha256", "reviewSplit"
    ]) ||
    !exactKeys(freeze, [
      "artifactType", "artifactVersion", "corpusVersion", "freezeSha256", "mappingSha256",
      "outputCount", "outputs", "packetSha256", "reviewSplit"
    ]) ||
    !freeze.outputs.every((output) => exactKeys(output, ["outputSha256", "reviewId"])) ||
    packet.artifactType !== "knowledge_answer_review_packet" ||
    mapping.artifactType !== "knowledge_answer_review_mapping" ||
    freeze.artifactType !== "knowledge_answer_output_freeze" ||
    packet.artifactVersion !== KNOWLEDGE_PROVIDER_ANSWER_REVIEW_VERSION ||
    mapping.artifactVersion !== KNOWLEDGE_PROVIDER_ANSWER_REVIEW_VERSION ||
    freeze.artifactVersion !== KNOWLEDGE_PROVIDER_ANSWER_REVIEW_VERSION ||
    mapping.corpusVersion !== KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION ||
    freeze.corpusVersion !== KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION ||
    mapping.reviewSplit !== "blinded_review" ||
    freeze.reviewSplit !== "blinded_review" ||
    !sha256Value(packetSha256) || canonicalSha256(packetBody) !== packetSha256 ||
    !sha256Value(mappingSha256) || canonicalSha256(mappingBody) !== mappingSha256 ||
    !sha256Value(freezeSha256) || canonicalSha256(freezeBody) !== freezeSha256 ||
    mapping.packetSha256 !== packetSha256 ||
    freeze.packetSha256 !== packetSha256 ||
    freeze.mappingSha256 !== mappingSha256 ||
    packet.identityBlinding.candidateIdentityHidden !== true ||
    packet.identityBlinding.caseIdentityHidden !== true ||
    packet.identityBlinding.expectedBehaviorHidden !== true ||
    packet.identityBlinding.implementationAuthorHidden !== true ||
    packet.identityBlinding.splitMappingHidden !== true ||
    packet.reviewContract.independence !== "independent_human_attestation_required" ||
    canonicalJson(packet.reviewContract.decisionValues) !==
      canonicalJson(["pass", "fail", "uncertain"]) ||
    canonicalJson(packet.reviewContract.requiredDimensions) !==
      canonicalJson(releaseReviewDimensions)
  ) invalidReviewArtifact();

  const packetByReviewId = new Map<string, ProviderAnswerReviewPacketItem>();
  for (const item of packet.items) {
    if (!exactKeys(item, [
      "answer", "citationViewerArtifacts", "evidenceReceiptSha256", "language",
      "outputSha256", "query", "reviewDimensions", "reviewId", "sourceLocalEvidence"
    ]) ||
      !item.sourceLocalEvidence.every((evidence) => exactKeys(evidence, [
        "baseName", "contentHash", "contextBoundaries", "excerpt", "handle", "headingPath",
        "locator", "sourceName", "sourceVersionNumber", "state", "textTruncated"
      ])) ||
      !item.citationViewerArtifacts.every((artifact) => exactKeys(artifact, [
        "provenance", "releaseEvidenceEligible", "viewer"
      ])) ||
      typeof item.answer !== "string" || !item.answer ||
      Buffer.byteLength(item.answer, "utf8") > MAX_CAPTURED_ANSWER_BYTES ||
      typeof item.query !== "string" || !item.query || item.query.length > 4_096 ||
      (item.language !== "en" && item.language !== "ru") ||
      !/^[A-Za-z0-9_-]{8,96}$/u.test(item.reviewId) ||
      packetByReviewId.has(item.reviewId) ||
      !sha256Value(item.outputSha256) ||
      canonicalSha256(packetItemBody(item)) !== item.outputSha256 ||
      canonicalJson(item).includes("blind-release-") ||
      !sha256Value(item.evidenceReceiptSha256) ||
      canonicalJson(item.reviewDimensions) !== canonicalJson(releaseReviewDimensions) ||
      item.citationViewerArtifacts.length !== item.sourceLocalEvidence.length) {
      invalidReviewArtifact();
    }
    for (let index = 0; index < item.citationViewerArtifacts.length; index += 1) {
      const artifact = item.citationViewerArtifacts[index];
      const evidence = item.sourceLocalEvidence[index];
      const viewer = artifact && decodeKnowledgeCitationViewer(artifact.viewer);
      if (!artifact || !viewer || !evidence || viewer.handle !== evidence.handle ||
        canonicalJson(viewer) !== canonicalJson(artifact.viewer) ||
        viewer.state !== evidence.state ||
        (artifact.provenance !== "synthetic_projection" &&
          artifact.provenance !== "persisted_route") ||
        (artifact.provenance === "synthetic_projection" &&
          artifact.releaseEvidenceEligible !== false) ||
        (artifact.provenance === "persisted_route" &&
          artifact.releaseEvidenceEligible !== true)) invalidReviewArtifact();
      if (viewer.state === "available" && (
        evidence.excerpt === null || viewer.excerpt !== evidence.excerpt ||
        viewer.headingPath.join("\u0000") !== evidence.headingPath.join("\u0000") ||
        viewer.locator.pageStart !== evidence.locator?.page ||
        viewer.source.baseName !== evidence.baseName ||
        viewer.source.name !== evidence.sourceName ||
        viewer.source.versionNumber !== evidence.sourceVersionNumber
      )) invalidReviewArtifact();
    }
    const viewerHandles = new Set(item.citationViewerArtifacts.map(({ viewer }) =>
      viewer.handle));
    if (viewerHandles.size !== item.citationViewerArtifacts.length ||
      knowledgeCitationHandlesFromText(item.answer).some((handle) =>
      !viewerHandles.has(handle))) {
      invalidReviewArtifact();
    }
    packetByReviewId.set(item.reviewId, item);
  }

  const completeEntries = mapping.entries.filter((entry) => entry.status === "complete");
  if (mapping.entries.some((entry) => entry.status === "complete"
    ? !exactKeys(entry, [
        "automatedGrounding", "caseId", "expectedBehavior", "language", "latencyMs",
        "modelId", "outputSha256", "provider", "reviewId", "status", "usage"
      ]) || !exactKeys(entry.automatedGrounding, [
        "citationCoverage", "citationPrecision", "issueCodes", "outcome", "repairCount"
      ])
    : entry.status === "failed"
      ? !exactKeys(entry, [
          "caseId", "failureCode", "httpStatus", "latencyMs", "modelId", "provider",
          "reviewId", "status"
        ])
      : entry.status !== "skipped_after_provider_failure" || !exactKeys(entry, [
          "caseId", "modelId", "provider", "reviewId", "status"
        ]))) invalidReviewArtifact();
  const selectedIdSet = new Set<string>(selectedCaseIds);
  const expectedModels = new Map<ProviderAnswerEvalProfile["provider"], string>([
    ["anthropic", "claude-sonnet-5"],
    ["gemini", "gemini-3.6-flash"],
    ["openai", "gpt-5.5"]
  ]);
  if (mapping.entries.some((entry) =>
    !selectedIdSet.has(entry.caseId) ||
    expectedModels.get(entry.provider) !== entry.modelId) ||
    new Set(mapping.entries.map((entry) => `${entry.provider}\u0000${entry.caseId}`)).size !==
      mapping.entries.length) invalidReviewArtifact();
  for (const provider of new Set(mapping.entries.map((entry) => entry.provider))) {
    const providerEntries = mapping.entries.filter((entry) => entry.provider === provider);
    if (providerEntries.length !== selectedCaseIds.length ||
      new Set(providerEntries.map((entry) => entry.caseId)).size !== selectedCaseIds.length) {
      invalidReviewArtifact();
    }
  }
  if (completeEntries.length !== packet.items.length ||
    new Set(completeEntries.map(({ reviewId }) => reviewId)).size !== completeEntries.length) {
    invalidReviewArtifact();
  }
  for (const entry of completeEntries) {
    const packetItem = packetByReviewId.get(entry.reviewId);
    if (!packetItem || !sha256Value(entry.outputSha256) ||
      entry.outputSha256 !== packetItem.outputSha256) invalidReviewArtifact();
  }

  const expectedOutputs = completeEntries
    .map(({ outputSha256, reviewId }) => ({ outputSha256, reviewId }))
    .sort((left, right) => left.reviewId.localeCompare(right.reviewId));
  if (freeze.outputCount !== expectedOutputs.length ||
    canonicalJson(freeze.outputs) !== canonicalJson(expectedOutputs)) {
    invalidReviewArtifact();
  }
}

export function assertProviderAnswerReviewArtifactChain(
  input: unknown
): asserts input is ProviderAnswerReviewArtifactChain {
  try {
    if (!record(input) || !record(input.freeze) || !record(input.mapping) ||
      !record(input.packet)) invalidReviewArtifact();
    assertProviderAnswerReviewArtifactChainInternal(
      input as unknown as ProviderAnswerReviewArtifactChain
    );
  } catch (error) {
    if (error instanceof ProviderAnswerEvalError) throw error;
    invalidReviewArtifact();
  }
}

function sourceLocalEvidence(
  item: KnowledgeEvidencePackageItem
): ReviewSourceLocalEvidence {
  return {
    baseName: item.baseName,
    contentHash: item.contentHash,
    contextBoundaries: item.contextBoundaries,
    excerpt: item.excerpt,
    handle: item.handle,
    headingPath: [...item.headingPath],
    locator: item.locator,
    sourceName: item.sourceName,
    sourceVersionNumber: item.sourceVersionNumber,
    state: item.state,
    textTruncated: item.textTruncated
  };
}

function createProviderAnswerReviewArtifacts(input: Readonly<{
  completed: readonly CompletedCall[];
  failed: readonly FailedCall[];
  randomIndex: (maximum: number) => number;
  skipped: readonly SkippedCall[];
}>): Readonly<{
  freeze: ProviderAnswerOutputFreeze;
  mapping: ProviderAnswerReviewMapping;
  packet: ProviderAnswerReviewPacket;
}> {
  const unshuffledItems = input.completed.map((call): ProviderAnswerReviewPacketItem => {
    const body: Omit<ProviderAnswerReviewPacketItem, "outputSha256"> = {
      answer: call.grounding.finalText,
      citationViewerArtifacts: call.caseDefinition.evidence.items.map((item, index) => ({
        provenance: "synthetic_projection" as const,
        releaseEvidenceEligible: false,
        viewer: citationViewerArtifact(item, index + 1)
      })),
      evidenceReceiptSha256: knowledgeEvidenceReceiptHash(call.caseDefinition.evidence),
      language: call.caseDefinition.language,
      query: call.caseDefinition.query,
      reviewDimensions: releaseReviewDimensions,
      reviewId: call.reviewId,
      sourceLocalEvidence: call.caseDefinition.evidence.items.map(sourceLocalEvidence)
    };
    return { ...body, outputSha256: canonicalSha256(body) };
  });
  const packetBody: Omit<ProviderAnswerReviewPacket, "packetSha256"> = {
    artifactType: "knowledge_answer_review_packet",
    artifactVersion: KNOWLEDGE_PROVIDER_ANSWER_REVIEW_VERSION,
    identityBlinding: {
      candidateIdentityHidden: true,
      caseIdentityHidden: true,
      expectedBehaviorHidden: true,
      implementationAuthorHidden: true,
      splitMappingHidden: true
    },
    items: shuffle(unshuffledItems, input.randomIndex),
    reviewContract: {
      decisionValues: ["pass", "fail", "uncertain"],
      independence: "independent_human_attestation_required",
      requiredDimensions: releaseReviewDimensions
    }
  };
  const packet: ProviderAnswerReviewPacket = {
    ...packetBody,
    packetSha256: canonicalSha256(packetBody)
  };
  const outputByReviewId = new Map(unshuffledItems.map((item) => [
    item.reviewId,
    item.outputSha256
  ]));
  const mappingBody: Omit<ProviderAnswerReviewMapping, "mappingSha256"> = {
    artifactType: "knowledge_answer_review_mapping",
    artifactVersion: KNOWLEDGE_PROVIDER_ANSWER_REVIEW_VERSION,
    corpusVersion: KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION,
    entries: [
      ...input.completed.map((call) => ({
        automatedGrounding: {
          citationCoverage: call.grounding.diagnostics.citationCoverage,
          citationPrecision: call.grounding.diagnostics.citationPrecision,
          issueCodes: call.grounding.diagnostics.issueCodes,
          outcome: call.grounding.outcome,
          repairCount: call.grounding.repairCount
        },
        caseId: call.caseDefinition.id,
        expectedBehavior: call.caseDefinition.expectedBehavior,
        language: call.caseDefinition.language,
        latencyMs: call.latencyMs,
        modelId: call.profile.modelId,
        outputSha256: outputByReviewId.get(call.reviewId)!,
        provider: call.profile.provider,
        reviewId: call.reviewId,
        status: "complete" as const,
        usage: call.usage
      })),
      ...input.failed.map((call) => ({
        ...call,
        reviewId: null,
        status: "failed" as const
      })),
      ...input.skipped.map((call) => ({
        ...call,
        reviewId: null,
        status: "skipped_after_provider_failure" as const
      }))
    ],
    packetSha256: packet.packetSha256,
    reviewSplit: "blinded_review"
  };
  const mapping: ProviderAnswerReviewMapping = {
    ...mappingBody,
    mappingSha256: canonicalSha256(mappingBody)
  };
  const freezeBody: Omit<ProviderAnswerOutputFreeze, "freezeSha256"> = {
    artifactType: "knowledge_answer_output_freeze",
    artifactVersion: KNOWLEDGE_PROVIDER_ANSWER_REVIEW_VERSION,
    corpusVersion: KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION,
    mappingSha256: mapping.mappingSha256,
    outputCount: unshuffledItems.length,
    outputs: unshuffledItems
      .map(({ outputSha256, reviewId }) => ({ outputSha256, reviewId }))
      .sort((left, right) => left.reviewId.localeCompare(right.reviewId)),
    packetSha256: packet.packetSha256,
    reviewSplit: "blinded_review"
  };
  const freeze: ProviderAnswerOutputFreeze = {
    ...freezeBody,
    freezeSha256: canonicalSha256(freezeBody)
  };
  assertProviderAnswerReviewArtifactChain({ freeze, mapping, packet });
  return { freeze, mapping, packet };
}

export function createPersistedProviderAnswerReviewArtifacts(input: Readonly<{
  completed: readonly Readonly<{
    answer: string;
    automatedGrounding?: Extract<
      ProviderAnswerReviewMapping["entries"][number],
      { status: "complete" }
    >["automatedGrounding"];
    caseDefinition: ProviderAnswerEvalCase;
    citationViewerArtifacts: readonly ProviderAnswerCitationViewerArtifact[];
    grounding: KnowledgeGroundingResult;
    latencyMs: number;
    profile: ProviderAnswerEvalProfile;
    reviewId: string;
    usage: ModelRunUsage;
  }>[];
  randomIndex?: (maximum: number) => number;
}>): Readonly<{
  freeze: ProviderAnswerOutputFreeze;
  mapping: ProviderAnswerReviewMapping;
  packet: ProviderAnswerReviewPacket;
}> {
  if (input.completed.some((call) =>
    call.citationViewerArtifacts.length !== call.caseDefinition.evidence.items.length ||
    call.citationViewerArtifacts.some((artifact) =>
      artifact.provenance !== "persisted_route" ||
      artifact.releaseEvidenceEligible !== true))) {
    invalidReviewArtifact();
  }
  const randomIndex = input.randomIndex ?? randomInt;
  const base = createProviderAnswerReviewArtifacts({
    completed: input.completed,
    failed: [],
    randomIndex,
    skipped: []
  });
  const viewersByReviewId = new Map(input.completed.map((call) => [
    call.reviewId,
    call.citationViewerArtifacts
  ]));
  const { packetSha256: _oldPacketSha256, ...oldPacketBody } = base.packet;
  const packetItems = oldPacketBody.items.map((item) => {
    const citationViewerArtifacts = viewersByReviewId.get(item.reviewId) ??
      invalidReviewArtifact();
    return {
      ...item,
      citationViewerArtifacts,
      sourceLocalEvidence: item.sourceLocalEvidence.map((evidence, index) => {
        const viewer = citationViewerArtifacts[index]?.viewer;
        return viewer?.state === "available"
          ? {
              ...evidence,
              baseName: viewer.source.baseName,
              sourceName: viewer.source.name,
              sourceVersionNumber: viewer.source.versionNumber
            }
          : evidence;
      })
    };
  }).map((item) => {
    const body = packetItemBody(item);
    return { ...body, outputSha256: canonicalSha256(body) };
  });
  const packetBody: Omit<ProviderAnswerReviewPacket, "packetSha256"> = {
    ...oldPacketBody,
    items: packetItems
  };
  const packet: ProviderAnswerReviewPacket = {
    ...packetBody,
    packetSha256: canonicalSha256(packetBody)
  };
  const outputByReviewId = new Map(packetItems.map((item) => [
    item.reviewId,
    item.outputSha256
  ]));
  const automatedGroundingByReviewId = new Map(input.completed.flatMap((call) =>
    call.automatedGrounding
      ? [[call.reviewId, call.automatedGrounding] as const]
      : []));
  const mappingEntries = base.mapping.entries.map((entry) => entry.status === "complete"
    ? {
        ...entry,
        automatedGrounding: automatedGroundingByReviewId.get(entry.reviewId) ??
          entry.automatedGrounding,
        outputSha256: outputByReviewId.get(entry.reviewId) ?? invalidReviewArtifact()
      }
    : entry);
  const { mappingSha256: _oldMappingSha256, ...oldMappingBody } = base.mapping;
  const mappingBody: Omit<ProviderAnswerReviewMapping, "mappingSha256"> = {
    ...oldMappingBody,
    entries: mappingEntries,
    packetSha256: packet.packetSha256
  };
  const mapping: ProviderAnswerReviewMapping = {
    ...mappingBody,
    mappingSha256: canonicalSha256(mappingBody)
  };
  const outputs = packetItems
    .map(({ outputSha256, reviewId }) => ({ outputSha256, reviewId }))
    .sort((left, right) => left.reviewId.localeCompare(right.reviewId));
  const { freezeSha256: _oldFreezeSha256, ...oldFreezeBody } = base.freeze;
  const freezeBody: Omit<ProviderAnswerOutputFreeze, "freezeSha256"> = {
    ...oldFreezeBody,
    mappingSha256: mapping.mappingSha256,
    outputCount: outputs.length,
    outputs,
    packetSha256: packet.packetSha256
  };
  const freeze: ProviderAnswerOutputFreeze = {
    ...freezeBody,
    freezeSha256: canonicalSha256(freezeBody)
  };
  assertProviderAnswerReviewArtifactChain({ freeze, mapping, packet });
  return { freeze, mapping, packet };
}

async function writePrivateArtifact(path: string, value: unknown): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await chmod(path, 0o600);
    const fileStatus = await stat(path);
    if (!fileStatus.isFile() || (fileStatus.mode & 0o777) !== 0o600) {
      throw new Error("private_artifact_permissions_invalid");
    }
  } catch {
    throw new ProviderAnswerEvalError("knowledge_provider_answer_eval_review_write_failed");
  }
}

export async function writeProviderAnswerReviewArtifacts(input: Readonly<{
  freeze: ProviderAnswerOutputFreeze;
  mapping: ProviderAnswerReviewMapping;
  packet: ProviderAnswerReviewPacket;
  reviewDirectory: string;
}>): Promise<void> {
  await validateProviderAnswerReviewDirectory(input.reviewDirectory);
  assertProviderAnswerReviewArtifactChain(input);
  await writePrivateArtifact(
    resolve(input.reviewDirectory, KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE),
    input.packet
  );
  await writePrivateArtifact(
    resolve(input.reviewDirectory, KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE),
    input.mapping
  );
  await writePrivateArtifact(
    resolve(input.reviewDirectory, KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE),
    input.freeze
  );
}

export async function runProviderAnswerEval(input: Readonly<{
  executePaid: boolean;
  nowMs?: () => number;
  prepareExecutor: (
    profiles: readonly ProviderAnswerEvalProfile[]
  ) => Promise<ProviderAnswerExecutor> | ProviderAnswerExecutor;
  randomId?: () => string;
  randomIndex?: (maximum: number) => number;
  reviewDirectory: string;
  selectedProvider?: ProviderAnswerEvalProfile["provider"] | null;
}>): Promise<ProviderAnswerEvalReport> {
  if (!input.executePaid) {
    throw new ProviderAnswerEvalError(
      "knowledge_provider_answer_eval_execution_not_authorized"
    );
  }
  const reviewDirectory = await validateProviderAnswerReviewDirectory(input.reviewDirectory);
  const profiles = providerAnswerEvalProfiles().filter((profile) =>
    input.selectedProvider ? profile.provider === input.selectedProvider : true);
  const cases = providerAnswerEvalCases();
  const plannedCalls = profiles.length * cases.length;
  if (profiles.length === 0 || plannedCalls > KNOWLEDGE_PROVIDER_ANSWER_MAX_CALLS) {
    throw new ProviderAnswerEvalError(
      "knowledge_provider_answer_eval_profile_contract_invalid"
    );
  }
  const executor = await input.prepareExecutor(profiles);
  const nowMs = input.nowMs ?? Date.now;
  const randomId = input.randomId ?? randomUUID;
  const randomIndex = input.randomIndex ?? randomInt;
  const completed: CompletedCall[] = [];
  const failed: FailedCall[] = [];
  const skipped: SkippedCall[] = [];
  const reviewIds = new Set<string>();

  for (const profile of profiles) {
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
      const caseDefinition = cases[caseIndex]!;
      const startedAt = nowMs();
      try {
        const result = await boundedProviderCall(executor, {
          profile,
          request: buildProviderAnswerEvalRequest(profile, caseDefinition)
        });
        const answer = result.answer.trim();
        if (!answer || Buffer.byteLength(answer, "utf8") > MAX_CAPTURED_ANSWER_BYTES) {
          throw new ProviderAnswerCallFailure("provider_answer_invalid");
        }
        const reviewId = randomId();
        if (!reviewId || reviewIds.has(reviewId)) {
          throw new Error("knowledge_provider_answer_eval_review_id_invalid");
        }
        reviewIds.add(reviewId);
        completed.push({
          answer,
          caseDefinition,
          grounding: groundKnowledgeAnswer({ answer, evidence: caseDefinition.evidence }),
          latencyMs: Math.max(0, Math.round(nowMs() - startedAt)),
          profile,
          reviewId,
          usage: result.usage
        });
      } catch (error) {
        const failure = error instanceof ProviderAnswerCallFailure
          ? error
          : new ProviderAnswerCallFailure("provider_call_failed");
        failed.push({
          caseId: caseDefinition.id,
          failureCode: failure.failureCode,
          httpStatus: failure.httpStatus,
          latencyMs: Math.max(0, Math.round(nowMs() - startedAt)),
          modelId: profile.modelId,
          provider: profile.provider
        });
        for (const skippedCase of cases.slice(caseIndex + 1)) {
          skipped.push({
            caseId: skippedCase.id,
            modelId: profile.modelId,
            provider: profile.provider
          });
        }
        break;
      }
    }
  }

  const { freeze, mapping, packet } = createProviderAnswerReviewArtifacts({
    completed,
    failed,
    randomIndex,
    skipped
  });
  await writeProviderAnswerReviewArtifacts({ freeze, mapping, packet, reviewDirectory });

  return {
    constraints: {
      maxCalls: KNOWLEDGE_PROVIDER_ANSWER_MAX_CALLS,
      maxOutputTokensPerCall: KNOWLEDGE_PROVIDER_ANSWER_MAX_OUTPUT_TOKENS,
      plannedCalls,
      sequentialCalls: true,
      timeoutMsPerCall: KNOWLEDGE_PROVIDER_ANSWER_TIMEOUT_MS
    },
    corpus: {
      caseCount: KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT,
      corpusVersion: KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION,
      languages: { en: 4, ru: 4 },
      reviewSplit: "blinded_review",
      slice: "bounded_bilingual_release_review"
    },
    execution: {
      attemptedCalls: completed.length + failed.length,
      completedCalls: completed.length,
      failedCalls: failed.length,
      paidExecutionAuthorized: true,
      skippedCalls: skipped.length
    },
    limitations: [
      "operator_delegated_agent_review_not_independent",
      "provider_identity_blinded_packet_requires_review",
      "bounded_blinded_review_slice_not_full_semantic_release_proof",
      "synthetic_citation_viewer_projection_not_persisted_route_release_evidence",
      "automated_grounding_is_lexical_not_semantic_judgment",
      "provider_billing_cost_not_guaranteed_by_adapter_usage"
    ],
    providers: providerAggregates(profiles, completed, failed, skipped),
    reportVersion: KNOWLEDGE_PROVIDER_ANSWER_EVAL_VERSION,
    review: {
      artifactsFrozenBeforeReview: true,
      citationViewerProvenance: "synthetic_projection",
      citationViewerReleaseEligible: false,
      independence: "operator_delegated_agent_review_not_independent",
      mappingSha256: mapping.mappingSha256,
      outputFreezeSha256: freeze.freezeSha256,
      packetItemCount: completed.length,
      packetSha256: packet.packetSha256,
      releaseEligibility: {
        eligible: false,
        reasonCodes: [
          "independent_human_review_not_completed",
          "synthetic_citation_viewer_projection"
        ]
      },
      reviewComplete: false,
      semanticReleaseProof: false
    },
    status: failed.length > 0 || completed.length !== plannedCalls
      ? "failed"
      : "review_required"
  };
}

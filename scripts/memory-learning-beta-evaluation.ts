import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { ModelRunUsage } from "../lib/domain/modelRunEvents";
import { estimateCostMicros } from "../lib/domain/usage";
import type {
  MemoryBinaryOutcome,
  MemoryEvaluationLanguage,
  MemoryOperationObservation,
  MemoryEvaluationSystemFingerprint
} from "../lib/evaluation/memory/contracts";
import { MEMORY_EVALUATION_SCORER_VERSION } from "../lib/evaluation/memory/contracts";
import { memoryEvaluationSha256 } from "../lib/evaluation/memory/canonical";
import {
  scoreMemoryBinaryOutcomes,
  scoreMemoryOperations,
  wilson95
} from "../lib/evaluation/memory/scorers";
import {
  MEMORY_AUTOMATIC_FACT_PRECISION_SCORER_VERSION,
  MEMORY_AUTOMATIC_LEARNING_CORPUS_VERSION,
  MEMORY_AUTOMATIC_LEARNING_EVALUATOR_VERSION,
  MEMORY_AUTOMATIC_LEARNING_EVIDENCE_VERSION,
  MEMORY_AUTOMATIC_LEARNING_HOLDOUT_CORPUS_HASH,
  MEMORY_AUTOMATIC_LEARNING_SCORER_VERSION,
  MEMORY_AUTOMATIC_LEARNING_SUITE_VERSION,
  scoreMemoryAutomaticExtraction,
  scoreMemoryAutomaticLearningHardGates
} from "../lib/evaluation/memory/automaticLearning";
import { prisma } from "../lib/server/prisma";
import {
  MEMORY_EPISODE_EXTRACTION_VERSIONS,
  memoryEpisodeExtractionInputHash,
  memoryEpisodeSourceWindowHash,
  type MemoryEpisodeExtractionInput
} from "../lib/server/memory/history/episode/contract";
import { decodeMemoryEpisodeExtraction } from "../lib/server/memory/history/episode/decoder";
import { createAcceptedMemoryEpisodeProvider } from "../lib/server/memory/history/episode/runtime";
import { projectMemoryHistorySafeText } from "../lib/server/memory/history/safety";
import {
  memoryVectorSpaceFingerprint,
  requireAcceptedMemoryUtilityPolicy,
  resolveCurrentMemoryUtilityPolicy
} from "../lib/server/memory/execution/policy";
import { requireAdminAcceptedMemoryDestination } from "../lib/server/memory/execution/adminConsent";
import { resolveMemoryEgressConsentMode } from "../lib/server/memory/execution/consentMode";
import type {
  MemoryExecutionRole,
  MemoryExecutionVersions,
  ResolvedMemoryExecutionTarget
} from "../lib/server/memory/execution";
import {
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  MEMORY_FACT_EXTRACTION_VERSIONS,
  memoryFactExtractionInputHash,
  type MemoryExtractedCandidate,
  type MemoryFactExtractionInput
} from "../lib/server/memory/learning/extraction/contract";
import { decodeMemoryFactExtraction } from "../lib/server/memory/learning/extraction/decoder";
import { createAcceptedMemoryFactProvider } from "../lib/server/memory/learning/extraction/runtime";
import {
  MEMORY_FACT_CONSOLIDATION_VERSIONS,
  MEMORY_FACT_VERIFICATION_VERSIONS,
  memoryFactConsolidationInputHash,
  memoryFactConsolidationOutputHash,
  memoryFactDecisionId,
  memoryFactRelatedSnapshotHash,
  memoryFactVerificationInputHash,
  type MemoryFactCandidateSnapshot,
  type MemoryFactConsolidationInput,
  type MemoryFactConsolidationOperation,
  type MemoryFactConsolidationPlan,
  type MemoryFactDecisionSnapshot,
  type MemoryFactVerificationInput,
  type MemoryRelatedFactSnapshot,
  type MemoryRelatedFactVersionSnapshot
} from "../lib/server/memory/learning/consolidation/contract";
import {
  decodeMemoryFactConsolidation,
  inspectMemoryFactVerificationOutput
} from "../lib/server/memory/learning/consolidation/decoder";
import { evaluateMemoryFactConsolidationPlan } from "../lib/server/memory/learning/consolidation/policy";
import {
  createAcceptedMemoryFactDecisionProvider,
  MEMORY_FACT_VERIFICATION_MAX_OUTPUT_TOKENS
} from "../lib/server/memory/learning/consolidation/runtime";
import { memorySha256 } from "../lib/server/memory/persistence/lexical";
import { detectMemoryTextLanguage } from "../lib/server/memory/history/language";
import { MEMORY_ITEM_EMBEDDING_VERSIONS } from "../lib/server/memory/embedding/contract";
import { MEMORY_QUERY_EMBEDDING_VERSIONS } from "../lib/server/memory/retrieval/runUtilities";
import { loadMemoryTuningCorpus } from "../tests/fixtures/memory-evaluation/tuning/corpus";
import {
  MEMORY_CORPUS_VERSION,
  type MemoryCorpusFixture,
  type MemoryCorpusMessage
} from "../tests/fixtures/memory-evaluation/shared/corpusTypes";

const BOOTSTRAP_SEED = 4_242;
// Corpus fixtures are independent chats. Combining near-duplicate fixtures in
// one extraction input invites valid fact deduplication that the fixture-level
// scorer would misclassify as omissions.
const EXTRACTION_BATCH_SIZE = 1;
const MATRIX_REPETITIONS = 10;
const SUPPORTING_CASES_PER_LANGUAGE = 32;
let failureStage = "startup";

type Split = "TUNING" | "HOLDOUT";
type FixtureSource = Readonly<{
  fixture: MemoryCorpusFixture;
  message: MemoryCorpusMessage;
}>;
type ExtractionAssessment = Readonly<{
  called: boolean;
  candidates: readonly MemoryExtractedCandidate[];
  decodeValid: boolean;
  foreignCandidate: boolean;
  source: FixtureSource;
}>;
type RoleCounters = {
  calls: number;
  decodeFailures: number;
  providerFailures: number;
};
export type MemoryLearningMatrixCase = Readonly<{
  expected: MemoryFactConsolidationOperation;
  input: MemoryFactConsolidationInput;
  language: MemoryEvaluationLanguage;
}>;
export type MemoryLearningVerifiedCase = Readonly<{
  expectedApprove: boolean;
  input: MemoryFactVerificationInput;
  language: MemoryEvaluationLanguage;
  operation: MemoryFactConsolidationOperation;
  variant: "mismatched_target" | "supported";
}>;
type CorpusManifest = Readonly<{
  corpusVersion: string;
  generatorVersion: string;
  manifestVersion: string;
  schemaVersion: string;
  splits: Readonly<Record<Split, Readonly<{ contentHash: string }>>>;
}>;
type EmbeddingEvidenceDependency = Readonly<{
  evidenceDigest: string;
  evaluatedAt: string;
  fingerprints: Readonly<{
    configuration: string;
    deployment: string;
    execution: string;
    model: string;
    provider: string;
    vectorSpace: string;
  }>;
}>;

const sha256Pattern = /^[a-f0-9]{64}$/u;

function hasArgument(value: string): boolean {
  return process.argv.slice(2).includes(value);
}

function argumentValue(prefix: string): string | null {
  const value = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
  return value?.slice(prefix.length).trim() || null;
}

function selectedSplit(): Split {
  if (hasArgument("--split=tuning")) return "TUNING";
  if (hasArgument("--split=holdout")) return "HOLDOUT";
  throw new Error("memory_learning_evaluation_split_required");
}

function concurrency(): number {
  const raw = argumentValue("--concurrency=") ?? "4";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 4) {
    throw new Error("memory_learning_evaluation_concurrency_invalid");
  }
  return value;
}

function decisionConcurrency(maximum: number): number {
  const raw = argumentValue("--decision-concurrency=") ?? "1";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error("memory_learning_evaluation_decision_concurrency_invalid");
  }
  return value;
}

function tuningCasesPerCohort(split: Split): number | null {
  const raw = argumentValue("--cases-per-cohort=");
  if (split === "HOLDOUT") {
    if (raw !== null) throw new Error("memory_learning_holdout_subset_forbidden");
    return null;
  }
  const value = Number(raw ?? "5");
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new Error("memory_learning_tuning_subset_invalid");
  }
  return value;
}

function tuningCohorts(split: Split): ReadonlySet<string> | null {
  const raw = argumentValue("--cohorts=");
  if (split === "HOLDOUT") {
    if (raw !== null) throw new Error("memory_learning_holdout_subset_forbidden");
    return null;
  }
  if (raw === null) return null;
  const values = raw.split(",").map((value) => value.trim());
  if (values.length === 0 || values.some((value) =>
    !/^[a-z][a-z0-9-]{0,79}$/u.test(value)
  ) || new Set(values).size !== values.length) {
    throw new Error("memory_learning_tuning_subset_invalid");
  }
  return new Set(values);
}

function boundedTuningCount(input: Readonly<{
  defaultValue: number;
  maximum: number;
  prefix: string;
  split: Split;
}>): number {
  const raw = argumentValue(input.prefix);
  if (input.split === "HOLDOUT") {
    if (raw !== null) throw new Error("memory_learning_holdout_subset_forbidden");
    return input.defaultValue;
  }
  const value = Number(raw ?? String(input.defaultValue));
  if (!Number.isSafeInteger(value) || value < 1 || value > input.maximum) {
    throw new Error("memory_learning_tuning_subset_invalid");
  }
  return value;
}

function privateEvidenceOutputPath(): string {
  const value = argumentValue("--evidence-output=");
  if (!value) throw new Error("memory_learning_evidence_output_required");
  const privateRoot = resolve(".aiqsa");
  const target = resolve(value);
  if (target === privateRoot || !target.startsWith(`${privateRoot}${sep}`)) {
    throw new Error("memory_learning_evidence_output_invalid");
  }
  return target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function privateEmbeddingEvidencePath(split: Split): string | null {
  const value = argumentValue("--embedding-holdout-evidence=");
  if (!value) {
    if (split === "HOLDOUT") {
      throw new Error("memory_learning_embedding_holdout_evidence_required");
    }
    return null;
  }
  const privateRoot = resolve(".aiqsa");
  const target = resolve(value);
  if (target === privateRoot || !target.startsWith(`${privateRoot}${sep}`)) {
    throw new Error("memory_learning_embedding_holdout_evidence_invalid");
  }
  return target;
}

async function loadEmbeddingEvidenceDependency(
  split: Split,
  manifest: CorpusManifest
): Promise<EmbeddingEvidenceDependency | null> {
  const path = privateEmbeddingEvidencePath(split);
  if (!path) return null;
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("memory_learning_embedding_holdout_evidence_invalid");
  }
  if (!isRecord(wrapper) || !isRecord(wrapper.evidence) ||
      typeof wrapper.evidenceDigest !== "string" ||
      !sha256Pattern.test(wrapper.evidenceDigest) ||
      memoryEvaluationSha256(wrapper.evidence) !== wrapper.evidenceDigest) {
    throw new Error("memory_learning_embedding_holdout_evidence_invalid");
  }
  const evidence = wrapper.evidence;
  const adapter = evidence.adapter;
  const corpus = evidence.corpus;
  const quality = evidence.quality;
  const operations = Array.isArray(evidence.operations) ? evidence.operations : null;
  if (
    evidence.passed !== true || evidence.sanitizedAggregatesOnly !== true ||
    !isRecord(adapter) || adapter.kind !== "AIQSA_NATIVE" ||
    adapter.liveProvider !== true || !isRecord(adapter.fingerprints) ||
    typeof evidence.evaluatedAt !== "string" ||
    !Number.isFinite(Date.parse(evidence.evaluatedAt)) ||
    new Date(evidence.evaluatedAt).toISOString() !== evidence.evaluatedAt ||
    !isRecord(corpus) || corpus.split !== "HOLDOUT" ||
    corpus.hash !== manifest.splits.HOLDOUT.contentHash ||
    corpus.version !== manifest.corpusVersion ||
    !isRecord(quality) || quality.releaseGatePassed !== true || !operations ||
    !["MEMORY_DOCUMENT_EMBED", "MEMORY_QUERY_EMBED"].every((role) =>
      operations.some((operation: unknown) =>
        isRecord(operation) && operation.role === role
      )
    )
  ) throw new Error("memory_learning_embedding_holdout_evidence_invalid");
  const fingerprints = adapter.fingerprints;
  const values = [
    fingerprints.configuration,
    fingerprints.deployment,
    fingerprints.execution,
    fingerprints.model,
    fingerprints.provider,
    fingerprints.vectorSpace
  ];
  if (!values.every((value) => typeof value === "string" && sha256Pattern.test(value))) {
    throw new Error("memory_learning_embedding_holdout_evidence_invalid");
  }
  return {
    evidenceDigest: wrapper.evidenceDigest,
    evaluatedAt: evidence.evaluatedAt,
    fingerprints: {
      configuration: fingerprints.configuration as string,
      deployment: fingerprints.deployment as string,
      execution: fingerprints.execution as string,
      model: fingerprints.model as string,
      provider: fingerprints.provider as string,
      vectorSpace: fingerprints.vectorSpace as string
    }
  };
}

async function loadManifest(): Promise<CorpusManifest> {
  const value = JSON.parse(await readFile(
    "tests/fixtures/memory-evaluation/manifests/corpus-v2.json",
    "utf8"
  )) as CorpusManifest;
  if (
    value.corpusVersion !== MEMORY_CORPUS_VERSION ||
    value.corpusVersion !== MEMORY_AUTOMATIC_LEARNING_CORPUS_VERSION ||
    !/^[a-f0-9]{64}$/u.test(value.splits.TUNING.contentHash) ||
    value.splits.HOLDOUT.contentHash !==
      MEMORY_AUTOMATIC_LEARNING_HOLDOUT_CORPUS_HASH ||
    MEMORY_EVALUATION_SCORER_VERSION !==
      MEMORY_AUTOMATIC_LEARNING_SCORER_VERSION
  ) throw new Error("memory_learning_corpus_manifest_invalid");
  return value;
}

function requireLiveAuthorization(split: Split, manifest: CorpusManifest): void {
  if (!hasArgument("--authorized-live-provider")) {
    throw new Error("memory_learning_live_provider_authorization_required");
  }
  if (split === "HOLDOUT" && !hasArgument(
    `--holdout-corpus-hash=${manifest.splits.HOLDOUT.contentHash}`
  )) throw new Error("memory_learning_holdout_hash_authorization_required");
}

async function loadCorpus(split: Split): Promise<readonly MemoryCorpusFixture[]> {
  if (split === "TUNING") return loadMemoryTuningCorpus();
  const { loadMemoryHoldoutCorpus } = await import(
    "../tests/fixtures/memory-evaluation/holdout/corpus"
  );
  return loadMemoryHoldoutCorpus({
    expectedCorpusVersion: MEMORY_CORPUS_VERSION,
    purpose: "SCORING_ONLY"
  });
}

function selectedFixtures(
  fixtures: readonly MemoryCorpusFixture[],
  limit: number | null,
  cohorts: ReadonlySet<string> | null
): readonly MemoryCorpusFixture[] {
  const selected = cohorts === null
    ? fixtures
    : fixtures.filter((fixture) => cohorts.has(fixture.cohort));
  if (cohorts !== null && (
    selected.length === 0 ||
    [...cohorts].some((cohort) =>
      !selected.some((fixture) => fixture.cohort === cohort)
    )
  )) throw new Error("memory_learning_tuning_subset_invalid");
  if (limit === null) return selected;
  const counts = new Map<string, number>();
  return selected.filter((fixture) => {
    const key = `${fixture.language}:${fixture.cohort}`;
    const current = counts.get(key) ?? 0;
    const cohortLimit = cohorts !== null ||
      fixture.tags.includes("adversarial") ||
      fixture.groupId.includes("critical") ||
      selected.filter((candidate) => candidate.groupId === fixture.groupId).length > 1
      ? limit
      : 1;
    if (current >= cohortLimit) return false;
    counts.set(key, current + 1);
    return true;
  });
}

function sourceMessage(fixture: MemoryCorpusFixture): MemoryCorpusMessage {
  const preferredIds = [
    ...(fixture.expectedFacts[0]?.sourceMessageIds ?? []),
    ...(fixture.forbiddenFacts[0]?.sourceMessageIds ?? [])
  ];
  for (const id of preferredIds) {
    for (const chat of fixture.chats) {
      const message = chat.messages.find((candidate) =>
        candidate.id === id && candidate.role === "user" &&
        candidate.ownerUserId === fixture.users[0]
      );
      if (message) return message;
    }
  }
  throw new Error("memory_learning_fixture_source_missing");
}

function fixtureSource(fixture: MemoryCorpusFixture): FixtureSource {
  return { fixture, message: sourceMessage(fixture) };
}

function batches<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  stage: string,
  run: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  let complete = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await run(values[index]!, index);
      complete += 1;
      if (complete === values.length || complete % 10 === 0) {
        process.stderr.write(`[memory-learning-eval] ${stage} ${complete}/${values.length}\n`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function factInput(
  sources: readonly FixtureSource[],
  batchIndex: number
): MemoryFactExtractionInput {
  const language = sources[0]!.fixture.language.toLowerCase() as "ru" | "en";
  const cohort = sources[0]!.fixture.cohort;
  const chatId = `qualification-${language}-${cohort}-${batchIndex}`;
  const userId = `qualification-user-${language}`;
  const messages = sources.map(({ message }) => ({
    contentHash: memorySha256({ text: message.text, version: 1 }),
    createdAt: message.createdAt,
    id: message.id,
    languageCode: detectMemoryTextLanguage(message.text),
    text: message.text,
    updatedAt: message.createdAt
  }));
  const sourceHash = memorySha256({
    chatId,
    messages: messages.map(({ contentHash, id }) => ({ contentHash, id })),
    version: 1
  });
  const withoutHash: Omit<MemoryFactExtractionInput, "inputHash"> = {
    folderId: sources[0]!.fixture.expectedFacts[0]?.scope.type === "FOLDER"
      ? `qualification-folder-${language}-${cohort}`
      : null,
    messages,
    source: {
      activeLeafMessageId: messages.at(-1)!.id,
      branchGeneration: 0,
      chatId,
      sourceHash,
      sourceRevision: 1,
      userId
    },
    sourceProjectionHash: memorySha256({ sourceHash, version: 1 }),
    sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    suppressionIdentitySnapshot: memorySha256({ sourceHash, suppression: 1 }),
    timeZone: "Europe/Moscow"
  };
  return { ...withoutHash, inputHash: memoryFactExtractionInputHash(withoutHash) };
}

function targetEvidence(target: ResolvedMemoryExecutionTarget) {
  return {
    connectionId: target.authority.connectionId,
    credentialId: target.authority.credentialId,
    credentialVersionId: target.authority.credentialVersionId,
    executionSnapshot: target.snapshot,
    providerModelId: target.authority.providerModelId
  };
}

function operationObservation(
  role: MemoryExecutionRole,
  usage: ModelRunUsage,
  latencyMs: number,
  pricing: Readonly<{
    inputTokenPriceMicros: number;
    outputTokenPriceMicros: number;
    reasoningTokenPriceMicros: number;
  }>,
  retries = 0
): MemoryOperationObservation {
  const costMicros = usage.estimatedCostMicros ?? estimateCostMicros(usage, pricing);
  return {
    estimatedCostUsd: costMicros / 1_000_000,
    inputTokens: usage.inputTokens,
    latencyMs,
    outputTokens: usage.outputTokens,
    retries,
    role
  };
}

function roleFingerprint(
  role: MemoryExecutionRole,
  target: ResolvedMemoryExecutionTarget
): MemoryEvaluationSystemFingerprint {
  return {
    ...target.qualificationFingerprints,
    role,
    vectorSpaceFingerprint: memoryVectorSpaceFingerprint(target)
  };
}

function expectedEmbeddingEvidenceFingerprints(
  target: ResolvedMemoryExecutionTarget
): EmbeddingEvidenceDependency["fingerprints"] {
  const model = target.snapshot.model;
  if (
    model.adapterKind === "fake" || !("modelClass" in model) ||
    model.modelClass !== "embedding" || !("embedding" in model) || !model.embedding
  ) {
    throw new Error("memory_learning_embedding_target_invalid");
  }
  return {
    configuration: memoryEvaluationSha256(model),
    deployment: memoryEvaluationSha256({
      connectionId: target.authority.connectionId,
      connectionVersion: target.authority.connectionVersion,
      modelVersion: target.authority.modelVersion,
      providerModelId: target.authority.providerModelId
    }),
    execution: memoryEvaluationSha256(target.snapshot),
    model: memoryEvaluationSha256({
      embedding: model.embedding,
      upstreamModelId: model.upstreamModelId
    }),
    provider: memoryEvaluationSha256(target.snapshot.providerFamily),
    vectorSpace: memoryEvaluationSha256({
      adapterKind: model.adapterKind,
      embedding: model.embedding,
      upstreamModelId: model.upstreamModelId
    })
  };
}

function requireEmbeddingEvidenceMatchesTargets(
  dependency: EmbeddingEvidenceDependency | null,
  targets: ReadonlyMap<MemoryExecutionRole, ResolvedMemoryExecutionTarget>,
  split: Split
): void {
  if (!dependency) {
    if (split === "HOLDOUT") {
      throw new Error("memory_learning_embedding_holdout_evidence_required");
    }
    return;
  }
  for (const role of ["MEMORY_DOCUMENT_EMBED", "MEMORY_QUERY_EMBED"] as const) {
    const target = targets.get(role);
    if (!target || !memoryVectorSpaceFingerprint(target)) {
      throw new Error("memory_learning_embedding_target_invalid");
    }
    const expected = expectedEmbeddingEvidenceFingerprints(target);
    if (Object.keys(expected).some((key) =>
      expected[key as keyof typeof expected] !==
        dependency.fingerprints[key as keyof typeof expected]
    )) throw new Error("memory_learning_embedding_holdout_evidence_stale");
  }
}

function expectedAutomaticCandidate(fixture: MemoryCorpusFixture): boolean {
  return fixture.expectedSafety.automaticPromotionAllowed &&
    fixture.expectedLifecycle.sourceEligible &&
    fixture.expectedFacts.length > 0;
}

function secretOrHighlySensitiveFixture(fixture: MemoryCorpusFixture): boolean {
  return fixture.expectedFacts.some(({ sensitivity }) => sensitivity === "SENSITIVE") ||
    fixture.forbiddenFacts.some(({ reason }) =>
      reason === "SECRET" || reason === "SENSITIVE_INFERENCE"
    );
}

function hasExplicitMemoryMutation(fixture: MemoryCorpusFixture): boolean {
  return fixture.actions.some(({ type }) =>
    type === "SAVE" || type === "EDIT" || type === "FORGET");
}

function addOutcome(
  outcomes: Array<{ language: MemoryEvaluationLanguage; outcome: MemoryBinaryOutcome }>,
  language: MemoryEvaluationLanguage,
  metric: MemoryBinaryOutcome["metric"],
  positive: boolean
): void {
  outcomes.push({
    language,
    outcome: { cohort: "overall", metric, positive }
  });
}

function extractionOutcomes(
  assessments: readonly ExtractionAssessment[],
  diagnostics: Record<string, number>
): Array<{ language: MemoryEvaluationLanguage; outcome: MemoryBinaryOutcome }> {
  const outcomes: Array<{
    language: MemoryEvaluationLanguage;
    outcome: MemoryBinaryOutcome;
  }> = [];
  for (const assessment of assessments) {
    const fixture = assessment.source.fixture;
    const language = fixture.language;
    const expectedPromotable = expectedAutomaticCandidate(fixture);
    const promotable = assessment.candidates.filter((candidate) =>
      candidate.state === "PENDING" && !candidate.negated
    );
    const admittedOutputSafe = !assessment.foreignCandidate;
    const extractionScore = scoreMemoryAutomaticExtraction({
      decodedCandidateCount: assessment.candidates.length,
      decodeValid: assessment.decodeValid,
      expectedPromotable,
      outputSafe: admittedOutputSafe,
      promotableCandidateCount: promotable.length
    });
    if (!extractionScore.sourceCovered) {
      const reason = !assessment.decodeValid
        ? "decode_invalid"
        : assessment.foreignCandidate
          ? "foreign_candidate"
          : "expected_missing";
      incrementDiagnostic(
        diagnostics,
        `extraction-assessment:${language}:${fixture.cohort}:${reason}`
      );
    }
    if (extractionScore.precisionOutcomes.some((positive) => !positive)) {
      incrementDiagnostic(
        diagnostics,
        `extraction-assessment:${language}:${fixture.cohort}:unexpected_promotable`
      );
    }
    const evidencePass = admittedOutputSafe && assessment.candidates.every((candidate) =>
      candidate.evidence.length > 0 && candidate.evidence.every(({ messageId }) =>
        messageId === assessment.source.message.id)
    );
    const languagePass = admittedOutputSafe && assessment.candidates.every((candidate) =>
      assessment.source.message.text.includes(candidate.displayText) &&
      detectMemoryTextLanguage(candidate.displayText) === candidate.languageCode
    );
    const temporalPass = admittedOutputSafe && assessment.candidates.every((candidate) =>
      candidate.rawTemporalExpression === null ||
      candidate.temporalResolutionEvidence !== null
    );
    for (const positive of extractionScore.precisionOutcomes) {
      addOutcome(outcomes, language, "AUTOMATIC_FACT_PRECISION", positive);
    }
    addOutcome(outcomes, language, "EVIDENCE_ID_VALIDITY", evidencePass);
    addOutcome(outcomes, language, "LANGUAGE_PRESERVING_DISPLAY_TEXT", languagePass);
    addOutcome(outcomes, language, "TEMPORAL_CURRENT_HISTORY_ACCURACY", temporalPass);
    addOutcome(
      outcomes,
      language,
      "SOURCE_COVERAGE",
      extractionScore.sourceCovered
    );
  }
  return outcomes;
}

export function memoryLearningMatrixBaseCandidate(
  language: MemoryEvaluationLanguage
): MemoryFactCandidateSnapshot {
  const languageCode = language.toLowerCase();
  const displayText = language === "RU"
    ? "Я предпочитаю синтетический чай."
    : "I prefer synthetic tea.";
  const observedAt = "2026-08-11T12:00:00.000Z";
  const messageId = `qualification-matrix-message-${languageCode}`;
  return {
    branchGeneration: 0,
    canonicalKey: "user.preference.drink",
    category: "preference",
    chatId: `qualification-matrix-chat-${languageCode}`,
    confidence: 0.95,
    directness: "DIRECT",
    displayText,
    evidence: [{
      endOffset: displayText.length,
      messageId,
      observedAt,
      quote: displayText,
      sourceTextHash: memorySha256(displayText),
      startOffset: 0
    }],
    id: memorySha256({ domain: "qualification-matrix-base", language }),
    importance: 0.9,
    languageCode,
    modality: "PREFERENCE",
    negated: false,
    proposedValue: {
      drink: language === "RU" ? "синтетический чай" : "synthetic tea"
    },
    rawTemporalExpression: null,
    scope: { targetId: null, type: "GLOBAL_USER" },
    sensitivity: "NORMAL",
    sourceHash: memorySha256({ domain: "qualification-matrix-source", language }),
    sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    sourceRevision: 1,
    sourceTimezone: language === "RU" ? "Europe/Moscow" : "UTC",
    temporalResolverVersion: null,
    temporalResolutionEvidence: null,
    validFrom: null,
    validTo: null
  };
}

function relatedVersion(
  candidate: MemoryFactCandidateSnapshot,
  input: Readonly<{
    displayText?: string;
    equivalent: boolean;
    explicit: boolean;
    latestEvidenceAt: string;
    suffix: string;
  }>
): MemoryRelatedFactVersionSnapshot {
  return {
    category: candidate.category,
    confidence: 0.95,
    directness: "DIRECT",
    displayText: input.displayText ?? (input.equivalent
      ? candidate.displayText
      : candidate.languageCode === "ru"
        ? "Ранее я предпочитал другой синтетический вариант."
        : "I previously preferred another synthetic option."),
    id: `qualification-version-${input.suffix}`,
    importance: candidate.importance,
    languageCode: candidate.languageCode,
    latestEvidenceAt: input.latestEvidenceAt,
    modality: candidate.modality,
    sourceMode: input.explicit ? "EXPLICIT" : "AUTOMATIC",
    state: "ACTIVE",
    structuredValue: input.equivalent
      ? candidate.proposedValue
      : { option: candidate.languageCode === "ru" ? "другой" : "another" },
    supportCount: 1,
    systemFrom: input.latestEvidenceAt,
    systemTo: null,
    validFrom: candidate.validFrom,
    validTo: candidate.validTo
  };
}

function relatedFact(
  candidate: MemoryFactCandidateSnapshot,
  input: Parameters<typeof relatedVersion>[1]
): MemoryRelatedFactSnapshot {
  const version = relatedVersion(candidate, input);
  return {
    canonicalKey: candidate.canonicalKey,
    category: candidate.category,
    currentVersionId: version.id,
    id: `qualification-fact-${input.suffix}`,
    scope: candidate.scope,
    state: "ACTIVE",
    versions: [version]
  };
}

function consolidationInput(
  candidate: MemoryFactCandidateSnapshot,
  relatedFacts: readonly MemoryRelatedFactSnapshot[]
): MemoryFactConsolidationInput {
  const relatedSnapshotHash = memoryFactRelatedSnapshotHash(relatedFacts);
  const withoutHash: Omit<MemoryFactConsolidationInput, "inputHash"> = {
    candidate,
    memoryRevision: 0,
    relatedFacts,
    relatedSnapshotHash
  };
  return { ...withoutHash, inputHash: memoryFactConsolidationInputHash(withoutHash) };
}

function matrixCandidate(
  base: MemoryFactCandidateSnapshot,
  language: MemoryEvaluationLanguage,
  operation: MemoryFactConsolidationOperation,
  index: number
): MemoryFactCandidateSnapshot {
  const observedAt = "2026-08-11T12:00:00.000Z";
  const suffix = `${language.toLowerCase()}-${operation.toLowerCase()}-${index}`;
  const negated = operation === "EXPIRE";
  const displayText = negated
    ? language === "RU"
      ? "Я больше не предпочитаю синтетический чай."
      : "I no longer prefer synthetic tea."
    : base.displayText;
  return {
    ...base,
    confidence: operation === "DEFER" ? 0.55 : Math.max(base.confidence, 0.9),
    displayText,
    evidence: [{
      endOffset: displayText.length,
      messageId: `qualification-message-${suffix}`,
      observedAt,
      quote: displayText,
      sourceTextHash: memorySha256(displayText),
      startOffset: 0
    }],
    id: memorySha256({ base: base.id, index, language, operation }),
    importance: 0.9,
    negated,
    proposedValue: negated
      ? { drink: language === "RU" ? "синтетический чай" : "synthetic tea" }
      : base.proposedValue,
    rawTemporalExpression: null,
    sourceHash: memorySha256({ source: suffix }),
    sourceRevision: index + 1,
    temporalResolverVersion: null,
    temporalResolutionEvidence: null,
    validFrom: null,
    validTo: null
  };
}

export function memoryLearningMatrixCases(
  bases: Readonly<Record<MemoryEvaluationLanguage, MemoryFactCandidateSnapshot>>,
  repetitions: number
): MemoryLearningMatrixCase[] {
  const operations: readonly MemoryFactConsolidationOperation[] = [
    "ADD", "REINFORCE", "SUPERSEDE", "CONFLICT", "EXPIRE", "NOOP", "DEFER"
  ];
  return (["RU", "EN"] as const).flatMap((language) =>
    operations.flatMap((operation) =>
      Array.from({ length: repetitions }, (_, index): MemoryLearningMatrixCase => {
        const candidate = matrixCandidate(bases[language], language, operation, index);
        const observedAt = candidate.evidence[0]!.observedAt;
        let related: readonly MemoryRelatedFactSnapshot[] = [];
        if (operation === "REINFORCE") {
          related = [relatedFact(candidate, {
            equivalent: true,
            explicit: false,
            latestEvidenceAt: "2026-08-10T12:00:00.000Z",
            suffix: `${language}-reinforce-${index}`
          })];
        } else if (operation === "SUPERSEDE") {
          related = [relatedFact(candidate, {
            equivalent: false,
            explicit: false,
            latestEvidenceAt: "2026-08-10T12:00:00.000Z",
            suffix: `${language}-${operation}-${index}`
          })];
        } else if (operation === "EXPIRE") {
          related = [relatedFact(candidate, {
            displayText: language === "RU"
              ? "Я предпочитаю синтетический чай."
              : "I prefer synthetic tea.",
            equivalent: true,
            explicit: false,
            latestEvidenceAt: "2026-08-10T12:00:00.000Z",
            suffix: `${language}-${operation}-${index}`
          })];
        } else if (operation === "CONFLICT") {
          related = [relatedFact(candidate, {
            displayText: language === "RU"
              ? "Я предпочитаю другой синтетический вариант."
              : "I prefer another synthetic option.",
            equivalent: false,
            explicit: false,
            latestEvidenceAt: observedAt,
            suffix: `${language}-conflict-${index}`
          })];
        } else if (operation === "NOOP") {
          related = [relatedFact(candidate, {
            equivalent: false,
            explicit: true,
            latestEvidenceAt: "2026-08-10T12:00:00.000Z",
            suffix: `${language}-noop-${index}`
          })];
        } else if (operation === "DEFER") {
          const fact = relatedFact(candidate, {
            equivalent: false,
            explicit: false,
            latestEvidenceAt: observedAt,
            suffix: `${language}-defer-${index}`
          });
          related = [{ ...fact, currentVersionId: null, state: "CONFLICTED" }];
        }
        return { expected: operation, input: consolidationInput(candidate, related), language };
      })
    )
  );
}

const matrixReasonCodes = Object.freeze({
  ADD: "new_supported_fact",
  CONFLICT: "simultaneous_contradiction",
  DEFER: "insufficient_support",
  EXPIRE: "direct_end_evidence",
  NOOP: "duplicate_or_explicit",
  REINFORCE: "same_current_value",
  SUPERSEDE: "direct_newer_evidence"
} as const);

export function memoryLearningMatrixGoldPlan(
  matrix: MemoryLearningMatrixCase
): MemoryFactConsolidationPlan {
  const targetsFact = ["REINFORCE", "SUPERSEDE", "CONFLICT", "EXPIRE"]
    .includes(matrix.expected);
  const target = targetsFact ? matrix.input.relatedFacts[0] : null;
  if (targetsFact && !target?.currentVersionId) {
    throw new Error("memory_learning_gold_matrix_target_missing");
  }
  const withoutHash: Omit<MemoryFactConsolidationPlan, "outputHash"> = {
    candidateId: matrix.input.candidate.id,
    effectiveFrom: matrix.expected === "SUPERSEDE"
      ? matrix.input.candidate.validFrom
      : null,
    evidenceIds: matrix.input.candidate.evidence.map(({ messageId }) => messageId),
    operation: matrix.expected,
    reasonCode: matrixReasonCodes[matrix.expected],
    targetFactId: target?.id ?? null,
    targetVersionId: target?.currentVersionId ?? null
  };
  const plan = {
    ...withoutHash,
    outputHash: memoryFactConsolidationOutputHash(matrix.input, withoutHash)
  };
  if (evaluateMemoryFactConsolidationPlan(matrix.input, plan).status !== "VALID") {
    throw new Error("memory_learning_gold_matrix_invalid");
  }
  return plan;
}

export function memoryLearningVerificationCases(
  matrices: readonly MemoryLearningMatrixCase[],
  casesPerLanguage: number
): MemoryLearningVerifiedCase[] {
  const operations = ["ADD", "SUPERSEDE", "CONFLICT", "EXPIRE"] as const;
  const cellCount = operations.length * 2;
  if (
    !Number.isSafeInteger(casesPerLanguage) ||
    casesPerLanguage < cellCount ||
    casesPerLanguage % cellCount !== 0
  ) throw new Error("memory_learning_verification_case_count_invalid");
  const casesPerOperation = casesPerLanguage / cellCount;
  const result: MemoryLearningVerifiedCase[] = [];
  for (const language of ["RU", "EN"] as const) {
    for (const operation of operations) {
      const selected = matrices
        .filter((matrix) =>
          matrix.language === language && matrix.expected === operation)
        .slice(0, casesPerOperation);
      if (selected.length !== casesPerOperation) {
        throw new Error("memory_learning_verification_matrix_insufficient");
      }
      for (const matrix of selected) {
        const plan = memoryLearningMatrixGoldPlan(matrix);
        const policyDecision = evaluateMemoryFactConsolidationPlan(matrix.input, plan);
        if (policyDecision.status !== "VALID") {
          throw new Error("memory_learning_gold_verification_case_invalid");
        }
        const target = plan.targetFactId
          ? matrix.input.relatedFacts.find(({ id }) => id === plan.targetFactId) ?? null
          : null;
        const decision: MemoryFactDecisionSnapshot = {
          consolidationInputHash: matrix.input.inputHash,
          consolidationOutputHash: plan.outputHash,
          id: memoryFactDecisionId(matrix.input, plan),
          operation: plan.operation,
          reasonCode: plan.reasonCode,
          relatedSnapshotHash: matrix.input.relatedSnapshotHash,
          requiresVerification: true,
          targetFactId: plan.targetFactId,
          targetVersionId: plan.targetVersionId
        };
        const validWithoutHash: Omit<MemoryFactVerificationInput, "inputHash"> = {
          candidate: matrix.input.candidate,
          decision,
          target
        };
        result.push({
          expectedApprove: true,
          input: {
            ...validWithoutHash,
            inputHash: memoryFactVerificationInputHash(validWithoutHash)
          },
          language,
          operation,
          variant: "supported"
        });
        const invalidDecision = {
          ...decision,
          id: memorySha256({ decision: decision.id, invalid: true }),
          targetFactId: "qualification-mismatched-fact",
          targetVersionId: "qualification-mismatched-version"
        };
        const invalidWithoutHash: Omit<MemoryFactVerificationInput, "inputHash"> = {
          candidate: matrix.input.candidate,
          decision: invalidDecision,
          target
        };
        result.push({
          expectedApprove: false,
          input: {
            ...invalidWithoutHash,
            inputHash: memoryFactVerificationInputHash(invalidWithoutHash)
          },
          language,
          operation,
          variant: "mismatched_target"
        });
      }
    }
  }
  return result;
}

function episodeInput(source: FixtureSource, index: number): MemoryEpisodeExtractionInput | null {
  const projection = projectMemoryHistorySafeText(source.message.text);
  if (!projection.eligible) return null;
  const language = source.fixture.language.toLowerCase() as "ru" | "en";
  const chunk = {
    contentHash: memorySha256(projection.safeText),
    id: `qualification-chunk-${language}-${index}`,
    languageCode: detectMemoryTextLanguage(projection.safeText),
    messageIds: [source.message.id],
    occurredFrom: source.message.createdAt,
    occurredTo: source.message.createdAt,
    ordinal: 0,
    redactionReasonCodes: projection.redactionReasonCodes,
    redactionState: projection.redactionState,
    safeProjectedText: projection.providerSafeText,
    safetyClass: projection.safetyClass,
    sourceAssistantId: null,
    sourceFolderId: null,
    sourceProjectionVersion: "memory-history-source-projection-v1"
  } as const;
  const identity = {
    activeLeafMessageId: source.message.id,
    branchGeneration: 0,
    chatId: `qualification-episode-chat-${language}-${index}`,
    sourceHash: memorySha256({ chunk, version: 1 }),
    sourceRevision: 1,
    userId: `qualification-episode-user-${language}`
  };
  const suppressionIdentitySnapshot = memorySha256({ identity, suppression: 1 });
  const sourceWindowHash = memoryEpisodeSourceWindowHash(
    identity,
    [chunk],
    suppressionIdentitySnapshot
  );
  const withoutHash: Omit<MemoryEpisodeExtractionInput, "inputHash"> = {
    chunks: [chunk],
    source: identity,
    sourceWindowHash,
    suppressionIdentitySnapshot
  };
  return { ...withoutHash, inputHash: memoryEpisodeExtractionInputHash(withoutHash) };
}

function diverseEpisodeSources(
  sources: readonly FixtureSource[],
  casesPerLanguage: number
): FixtureSource[] {
  const result: FixtureSource[] = [];
  for (const language of ["RU", "EN"] as const) {
    const eligible = sources.filter(({ fixture, message }) =>
      fixture.language === language && fixture.expectedEgress.remoteCallsAllowed &&
      fixture.expectedLifecycle.sourceEligible && projectMemoryHistorySafeText(message.text).eligible
    );
    const byCohort = new Map<string, FixtureSource[]>();
    for (const source of eligible) {
      const values = byCohort.get(source.fixture.cohort) ?? [];
      values.push(source);
      byCohort.set(source.fixture.cohort, values);
    }
    let offset = 0;
    while (result.filter(({ fixture }) => fixture.language === language).length <
      casesPerLanguage) {
      let added = false;
      for (const values of byCohort.values()) {
        const value = values[offset];
        if (!value) continue;
        result.push(value);
        added = true;
        if (result.filter(({ fixture }) => fixture.language === language).length >=
          casesPerLanguage) break;
      }
      if (!added) break;
      offset += 1;
    }
  }
  return result;
}

function manualBinaryGate(values: readonly boolean[]): Readonly<{
  interval: ReturnType<typeof wilson95>;
  passed: boolean;
  point: number;
  positive: number;
  total: number;
}> {
  const positive = values.filter(Boolean).length;
  const point = positive / values.length;
  const interval = wilson95(positive, values.length);
  return {
    interval,
    passed: point >= 0.9 && interval.lower >= 0.8,
    point,
    positive,
    total: values.length
  };
}

function versionEvidence(
  role: MemoryExecutionRole,
  versions: MemoryExecutionVersions
): Readonly<{ role: MemoryExecutionRole } & MemoryExecutionVersions> {
  return { role, ...versions };
}

function safeFailureCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z][a-z0-9_]{0,119}$/u.test(code)) return code;
  }
  if (error instanceof Error && /^[a-z][a-z0-9_]{0,119}$/u.test(error.message)) {
    return error.message;
  }
  return "unknown";
}

function incrementDiagnostic(diagnostics: Record<string, number>, key: string): void {
  diagnostics[key] = (diagnostics[key] ?? 0) + 1;
}

function verificationUsageDiagnostic(usage: ModelRunUsage): string {
  const outputBand = usage.outputTokens === 0
    ? "output_zero"
    : usage.outputTokens >= MEMORY_FACT_VERIFICATION_MAX_OUTPUT_TOKENS
      ? "output_at_limit"
      : usage.outputTokens >= MEMORY_FACT_VERIFICATION_MAX_OUTPUT_TOKENS * 0.75
        ? "output_high"
        : "output_below_75pct";
  const reasoningBand = usage.reasoningTokens === 0
    ? "reasoning_zero"
    : usage.reasoningTokens >= usage.outputTokens
      ? "reasoning_all_output"
      : "reasoning_partial_output";
  return `${outputBand}:${reasoningBand}`;
}

async function runWithQualificationRetry<T>(input: Readonly<{
  diagnostics: Record<string, number>;
  label: string;
  run: () => Promise<T>;
}>): Promise<Readonly<{ result: T; retries: number }>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { result: await input.run(), retries: attempt };
    } catch (error) {
      const code = safeFailureCode(error);
      if (attempt === 0 && code.endsWith("_provider_outcome_unknown")) {
        incrementDiagnostic(input.diagnostics, `provider-retry:${input.label}:${code}`);
        continue;
      }
      throw error;
    }
  }
  throw new Error("memory_learning_provider_retry_exhausted");
}

async function main(): Promise<void> {
  failureStage = "arguments";
  const split = selectedSplit();
  const workerCount = concurrency();
  const decisionWorkerCount = decisionConcurrency(workerCount);
  const limit = tuningCasesPerCohort(split);
  const cohortSelection = tuningCohorts(split);
  const matrixRepetitions = boundedTuningCount({
    defaultValue: MATRIX_REPETITIONS,
    maximum: MATRIX_REPETITIONS,
    prefix: "--matrix-repetitions=",
    split
  });
  const supportingCasesPerLanguage = boundedTuningCount({
    defaultValue: SUPPORTING_CASES_PER_LANGUAGE,
    maximum: SUPPORTING_CASES_PER_LANGUAGE,
    prefix: "--supporting-cases-per-language=",
    split
  });
  const outputPath = privateEvidenceOutputPath();
  const manifest = await loadManifest();
  requireLiveAuthorization(split, manifest);
  const embeddingDependency = await loadEmbeddingEvidenceDependency(split, manifest);

  failureStage = "corpus";
  const corpus = await loadCorpus(split);
  const fixtures = selectedFixtures(corpus, limit, cohortSelection);
  const sources = fixtures.map(fixtureSource);

  failureStage = "authority";
  const users = await prisma.user.findMany({
    select: { id: true },
    where: { role: "admin", status: "active" }
  });
  if (users.length !== 1) throw new Error("memory_learning_admin_ambiguous");
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({
    select: {
      acceptedUtilityEgressAt: true,
      acceptedUtilityEgressFingerprint: true,
      acceptedUtilityPolicyVersion: true,
      embeddingProviderModelId: true
    },
    where: { userId: users[0]!.id }
  });
  const policy = await resolveCurrentMemoryUtilityPolicy(prisma, users[0]!.id, settings);
  const roleTargets = new Map<MemoryExecutionRole, ResolvedMemoryExecutionTarget>();
  for (const role of [
    "MEMORY_DOCUMENT_EMBED",
    "MEMORY_EPISODE_EXTRACT",
    "MEMORY_FACT_EXTRACT",
    "MEMORY_CONSOLIDATE",
    "MEMORY_VERIFY",
    "MEMORY_QUERY_EMBED"
  ] as const) {
    const target = policy.targets.get(role);
    if (!target) throw new Error("memory_learning_system_target_unavailable");
    roleTargets.set(role, target);
  }
  const consentMode = resolveMemoryEgressConsentMode();
  let acceptedAt: Date | null = null;
  if (consentMode === "ADMIN") {
    for (const [role, target] of roleTargets) {
      await requireAdminAcceptedMemoryDestination(prisma, { role, target });
    }
    acceptedAt = (await prisma.memoryEgressAdminPolicy.findUnique({
      select: { acceptedAt: true },
      where: { id: "installation" }
    }))?.acceptedAt ?? null;
  } else {
    requireAcceptedMemoryUtilityPolicy(settings, policy, consentMode);
    acceptedAt = settings.acceptedUtilityEgressAt;
  }
  if (!acceptedAt || (embeddingDependency &&
      acceptedAt.getTime() > Date.parse(embeddingDependency.evaluatedAt))) {
    throw new Error("memory_learning_embedding_holdout_egress_unaccepted");
  }
  requireEmbeddingEvidenceMatchesTargets(embeddingDependency, roleTargets, split);
  if (hasArgument("--preflight-only")) {
    process.stdout.write(`${JSON.stringify({
      embeddingEvidenceDigest: embeddingDependency?.evidenceDigest ?? null,
      fingerprints: [...roleTargets.entries()].map(([role, target]) =>
        roleFingerprint(role, target)
      ).sort((left, right) => left.role.localeCompare(right.role)),
      providerCalls: 0,
      ready: true,
      roles: [...roleTargets.keys()].sort(),
      split
    }, null, 2)}\n`);
    await prisma.$disconnect();
    return;
  }
  const factTarget = roleTargets.get("MEMORY_FACT_EXTRACT")!;
  const consolidateTarget = roleTargets.get("MEMORY_CONSOLIDATE")!;
  const verifyTarget = roleTargets.get("MEMORY_VERIFY")!;
  const episodeTarget = roleTargets.get("MEMORY_EPISODE_EXTRACT")!;
  const pricingRow = await prisma.providerModel.findUniqueOrThrow({
    select: {
      inputTokenPriceMicros: true,
      outputTokenPriceMicros: true
    },
    where: { id: factTarget.authority.providerModelId }
  });
  const pricing = {
    inputTokenPriceMicros: pricingRow.inputTokenPriceMicros,
    outputTokenPriceMicros: pricingRow.outputTokenPriceMicros,
    reasoningTokenPriceMicros: pricingRow.outputTokenPriceMicros
  };

  const operations: MemoryOperationObservation[] = [];
  const providerCalls: Array<Readonly<{
    acceptedDestination: boolean;
    remoteCallsAllowed: boolean;
  }>> = [];
  const acceptedDestinationKeys = new Set([...roleTargets].map(([role, target]) =>
    `${role}:${target.destinationFingerprint}`
  ));
  const observeProviderCall = (
    role: MemoryExecutionRole,
    remoteCallsAllowed: boolean
  ): void => {
    const target = roleTargets.get(role);
    providerCalls.push({
      acceptedDestination: Boolean(target && acceptedDestinationKeys.has(
        `${role}:${target.destinationFingerprint}`
      )),
      remoteCallsAllowed
    });
  };
  const diagnostics: Record<string, number> = {};
  const counters: Record<"extraction" | "consolidation" | "verification" | "episode", RoleCounters> = {
    consolidation: { calls: 0, decodeFailures: 0, providerFailures: 0 },
    episode: { calls: 0, decodeFailures: 0, providerFailures: 0 },
    extraction: { calls: 0, decodeFailures: 0, providerFailures: 0 },
    verification: { calls: 0, decodeFailures: 0, providerFailures: 0 }
  };

  failureStage = "extraction";
  const eligibleSources = sources.filter(({ fixture }) =>
    fixture.expectedEgress.remoteCallsAllowed &&
    fixture.expectedLifecycle.sourceEligible &&
    !hasExplicitMemoryMutation(fixture)
  );
  const grouped = new Map<string, FixtureSource[]>();
  for (const source of eligibleSources) {
    const key = `${source.fixture.language}:${source.fixture.cohort}`;
    const values = grouped.get(key) ?? [];
    values.push(source);
    grouped.set(key, values);
  }
  const extractionBatches = [...grouped.values()].flatMap((values) =>
    batches(values, EXTRACTION_BATCH_SIZE)
  );
  const factProvider = createAcceptedMemoryFactProvider(prisma);
  const extractedBatches = await mapConcurrent(
    extractionBatches,
    workerCount,
    "extraction",
    async (batch, index) => {
      const input = factInput(batch, index);
      counters.extraction.calls += 1;
      const startedAt = performance.now();
      try {
        const attempt = await runWithQualificationRetry({
          diagnostics,
          label: "extraction",
          run: () => {
            observeProviderCall(
              "MEMORY_FACT_EXTRACT",
              batch.every(({ fixture }) => fixture.expectedEgress.remoteCallsAllowed)
            );
            return factProvider.run(
              targetEvidence(factTarget),
              input,
              AbortSignal.timeout(300_000)
            );
          }
        });
        const result = attempt.result;
        operations.push(operationObservation(
          "MEMORY_FACT_EXTRACT",
          result.usage,
          performance.now() - startedAt,
          pricing,
          attempt.retries
        ));
        try {
          return { batch, input, plan: decodeMemoryFactExtraction(result.toolCalls, input) };
        } catch (error) {
          counters.extraction.decodeFailures += 1;
          incrementDiagnostic(
            diagnostics,
            `extraction:${batch[0]!.fixture.language}:${batch[0]!.fixture.cohort}:${safeFailureCode(error)}`
          );
          return { batch, input, plan: null };
        }
      } catch (error) {
        counters.extraction.providerFailures += 1;
        incrementDiagnostic(
          diagnostics,
          `extraction-provider:${safeFailureCode(error)}`
        );
        return { batch, input, plan: null };
      }
    }
  );
  const assessments = new Map<string, ExtractionAssessment>();
  for (const source of sources) {
    assessments.set(source.fixture.id, {
      called: false,
      candidates: [],
      decodeValid: true,
      foreignCandidate: false,
      source
    });
  }
  for (const result of extractedBatches) {
    const messageIds = new Set(result.batch.map(({ message }) => message.id));
    const candidates = result.plan?.candidates ?? [];
    const foreignCandidate = candidates.some((candidate) =>
      candidate.evidence.some(({ messageId }) => !messageIds.has(messageId)) ||
      new Set(candidate.evidence.map(({ messageId }) => messageId)).size !== 1
    );
    for (const source of result.batch) {
      const associated = candidates.filter((candidate) =>
        candidate.evidence.some(({ messageId }) => messageId === source.message.id)
      );
      assessments.set(source.fixture.id, {
        called: true,
        candidates: associated,
        decodeValid: result.plan !== null,
        foreignCandidate,
        source
      });
    }
  }
  const extractionScores = extractionOutcomes(
    [...assessments.values()],
    diagnostics
  );

  failureStage = "consolidation";
  const decisionProvider = createAcceptedMemoryFactDecisionProvider(prisma);
  const matrices = memoryLearningMatrixCases(
    {
      EN: memoryLearningMatrixBaseCandidate("EN"),
      RU: memoryLearningMatrixBaseCandidate("RU")
    },
    matrixRepetitions
  );
  const consolidationResults = await mapConcurrent(
    matrices,
    decisionWorkerCount,
    "consolidation",
    async (matrix) => {
      counters.consolidation.calls += 1;
      const startedAt = performance.now();
      try {
        const attempt = await runWithQualificationRetry({
          diagnostics,
          label: "consolidation",
          run: () => {
            observeProviderCall("MEMORY_CONSOLIDATE", true);
            return decisionProvider.run({
              ...targetEvidence(consolidateTarget),
              logicalRole: "MEMORY_CONSOLIDATE"
            }, { input: matrix.input, kind: "CONSOLIDATE" }, AbortSignal.timeout(300_000));
          }
        });
        const result = attempt.result;
        operations.push(operationObservation(
          "MEMORY_CONSOLIDATE",
          result.usage,
          performance.now() - startedAt,
          pricing,
          attempt.retries
        ));
        try {
          const plan = decodeMemoryFactConsolidation(result.toolCalls, matrix.input);
          const policyDecision = evaluateMemoryFactConsolidationPlan(matrix.input, plan);
          const correct = plan.operation === matrix.expected && policyDecision.status === "VALID";
          if (!correct) {
            incrementDiagnostic(
              diagnostics,
              `consolidation:${matrix.language}:${matrix.expected}:${plan.operation}:${policyDecision.status}`
            );
          }
          return { correct, input: matrix.input, language: matrix.language, plan };
        } catch (error) {
          counters.consolidation.decodeFailures += 1;
          incrementDiagnostic(
            diagnostics,
            `consolidation-decode:${matrix.language}:${matrix.expected}:${safeFailureCode(error)}`
          );
          return { correct: false, input: matrix.input, language: matrix.language, plan: null };
        }
      } catch (error) {
        counters.consolidation.providerFailures += 1;
        incrementDiagnostic(
          diagnostics,
          `consolidation-provider:${safeFailureCode(error)}`
        );
        return { correct: false, input: matrix.input, language: matrix.language, plan: null };
      }
    }
  );
  const binaryOutcomes = [...extractionScores];
  for (const result of consolidationResults) {
    addOutcome(
      binaryOutcomes,
      result.language,
      "CONSOLIDATION_OPERATION_ACCURACY",
      result.correct
    );
  }

  failureStage = "verification";
  const verificationInputs = memoryLearningVerificationCases(
    matrices,
    supportingCasesPerLanguage
  );
  const verificationResults = await mapConcurrent(
    verificationInputs,
    decisionWorkerCount,
    "verification",
    async (item) => {
      counters.verification.calls += 1;
      const startedAt = performance.now();
      try {
        const attempt = await runWithQualificationRetry({
          diagnostics,
          label: "verification",
          run: () => {
            observeProviderCall("MEMORY_VERIFY", true);
            return decisionProvider.run({
              ...targetEvidence(verifyTarget),
              logicalRole: "MEMORY_VERIFY"
            }, { input: item.input, kind: "VERIFY" }, AbortSignal.timeout(300_000));
          }
        });
        const result = attempt.result;
        operations.push(operationObservation(
          "MEMORY_VERIFY",
          result.usage,
          performance.now() - startedAt,
          pricing,
          attempt.retries
        ));
        const inspected = inspectMemoryFactVerificationOutput(
          result.toolCalls,
          item.input
        );
        const expected = item.expectedApprove
          ? "expected_approve"
          : "expected_non_approve";
        if (!inspected.ok) {
          counters.verification.decodeFailures += 1;
          incrementDiagnostic(
            diagnostics,
            `verification-contract:${item.language}:${item.operation}:${item.variant}:` +
              `${expected}:${inspected.issue}` +
              (inspected.missingRequiredKeys.length > 0
                ? `:missing_${inspected.missingRequiredKeys.join("+")}`
                : "") +
              (inspected.unexpectedKeyCount > 0
                ? `:unexpected_key_count_${inspected.unexpectedKeyCount}`
                : "") +
              (inspected.issue === "tool_call_missing"
                ? `:${result.outputKind}`
                : "") +
              `:${verificationUsageDiagnostic(result.usage)}`
          );
          return false;
        }
        const correct = item.expectedApprove
          ? inspected.plan.verdict === "APPROVE"
          : inspected.plan.verdict !== "APPROVE";
        if (!correct) {
          incrementDiagnostic(
            diagnostics,
            `verification-assessment:${item.language}:${item.operation}:${item.variant}:` +
              `${expected}:actual_${inspected.plan.verdict.toLowerCase()}`
          );
        }
        return correct;
      } catch (error) {
        counters.verification.providerFailures += 1;
        incrementDiagnostic(
          diagnostics,
          `verification-provider:${safeFailureCode(error)}`
        );
        return false;
      }
    }
  );

  failureStage = "episode";
  const episodeProvider = createAcceptedMemoryEpisodeProvider(prisma);
  const episodeSources = diverseEpisodeSources(sources, supportingCasesPerLanguage);
  const episodeResults = await mapConcurrent(
    episodeSources,
    workerCount,
    "episode",
    async (source, index) => {
      const input = episodeInput(source, index);
      if (!input) return false;
      counters.episode.calls += 1;
      const startedAt = performance.now();
      try {
        const attempt = await runWithQualificationRetry({
          diagnostics,
          label: "episode",
          run: () => {
            observeProviderCall(
              "MEMORY_EPISODE_EXTRACT",
              source.fixture.expectedEgress.remoteCallsAllowed
            );
            return episodeProvider.run(
              targetEvidence(episodeTarget),
              input,
              AbortSignal.timeout(300_000)
            );
          }
        });
        const result = attempt.result;
        operations.push(operationObservation(
          "MEMORY_EPISODE_EXTRACT",
          result.usage,
          performance.now() - startedAt,
          pricing,
          attempt.retries
        ));
        try {
          const plan = decodeMemoryEpisodeExtraction(result.toolCalls, input);
          return plan.episodes.length === 1 &&
            plan.episodes[0]!.messageIds.includes(source.message.id) &&
            source.message.text.includes(plan.episodes[0]!.safeSummary);
        } catch (error) {
          counters.episode.decodeFailures += 1;
          incrementDiagnostic(
            diagnostics,
            `episode-decode:${source.fixture.language}:${safeFailureCode(error)}`
          );
          return false;
        }
      } catch (error) {
        counters.episode.providerFailures += 1;
        incrementDiagnostic(diagnostics, `episode-provider:${safeFailureCode(error)}`);
        return false;
      }
    }
  );

  failureStage = "scoring";
  const binary = scoreMemoryBinaryOutcomes(binaryOutcomes);
  const requiredMetrics = [
    "AUTOMATIC_FACT_PRECISION",
    "CONSOLIDATION_OPERATION_ACCURACY",
    "TEMPORAL_CURRENT_HISTORY_ACCURACY",
    "LANGUAGE_PRESERVING_DISPLAY_TEXT",
    "EVIDENCE_ID_VALIDITY"
  ] as const;
  const required = binary.filter(({ cohort, metric }) =>
    cohort === "overall" && requiredMetrics.includes(metric as typeof requiredMetrics[number])
  );
  const qualityCoverageComplete = required.length === requiredMetrics.length * 2;
  const qualityPassed = qualityCoverageComplete && required.every(({ gatePassed }) =>
    gatePassed === true
  );
  const verifierByLanguage = Object.fromEntries((["RU", "EN"] as const).map((language) => {
    const selected = verificationResults.filter((_, index) =>
      verificationInputs[index]!.language === language
    );
    return [language, manualBinaryGate(selected)];
  }));
  const episodeByLanguage = Object.fromEntries((["RU", "EN"] as const).map((language) => {
    const selected = episodeResults.filter((_, index) =>
      episodeSources[index]!.fixture.language === language
    );
    return [language, manualBinaryGate(selected)];
  }));
  const supportingRolesPassed = Object.values(verifierByLanguage).every(({ passed }) => passed) &&
    Object.values(episodeByLanguage).every(({ passed }) => passed);
  const hardGates = scoreMemoryAutomaticLearningHardGates({
    promotions: [...assessments.values()].map((assessment) => ({
      promotableCandidateCount: assessment.candidates.filter((candidate) =>
        candidate.state === "PENDING" && !candidate.negated
      ).length,
      secretOrHighlySensitive: secretOrHighlySensitiveFixture(
        assessment.source.fixture
      )
    })),
    providerCalls
  });
  const hardGatesPassed = Object.values(hardGates).every((failures) => failures === 0);
  // A provider failure is an observed availability event, not a false durable
  // fact. Every such call fails safe to zero decoded candidates and remains
  // visible in counters/coverage/operation evidence. Quality and safety gates
  // therefore decide release without demanding an unrealistic zero-timeout
  // sample across hundreds of live requests.
  const passed = qualityPassed && supportingRolesPassed && hardGatesPassed;
  const evidence = {
    adapter: {
      fingerprints: [...roleTargets.entries()].map(([role, target]) =>
        roleFingerprint(role, target)
      ).sort((left, right) => left.role.localeCompare(right.role)),
      kind: "AIQSA_NATIVE",
      liveProvider: true,
      version: MEMORY_AUTOMATIC_LEARNING_EVALUATOR_VERSION
    },
    corpus: {
      evaluatedFixtures: fixtures.length,
      fullSplitFixtures: corpus.length,
      hash: manifest.splits[split].contentHash,
      split,
      version: manifest.corpusVersion
    },
    counters,
    dependencies: {
      embeddingHoldout: embeddingDependency
    },
    diagnostics,
    evaluatedAt: new Date().toISOString(),
    evidenceVersion: MEMORY_AUTOMATIC_LEARNING_EVIDENCE_VERSION,
    hardGates,
    operations: scoreMemoryOperations(operations),
    passed,
    quality: {
      binary,
      coverageComplete: qualityCoverageComplete,
      gatePassed: qualityPassed,
      supportingRoles: {
        episode: episodeByLanguage,
        verification: verifierByLanguage
      }
    },
    sanitizedAggregatesOnly: true,
    versions: [
      versionEvidence("MEMORY_DOCUMENT_EMBED", MEMORY_ITEM_EMBEDDING_VERSIONS),
      versionEvidence("MEMORY_EPISODE_EXTRACT", MEMORY_EPISODE_EXTRACTION_VERSIONS),
      versionEvidence("MEMORY_FACT_EXTRACT", MEMORY_FACT_EXTRACTION_VERSIONS),
      versionEvidence("MEMORY_CONSOLIDATE", MEMORY_FACT_CONSOLIDATION_VERSIONS),
      versionEvidence("MEMORY_VERIFY", MEMORY_FACT_VERIFICATION_VERSIONS),
      versionEvidence("MEMORY_QUERY_EMBED", MEMORY_QUERY_EMBEDDING_VERSIONS)
    ],
    suite: {
      bootstrapSeed: BOOTSTRAP_SEED,
      concurrency: workerCount,
      decisionConcurrency: decisionWorkerCount,
      extractionBatchSize: EXTRACTION_BATCH_SIZE,
      extractionScorer: MEMORY_AUTOMATIC_FACT_PRECISION_SCORER_VERSION,
      generator: manifest.generatorVersion,
      manifest: manifest.manifestVersion,
      matrixRepetitions,
      maximumProviderAttempts: 2,
      schema: manifest.schemaVersion,
      scorer: MEMORY_EVALUATION_SCORER_VERSION,
      selectedCasesPerCohort: limit,
      selectedCohorts: cohortSelection === null
        ? null
        : [...cohortSelection].sort(),
      supportingCasesPerLanguage,
      version: MEMORY_AUTOMATIC_LEARNING_SUITE_VERSION
    }
  };
  const persistedEvidence = JSON.parse(JSON.stringify(evidence)) as unknown;
  const evidenceDigest = memoryEvaluationSha256(persistedEvidence);
  failureStage = "output";
  await mkdir(dirname(outputPath), { mode: 0o700, recursive: true });
  await writeFile(outputPath, `${JSON.stringify({
    evidence: persistedEvidence,
    evidenceDigest
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    evidenceDigest,
    evaluatedFixtures: fixtures.length,
    outputPath: relative(process.cwd(), outputPath),
    passed,
    split
  }, null, 2)}\n`);
  await prisma.$disconnect();
}

const directModuleUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (directModuleUrl === import.meta.url) {
  void main().catch(async (error: unknown) => {
    const code = error instanceof Error && /^memory_[a-z0-9_]+$/u.test(error.message)
      ? error.message
      : "memory_learning_evaluation_failed";
    process.stderr.write(`${code}:${failureStage}\n`);
    process.exitCode = 1;
    await prisma.$disconnect().catch(() => undefined);
  });
}

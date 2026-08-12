import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { Prisma } from "@prisma/client";
import {
  MEMORY_RETRIEVAL_MINIMUM_VECTOR_SCORE,
  MEMORY_RETRIEVAL_PIPELINE_VERSION
} from "../lib/domain/memory/retrieval";
import type {
  MemoryEvaluationLanguage,
  MemoryOperationObservation
} from "../lib/evaluation/memory/contracts";
import {
  deriveMemoryEvaluationSeed,
  memoryEvaluationSha256
} from "../lib/evaluation/memory/canonical";
import {
  MEMORY_PHASE7_ABLATION_STAGES,
  MEMORY_PHASE7_BOOTSTRAP_SAMPLES,
  MEMORY_PHASE7_CORPUS_VERSION,
  MEMORY_PHASE7_EVALUATOR_VERSION,
  MEMORY_PHASE7_EVIDENCE_VERSION,
  MEMORY_PHASE7_HINDSIGHT_REFERENCE,
  MEMORY_PHASE7_MATERIAL_LIFT,
  MEMORY_PHASE7_RANDOM_SEED,
  MEMORY_PHASE7_SCORER_VERSION,
  MEMORY_PHASE7_SUITE_VERSION,
  decideMemoryPhase7CoreMateriality,
  decideMemoryPhase7OptionalComponent,
  memoryPhase7EvidenceIdentityIsCurrent,
  type MemoryPhase7AblationStage,
  type MemoryPhase7LanguageScore
} from "../lib/evaluation/memory/phase7";
import {
  MEMORY_PHASE7_ABLATION_EVALUATOR_VERSION,
  evaluateMemoryPhase7AblationStage,
  memoryPhase7AblationEmbeddingTexts,
  memoryPhase7AblationPairKey,
  type MemoryPhase7CaseObservation,
  type MemoryPhase7StageEvaluation
} from "../lib/evaluation/memory/phase7Ablation";
import {
  scoreMemoryOperations,
  stratifiedBootstrap95,
  wilson95
} from "../lib/evaluation/memory/scorers";
import { MEMORY_RETRIEVAL_PLANNER_VERSION } from
  "../lib/domain/memory/retrieval/planner";
import { createPrismaEmbeddingRuntime } from
  "../lib/server/providerRuntime/embeddingRuntime";
import { ProviderAdmissionError } from
  "../lib/server/providerRuntime/admission";
import {
  EmbeddingAdapterError,
  MAX_EMBEDDING_BATCH_INPUTS
} from "../lib/server/providers/embeddings";
import { prisma } from "../lib/server/prisma";
import {
  MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
} from "../lib/server/memory/retrieval/vector";
import {
  buildMemoryPhase7AblationCases,
  MEMORY_PHASE7_ABLATION_CASE_BUILDER_VERSION
} from "../tests/fixtures/memory-evaluation/phase7AblationCases";
import { loadMemoryTuningCorpus } from
  "../tests/fixtures/memory-evaluation/tuning/corpus";

const TUNING_THRESHOLDS = [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75] as const;
const LEXICAL_PAIR_BATCH_SIZE = 2_000;
let failureStage = "startup";

type Split = "HOLDOUT" | "TUNING";
type CorpusManifest = Readonly<{
  corpusVersion: string;
  generatorVersion: string;
  manifestVersion: string;
  schemaVersion: string;
  splits: Readonly<Record<Split, Readonly<{ contentHash: string }>>>;
}>;

function hasArgument(value: string): boolean {
  return process.argv.slice(2).includes(value);
}

function argumentValue(prefix: string): string | null {
  return process.argv.slice(2).find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length).trim() || null;
}

function selectedSplit(): Split {
  if (hasArgument("--split=tuning")) return "TUNING";
  if (hasArgument("--split=holdout")) return "HOLDOUT";
  throw new Error("memory_phase7_ablation_split_required");
}

function privateEvidenceOutputPath(): string {
  const value = argumentValue("--evidence-output=");
  if (!value) throw new Error("memory_phase7_ablation_evidence_output_required");
  const privateRoot = resolve(".aiqsa");
  const target = resolve(value);
  if (target === privateRoot || !target.startsWith(`${privateRoot}${sep}`)) {
    throw new Error("memory_phase7_ablation_evidence_output_invalid");
  }
  return target;
}

async function loadManifest(): Promise<CorpusManifest> {
  const parsed = JSON.parse(await readFile(
    "tests/fixtures/memory-evaluation/manifests/corpus-v2.json",
    "utf8"
  )) as CorpusManifest;
  if (
    parsed.corpusVersion !== MEMORY_PHASE7_CORPUS_VERSION ||
    !/^[a-f0-9]{64}$/u.test(parsed.splits.TUNING.contentHash) ||
    !/^[a-f0-9]{64}$/u.test(parsed.splits.HOLDOUT.contentHash)
  ) throw new Error("memory_phase7_ablation_manifest_invalid");
  return parsed;
}

function requireLiveAuthorization(split: Split, manifest: CorpusManifest): void {
  if (!hasArgument("--authorized-live-provider")) {
    throw new Error("memory_phase7_ablation_live_provider_authorization_required");
  }
  if (split === "HOLDOUT" && !hasArgument(
    `--holdout-corpus-hash=${manifest.splits.HOLDOUT.contentHash}`
  )) throw new Error("memory_phase7_ablation_holdout_hash_authorization_required");
}

function selectedThreshold(split: Split): number | null {
  const raw = argumentValue("--minimum-vector-score=");
  if (split === "TUNING") {
    if (raw !== null) throw new Error("memory_phase7_ablation_tuning_threshold_forbidden");
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value !== MEMORY_RETRIEVAL_MINIMUM_VECTOR_SCORE) {
    throw new Error("memory_phase7_ablation_holdout_threshold_invalid");
  }
  return value;
}

async function loadCorpus(split: Split) {
  if (split === "TUNING") return loadMemoryTuningCorpus();
  const { loadMemoryHoldoutCorpus } = await import(
    "../tests/fixtures/memory-evaluation/holdout/corpus"
  );
  return loadMemoryHoldoutCorpus({
    expectedCorpusVersion: MEMORY_PHASE7_CORPUS_VERSION,
    purpose: "SCORING_ONLY"
  });
}

async function selectedEmbeddingAuthority() {
  const users = await prisma.user.findMany({
    select: { id: true },
    where: { role: "admin", status: "active" }
  });
  if (users.length !== 1) throw new Error("memory_phase7_ablation_admin_ambiguous");
  const models = await prisma.providerModel.findMany({
    select: { activeConfig: true, id: true },
    where: { activatedAt: { not: null }, enabled: true }
  });
  const eligible = models.filter(({ activeConfig }) =>
    activeConfig && typeof activeConfig === "object" && !Array.isArray(activeConfig) &&
    activeConfig.modelClass === "embedding" &&
    activeConfig.upstreamModelId === MEMORY_PHASE7_HINDSIGHT_REFERENCE.embeddingModel
  );
  if (eligible.length !== 1) {
    throw new Error("memory_phase7_ablation_embedding_model_ambiguous");
  }
  return { providerModelId: eligible[0]!.id, userId: users[0]!.id };
}

function batches<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function estimatedCostUsd(
  inputTokens: number | null,
  inputTokenPriceMicros: number
): number | null {
  if (inputTokens === null || inputTokenPriceMicros <= 0) return null;
  return inputTokens * inputTokenPriceMicros / 1_000_000;
}

type EmbeddingAdapter = Awaited<ReturnType<
  ReturnType<typeof createPrismaEmbeddingRuntime>["resolveForUser"]
>>["adapter"];

async function embed(input: Readonly<{
  adapter: EmbeddingAdapter;
  inputTokenPriceMicros: number;
  mode: "document" | "query";
  texts: readonly string[];
}>): Promise<Readonly<{
  operations: readonly MemoryOperationObservation[];
  requestIdsPresent: number;
  vectors: ReadonlyMap<string, readonly number[]>;
}>> {
  const operations: MemoryOperationObservation[] = [];
  const vectors = new Map<string, readonly number[]>();
  let requestIdsPresent = 0;
  for (const batch of batches(input.texts, MAX_EMBEDDING_BATCH_INPUTS)) {
    const startedAt = performance.now();
    const result = await input.adapter.embed({ mode: input.mode, texts: batch });
    if (result.requestId) requestIdsPresent += 1;
    batch.forEach((text, index) => vectors.set(text, result.vectors[index]!));
    operations.push({
      estimatedCostUsd: estimatedCostUsd(
        result.usage.inputTokens,
        input.inputTokenPriceMicros
      ),
      inputTokens: result.usage.inputTokens,
      latencyMs: performance.now() - startedAt,
      outputTokens: 0,
      retries: 0,
      role: input.mode === "document" ? "MEMORY_DOCUMENT_EMBED" : "MEMORY_QUERY_EMBED"
    });
  }
  return { operations, requestIdsPresent, vectors };
}

type LexicalRow = Readonly<{
  candidate_key: string;
  case_key: string;
  document_text: string;
  terms: readonly string[];
}>;

async function postgresLexicalScores(
  cases: ReturnType<typeof buildMemoryPhase7AblationCases>
): Promise<Readonly<{
  latencyMs: number;
  pairCount: number;
  scores: ReadonlyMap<string, number>;
}>> {
  const rows: LexicalRow[] = cases.flatMap((current) => {
    const terms = [...new Set(current.lexicalTerms.flatMap((term) =>
      term.match(/[\p{L}\p{N}]+/gu) ?? []
    ))];
    return terms.length === 0 ? [] : current.candidates.map((candidate) => ({
      candidate_key: candidate.key,
      case_key: current.key,
      document_text: candidate.text,
      terms
    }));
  });
  const scores = new Map<string, number>();
  let latencyMs = 0;
  for (const batch of batches(rows, LEXICAL_PAIR_BATCH_SIZE)) {
    const startedAt = performance.now();
    const result = await prisma.$queryRaw<Array<{
      candidate_key: string;
      case_key: string;
      score: number;
    }>>(Prisma.sql`
      WITH pairs AS MATERIALIZED (
        SELECT *
        FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS pair(
          candidate_key text,
          case_key text,
          document_text text,
          terms jsonb
        )
      ),
      expanded AS MATERIALIZED (
        SELECT
          pair.candidate_key,
          pair.case_key,
          pair.document_text,
          term.value #>> '{}' AS term
        FROM pairs AS pair
        CROSS JOIN LATERAL jsonb_array_elements(pair.terms) AS term(value)
      ),
      prepared AS MATERIALIZED (
        SELECT
          candidate_key,
          case_key,
          to_tsvector('english', document_text) AS vector_en,
          to_tsvector('russian', replace(document_text, 'ё', 'е')) AS vector_ru,
          to_tsvector('simple', replace(document_text, 'ё', 'е')) AS vector_simple,
          plainto_tsquery('english', term) AS query_en,
          plainto_tsquery('russian', replace(term, 'ё', 'е')) AS query_ru,
          plainto_tsquery('simple', replace(term, 'ё', 'е')) AS query_simple
        FROM expanded
      ),
      scored AS (
        SELECT
          candidate_key,
          case_key,
          GREATEST(
            CASE WHEN vector_en @@ query_en THEN ts_rank_cd(vector_en, query_en) ELSE 0 END,
            CASE WHEN vector_ru @@ query_ru THEN ts_rank_cd(vector_ru, query_ru) ELSE 0 END,
            CASE WHEN vector_simple @@ query_simple
              THEN ts_rank_cd(vector_simple, query_simple) ELSE 0 END
          )::double precision AS score
        FROM prepared
      )
      SELECT candidate_key, case_key, MAX(score)::double precision AS score
      FROM scored
      GROUP BY candidate_key, case_key
    `);
    latencyMs += performance.now() - startedAt;
    for (const row of result) {
      if (row.score > 0) {
        scores.set(memoryPhase7AblationPairKey(row.case_key, row.candidate_key), row.score);
      }
    }
  }
  return { latencyMs, pairCount: rows.length, scores };
}

async function databaseVersions(): Promise<Readonly<{ pgvector: string; postgresql: string }>> {
  const rows = await prisma.$queryRaw<Array<{ pgvector: string; postgresql: string }>>`
    SELECT
      current_setting('server_version')::text AS postgresql,
      COALESCE((SELECT extversion FROM pg_extension WHERE extname = 'vector'), 'absent')::text
        AS pgvector
  `;
  if (rows.length !== 1) throw new Error("memory_phase7_ablation_database_unavailable");
  return rows[0]!;
}

function thresholdPass(score: MemoryPhase7StageEvaluation["score"]): boolean {
  return (["EN", "RU"] as const).every((language) => {
    const value = score[language];
    return value.hardInvariantFailures === 0 &&
      value.irrelevantInjectionRate <=
        MEMORY_PHASE7_MATERIAL_LIFT.irrelevantInjectionPointMaximum &&
      value.irrelevantInjectionUpper95 <=
        MEMORY_PHASE7_MATERIAL_LIFT.irrelevantInjectionUpperMaximum &&
      value.recallAt5 >= 0.85 && value.temporalAccuracy >= 0.9 &&
      value.scopeAccuracy >= 0.9 &&
      Object.values(value.criticalRecallAt5).every((point) => point >= 0.85);
  });
}

function chooseTuningThreshold(
  values: readonly Readonly<{ evaluation: MemoryPhase7StageEvaluation; threshold: number }>[]
): number | null {
  return [...values].filter(({ evaluation }) => thresholdPass(evaluation.score))
    .sort((left, right) => {
      const minimum = (value: MemoryPhase7StageEvaluation) => Math.min(
        value.score.EN.recallAt5,
        value.score.RU.recallAt5
      );
      return minimum(right.evaluation) - minimum(left.evaluation) ||
        Math.min(
          right.evaluation.score.EN.temporalAccuracy,
          right.evaluation.score.RU.temporalAccuracy
        ) - Math.min(
          left.evaluation.score.EN.temporalAccuracy,
          left.evaluation.score.RU.temporalAccuracy
        ) || left.threshold - right.threshold;
    })[0]?.threshold ?? null;
}

function intervalEvidence(
  observations: readonly MemoryPhase7CaseObservation[]
) {
  return Object.fromEntries(((["EN", "RU"] as const).map((language) => {
    const values = observations.filter((current) => current.language === language);
    const recall = values.filter((current) => current.recallAt5 !== null);
    const scope = values.filter((current) => current.scopeCorrect !== null);
    const temporal = values.filter((current) => current.temporalCorrect !== null);
    const irrelevant = values.filter((current) => current.irrelevant).length;
    return [language, {
      irrelevantInjection: wilson95(irrelevant, values.length),
      recallAt5: stratifiedBootstrap95(recall.map((current) => ({
        score: current.recallAt5!,
        stratum: current.cohort
      })), {
        samples: MEMORY_PHASE7_BOOTSTRAP_SAMPLES,
        seed: deriveMemoryEvaluationSeed(MEMORY_PHASE7_RANDOM_SEED, `${language}:recall`)
      }),
      scopeAccuracy: wilson95(
        scope.filter((current) => current.scopeCorrect).length,
        scope.length
      ),
      temporalAccuracy: wilson95(
        temporal.filter((current) => current.temporalCorrect).length,
        temporal.length
      )
    }];
  }))) as Record<MemoryEvaluationLanguage, Readonly<{
    irrelevantInjection: ReturnType<typeof wilson95>;
    recallAt5: ReturnType<typeof stratifiedBootstrap95>;
    scopeAccuracy: ReturnType<typeof wilson95>;
    temporalAccuracy: ReturnType<typeof wilson95>;
  }>>;
}

function releasePass(
  score: MemoryPhase7StageEvaluation["score"],
  intervals: ReturnType<typeof intervalEvidence>
): boolean {
  return (["EN", "RU"] as const).every((language) => {
    const value = score[language];
    const interval = intervals[language];
    return value.hardInvariantFailures === 0 &&
      value.recallAt5 >= 0.85 && interval.recallAt5.lower >= 0.8 &&
      value.irrelevantInjectionRate <= 0.03 &&
      interval.irrelevantInjection.upper <= 0.05 &&
      value.temporalAccuracy >= 0.9 && interval.temporalAccuracy.lower >= 0.85 &&
      value.scopeAccuracy >= 0.9 && interval.scopeAccuracy.lower >= 0.85 &&
      Object.values(value.criticalRecallAt5).every((point) => point >= 0.85);
  });
}

const hardCapabilityStages = new Set<MemoryPhase7AblationStage>([
  "EXACT_CHUNK_FTS",
  "EPISODES",
  "SEMANTIC_FACTS",
  "TEMPORAL_SCOPE_TEMPERATURE",
  "BOUNDED_HISTORY_TOOL"
]);

function stageEvidence(
  stages: readonly MemoryPhase7StageEvaluation[]
) {
  return stages.map((current, index) => {
    const previous = stages[index - 1];
    const decision = previous
      ? current.stage === "MULTILINGUAL_RERANKER"
        ? decideMemoryPhase7OptionalComponent({
            costUsdPerEligibleQuery: 0,
            current: current.score,
            latencyP95Ms: 0,
            previous: previous.score
          })
        : decideMemoryPhase7CoreMateriality({
            current: current.score,
            hardCapabilityAfter: hardCapabilityStages.has(current.stage),
            hardCapabilityBefore: false,
            previous: previous.score
          })
      : null;
    return {
      cases: current.cases,
      decision,
      irrelevantInjections: current.irrelevantInjections,
      retrievalContamination: current.retrievalContamination,
      score: current.score,
      selectedCandidates: current.selectedCandidates,
      stage: current.stage
    };
  });
}

async function main(): Promise<void> {
  failureStage = "arguments";
  const split = selectedSplit();
  const outputPath = privateEvidenceOutputPath();
  const manifest = await loadManifest();
  requireLiveAuthorization(split, manifest);
  const frozenThreshold = selectedThreshold(split);

  failureStage = "corpus";
  const fixtures = await loadCorpus(split);
  const cases = buildMemoryPhase7AblationCases(fixtures);
  const texts = memoryPhase7AblationEmbeddingTexts(cases);

  failureStage = "authority";
  const authority = await selectedEmbeddingAuthority();
  const binding = await createPrismaEmbeddingRuntime(prisma).resolveForUser(authority);
  const pricing = await prisma.providerModel.findUniqueOrThrow({
    select: { inputTokenPriceMicros: true },
    where: { id: authority.providerModelId }
  });
  const versions = await databaseVersions();
  if (hasArgument("--preflight-only")) {
    process.stdout.write(`${JSON.stringify({
      candidatePairs: cases.reduce((sum, current) => sum + current.candidates.length, 0),
      cases: cases.length,
      documentTexts: texts.documents.length,
      embeddingModel: binding.configuration.upstreamModelId,
      pricingConfigured: pricing.inputTokenPriceMicros > 0,
      providerCalls: 0,
      queryTexts: texts.queries.length,
      split
    }, null, 2)}\n`);
    await prisma.$disconnect();
    return;
  }

  failureStage = "lexical";
  const lexical = await postgresLexicalScores(cases);
  failureStage = "embedding";
  const documents = await embed({
    adapter: binding.adapter,
    inputTokenPriceMicros: pricing.inputTokenPriceMicros,
    mode: "document",
    texts: texts.documents
  });
  const queries = await embed({
    adapter: binding.adapter,
    inputTokenPriceMicros: pricing.inputTokenPriceMicros,
    mode: "query",
    texts: texts.queries
  });

  failureStage = "scoring";
  const tuningLadder = split === "TUNING"
    ? TUNING_THRESHOLDS.map((threshold) => ({
        evaluation: evaluateMemoryPhase7AblationStage({
          cases,
          documentVectors: documents.vectors,
          lexicalScores: lexical.scores,
          minimumVectorScore: threshold,
          queryVectors: queries.vectors,
          stage: "TEMPORAL_SCOPE_TEMPERATURE"
        }),
        threshold
      }))
    : [];
  const threshold = frozenThreshold ?? chooseTuningThreshold(tuningLadder) ??
    MEMORY_RETRIEVAL_MINIMUM_VECTOR_SCORE;
  const stages = MEMORY_PHASE7_ABLATION_STAGES.map((stage) =>
    evaluateMemoryPhase7AblationStage({
      cases,
      documentVectors: documents.vectors,
      lexicalScores: lexical.scores,
      minimumVectorScore: threshold,
      queryVectors: queries.vectors,
      stage
    })
  );
  const releaseStage = stages.find(({ stage }) =>
    stage === "TEMPORAL_SCOPE_TEMPERATURE"
  )!;
  const intervals = intervalEvidence(releaseStage.observations);
  const qualityPassed = releasePass(releaseStage.score, intervals);
  const identity = {
    bootstrapSamples: MEMORY_PHASE7_BOOTSTRAP_SAMPLES,
    corpusHash: manifest.splits[split].contentHash,
    corpusVersion: MEMORY_PHASE7_CORPUS_VERSION,
    evaluatorVersion: MEMORY_PHASE7_EVALUATOR_VERSION,
    evidenceVersion: MEMORY_PHASE7_EVIDENCE_VERSION,
    randomSeed: MEMORY_PHASE7_RANDOM_SEED,
    scorerVersion: MEMORY_PHASE7_SCORER_VERSION,
    suiteVersion: MEMORY_PHASE7_SUITE_VERSION
  };
  const evidence = {
    adapter: {
      fingerprints: {
        configuration: memoryEvaluationSha256(binding.configuration),
        deployment: memoryEvaluationSha256({
          connectionId: binding.connectionId,
          connectionVersion: binding.connectionVersion,
          modelVersion: binding.modelVersion,
          providerModelId: binding.providerModelId
        }),
        execution: memoryEvaluationSha256(binding.executionSnapshot),
        model: memoryEvaluationSha256({
          embedding: binding.configuration.embedding,
          upstreamModelId: binding.configuration.upstreamModelId
        }),
        provider: memoryEvaluationSha256(binding.provider),
        vectorSpace: memoryEvaluationSha256({
          adapterKind: binding.configuration.adapterKind,
          embedding: binding.configuration.embedding,
          upstreamModelId: binding.configuration.upstreamModelId
        })
      },
      kind: "AIQSA_NATIVE",
      liveProvider: true,
      version: MEMORY_PHASE7_ABLATION_EVALUATOR_VERSION
    },
    capabilityPolicy: {
      profileWorkingSet: "PENDING_SEPARATE_GATE",
      queryExpansion: "OFF_NO_MEASURED_LIFT",
      remoteReranker: "OFF_NO_MEASURED_LIFT"
    },
    corpus: {
      cases: cases.length,
      distractorConstruction: MEMORY_PHASE7_ABLATION_CASE_BUILDER_VERSION,
      hash: manifest.splits[split].contentHash,
      split,
      version: manifest.corpusVersion
    },
    evaluatedAt: new Date().toISOString(),
    evidenceVersion: MEMORY_PHASE7_EVIDENCE_VERSION,
    intervals,
    localLexical: {
      latencyMs: lexical.latencyMs,
      pairCount: lexical.pairCount,
      perCaseMeanMs: lexical.latencyMs / cases.length
    },
    operations: scoreMemoryOperations([...documents.operations, ...queries.operations]),
    passed: split === "HOLDOUT" && qualityPassed &&
      memoryPhase7EvidenceIdentityIsCurrent(identity),
    providerRequests: {
      documents: documents.operations.length,
      queries: queries.operations.length,
      requestIdsPresent: documents.requestIdsPresent + queries.requestIdsPresent
    },
    qualityPassed,
    sanitizedAggregatesOnly: true,
    stages: stageEvidence(stages),
    threshold,
    tuningThresholdLadder: split === "TUNING"
      ? tuningLadder.map(({ evaluation, threshold: current }) => ({
          passed: thresholdPass(evaluation.score),
          score: evaluation.score,
          threshold: current
        }))
      : undefined,
    versions: {
      ...identity,
      ablationEvaluator: MEMORY_PHASE7_ABLATION_EVALUATOR_VERSION,
      caseBuilder: MEMORY_PHASE7_ABLATION_CASE_BUILDER_VERSION,
      generator: manifest.generatorVersion,
      manifest: manifest.manifestVersion,
      pgvector: versions.pgvector,
      pipeline: MEMORY_RETRIEVAL_PIPELINE_VERSION,
      planner: MEMORY_RETRIEVAL_PLANNER_VERSION,
      postgresql: versions.postgresql,
      schema: manifest.schemaVersion,
      vectorConfig: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
      vectorPipeline: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
    }
  };

  failureStage = "output";
  const persisted = JSON.parse(JSON.stringify(evidence)) as unknown;
  const evidenceDigest = memoryEvaluationSha256(persisted);
  await mkdir(dirname(outputPath), { mode: 0o700, recursive: true });
  await writeFile(outputPath, `${JSON.stringify({
    evidence: persisted,
    evidenceDigest
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    evidenceDigest,
    outputPath: relative(process.cwd(), outputPath),
    passed: evidence.passed,
    qualityPassed,
    releaseScore: releaseStage.score,
    split,
    threshold
  }, null, 2)}\n`);
  await prisma.$disconnect();
}

void main().catch(async (error: unknown) => {
  const code = error instanceof EmbeddingAdapterError
    ? `memory_phase7_ablation_${error.code}`
    : error instanceof ProviderAdmissionError
      ? `memory_phase7_ablation_${error.code}`
      : error instanceof Error && /^memory_[a-z0-9_]+$/u.test(error.message)
        ? error.message
        : "memory_phase7_ablation_evaluation_failed";
  process.stderr.write(`${code}:${failureStage}\n`);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
});

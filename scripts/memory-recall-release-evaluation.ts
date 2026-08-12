import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { Prisma } from "@prisma/client";
import type { MemoryEvaluationLanguage, MemoryOperationObservation } from "../lib/evaluation/memory/contracts";
import {
  MEMORY_EVALUATION_SCORER_VERSION
} from "../lib/evaluation/memory/contracts";
import { memoryEvaluationSha256 } from "../lib/evaluation/memory/canonical";
import {
  evaluateMemoryRecallRelease,
  memoryRecallReleaseEmbeddingTexts,
  memoryRecallReleasePairKey,
  MEMORY_RECALL_RELEASE_EVIDENCE_VERSION,
  MEMORY_RECALL_RELEASE_EVALUATOR_VERSION,
  type MemoryRecallReleaseCase,
  type MemoryRecallReleaseEvaluation
} from "../lib/evaluation/memory/recallRelease";
import {
  scoreMemoryBinaryOutcomes,
  scoreMemoryOperations,
  scoreMemoryRankedOutcomes
} from "../lib/evaluation/memory/scorers";
import {
  MEMORY_RETRIEVAL_MINIMUM_VECTOR_SCORE,
  MEMORY_RETRIEVAL_PIPELINE_VERSION
} from "../lib/domain/memory/retrieval";
import { MEMORY_RETRIEVAL_PLANNER_VERSION } from "../lib/domain/memory/retrieval/planner";
import { createPrismaEmbeddingRuntime } from "../lib/server/providerRuntime/embeddingRuntime";
import { ProviderAdmissionError } from "../lib/server/providerRuntime/admission";
import {
  EmbeddingAdapterError,
  MAX_EMBEDDING_BATCH_INPUTS
} from "../lib/server/providers/embeddings";
import { prisma } from "../lib/server/prisma";
import {
  MEMORY_LOCAL_RETRIEVAL_REPOSITORY_VERSION
} from "../lib/server/memory/retrieval/localRepository";
import {
  MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
} from "../lib/server/memory/retrieval/vector";
import {
  buildMemoryRecallReleaseCases,
  MEMORY_RECALL_RELEASE_CASE_BUILDER_VERSION
} from "../tests/fixtures/memory-evaluation/recallReleaseCases";
import { loadMemoryTuningCorpus } from "../tests/fixtures/memory-evaluation/tuning/corpus";
import { MEMORY_CORPUS_VERSION } from "../tests/fixtures/memory-evaluation/shared/corpusTypes";

const BOOTSTRAP_SAMPLES = 10_000;
const RANDOM_SEED = 4_242;
const tuningThresholds = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5] as const;
let failureStage = "startup";

type Split = "TUNING" | "HOLDOUT";

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
  const value = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
  return value?.slice(prefix.length).trim() || null;
}

function privateEvidenceOutputPath(): string | null {
  const value = argumentValue("--evidence-output=");
  if (!value) return null;
  const privateRoot = resolve(".aiqsa");
  const target = resolve(value);
  if (target === privateRoot || !target.startsWith(`${privateRoot}${sep}`)) {
    throw new Error("memory_recall_evidence_output_invalid");
  }
  return target;
}

function selectedSplit(): Split {
  if (hasArgument("--split=tuning")) return "TUNING";
  if (hasArgument("--split=holdout")) return "HOLDOUT";
  throw new Error("memory_recall_evaluation_split_required");
}

function requireLiveAuthorization(split: Split, manifest: CorpusManifest): void {
  if (!hasArgument("--authorized-live-provider")) {
    throw new Error("memory_recall_live_provider_authorization_required");
  }
  if (split === "HOLDOUT" && !hasArgument(
    `--holdout-corpus-hash=${manifest.splits.HOLDOUT.contentHash}`
  )) {
    throw new Error("memory_recall_holdout_hash_authorization_required");
  }
}

async function loadManifest(): Promise<CorpusManifest> {
  const parsed = JSON.parse(await readFile(
    "tests/fixtures/memory-evaluation/manifests/corpus-v2.json",
    "utf8"
  )) as CorpusManifest;
  if (
    parsed.corpusVersion !== MEMORY_CORPUS_VERSION ||
    !/^[a-f0-9]{64}$/u.test(parsed.splits.TUNING.contentHash) ||
    !/^[a-f0-9]{64}$/u.test(parsed.splits.HOLDOUT.contentHash)
  ) {
    throw new Error("memory_recall_corpus_manifest_invalid");
  }
  return parsed;
}

async function loadCorpus(split: Split) {
  if (split === "TUNING") return loadMemoryTuningCorpus();
  const { loadMemoryHoldoutCorpus } = await import(
    "../tests/fixtures/memory-evaluation/holdout/corpus"
  );
  return loadMemoryHoldoutCorpus({
    expectedCorpusVersion: MEMORY_CORPUS_VERSION,
    purpose: "SCORING_ONLY"
  });
}

async function selectedEmbeddingAuthority() {
  const explicitUserId = process.env.AIQSA_MEMORY_EVALUATION_USER_ID?.trim();
  const upstreamModelId = argumentValue("--upstream-model=");
  if (!upstreamModelId || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(upstreamModelId)) {
    throw new Error("memory_recall_upstream_model_required");
  }
  const users = await prisma.user.findMany({
    select: { id: true },
    where: {
      status: "active",
      ...(explicitUserId ? { id: explicitUserId } : { role: "admin" })
    }
  });
  if (users.length !== 1) {
    throw new Error("memory_recall_embedding_authority_ambiguous");
  }
  const models = await prisma.providerModel.findMany({
    select: { activeConfig: true, id: true },
    where: { activatedAt: { not: null }, enabled: true }
  });
  const eligible = models.filter(({ activeConfig }) =>
    activeConfig && typeof activeConfig === "object" && !Array.isArray(activeConfig) &&
    activeConfig.modelClass === "embedding" &&
    activeConfig.upstreamModelId === upstreamModelId
  );
  if (eligible.length !== 1) throw new Error("memory_recall_embedding_model_ambiguous");
  return {
    providerModelId: eligible[0]!.id,
    userId: users[0]!.id
  };
}

function batches<T>(values: readonly T[]): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += MAX_EMBEDDING_BATCH_INPUTS) {
    result.push(values.slice(index, index + MAX_EMBEDDING_BATCH_INPUTS));
  }
  return result;
}

function estimatedCostUsd(inputTokens: number | null, inputTokenPriceMicros: number): number | null {
  return inputTokens === null ? null : inputTokens * inputTokenPriceMicros / 1_000_000;
}

async function embedTexts(input: Readonly<{
  adapter: Awaited<ReturnType<ReturnType<typeof createPrismaEmbeddingRuntime>["resolveForUser"]>>["adapter"];
  inputTokenPriceMicros: number;
  mode: "document" | "query";
  texts: readonly string[];
}>): Promise<Readonly<{
  operations: readonly MemoryOperationObservation[];
  requestIdsPresent: number;
  vectors: ReadonlyMap<string, readonly number[]>;
}>> {
  const vectors = new Map<string, readonly number[]>();
  const operations: MemoryOperationObservation[] = [];
  let requestIdsPresent = 0;
  for (const batch of batches(input.texts)) {
    const startedAt = performance.now();
    const result = await input.adapter.embed({ mode: input.mode, texts: batch });
    const latencyMs = performance.now() - startedAt;
    if (result.requestId) requestIdsPresent += 1;
    batch.forEach((text, index) => vectors.set(text, result.vectors[index]!));
    operations.push({
      estimatedCostUsd: estimatedCostUsd(
        result.usage.inputTokens,
        input.inputTokenPriceMicros
      ),
      inputTokens: result.usage.inputTokens,
      latencyMs,
      outputTokens: 0,
      retries: 0,
      role: input.mode === "document" ? "MEMORY_DOCUMENT_EMBED" : "MEMORY_QUERY_EMBED"
    });
  }
  return { operations, requestIdsPresent, vectors };
}

function profileSummary(
  result: MemoryRecallReleaseEvaluation,
  minimumVectorScore: number
) {
  const recall = Object.fromEntries((["RU", "EN"] as const).map((language) => {
    const outcomes = result.ranked.filter(({ language: current, outcome }) =>
      current === language && outcome.metric === "CURATED_RECALL_AT_5" &&
      outcome.cohort === "overall"
    );
    return [language, outcomes.reduce((sum, { outcome }) => sum + outcome.score, 0) /
      outcomes.length];
  })) as Record<MemoryEvaluationLanguage, number>;
  const irrelevant = Object.fromEntries((["RU", "EN"] as const).map((language) => {
    const outcomes = result.binary.filter(({ language: current }) => current === language);
    return [language, outcomes.filter(({ outcome }) => outcome.positive).length / outcomes.length];
  })) as Record<MemoryEvaluationLanguage, number>;
  const failingCriticalCohorts = [...new Set(result.ranked.filter(({ outcome }) =>
    outcome.metric === "CURATED_RECALL_AT_5" && outcome.cohort !== "overall" &&
    outcome.score < 0.85
  ).map(({ outcome }) => outcome.cohort))].sort();
  return { failingCriticalCohorts, irrelevant, minimumVectorScore, recall };
}

async function databaseVersions(): Promise<Readonly<{ pgvector: string; postgresql: string }>> {
  const rows = await prisma.$queryRaw<Array<{ pgvector: string; postgresql: string }>>`
    SELECT
      current_setting('server_version')::text AS postgresql,
      COALESCE((SELECT extversion FROM pg_extension WHERE extname = 'vector'), 'absent')::text
        AS pgvector
  `;
  if (rows.length !== 1) throw new Error("memory_recall_database_version_unavailable");
  return rows[0]!;
}

async function postgresLexicalScores(cases: readonly MemoryRecallReleaseCase[]): Promise<Readonly<{
  latencyMs: number;
  pairCount: number;
  scores: ReadonlyMap<string, number>;
}>> {
  const rows = cases.flatMap((current) => {
    const terms = [...new Set(current.lexicalTerms.flatMap((term) =>
      term.match(/[\p{L}\p{N}]+/gu) ?? []
    ))];
    return current.candidates.map((candidate) => ({
      candidate_key: candidate.key,
      case_key: current.key,
      document_text: candidate.text,
      terms
    }));
  }).filter(({ terms }) => terms.length > 0);
  const startedAt = performance.now();
  const result = await prisma.$queryRaw<Array<{
    candidate_key: string;
    case_key: string;
    score: number;
  }>>(Prisma.sql`
    WITH pairs AS MATERIALIZED (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS pair(
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
  return {
    latencyMs: performance.now() - startedAt,
    pairCount: rows.length,
    scores: new Map(result.filter(({ score }) => score > 0).map((row) => [
      memoryRecallReleasePairKey(row.case_key, row.candidate_key),
      row.score
    ]))
  };
}

async function main(): Promise<void> {
  failureStage = "manifest";
  const manifest = await loadManifest();
  const split = selectedSplit();
  requireLiveAuthorization(split, manifest);
  failureStage = "corpus";
  const fixtures = await loadCorpus(split);
  const cases = buildMemoryRecallReleaseCases(fixtures);
  const texts = memoryRecallReleaseEmbeddingTexts(cases);
  const lexical = await postgresLexicalScores(cases);
  failureStage = "authority";
  const authority = await selectedEmbeddingAuthority();
  failureStage = "binding";
  const binding = await createPrismaEmbeddingRuntime(prisma).resolveForUser(authority);
  failureStage = "pricing";
  const pricing = await prisma.providerModel.findUnique({
    select: { inputTokenPriceMicros: true },
    where: { id: authority.providerModelId }
  });
  if (!pricing) throw new Error("memory_recall_embedding_pricing_unavailable");

  failureStage = "embedding";
  const versions = await databaseVersions();
  const documents = await embedTexts({
    adapter: binding.adapter,
    inputTokenPriceMicros: pricing.inputTokenPriceMicros,
    mode: "document",
    texts: texts.documents
  });
  const queries = await embedTexts({
    adapter: binding.adapter,
    inputTokenPriceMicros: pricing.inputTokenPriceMicros,
    mode: "query",
    texts: texts.queries
  });
  failureStage = "scoring";
  const selected = evaluateMemoryRecallRelease({
    cases,
    documentVectors: documents.vectors,
    lexicalScores: lexical.scores,
    minimumVectorScore: MEMORY_RETRIEVAL_MINIMUM_VECTOR_SCORE,
    queryVectors: queries.vectors,
    topK: 5
  });
  const binary = scoreMemoryBinaryOutcomes(selected.binary);
  const ranked = scoreMemoryRankedOutcomes(selected.ranked, {
    samples: BOOTSTRAP_SAMPLES,
    seed: RANDOM_SEED
  });
  const requiredBinary = binary.filter(({ cohort, metric }) =>
    cohort === "overall" && metric === "IRRELEVANT_AUTOMATIC_INJECTION_RATE"
  );
  const requiredRanked = ranked.filter(({ metric }) => metric === "CURATED_RECALL_AT_5");
  const coverageComplete = requiredBinary.length === 2 &&
    requiredRanked.filter(({ cohort }) => cohort === "overall").length === 2;
  const qualityPassed = coverageComplete && [...requiredBinary, ...requiredRanked]
    .every(({ gatePassed }) => gatePassed === true);
  const retrievalConfigFingerprint = memoryEvaluationSha256({
    caseBuilder: MEMORY_RECALL_RELEASE_CASE_BUILDER_VERSION,
    evaluator: MEMORY_RECALL_RELEASE_EVALUATOR_VERSION,
    localRepository: MEMORY_LOCAL_RETRIEVAL_REPOSITORY_VERSION,
    minimumVectorScore: MEMORY_RETRIEVAL_MINIMUM_VECTOR_SCORE,
    pipeline: MEMORY_RETRIEVAL_PIPELINE_VERSION,
    planner: MEMORY_RETRIEVAL_PLANNER_VERSION,
    topK: 5,
    vectorConfig: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
    vectorPipeline: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
  });
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
      liveProvider: true
    },
    corpus: {
      hash: manifest.splits[split].contentHash,
      split,
      version: manifest.corpusVersion
    },
    evidenceVersion: MEMORY_RECALL_RELEASE_EVIDENCE_VERSION,
    evaluatedAt: new Date().toISOString(),
    operations: scoreMemoryOperations([...documents.operations, ...queries.operations]),
    passed: qualityPassed,
    providerRequests: {
      documents: documents.operations.length,
      queries: queries.operations.length,
      requestIdsPresent: documents.requestIdsPresent + queries.requestIdsPresent
    },
    localLexical: {
      latencyMs: lexical.latencyMs,
      pairCount: lexical.pairCount,
      perCaseMeanMs: lexical.latencyMs / cases.length
    },
    quality: {
      binary,
      coverageComplete,
      ranked,
      releaseGatePassed: qualityPassed
    },
    sanitizedAggregatesOnly: true,
    summary: selected.summary,
    tuningThresholdLadder: split === "TUNING"
      ? tuningThresholds.map((minimumVectorScore) => profileSummary(evaluateMemoryRecallRelease({
          cases,
          documentVectors: documents.vectors,
          lexicalScores: lexical.scores,
          minimumVectorScore,
          queryVectors: queries.vectors,
          topK: 5
        }), minimumVectorScore))
      : undefined,
    versions: {
      caseBuilder: MEMORY_RECALL_RELEASE_CASE_BUILDER_VERSION,
      evaluator: MEMORY_RECALL_RELEASE_EVALUATOR_VERSION,
      generator: manifest.generatorVersion,
      localRepository: MEMORY_LOCAL_RETRIEVAL_REPOSITORY_VERSION,
      manifest: manifest.manifestVersion,
      pgvector: versions.pgvector,
      pipeline: MEMORY_RETRIEVAL_PIPELINE_VERSION,
      planner: MEMORY_RETRIEVAL_PLANNER_VERSION,
      postgresql: versions.postgresql,
      randomSeed: RANDOM_SEED,
      retrievalConfigFingerprint,
      schema: manifest.schemaVersion,
      scorer: MEMORY_EVALUATION_SCORER_VERSION,
      vectorPipeline: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
    }
  };
  failureStage = "output";
  const persistedEvidence = JSON.parse(JSON.stringify(evidence)) as unknown;
  const evidenceDigest = memoryEvaluationSha256(persistedEvidence);
  const outputPath = privateEvidenceOutputPath();
  if (outputPath) {
    await mkdir(dirname(outputPath), { mode: 0o700, recursive: true });
    await writeFile(outputPath, `${JSON.stringify({
      evidence: persistedEvidence,
      evidenceDigest
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
      evidenceDigest,
      outputPath: relative(process.cwd(), outputPath),
      passed: qualityPassed,
      split,
      summary: selected.summary,
      upstreamModelId: authority.providerModelId
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  }
  await prisma.$disconnect();
}

void main().catch(async (error: unknown) => {
  const code = error instanceof EmbeddingAdapterError
    ? `memory_recall_${error.code}`
    : error instanceof ProviderAdmissionError
      ? `memory_recall_${error.code}`
      : error instanceof Error && /^memory_[a-z0-9_]+$/u.test(error.message)
        ? error.message
        : "memory_recall_evaluation_failed";
  process.stderr.write(`${code}:${failureStage}\n`);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
});

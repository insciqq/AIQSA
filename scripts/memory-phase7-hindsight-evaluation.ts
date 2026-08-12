import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { Prisma } from "@prisma/client";
import {
  MEMORY_RETRIEVAL_MINIMUM_VECTOR_SCORE,
  MEMORY_RETRIEVAL_PIPELINE_VERSION
} from "../lib/domain/memory/retrieval";
import { memoryEvaluationSha256 } from
  "../lib/evaluation/memory/canonical";
import type { MemoryOperationObservation } from
  "../lib/evaluation/memory/contracts";
import {
  MEMORY_PHASE7_BOOTSTRAP_SAMPLES,
  MEMORY_PHASE7_CORPUS_VERSION,
  MEMORY_PHASE7_EVALUATOR_VERSION,
  MEMORY_PHASE7_EVIDENCE_VERSION,
  MEMORY_PHASE7_HINDSIGHT_REFERENCE,
  MEMORY_PHASE7_RANDOM_SEED,
  MEMORY_PHASE7_SCORER_VERSION,
  MEMORY_PHASE7_SUITE_VERSION,
  decideMemoryPhase7HindsightGap,
  memoryPhase7EvidenceIdentityIsCurrent
} from "../lib/evaluation/memory/phase7";
import {
  MEMORY_PHASE7_ABLATION_EVALUATOR_VERSION,
  evaluateMemoryPhase7AblationStage,
  memoryPhase7AblationEmbeddingTexts,
  memoryPhase7AblationPairKey,
  type MemoryPhase7AblationCase
} from "../lib/evaluation/memory/phase7Ablation";
import { scoreMemoryOperations } from
  "../lib/evaluation/memory/scorers";
import { createPrismaEmbeddingRuntime } from
  "../lib/server/providerRuntime/embeddingRuntime";
import {
  MAX_EMBEDDING_BATCH_INPUTS,
  type EmbeddingAdapter
} from "../lib/server/providers/embeddings";
import { prisma } from "../lib/server/prisma";
import {
  MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
} from "../lib/server/memory/retrieval/vector";
import { MEMORY_RETRIEVAL_PLANNER_VERSION } from
  "../lib/domain/memory/retrieval/planner";
import {
  buildMemoryPhase7AblationCases,
  MEMORY_PHASE7_ABLATION_CASE_BUILDER_VERSION
} from "../tests/fixtures/memory-evaluation/phase7AblationCases";
import { MEMORY_CRITICAL_COHORTS } from
  "../tests/fixtures/memory-evaluation/shared/corpusTypes";
import {
  MEMORY_PHASE7_HINDSIGHT_COMPARISON_VERSION,
  scoreMemoryPhase7HindsightCases,
  scoreMemoryPhase7NativeComparison,
  selectMemoryPhase7HindsightFixtures,
  type HindsightCaseResult,
  type HindsightRecallResult
} from "../tests/harness/memory-reference/phase7HindsightComparison";

const LEXICAL_PAIR_BATCH_SIZE = 2_000;
const HTTP_RESPONSE_LIMIT_BYTES = 2 * 1_024 * 1_024;
const HINDSIGHT_TOP_K = 5;
let failureStage = "startup";

type CorpusManifest = Readonly<{
  corpusVersion: string;
  generatorVersion: string;
  manifestVersion: string;
  schemaVersion: string;
  splits: Readonly<{ HOLDOUT: Readonly<{ contentHash: string }> }>;
}>;

type HindsightApiResult = Readonly<{
  document_id?: unknown;
  text?: unknown;
}>;

function hasArgument(value: string): boolean {
  return process.argv.slice(2).includes(value);
}

function argumentValue(prefix: string): string | null {
  return process.argv.slice(2).find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length).trim() || null;
}

function evidenceOutputPath(): string {
  const value = argumentValue("--evidence-output=");
  if (!value) throw new Error("memory_phase7_hindsight_evidence_output_required");
  const privateRoot = resolve(".aiqsa");
  const target = resolve(value);
  if (target === privateRoot || !target.startsWith(`${privateRoot}${sep}`)) {
    throw new Error("memory_phase7_hindsight_evidence_output_invalid");
  }
  return target;
}

function hindsightBaseUrl(): string {
  const value = process.env.AIQSA_HINDSIGHT_REFERENCE_URL;
  if (value !== "http://aiqsa-memory-hindsight-v070:8888") {
    throw new Error("memory_phase7_hindsight_url_invalid");
  }
  return value;
}

async function manifest(): Promise<CorpusManifest> {
  const value = JSON.parse(await readFile(
    "tests/fixtures/memory-evaluation/manifests/corpus-v2.json", "utf8"
  )) as CorpusManifest;
  if (
    value.corpusVersion !== MEMORY_PHASE7_CORPUS_VERSION ||
    value.splits.HOLDOUT.contentHash.length !== 64
  ) throw new Error("memory_phase7_hindsight_manifest_invalid");
  return value;
}

function requireAuthorization(corpusHash: string): void {
  if (!hasArgument("--authorized-live-provider")) {
    throw new Error("memory_phase7_hindsight_live_provider_authorization_required");
  }
  if (!hasArgument(`--holdout-corpus-hash=${corpusHash}`)) {
    throw new Error("memory_phase7_hindsight_holdout_hash_authorization_required");
  }
}

function batches<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function selectedEmbeddingAuthority() {
  const users = await prisma.user.findMany({
    select: { id: true }, where: { role: "admin", status: "active" }
  });
  if (users.length !== 1) throw new Error("memory_phase7_hindsight_admin_ambiguous");
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
    throw new Error("memory_phase7_hindsight_embedding_model_ambiguous");
  }
  return { providerModelId: eligible[0]!.id, userId: users[0]!.id };
}

function estimatedCostUsd(tokens: number | null, priceMicros: number): number | null {
  return tokens === null || priceMicros <= 0 ? null : tokens * priceMicros / 1_000_000;
}

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
        result.usage.inputTokens, input.inputTokenPriceMicros
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

async function postgresLexicalScores(cases: readonly MemoryPhase7AblationCase[]) {
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
          candidate_key text, case_key text, document_text text, terms jsonb
        )
      ), expanded AS MATERIALIZED (
        SELECT pair.candidate_key, pair.case_key, pair.document_text,
          term.value #>> '{}' AS term
        FROM pairs AS pair
        CROSS JOIN LATERAL jsonb_array_elements(pair.terms) AS term(value)
      ), prepared AS MATERIALIZED (
        SELECT candidate_key, case_key,
          to_tsvector('english', document_text) AS vector_en,
          to_tsvector('russian', replace(document_text, 'ё', 'е')) AS vector_ru,
          to_tsvector('simple', replace(document_text, 'ё', 'е')) AS vector_simple,
          plainto_tsquery('english', term) AS query_en,
          plainto_tsquery('russian', replace(term, 'ё', 'е')) AS query_ru,
          plainto_tsquery('simple', replace(term, 'ё', 'е')) AS query_simple
        FROM expanded
      ), scored AS (
        SELECT candidate_key, case_key, GREATEST(
          CASE WHEN vector_en @@ query_en THEN ts_rank_cd(vector_en, query_en) ELSE 0 END,
          CASE WHEN vector_ru @@ query_ru THEN ts_rank_cd(vector_ru, query_ru) ELSE 0 END,
          CASE WHEN vector_simple @@ query_simple
            THEN ts_rank_cd(vector_simple, query_simple) ELSE 0 END
        )::double precision AS score
        FROM prepared
      )
      SELECT candidate_key, case_key, MAX(score)::double precision AS score
      FROM scored GROUP BY candidate_key, case_key
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

function repoolSelectedCases(
  cases: readonly MemoryPhase7AblationCase[]
): readonly MemoryPhase7AblationCase[] {
  const pools = new Map<string, Map<string, MemoryPhase7AblationCase["candidates"][number]>>();
  for (const current of cases) {
    const pool = pools.get(current.language) ?? new Map();
    for (const candidate of current.candidates) {
      if (candidate.sourceFixtureId === current.sourceFixtureId) {
        pool.set(candidate.key, candidate);
      }
    }
    pools.set(current.language, pool);
  }
  return cases.map((current) => ({
    ...current,
    candidates: [...(pools.get(current.language)?.values() ?? [])]
  }));
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
}

async function httpJson<T>(input: Readonly<{
  body?: unknown;
  method?: "GET" | "POST" | "PUT";
  path: string;
  timeoutMs: number;
}>): Promise<T> {
  const response = await fetch(`${hindsightBaseUrl()}${input.path}`, {
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    headers: input.body === undefined ? undefined : { "content-type": "application/json" },
    method: input.method ?? "GET",
    signal: AbortSignal.timeout(input.timeoutMs)
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`memory_phase7_hindsight_http_${response.status}`);
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > HTTP_RESPONSE_LIMIT_BYTES) {
    throw new Error("memory_phase7_hindsight_response_too_large");
  }
  return JSON.parse(body) as T;
}

async function runHindsight(input: Readonly<{
  cases: readonly MemoryPhase7AblationCase[];
  fixtures: readonly ReturnType<typeof selectMemoryPhase7HindsightFixtures>[number][];
}>): Promise<Readonly<{
  caseResults: readonly HindsightCaseResult[];
  recallLatencyP95Ms: number;
  retainItems: number;
  retainLatencyMs: number;
  usage: Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number }>;
  versionFingerprint: string;
}>> {
  const version = await httpJson<unknown>({ path: "/version", timeoutMs: 30_000 });
  const fixtureById = new Map(input.fixtures.map((fixture) => [fixture.id, fixture]));
  const bankByLanguage = { EN: "phase7-holdout-en", RU: "phase7-holdout-ru" } as const;
  let retainItems = 0;
  let retainLatencyMs = 0;
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const language of ["EN", "RU"] as const) {
    const bank = bankByLanguage[language];
    await httpJson({
      body: { enable_observations: false }, method: "PUT",
      path: `/v1/default/banks/${bank}`, timeoutMs: 30_000
    });
    const items = input.cases.filter((current) => current.language === language)
      .flatMap((current) => {
        const fixture = fixtureById.get(current.sourceFixtureId);
        if (!fixture?.expectedEgress.remoteCallsAllowed) return [];
        const source = current.candidates.find((candidate) =>
          candidate.sourceFixtureId === current.sourceFixtureId &&
          candidate.kind === "HISTORY_CHUNK"
        );
        return source ? [{
          content: source.text,
          context: "Synthetic Phase 7 memory comparison",
          document_id: fixture.id,
          tags: ["phase7-synthetic", language.toLocaleLowerCase("und")],
          timestamp: source.occurredFrom ?? "unset"
        }] : [];
      });
    if (items.length === 0) continue;
    const startedAt = performance.now();
    const retained = await httpJson<{
      items_count?: unknown;
      success?: unknown;
      usage?: Readonly<{ input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown }>;
    }>({
      body: { async: false, items }, method: "POST",
      path: `/v1/default/banks/${bank}/memories`, timeoutMs: 600_000
    });
    retainLatencyMs += performance.now() - startedAt;
    if (retained.success !== true || retained.items_count !== items.length) {
      throw new Error("memory_phase7_hindsight_retain_invalid");
    }
    retainItems += items.length;
    for (const [source, target] of [
      [retained.usage?.input_tokens, "inputTokens"],
      [retained.usage?.output_tokens, "outputTokens"],
      [retained.usage?.total_tokens, "totalTokens"]
    ] as const) {
      if (typeof source === "number" && Number.isSafeInteger(source) && source >= 0) {
        usage[target] += source;
      }
    }
  }
  const recallLatencies: number[] = [];
  const caseResults: HindsightCaseResult[] = [];
  for (const fixture of input.fixtures) {
    if (!fixture.expectedEgress.remoteCallsAllowed) {
      caseResults.push({ fixture, providerCallPerformed: false, results: [] });
      continue;
    }
    const query = fixture.queries[0];
    if (!query) throw new Error("memory_phase7_hindsight_fixture_shape_invalid");
    const startedAt = performance.now();
    const response = await httpJson<{ results?: unknown }>({
      body: {
        budget: "low",
        include: { chunks: null, entities: null, source_facts: null },
        max_tokens: 512,
        query: query.text,
        query_timestamp: "2026-08-11T12:00:00.000Z",
        trace: false,
        types: ["world", "experience"]
      },
      method: "POST",
      path: `/v1/default/banks/${bankByLanguage[fixture.language]}/memories/recall`,
      timeoutMs: 120_000
    });
    recallLatencies.push(performance.now() - startedAt);
    if (!Array.isArray(response.results)) {
      throw new Error("memory_phase7_hindsight_recall_invalid");
    }
    const results: HindsightRecallResult[] = response.results.slice(0, HINDSIGHT_TOP_K)
      .map((result: HindsightApiResult) => {
        if (typeof result.text !== "string" || result.text.length > 32_000) {
          throw new Error("memory_phase7_hindsight_recall_invalid");
        }
        return {
          documentId: typeof result.document_id === "string" ? result.document_id : null,
          text: result.text
        };
      });
    caseResults.push({ fixture, providerCallPerformed: true, results });
  }
  return {
    caseResults,
    recallLatencyP95Ms: percentile95(recallLatencies),
    retainItems,
    retainLatencyMs,
    usage,
    versionFingerprint: memoryEvaluationSha256(version)
  };
}

async function databaseVersions() {
  const rows = await prisma.$queryRaw<Array<{ pgvector: string; postgresql: string }>>`
    SELECT current_setting('server_version')::text AS postgresql,
      COALESCE((SELECT extversion FROM pg_extension WHERE extname = 'vector'), 'absent')::text
        AS pgvector
  `;
  if (rows.length !== 1) throw new Error("memory_phase7_hindsight_database_unavailable");
  return rows[0]!;
}

async function main(): Promise<void> {
  failureStage = "arguments";
  const outputPath = evidenceOutputPath();
  const corpusManifest = await manifest();
  requireAuthorization(corpusManifest.splits.HOLDOUT.contentHash);
  hindsightBaseUrl();

  failureStage = "corpus";
  const { loadMemoryHoldoutCorpus } = await import(
    "../tests/fixtures/memory-evaluation/holdout/corpus"
  );
  const fixtures = await loadMemoryHoldoutCorpus({
    expectedCorpusVersion: MEMORY_PHASE7_CORPUS_VERSION,
    purpose: "SCORING_ONLY"
  });
  const selected = selectMemoryPhase7HindsightFixtures({
    criticalCohorts: MEMORY_CRITICAL_COHORTS,
    fixtures,
    randomSeed: MEMORY_PHASE7_RANDOM_SEED
  });
  const cases = repoolSelectedCases(buildMemoryPhase7AblationCases(selected));
  const texts = memoryPhase7AblationEmbeddingTexts(cases);
  const fixtureById = new Map(selected.map((fixture) => [fixture.id, fixture]));
  const remoteQueries = [...new Set(cases.filter((current) =>
    fixtureById.get(current.sourceFixtureId)?.expectedEgress.remoteCallsAllowed === true
  ).map(({ queryText }) => queryText))].sort();
  if (hasArgument("--preflight-only")) {
    process.stdout.write(`${JSON.stringify({
      cases: cases.length,
      documents: texts.documents.length,
      hindsightRecallCalls: selected.filter(({ expectedEgress }) =>
        expectedEgress.remoteCallsAllowed
      ).length,
      localOnlyDenied: selected.filter(({ expectedEgress }) =>
        !expectedEgress.remoteCallsAllowed
      ).length,
      nativeEmbeddingRequestsMaximum: 2,
      remoteQueries: remoteQueries.length,
      selectedPerLanguage: cases.length / 2
    }, null, 2)}\n`);
    await prisma.$disconnect();
    return;
  }

  failureStage = "native-authority";
  const authority = await selectedEmbeddingAuthority();
  const binding = await createPrismaEmbeddingRuntime(prisma).resolveForUser(authority);
  const pricing = await prisma.providerModel.findUniqueOrThrow({
    select: { inputTokenPriceMicros: true }, where: { id: authority.providerModelId }
  });
  const versions = await databaseVersions();
  failureStage = "native-lexical";
  const lexical = await postgresLexicalScores(cases);
  failureStage = "native-embedding";
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
    texts: remoteQueries
  });
  const observedDimension = documents.vectors.values().next().value?.length;
  if (
    typeof observedDimension !== "number" ||
    !Number.isSafeInteger(observedDimension) ||
    observedDimension < 1
  ) {
    throw new Error("memory_phase7_hindsight_vector_dimension_missing");
  }
  const localVector: number[] = Array.from(
    { length: observedDimension }, (_, index) => index === 0 ? 1 : 0
  );
  for (const current of cases) {
    if (!queries.vectors.has(current.queryText)) {
      const fixture = fixtureById.get(current.sourceFixtureId);
      if (fixture?.expectedEgress.remoteCallsAllowed !== false) {
        throw new Error("memory_phase7_hindsight_query_vector_missing");
      }
      (queries.vectors as Map<string, readonly number[]>).set(current.queryText, localVector);
    }
  }
  const nativeEvaluation = evaluateMemoryPhase7AblationStage({
    cases,
    documentVectors: documents.vectors,
    lexicalScores: lexical.scores,
    minimumVectorScore: MEMORY_RETRIEVAL_MINIMUM_VECTOR_SCORE,
    queryVectors: queries.vectors,
    stage: "TEMPORAL_SCOPE_TEMPERATURE"
  });
  const nativeMetrics = scoreMemoryPhase7NativeComparison(nativeEvaluation.observations);

  failureStage = "hindsight";
  const referenceRun = await runHindsight({ cases, fixtures: selected });
  const referenceScored = scoreMemoryPhase7HindsightCases(referenceRun.caseResults);
  const decision = decideMemoryPhase7HindsightGap({
    native: nativeMetrics,
    reference: referenceScored.metrics
  });
  const identity = {
    bootstrapSamples: MEMORY_PHASE7_BOOTSTRAP_SAMPLES,
    corpusHash: corpusManifest.splits.HOLDOUT.contentHash,
    corpusVersion: MEMORY_PHASE7_CORPUS_VERSION,
    evaluatorVersion: MEMORY_PHASE7_EVALUATOR_VERSION,
    evidenceVersion: MEMORY_PHASE7_EVIDENCE_VERSION,
    randomSeed: MEMORY_PHASE7_RANDOM_SEED,
    scorerVersion: MEMORY_PHASE7_SCORER_VERSION,
    suiteVersion: MEMORY_PHASE7_SUITE_VERSION
  };
  const evidence = {
    adapter: {
      commit: MEMORY_PHASE7_HINDSIGHT_REFERENCE.commit,
      configuration: {
        autoConsolidation: false,
        embeddingDimensions: MEMORY_PHASE7_HINDSIGHT_REFERENCE.embeddingDimensions,
        embeddingModel: MEMORY_PHASE7_HINDSIGHT_REFERENCE.embeddingModel,
        embeddingTransport: "OPENAI_COMPATIBLE_OPENROUTER",
        llmMaxConcurrent: 1,
        llmModel: MEMORY_PHASE7_HINDSIGHT_REFERENCE.llmModel,
        observations: false,
        reranker: MEMORY_PHASE7_HINDSIGHT_REFERENCE.reranker,
        textSearchLanguage: MEMORY_PHASE7_HINDSIGHT_REFERENCE.textSearchLanguage,
        vectorExtension: MEMORY_PHASE7_HINDSIGHT_REFERENCE.vectorExtension
      },
      imageDigest: MEMORY_PHASE7_HINDSIGHT_REFERENCE.imageDigest,
      kind: "HINDSIGHT_REFERENCE",
      tag: MEMORY_PHASE7_HINDSIGHT_REFERENCE.tag,
      versionFingerprint: referenceRun.versionFingerprint
    },
    comparison: {
      decision,
      native: nativeMetrics,
      reference: referenceScored.metrics,
      strictPrecisionDefinition: "CASE_HAS_NO_UNGROUNDED_TOP5_FACT",
      temporalDefinition: "TOP1_DOCUMENT_AND_EXPECTED_LEXICAL_CONTRAST"
    },
    corpus: {
      cases: cases.length,
      hash: corpusManifest.splits.HOLDOUT.contentHash,
      localOnlyProviderCalls: 0,
      localOnlyProviderDenials: referenceScored.observations.filter(({ egressDenied }) =>
        egressDenied
      ).length,
      selectionDigest: memoryEvaluationSha256(selected.map(({ id }) => id).sort()),
      split: "HOLDOUT",
      version: corpusManifest.corpusVersion
    },
    evaluatedAt: new Date().toISOString(),
    evidenceVersion: MEMORY_PHASE7_EVIDENCE_VERSION,
    hindsightOperations: {
      recallCalls: referenceRun.caseResults.filter(({ providerCallPerformed }) =>
        providerCallPerformed
      ).length,
      recallLatencyP95Ms: referenceRun.recallLatencyP95Ms,
      retainItems: referenceRun.retainItems,
      retainLatencyMs: referenceRun.retainLatencyMs,
      usage: referenceRun.usage
    },
    nativeOperations: scoreMemoryOperations([
      ...documents.operations, ...queries.operations
    ]),
    passed: !decision.requiresFocusedQualityWork &&
      memoryPhase7EvidenceIdentityIsCurrent(identity),
    sanitizedAggregatesOnly: true,
    versions: {
      ...identity,
      ablationEvaluator: MEMORY_PHASE7_ABLATION_EVALUATOR_VERSION,
      caseBuilder: MEMORY_PHASE7_ABLATION_CASE_BUILDER_VERSION,
      comparison: MEMORY_PHASE7_HINDSIGHT_COMPARISON_VERSION,
      generator: corpusManifest.generatorVersion,
      manifest: corpusManifest.manifestVersion,
      pgvector: versions.pgvector,
      pipeline: MEMORY_RETRIEVAL_PIPELINE_VERSION,
      planner: MEMORY_RETRIEVAL_PLANNER_VERSION,
      postgresql: versions.postgresql,
      schema: corpusManifest.schemaVersion,
      vectorConfig: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
      vectorPipeline: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
    }
  };
  failureStage = "output";
  const persisted = JSON.parse(JSON.stringify(evidence)) as unknown;
  const evidenceDigest = memoryEvaluationSha256(persisted);
  await mkdir(dirname(outputPath), { mode: 0o700, recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ evidence: persisted, evidenceDigest }, null, 2)}\n`, {
    flag: "wx", mode: 0o600
  });
  process.stdout.write(`${JSON.stringify({
    decision,
    evidenceDigest,
    native: nativeMetrics,
    outputPath: relative(process.cwd(), outputPath),
    passed: evidence.passed,
    reference: referenceScored.metrics
  }, null, 2)}\n`);
  await prisma.$disconnect();
}

void main().catch(async (error: unknown) => {
  const code = error instanceof Error && /^memory_[a-z0-9_]+$/u.test(error.message)
    ? error.message
    : "memory_phase7_hindsight_evaluation_failed";
  process.stderr.write(`${code}:${failureStage}\n`);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
});

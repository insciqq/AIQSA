import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { Prisma, PrismaClient } from "@prisma/client";
import { textMessageContent } from "../../lib/domain/content";
import { KNOWLEDGE_SELECTION_VERSION } from "../../lib/contracts/knowledge";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from
  "../../lib/server/knowledge/indexProfile";
import { createKnowledgeRerankStage } from
  "../../lib/server/knowledge/rerankExecution";
import {
  createPrismaKnowledgeRerankerRuntime,
  type KnowledgeRerankerRoleResolution
} from "../../lib/server/knowledge/rerankerRuntime";
import {
  createPrismaKnowledgeEmbeddingRuntime,
  createPrismaKnowledgeRetrievalStore
} from "../../lib/server/knowledge/prismaRetrievalRepository";
import { loadKnowledgeRunAdmissionPlan } from
  "../../lib/server/knowledge/runAdmission";
import {
  KNOWLEDGE_LANE_CANDIDATE_LIMIT,
  KNOWLEDGE_RANKING_PROFILE_VERSION,
  KNOWLEDGE_RETRIEVAL_FUSION,
  KNOWLEDGE_RRF_K
} from "../../lib/server/knowledge/retrievalRanking";
import {
  KNOWLEDGE_QUERY_MAX_CHARACTERS,
  KNOWLEDGE_RESULT_LIMIT,
  type KnowledgeAcceptedBinding
} from "../../lib/server/knowledge/retrievalTypes";
import { knowledgeTokenizerEvidenceLabel } from
  "../../lib/server/knowledge/tokenizer/knowledgeTokenCounter";
import { insertAcceptedKnowledgeRunBindings } from
  "../../lib/server/runs/prismaRepositoryBindings";
import {
  KNOWLEDGE_BENCHMARK_DOC_FORMAT_VERSION,
  KNOWLEDGE_BENCHMARK_SUMMARY_SCHEMA_VERSION,
  aggregateKnowledgeSuiteMetrics,
  assertKnowledgeBenchmarkAck,
  assertKnowledgeBenchmarkDatabaseUrl,
  decodeConvFinQaQueries,
  decodeKnowledgeBenchmarkManifest,
  decodeKnowledgeFrozenRunManifest,
  decodeRusScifactQueries,
  expandRankedDocuments,
  knowledgeDatasetFingerprint,
  knowledgeRunManifestFingerprint,
  mapConcurrentOrdered,
  parseJsonLines,
  parseQrelsTsv,
  projectDocumentRanking,
  queryEmbeddingCacheKey,
  resolveKnowledgeBenchmarkOutputDirectory,
  type KnowledgeBenchmarkQuery,
  type KnowledgeConfigLabel,
  type KnowledgeFrozenRunManifest,
  type KnowledgeQueryOutcome,
  type KnowledgeSuiteId,
  type KnowledgeSuiteManifest
} from "./contract";

/** Retrieval-only evaluation driver. It is executed inside the isolated
 * benchmark app container (compose exec + npx tsx) and performs, for every
 * official query, exactly the query-embedding plus the single hybrid
 * retrieval repository operation an accepted `search_knowledge` call
 * performs: the accepted run-binding embedding runtime with `mode: "query"`,
 * the current installation reranker role frozen for the run, then one
 * `hybridSearch` repository operation with the product's global candidate
 * and result limits. No answer generation happens, no per-dataset
 * conditionals exist, and one global ranking profile serves both suites.
 *
 * Sanitized output only: aggregate metrics plus the frozen run manifest per
 * run under `results/<run-id>/`, official public dataset ids in the audit
 * ranking file, and aggregate-only console lines. No query text, document
 * text, or private content reaches file names or the console. */

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(benchmarkRoot, "../..");
const datasetsRoot = resolve(benchmarkRoot, ".data/datasets");
const stateRoot = resolve(benchmarkRoot, ".data/state");
const cacheRoot = resolve(benchmarkRoot, ".data/cache/query-embeddings");
const INGEST_STATE_SCHEMA_VERSION = 1;
const RANKINGS_SCHEMA_VERSION = 1;

type CliOptions = Readonly<{
  concurrency: number;
  configLabel: KnowledgeConfigLabel;
  embedTimeoutMs: number;
  outputDirectory: string | undefined;
  queryLimit: number | undefined;
  suiteId: KnowledgeSuiteId;
}>;

type IngestStateFile = Readonly<{
  completedAt: string | null;
  corpusContentSha256: string;
  datasetSources: readonly Readonly<{ datasetId: string; revision: string }>[];
  docFormatVersion: number;
  documents: Readonly<Record<string, Readonly<{
    officialId: string;
    sourceId: string;
    state: string;
  }>>>;
  knowledgeBaseId: string | null;
  ocr: Readonly<{ assertedZeroOcr: boolean }> | null;
  querySplit: string;
  schemaVersion: number;
  suiteId: KnowledgeSuiteId;
  userId: string | null;
}>;

function emit(event: string, details: Readonly<Record<string, unknown>> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

function parseCli(argv: readonly string[]): CliOptions {
  let confirmPaid = false;
  let suiteId: KnowledgeSuiteId | undefined;
  let configLabel: KnowledgeConfigLabel | undefined;
  let concurrency = 4;
  let embedTimeoutMinutes = 2;
  let outputDirectory: string | undefined;
  let queryLimit: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    switch (argument) {
      case "--confirm-paid":
        if (next !== "DISPOSABLE") {
          throw new Error("knowledge_benchmark_paid_confirmation_invalid");
        }
        confirmPaid = true;
        index += 1;
        break;
      case "--suite":
        if (next !== "rusbeir-rus-scifact" && next !== "t2ragbench-convfinqa") {
          throw new Error("knowledge_benchmark_suite_invalid");
        }
        suiteId = next;
        index += 1;
        break;
      case "--config":
        if (next !== "A" && next !== "B" && next !== "C") {
          throw new Error("knowledge_benchmark_config_label_invalid");
        }
        configLabel = next;
        index += 1;
        break;
      case "--concurrency": {
        const parsed = Number(next);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 16) {
          throw new Error("knowledge_benchmark_concurrency_invalid");
        }
        concurrency = parsed;
        index += 1;
        break;
      }
      case "--embed-timeout-minutes": {
        const parsed = Number(next);
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          throw new Error("knowledge_benchmark_embed_timeout_invalid");
        }
        embedTimeoutMinutes = parsed;
        index += 1;
        break;
      }
      case "--output":
        if (!next?.trim()) throw new Error("knowledge_benchmark_output_invalid");
        outputDirectory = next;
        index += 1;
        break;
      case "--query-limit": {
        // Bounded smoke option for plumbing verification only: a limited run
        // is marked non-scoreable and refuses to write a summary.json.
        const parsed = Number(next);
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          throw new Error("knowledge_benchmark_query_limit_invalid");
        }
        queryLimit = parsed;
        index += 1;
        break;
      }
      default:
        throw new Error(
          `knowledge_benchmark_argument_unknown:${argument ?? "missing"}`
        );
    }
  }
  if (!confirmPaid) {
    throw new Error("knowledge_benchmark_paid_confirmation_required");
  }
  if (!suiteId) throw new Error("knowledge_benchmark_suite_required");
  if (!configLabel) throw new Error("knowledge_benchmark_config_label_required");
  return Object.freeze({
    concurrency,
    configLabel,
    embedTimeoutMs: embedTimeoutMinutes * 60_000,
    outputDirectory,
    queryLimit,
    suiteId
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await rename(temporaryPath, path);
}

function suiteFilePath(suiteId: KnowledgeSuiteId, manifestPath: string): string {
  const directory = suiteId === "rusbeir-rus-scifact" ? "rus-scifact" : "convfinqa";
  const flattened = manifestPath === "test.tsv"
    ? "qrels-test.tsv"
    : manifestPath.split("/").at(-1)!;
  return resolve(datasetsRoot, directory, flattened);
}

async function verifySuiteDownloads(suite: KnowledgeSuiteManifest): Promise<void> {
  for (const source of suite.sources) {
    for (const file of source.files) {
      const path = suiteFilePath(suite.suiteId, file.path);
      let actual: string;
      try {
        actual = await sha256File(path);
      } catch {
        throw new Error("knowledge_benchmark_dataset_missing_run_download");
      }
      if (actual !== file.sha256) {
        throw new Error("knowledge_benchmark_dataset_checksum_mismatch");
      }
    }
  }
}

async function loadQueries(
  suite: KnowledgeSuiteManifest
): Promise<readonly KnowledgeBenchmarkQuery[]> {
  let queries: readonly KnowledgeBenchmarkQuery[];
  if (suite.suiteId === "rusbeir-rus-scifact") {
    const rows = parseJsonLines(
      await readFile(suiteFilePath(suite.suiteId, "queries.jsonl"), "utf8"),
      "knowledge_benchmark_queries_jsonl_invalid"
    );
    const qrels = parseQrelsTsv(
      await readFile(suiteFilePath(suite.suiteId, "test.tsv"), "utf8")
    );
    queries = decodeRusScifactQueries(rows, qrels);
  } else {
    queries = decodeConvFinQaQueries(parseJsonLines(
      await readFile(
        suiteFilePath(suite.suiteId, "data/ConvFinQA/turn_0.jsonl"),
        "utf8"
      ),
      "knowledge_benchmark_queries_jsonl_invalid"
    ));
  }
  if (queries.length !== suite.expectedQueryCount) {
    throw new Error("knowledge_benchmark_query_count_mismatch");
  }
  if (queries.some(({ text }) => text.length > KNOWLEDGE_QUERY_MAX_CHARACTERS)) {
    throw new Error("knowledge_benchmark_query_too_long");
  }
  return queries;
}

async function loadIngestState(suiteId: KnowledgeSuiteId): Promise<IngestStateFile> {
  const statePath = resolve(stateRoot, `ingest-${suiteId}.json`);
  let state: IngestStateFile;
  try {
    state = JSON.parse(await readFile(statePath, "utf8")) as IngestStateFile;
  } catch {
    throw new Error("knowledge_benchmark_ingest_state_missing");
  }
  if (state.schemaVersion !== INGEST_STATE_SCHEMA_VERSION ||
    state.suiteId !== suiteId || !state.completedAt || !state.userId ||
    !state.knowledgeBaseId || state.ocr?.assertedZeroOcr !== true ||
    state.docFormatVersion !== KNOWLEDGE_BENCHMARK_DOC_FORMAT_VERSION) {
    throw new Error("knowledge_benchmark_ingest_state_incomplete");
  }
  return state;
}

async function assertDatabaseIdentity(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ database: string; role: string }>>(
    Prisma.sql`SELECT current_database() AS database, current_user AS role`
  );
  if (rows.length !== 1 || rows[0]?.database !== "aiqsa_knowledge_benchmark" ||
    rows[0]?.role !== "aiqsa_benchmark") {
    throw new Error("knowledge_benchmark_database_identity_mismatch");
  }
}

/** Creates one accepted benchmark run whose Knowledge bindings authorize the
 * ingested base, exactly like ordinary run admission does. */
async function createBenchmarkRun(
  prisma: PrismaClient,
  userId: string,
  knowledgeBaseId: string,
  suiteId: KnowledgeSuiteId
): Promise<string> {
  const plan = await loadKnowledgeRunAdmissionPlan(prisma, {
    knowledgePlan: {
      baseIds: [knowledgeBaseId],
      mode: "explicit",
      sourceIds: [],
      version: KNOWLEDGE_SELECTION_VERSION
    },
    userId
  });
  const runId = randomUUID();
  const chatId = randomUUID();
  const userMessageId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.chat.create({
      data: {
        id: chatId,
        memoryMode: "EXCLUDED",
        title: `Knowledge benchmark retrieval ${suiteId}`,
        userId
      }
    });
    await tx.message.create({
      data: {
        chatId,
        content: textMessageContent(
          "Knowledge retrieval benchmark run"
        ) as Prisma.InputJsonValue,
        id: userMessageId,
        role: "user",
        status: "complete"
      }
    });
    await tx.modelRun.create({
      data: {
        chatId,
        id: runId,
        modelId: "knowledge-benchmark",
        provider: "knowledge-benchmark",
        status: "complete",
        userId,
        userMessageId
      }
    });
    await insertAcceptedKnowledgeRunBindings(tx, { plan, runId, userId });
  }, { timeout: 120_000 });
  return runId;
}

function shortHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** Content-free identity of the reranker configuration frozen for this run.
 * Connection and credential identifiers are intentionally excluded from the
 * public benchmark summary. */
function rerankerManifestIdentity(
  resolution: KnowledgeRerankerRoleResolution
): string | null {
  if (resolution.kind === "absent") return null;
  if (resolution.kind === "unavailable") {
    return `unavailable:${resolution.selectedProviderModelId ?? "unknown"}`;
  }
  return [
    resolution.pin.provider,
    resolution.pin.providerModelId,
    resolution.pin.upstreamModelId,
    `policy-v${resolution.pin.policyVersion}`,
    resolution.pin.adapterVersion,
    `formatter-v${resolution.pin.candidateFormatterVersion}`
  ].join(":");
}

function buildFrozenManifest(
  state: IngestStateFile,
  suite: KnowledgeSuiteManifest,
  configLabel: KnowledgeConfigLabel,
  binding: KnowledgeAcceptedBinding,
  runtime: Readonly<{
    configuration: Readonly<{
      embedding?: Readonly<{ queryInstructionTemplate: string | null }>;
      upstreamModelId: string;
    }>;
    provider: string;
  }>,
  reranker: KnowledgeRerankerRoleResolution
): KnowledgeFrozenRunManifest {
  const instructionTemplate =
    runtime.configuration.embedding?.queryInstructionTemplate ?? null;
  return decodeKnowledgeFrozenRunManifest({
    candidateLimits: {
      final: KNOWLEDGE_RESULT_LIMIT,
      lexical: KNOWLEDGE_LANE_CANDIDATE_LIMIT,
      vector: KNOWLEDGE_LANE_CANDIDATE_LIMIT
    },
    chunkingProfile: `chunking-v${KNOWLEDGE_CHUNKING_PROFILE_VERSION}`,
    configLabel,
    corpusContentSha256: state.corpusContentSha256,
    datasetSources: state.datasetSources,
    docFormatVersion: state.docFormatVersion,
    embeddingDimension: binding.targetDimension,
    // The chunking profile is the executable owner of the document embedding
    // formatter and must be bumped whenever that formatter changes.
    embeddingFormatterVersion:
      `chunking-profile-v${KNOWLEDGE_CHUNKING_PROFILE_VERSION}`,
    embeddingModelId:
      `${runtime.provider}:${runtime.configuration.upstreamModelId}`,
    indexProfile: `vector-space:${binding.vectorSpaceFingerprint}`,
    queryInstructionVersion: instructionTemplate === null
      ? "none"
      : `qi-${shortHash(instructionTemplate)}`,
    querySplit: suite.querySplit,
    rankingProfile:
      `${KNOWLEDGE_RETRIEVAL_FUSION}:v=${KNOWLEDGE_RANKING_PROFILE_VERSION}:k=${KNOWLEDGE_RRF_K}`,
    rerankerModelId: rerankerManifestIdentity(reranker),
    suiteId: state.suiteId,
    tokenizerFingerprint: knowledgeTokenizerEvidenceLabel(
      runtime.configuration.upstreamModelId
    )
  });
}

type CachedEmbedding = Readonly<{
  dimension: number;
  inputTokens: number | null;
  totalTokens: number | null;
  vector: readonly number[];
}>;

async function readCachedEmbedding(path: string): Promise<CachedEmbedding | null> {
  try {
    const cached = JSON.parse(await readFile(path, "utf8")) as CachedEmbedding;
    if (!Array.isArray(cached.vector) || cached.vector.length !== cached.dimension ||
      cached.vector.some((value) => typeof value !== "number")) {
      return null;
    }
    return cached;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  assertKnowledgeBenchmarkAck(process.env);
  loadEnvConfig(repositoryRoot, true, { error() {}, info() {} }, true);
  if (!process.env.AIQSA_ENCRYPTION_KEY) {
    throw new Error("knowledge_benchmark_encryption_key_required");
  }
  const databaseUrl = process.env.AIQSA_KNOWLEDGE_BENCHMARK_DATABASE_URL ??
    process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("knowledge_benchmark_database_url_required");
  }
  assertKnowledgeBenchmarkDatabaseUrl(databaseUrl, { allowContainerHost: true });
  const manifest = decodeKnowledgeBenchmarkManifest(JSON.parse(
    await readFile(resolve(benchmarkRoot, "upstream.json"), "utf8")
  ) as unknown);
  const suite = manifest.suites[options.suiteId];
  await verifySuiteDownloads(suite);
  const allQueries = await loadQueries(suite);
  const queries = options.queryLimit === undefined
    ? allQueries
    : allQueries.slice(0, options.queryLimit);
  const state = await loadIngestState(options.suiteId);
  const officialIdsBySourceId: Record<string, string[]> = {};
  const knownOfficialIds = new Set<string>();
  for (const document of Object.values(state.documents)) {
    (officialIdsBySourceId[document.sourceId] ??= []).push(document.officialId);
    knownOfficialIds.add(document.officialId);
  }
  for (const query of queries) {
    for (const documentId of Object.keys(query.relevant)) {
      if (!knownOfficialIds.has(documentId)) {
        throw new Error("knowledge_benchmark_relevant_document_not_ingested");
      }
    }
  }
  const runStamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const runId = `${options.suiteId}-${options.configLabel}-${runStamp}`;
  const outputDirectory = resolveKnowledgeBenchmarkOutputDirectory(
    benchmarkRoot,
    options.outputDirectory ?? `results/${runId}`
  );
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await assertDatabaseIdentity(prisma);
    const benchmarkRunId = await createBenchmarkRun(
      prisma,
      state.userId!,
      state.knowledgeBaseId!,
      options.suiteId
    );
    const store = createPrismaKnowledgeRetrievalStore(prisma);
    const bindings = await store.loadBindings({
      runId: benchmarkRunId,
      userId: state.userId!
    });
    if (bindings.length === 0) {
      throw new Error("knowledge_benchmark_run_bindings_missing");
    }
    const vectorSpaces = new Set(bindings.map(
      ({ vectorSpaceFingerprint }) => vectorSpaceFingerprint
    ));
    if (vectorSpaces.size !== 1) {
      throw new Error("knowledge_benchmark_vector_space_ambiguous");
    }
    const runtime = await createPrismaKnowledgeEmbeddingRuntime(prisma)
      .resolve(bindings[0]!);
    // Freeze one admitted installation role for the complete diagnostic run.
    // Each query still creates a fresh one-request stage, while mid-run Admin
    // changes cannot silently mix retrieval configurations in one manifest.
    const reranker = await createPrismaKnowledgeRerankerRuntime(prisma).resolve();
    const frozenManifest = buildFrozenManifest(
      state,
      suite,
      options.configLabel,
      bindings[0]!,
      runtime,
      reranker
    );
    emit("run_started", {
      configLabel: options.configLabel,
      datasetFingerprint: knowledgeDatasetFingerprint(frozenManifest),
      manifestFingerprint: knowledgeRunManifestFingerprint(frozenManifest),
      queryCount: queries.length,
      resultLabel: suite.resultLabel,
      runId,
      scoreable: options.queryLimit === undefined
    });
    await mkdir(cacheRoot, { recursive: true });
    let cacheHits = 0;
    let nextProgressAt = 0;
    let completed = 0;
    // Public suites contain distinct query ids with identical query text.
    // Coalesce concurrent misses so one cache key produces exactly one paid
    // embedding request and every identical query uses the same vector.
    const pendingEmbeddings = new Map<string, Promise<CachedEmbedding>>();
    const outcomes = await mapConcurrentOrdered(
      queries,
      options.concurrency,
      async (query): Promise<KnowledgeQueryOutcome> => {
        const cachePath = resolve(
          cacheRoot,
          `${queryEmbeddingCacheKey(frozenManifest, query.text)}.json`
        );
        let cached = await readCachedEmbedding(cachePath);
        let embedMs = 0;
        let embedRequests = 0;
        if (!cached) {
          const pending = pendingEmbeddings.get(cachePath);
          if (pending) {
            cached = await pending;
            cacheHits += 1;
          } else {
            const embedStartedAt = Date.now();
            const request = (async (): Promise<CachedEmbedding> => {
              const embedded = await runtime.adapter.embed({
                mode: "query",
                signal: AbortSignal.timeout(options.embedTimeoutMs),
                texts: [query.text]
              });
              const vector = embedded.vectors[0];
              if (!vector || vector.length !== bindings[0]!.targetDimension) {
                throw new Error("knowledge_benchmark_embedding_shape_invalid");
              }
              const entry = Object.freeze({
                dimension: vector.length,
                inputTokens: embedded.usage.inputTokens,
                totalTokens: embedded.usage.totalTokens,
                vector
              });
              await writeJsonAtomic(cachePath, entry);
              return entry;
            })();
            pendingEmbeddings.set(cachePath, request);
            try {
              cached = await request;
              embedMs = Date.now() - embedStartedAt;
              embedRequests = 1;
            } finally {
              pendingEmbeddings.delete(cachePath);
            }
          }
        } else {
          cacheHits += 1;
        }
        const searchStartedAt = Date.now();
        const rerankExecutor = reranker.kind === "ready"
          ? createKnowledgeRerankStage({
              adapter: reranker.adapter,
              pin: reranker.pin,
              query: query.text
            })
          : null;
        const result = await store.hybridSearch({
          anchorQuery: query.text,
          candidateLimit: KNOWLEDGE_LANE_CANDIDATE_LIMIT,
          excludedContentHashes: [],
          operation: "automatic_search",
          query: query.text,
          ...(rerankExecutor ? { rerank: { executor: rerankExecutor } } : {}),
          resultLimit: KNOWLEDGE_RESULT_LIMIT,
          runId: benchmarkRunId,
          userId: state.userId!,
          vectors: bindings.map((binding) => ({
            bindingOrdinal: binding.ordinal,
            indexGenerationId: binding.indexGenerationId,
            knowledgeBaseId: binding.knowledgeBaseId,
            targetDimension: binding.targetDimension,
            vector: cached!.vector
          }))
        });
        const searchMs = Date.now() - searchStartedAt;
        const rerankerEvidence = result.rerankerBinding;
        if (reranker.kind === "ready" && !rerankerEvidence) {
          throw new Error("knowledge_benchmark_reranker_evidence_missing");
        }
        const rankedDocumentIds = expandRankedDocuments(
          // The product result order is authoritative after hosted reranking.
          // A monotonic ordinal score lets the document projection preserve
          // that order even when a partial rerank omitted some scores.
          projectDocumentRanking(result.passages.map((passage, index) => ({
            documentId: passage.documentId,
            passageId: passage.chunkId,
            score: result.passages.length - index
          }))),
          officialIdsBySourceId
        );
        const rerankRequestMade = rerankerEvidence !== undefined &&
          rerankerEvidence.inputCandidateCount > 1;
        completed += 1;
        if (Date.now() >= nextProgressAt) {
          emit("retrieval_progress", {
            cacheHits,
            completedQueries: completed,
            totalQueries: queries.length
          });
          nextProgressAt = Date.now() + 15_000;
        }
        return Object.freeze({
          candidatesAfterRerank: result.passages.length,
          candidatesBeforeRerank:
            rerankerEvidence?.inputCandidateCount ?? result.candidateCount,
          embeddingUsage: Object.freeze({
            costMicros: null,
            requests: embedRequests,
            tokens: cached.totalTokens ?? cached.inputTokens ?? 0
          }),
          queryId: query.officialId,
          rankedDocumentIds,
          relevant: query.relevant,
          rerankApplied: rerankRequestMade &&
            (rerankerEvidence?.status === "complete" ||
              rerankerEvidence?.status === "partial"),
          rerankFallback: reranker.kind === "unavailable" ||
            rerankerEvidence?.status === "degraded",
          rerankMs: rerankRequestMade
            ? rerankerEvidence?.durationMs ?? null
            : null,
          rerankerUsage: Object.freeze({
            costMicros: null,
            requests: rerankRequestMade ? 1 : 0,
            tokens: rerankerEvidence?.usage.totalTokens ?? 0
          }),
          retrievalMs: embedMs + searchMs
        });
      }
    );
    const metrics = aggregateKnowledgeSuiteMetrics(outcomes);
    await mkdir(outputDirectory, { recursive: true });
    if (options.queryLimit === undefined) {
      await writeJsonAtomic(resolve(outputDirectory, "summary.json"), {
        configLabel: options.configLabel,
        createdAt: new Date().toISOString(),
        datasetFingerprint: knowledgeDatasetFingerprint(frozenManifest),
        execution: {
          embedCacheHits: cacheHits,
          embedCacheMisses: queries.length - cacheHits,
          uniqueSources: Object.keys(officialIdsBySourceId).length,
          zeroOcrAsserted: true
        },
        manifest: frozenManifest,
        manifestFingerprint: knowledgeRunManifestFingerprint(frozenManifest),
        metrics,
        resultLabel: suite.resultLabel,
        runId,
        schemaVersion: KNOWLEDGE_BENCHMARK_SUMMARY_SCHEMA_VERSION
      });
    }
    // Audit projection with official public dataset ids only.
    await writeJsonAtomic(resolve(outputDirectory, "rankings.json"), {
      manifestFingerprint: knowledgeRunManifestFingerprint(frozenManifest),
      queries: outcomes.map((outcome) => ({
        queryId: outcome.queryId,
        rankedDocumentIds: outcome.rankedDocumentIds,
        relevantDocumentIds: Object.keys(outcome.relevant).sort()
      })),
      runId,
      schemaVersion: RANKINGS_SCHEMA_VERSION,
      scoreable: options.queryLimit === undefined
    });
    emit("run_complete", {
      cacheHits,
      exactRelevantHitRate: metrics.exactRelevantHitRate,
      mrr10: metrics.mrr10,
      ndcg10: metrics.ndcg10,
      queryCount: metrics.queryCount,
      recall10: metrics.recall10,
      recall50: metrics.recall50,
      rerankFallbackRate: metrics.rerankFallbackRate,
      retrievalMsP50: metrics.retrievalMsP50,
      retrievalMsP95: metrics.retrievalMsP95,
      runId,
      scoreable: options.queryLimit === undefined
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown";
  const code = /^[A-Za-z0-9_:,.-]{1,200}$/u.test(message)
    ? message
    : "knowledge_benchmark_retrieve_failed";
  emit("retrieve_failed", { code });
  process.exitCode = 1;
});

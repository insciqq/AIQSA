import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { Prisma, PrismaClient } from "@prisma/client";
import { textMessageContent } from "../../lib/domain/content";
import { KNOWLEDGE_SELECTION_VERSION } from "../../lib/contracts/knowledge";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from
  "../../lib/server/knowledge/indexProfile";
import { createPrismaKnowledgeBulkActivationRepository } from
  "../../lib/server/knowledge/bulkActivation";
import { KNOWLEDGE_FOCUSED_REQUEST_VERSION } from
  "../../lib/server/knowledge/focusedRequest";
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
import { inspectKnowledgeSearchIntegrity } from
  "../../lib/server/knowledge/searchProjection";
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
  createKnowledgeBenchmarkRequestPacer,
  decodeConvFinQaQueries,
  decodeKnowledgeBenchmarkManifest,
  decodeKnowledgeFrozenRunManifest,
  decodeRusScifactQueries,
  excludeKnowledgeBenchmarkDocuments,
  expandRankedDocuments,
  knowledgeDatasetFingerprint,
  knowledgeQuerySetContentSha256,
  knowledgeRunManifestFingerprint,
  mapConcurrentOrdered,
  parseJsonLines,
  parseQrelsTsv,
  projectDocumentRanking,
  queryEmbeddingCacheKey,
  resolveKnowledgeBenchmarkOutputDirectory,
  selectKnowledgeBenchmarkQueries,
  type KnowledgeBenchmarkQuery,
  type KnowledgeConfigLabel,
  type KnowledgeFrozenRunManifest,
  type KnowledgeSuiteId,
  type KnowledgeSuiteManifest
} from "./contract";
import {
  BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT,
  BRIGHT_STACKOVERFLOW_FILES,
  BRIGHT_STACKOVERFLOW_PREPARED_FORMAT_VERSION,
  BRIGHT_STACKOVERFLOW_QUERY_COUNT,
  BRIGHT_STACKOVERFLOW_REVISION,
  brightDeterministicUuid
} from "./brightStackOverflowContract";
import {
  aggregateBrightRetrievalMetrics,
  buildBrightRetrievalQueries
} from "./brightStackOverflowRetrieval";
import {
  verifyBrightPreparedDataset
} from "./brightStackOverflowPrepared";
import {
  activeImportProfile,
  importIdentity,
  preparedRoot as brightPreparedRoot,
  selectedDocuments
} from "./stageBrightStackOverflowImport";
import {
  aggregateKnowledgeRerankAdmissionDiagnostics,
  decodeKnowledgeRetrievalCheckpointFile,
  decodeKnowledgeRetrievalCheckpointHeader,
  KNOWLEDGE_RETRIEVAL_CHECKPOINT_SCHEMA_VERSION,
  type KnowledgeBenchmarkSchedule,
  type KnowledgeRetrievalCheckpointOutcome
} from "./retrievalCheckpoint";

/** Retrieval-only evaluation driver. It is executed inside the isolated
 * benchmark app container (compose exec + npx tsx) and performs, for every
 * scoreable official query, exactly the query-embedding plus the single hybrid
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
const RANKINGS_SCHEMA_VERSION = 4;
const RETRIEVAL_CHECKPOINT_FILE = "retrieval-checkpoint.json";
const RETRIEVAL_CHECKPOINT_OUTCOMES_DIRECTORY = "retrieval-checkpoint-outcomes";
let failureStage = "startup";

type CliOptions = Readonly<{
  concurrency: number;
  configLabel: KnowledgeConfigLabel;
  diagnosticCandidateAudit: boolean;
  diagnosticDisableReranker: boolean;
  embedTimeoutMs: number;
  outputDirectory: string | undefined;
  preflightOnly: boolean;
  queryIds: readonly string[];
  queryLimit: number | undefined;
  queryStartIntervalMs: number;
  rateLimitCooldownMs: number;
  resume: boolean;
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

export function parseKnowledgeRetrievalCli(argv: readonly string[]): CliOptions {
  let paidConfirmation: string | null = null;
  let suiteId: KnowledgeSuiteId | undefined;
  let configLabel: KnowledgeConfigLabel | undefined;
  let diagnosticCandidateAudit = false;
  let diagnosticDisableReranker = false;
  // Public rerank capacity is provider-dependent and a full suite is long.
  // Default to the safest load; operators may raise it only after a canary.
  let concurrency = 1;
  let embedTimeoutMinutes = 2;
  let outputDirectory: string | undefined;
  let preflightOnly = false;
  const queryIds: string[] = [];
  let queryLimit: number | undefined;
  let queryStartIntervalMs = 30_000;
  let rateLimitCooldownMs = 120_000;
  let resume = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    switch (argument) {
      case "--confirm-paid":
        if (!next?.trim()) {
          throw new Error("knowledge_benchmark_paid_confirmation_invalid");
        }
        paidConfirmation = next;
        index += 1;
        break;
      case "--suite":
        if (next !== "rusbeir-rus-scifact" && next !== "t2ragbench-convfinqa" &&
          next !== "bright-stackoverflow-50m") {
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
      case "--diagnostic-disable-reranker":
        diagnosticDisableReranker = true;
        break;
      case "--diagnostic-candidate-audit":
        diagnosticCandidateAudit = true;
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
      case "--preflight-only":
        preflightOnly = true;
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
      case "--query-id":
        if (!next || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(next)) {
          throw new Error("knowledge_benchmark_query_id_invalid");
        }
        queryIds.push(next);
        index += 1;
        break;
      case "--query-start-interval-ms": {
        const parsed = Number(next);
        if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 600_000) {
          throw new Error("knowledge_benchmark_request_interval_invalid");
        }
        queryStartIntervalMs = parsed;
        index += 1;
        break;
      }
      case "--rate-limit-cooldown-ms": {
        const parsed = Number(next);
        if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 3_600_000) {
          throw new Error("knowledge_benchmark_rate_limit_cooldown_invalid");
        }
        rateLimitCooldownMs = parsed;
        index += 1;
        break;
      }
      case "--resume":
        resume = true;
        break;
      default:
        throw new Error(
          `knowledge_benchmark_argument_unknown:${argument ?? "missing"}`
        );
    }
  }
  if (!suiteId) throw new Error("knowledge_benchmark_suite_required");
  if (!configLabel) throw new Error("knowledge_benchmark_config_label_required");
  if (!preflightOnly) {
    const expectedConfirmation = suiteId === "bright-stackoverflow-50m"
      ? "BRIGHT_RETRIEVAL"
      : "DISPOSABLE";
    if (paidConfirmation === null) {
      throw new Error("knowledge_benchmark_paid_confirmation_required");
    }
    if (paidConfirmation !== expectedConfirmation) {
      throw new Error("knowledge_benchmark_paid_confirmation_invalid");
    }
  }
  if (queryIds.length > 0 && queryLimit !== undefined) {
    throw new Error("knowledge_benchmark_query_selection_ambiguous");
  }
  if (new Set(queryIds).size !== queryIds.length) {
    throw new Error("knowledge_benchmark_query_id_duplicate");
  }
  if ((diagnosticCandidateAudit || diagnosticDisableReranker) &&
    queryIds.length === 0 && queryLimit === undefined) {
    throw new Error("knowledge_benchmark_diagnostic_reranker_scope_invalid");
  }
  if (diagnosticCandidateAudit && diagnosticDisableReranker) {
    throw new Error("knowledge_benchmark_diagnostic_mode_ambiguous");
  }
  if (resume && outputDirectory === undefined) {
    throw new Error("knowledge_benchmark_resume_selection_invalid");
  }
  if (preflightOnly && (resume || outputDirectory !== undefined ||
    queryIds.length > 0 || queryLimit !== undefined ||
    diagnosticCandidateAudit || diagnosticDisableReranker)) {
    throw new Error("knowledge_benchmark_preflight_mode_invalid");
  }
  return Object.freeze({
    concurrency,
    configLabel,
    diagnosticCandidateAudit,
    diagnosticDisableReranker,
    embedTimeoutMs: embedTimeoutMinutes * 60_000,
    outputDirectory,
    preflightOnly,
    queryIds: Object.freeze([...queryIds]),
    queryLimit,
    queryStartIntervalMs,
    rateLimitCooldownMs,
    resume,
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

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "ENOENT";
}

async function readOptionalJson(path: string, invalidCode: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw new Error(invalidCode);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(invalidCode);
  }
}

function sameSchedule(
  left: KnowledgeBenchmarkSchedule,
  right: KnowledgeBenchmarkSchedule
): boolean {
  return left.concurrency === right.concurrency &&
    left.queryStartIntervalMs === right.queryStartIntervalMs &&
    left.rateLimitCooldownMs === right.rateLimitCooldownMs;
}

type RetrievalCheckpointRuntime = Readonly<{
  outcomeDirectory: string;
  resumedOutcomes: ReadonlyMap<number, KnowledgeRetrievalCheckpointOutcome>;
  runId: string;
}>;

function checkpointOutcomePath(directory: string, index: number): string {
  return resolve(directory, `${String(index).padStart(6, "0")}.json`);
}

export async function prepareRetrievalCheckpoint(input: Readonly<{
  manifestFingerprint: string;
  outputDirectory: string;
  queries: readonly KnowledgeBenchmarkQuery[];
  resume: boolean;
  runId: string;
  schedule: KnowledgeBenchmarkSchedule;
}>): Promise<RetrievalCheckpointRuntime> {
  const headerPath = resolve(input.outputDirectory, RETRIEVAL_CHECKPOINT_FILE);
  const outcomeDirectory = resolve(
    input.outputDirectory,
    RETRIEVAL_CHECKPOINT_OUTCOMES_DIRECTORY
  );
  if (!input.resume) {
    let entries: readonly string[] = [];
    try {
      entries = await readdir(input.outputDirectory);
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new Error("knowledge_benchmark_retrieval_checkpoint_initialize_failed");
      }
    }
    if (entries.length !== 0) {
      throw new Error("knowledge_benchmark_retrieval_checkpoint_output_not_empty");
    }
    await mkdir(outcomeDirectory, { recursive: true });
    await writeJsonAtomic(headerPath, {
      manifestFingerprint: input.manifestFingerprint,
      queryCount: input.queries.length,
      querySetContentSha256: knowledgeQuerySetContentSha256(input.queries),
      runId: input.runId,
      schedule: input.schedule,
      schemaVersion: KNOWLEDGE_RETRIEVAL_CHECKPOINT_SCHEMA_VERSION
    });
    return Object.freeze({
      outcomeDirectory,
      resumedOutcomes: new Map(),
      runId: input.runId
    });
  }
  if (await readOptionalJson(
    resolve(input.outputDirectory, "summary.json"),
    "knowledge_benchmark_retrieval_checkpoint_summary_invalid"
  ) !== null) {
    throw new Error("knowledge_benchmark_retrieval_checkpoint_already_complete");
  }
  const rawHeader = await readOptionalJson(
    headerPath,
    "knowledge_benchmark_retrieval_checkpoint_header_invalid"
  );
  if (rawHeader === null) {
    throw new Error("knowledge_benchmark_retrieval_checkpoint_missing");
  }
  const header = decodeKnowledgeRetrievalCheckpointHeader(rawHeader);
  if (header.manifestFingerprint !== input.manifestFingerprint ||
    header.queryCount !== input.queries.length ||
    header.querySetContentSha256 !== knowledgeQuerySetContentSha256(input.queries) ||
    !sameSchedule(header.schedule, input.schedule)) {
    throw new Error("knowledge_benchmark_retrieval_checkpoint_mismatch");
  }
  await mkdir(outcomeDirectory, { recursive: true });
  const resumedOutcomes = new Map<number, KnowledgeRetrievalCheckpointOutcome>();
  for (let index = 0; index < input.queries.length; index += 1) {
    const raw = await readOptionalJson(
      checkpointOutcomePath(outcomeDirectory, index),
      "knowledge_benchmark_retrieval_checkpoint_file_invalid"
    );
    if (raw === null) continue;
    resumedOutcomes.set(index, decodeKnowledgeRetrievalCheckpointFile(
      raw,
      input.manifestFingerprint,
      input.queries[index]!
    ));
  }
  return Object.freeze({
    outcomeDirectory,
    resumedOutcomes,
    runId: header.runId
  });
}

function suiteFilePath(suiteId: KnowledgeSuiteId, manifestPath: string): string {
  if (suiteId === "bright-stackoverflow-50m") {
    const file = Object.values(BRIGHT_STACKOVERFLOW_FILES)
      .find((candidate) => candidate.path === manifestPath);
    if (!file) throw new Error("knowledge_benchmark_dataset_path_invalid");
    return resolve(datasetsRoot, suiteId, file.localName);
  }
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
): Promise<Readonly<{
  boundedQueryCount: number;
  normalizedQueryCount: number;
  queries: readonly KnowledgeBenchmarkQuery[];
}>> {
  if (suite.suiteId === "bright-stackoverflow-50m") {
    const prepared = await verifyBrightPreparedDataset(brightPreparedRoot);
    const [runtimeText, evaluatorText] = await Promise.all([
      readFile(resolve(brightPreparedRoot, prepared.queries.runtimeFile.path), "utf8"),
      readFile(resolve(brightPreparedRoot, prepared.queries.evaluatorFile.path), "utf8")
    ]);
    const querySet = buildBrightRetrievalQueries(
      parseJsonLines(runtimeText, "bright_stackoverflow_runtime_queries_invalid"),
      parseJsonLines(evaluatorText, "bright_stackoverflow_evaluator_queries_invalid")
    );
    if (querySet.queries.length !== BRIGHT_STACKOVERFLOW_QUERY_COUNT) {
      throw new Error("knowledge_benchmark_query_count_mismatch");
    }
    return querySet;
  }
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
    const rows = parseJsonLines(
      await readFile(
        suiteFilePath(suite.suiteId, "data/ConvFinQA/turn_0.jsonl"),
        "utf8"
      ),
      "knowledge_benchmark_queries_jsonl_invalid"
    );
    if (rows.length !== suite.expectedQueryCount) {
      throw new Error("knowledge_benchmark_query_count_mismatch");
    }
    queries = decodeConvFinQaQueries(rows);
  }
  if (queries.length !==
    suite.expectedQueryCount - suite.expectedExcludedQueryCount) {
    throw new Error("knowledge_benchmark_query_count_mismatch");
  }
  if (queries.some(({ text }) => [...text].length > KNOWLEDGE_QUERY_MAX_CHARACTERS)) {
    throw new Error("knowledge_benchmark_query_too_long");
  }
  return Object.freeze({
    boundedQueryCount: 0,
    normalizedQueryCount: 0,
    queries
  });
}

async function loadIngestState(suiteId: KnowledgeSuiteId): Promise<IngestStateFile> {
  if (suiteId === "bright-stackoverflow-50m") {
    const prepared = await verifyBrightPreparedDataset(brightPreparedRoot);
    const documents: Record<string, Readonly<{
      officialId: string;
      sourceId: string;
      state: string;
    }>> = {};
    for await (const document of selectedDocuments(
      0,
      BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT,
      prepared.corpus.shards
    )) {
      documents[String(document.ordinal)] = Object.freeze({
        officialId: document.officialId,
        sourceId: document.sourceId,
        state: "ready"
      });
    }
    if (Object.keys(documents).length !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT) {
      throw new Error("knowledge_benchmark_ingest_state_incomplete");
    }
    return Object.freeze({
      completedAt: null,
      corpusContentSha256: prepared.corpus.preparedFingerprint,
      datasetSources: Object.freeze([{
        datasetId: "xlangai/BRIGHT",
        revision: BRIGHT_STACKOVERFLOW_REVISION
      }]),
      docFormatVersion: BRIGHT_STACKOVERFLOW_PREPARED_FORMAT_VERSION,
      documents: Object.freeze(documents),
      knowledgeBaseId: null,
      ocr: null,
      querySplit: "stackoverflow",
      schemaVersion: INGEST_STATE_SCHEMA_VERSION,
      suiteId,
      userId: null
    });
  }
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

type BrightRetrievalAttestation = Readonly<{
  admittedBindingCount: number;
  admittedMaterializedSourceCount: number;
  admittedResolvedSourceCount: number;
  embeddingCount: number;
  passageCount: number;
  projectedArtifactCount: number;
  projectedPassageCount: number;
  sourceCount: number;
}>;

async function hydrateBrightIngestState(
  prisma: PrismaClient,
  state: IngestStateFile
): Promise<Readonly<{
  attestation: BrightRetrievalAttestation;
  state: IngestStateFile;
}>> {
  const prepared = await verifyBrightPreparedDataset(brightPreparedRoot);
  const ownerUserId = brightDeterministicUuid("benchmark-owner");
  const owner = await prisma.user.findUnique({
    select: { role: true, status: true },
    where: { id: ownerUserId }
  });
  if (owner?.role !== "user" || owner.status !== "active") {
    throw new Error("bright_stackoverflow_retrieval_owner_invalid");
  }
  const profile = await activeImportProfile(prisma, ownerUserId);
  const identity = importIdentity(prepared.manifestFingerprint, profile);
  const knowledgeBaseId = brightDeterministicUuid("benchmark-base", identity);
  const generationId = brightDeterministicUuid("benchmark-generation", identity);
  const base = await prisma.knowledgeBase.findUnique({
    select: {
      activeIndexGenerationId: true,
      archivedAt: true,
      deletionRequestedAt: true,
      ownerUserId: true,
      trashedAt: true
    },
    where: { id: knowledgeBaseId }
  });
  if (!base || base.ownerUserId !== ownerUserId ||
    base.activeIndexGenerationId !== generationId || base.archivedAt ||
    base.trashedAt || base.deletionRequestedAt) {
    throw new Error("bright_stackoverflow_retrieval_base_invalid");
  }
  const target = Object.freeze({
    embeddingProviderModelId: profile.embeddingProviderModelId,
    generationId,
    knowledgeBaseId,
    ownerUserId,
    profileRevisionId: profile.profileRevisionId,
    targetDimension: profile.targetDimension,
    vectorSpaceFingerprint: profile.vectorSpaceFingerprint
  });
  const activation = await createPrismaKnowledgeBulkActivationRepository(prisma)
    .inspect(target);
  if (activation.totalSources !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
    activation.readySources !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
    activation.pendingSources !== 0) {
    throw new Error("bright_stackoverflow_retrieval_sources_incomplete");
  }
  const snapshot = await prisma.knowledgeBaseSnapshot.findFirst({
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, readySourceCount: true, sourceCount: true },
    where: { knowledgeBaseId }
  });
  if (!snapshot || snapshot.sourceCount !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
    snapshot.readySourceCount !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT) {
    throw new Error("bright_stackoverflow_retrieval_snapshot_incomplete");
  }
  const [counts] = await prisma.$queryRaw<Array<{
    embeddingCount: number;
    passageCount: number;
    pdfAttemptCount: number;
    uploadItemCount: number;
  }>>(Prisma.sql`
    WITH target_artifacts AS MATERIALIZED (
      SELECT artifact."id"
      FROM "KnowledgeBaseSource" AS membership
      INNER JOIN "KnowledgeSource" AS source
        ON source."id" = membership."sourceId"
      INNER JOIN "KnowledgeSourceVersion" AS version
        ON version."id" = source."currentVersionId"
      INNER JOIN "KnowledgeSourceIndexArtifact" AS artifact
        ON artifact."sourceVersionId" = version."id"
       AND artifact."profileRevisionId" = ${profile.profileRevisionId}
      WHERE membership."knowledgeBaseId" = ${knowledgeBaseId}
        AND membership."removedAt" IS NULL
    )
    SELECT
      (
        SELECT count(*)::integer
        FROM target_artifacts AS target
        INNER JOIN "KnowledgeHierarchicalIndexArtifact" AS hierarchy
          ON hierarchy."sourceArtifactId" = target."id"
        INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
          ON passage."indexArtifactId" = hierarchy."id"
      ) AS "passageCount",
      (
        SELECT count(*)::integer
        FROM target_artifacts AS target
        INNER JOIN "KnowledgeHierarchicalIndexArtifact" AS hierarchy
          ON hierarchy."sourceArtifactId" = target."id"
        INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
          ON passage."indexArtifactId" = hierarchy."id"
        INNER JOIN "KnowledgeArtifactPassageEmbedding" AS embedding
          ON embedding."passageId" = passage."id"
      ) AS "embeddingCount",
      (
        SELECT count(*)::integer
        FROM target_artifacts AS target
        INNER JOIN "KnowledgePdfProcessingAttempt" AS pdf_attempt
          ON pdf_attempt."sourceArtifactId" = target."id"
      ) AS "pdfAttemptCount",
      (
        SELECT count(*)::integer
        FROM target_artifacts AS target
        INNER JOIN "KnowledgeUploadItem" AS upload_item
          ON upload_item."sourceArtifactId" = target."id"
      ) AS "uploadItemCount"
  `);
  if (!counts || counts.passageCount < BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
    counts.embeddingCount !== counts.passageCount || counts.pdfAttemptCount !== 0 ||
    counts.uploadItemCount !== 0) {
    throw new Error("bright_stackoverflow_retrieval_product_state_incomplete");
  }
  const projection = await inspectKnowledgeSearchIntegrity({ client: prisma });
  if (!projection.healthy ||
    projection.readyProjectionCount !== projection.expectedArtifactCount ||
    projection.currentMappingDocumentCount !== projection.expectedPassageCount) {
    throw new Error("bright_stackoverflow_retrieval_projection_incomplete");
  }
  let admission: Awaited<ReturnType<typeof loadKnowledgeRunAdmissionPlan>>;
  try {
    admission = await loadKnowledgeRunAdmissionPlan(prisma, {
      knowledgePlan: {
        baseIds: [knowledgeBaseId],
        mode: "explicit",
        sourceIds: [],
        version: KNOWLEDGE_SELECTION_VERSION
      },
      userId: ownerUserId
    });
  } catch (error) {
    const name = error instanceof Error && /^[A-Za-z0-9_.-]{1,100}$/u.test(error.name)
      ? error.name
      : "unknown";
    const candidateCode = typeof error === "object" && error !== null &&
      "code" in error ? String(error.code) : "none";
    const code = /^[A-Za-z0-9_.-]{1,100}$/u.test(candidateCode)
      ? candidateCode
      : "unknown";
    throw new Error(`bright_stackoverflow_retrieval_admission_failed:${name}:${code}`);
  }
  const admittedBinding = admission.bindings[0];
  if (admission.bindings.length !== 1 || !admittedBinding?.includeWholeBase ||
    admittedBinding.knowledgeBaseId !== knowledgeBaseId ||
    admittedBinding.selectedSourceIds.length !== 0 ||
    admission.resolvedSourceCount !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
    admission.sources?.length !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
    admission.exclusions.some(({ count }) => count !== 0)) {
    throw new Error("bright_stackoverflow_retrieval_admission_incomplete");
  }
  return Object.freeze({
    attestation: Object.freeze({
      admittedBindingCount: admission.bindings.length,
      admittedMaterializedSourceCount: admission.sources.length,
      admittedResolvedSourceCount: admission.resolvedSourceCount,
      embeddingCount: counts.embeddingCount,
      passageCount: counts.passageCount,
      projectedArtifactCount: projection.readyProjectionCount,
      projectedPassageCount: projection.currentMappingDocumentCount,
      sourceCount: activation.readySources
    }),
    state: Object.freeze({
      ...state,
      completedAt: snapshot.createdAt.toISOString(),
      knowledgeBaseId,
      ocr: Object.freeze({ assertedZeroOcr: true }),
      userId: ownerUserId
    })
  });
}

/** Creates one accepted benchmark run whose Knowledge bindings authorize the
 * ingested base, exactly like ordinary run admission does. */
async function createBenchmarkRun(
  prisma: PrismaClient,
  userId: string,
  knowledgeBaseId: string,
  suiteId: KnowledgeSuiteId
): Promise<string> {
  failureStage = "run_admission_plan";
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
  failureStage = "run_admission_persist";
  await prisma.$transaction(async (tx) => {
    failureStage = "run_admission_chat";
    await tx.chat.create({
      data: {
        id: chatId,
        memoryMode: "EXCLUDED",
        title: `Knowledge benchmark retrieval ${suiteId}`,
        userId
      }
    });
    failureStage = "run_admission_message";
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
    failureStage = "run_admission_model_run";
    await tx.modelRun.create({
      data: {
        chatId,
        id: runId,
        modelId: "knowledge-benchmark",
        normalizedRequest: {},
        provider: "knowledge-benchmark",
        status: "complete",
        userId,
        userMessageId
      }
    });
    failureStage = "run_admission_bindings";
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
  queries: readonly KnowledgeBenchmarkQuery[],
  configLabel: KnowledgeConfigLabel,
  binding: KnowledgeAcceptedBinding,
  queryPreparation: Readonly<{
    boundedQueryCount: number;
    normalizedQueryCount: number;
  }>,
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
    excludedQueryCount: suite.expectedExcludedQueryCount,
    indexProfile: `vector-space:${binding.vectorSpaceFingerprint}`,
    queryCount: queries.length,
    queryInstructionVersion: instructionTemplate === null
      ? "none"
      : `qi-${shortHash(instructionTemplate)}`,
    queryPreparation: {
      boundedQueryCount: queryPreparation.boundedQueryCount,
      focusedRequestVersion: suite.suiteId === "bright-stackoverflow-50m"
        ? KNOWLEDGE_FOCUSED_REQUEST_VERSION
        : null,
      normalizedQueryCount: queryPreparation.normalizedQueryCount
    },
    querySetContentSha256: knowledgeQuerySetContentSha256(queries),
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

export async function readCachedEmbedding(path: string): Promise<CachedEmbedding | null> {
  const invalidCode = "knowledge_benchmark_embedding_cache_invalid";
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw new Error(invalidCode);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(invalidCode);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(invalidCode);
  }
  const cached = value as Record<string, unknown>;
  const validTokens = (tokens: unknown): boolean => tokens === null ||
    typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0;
  if (Object.keys(cached).length !== 4 ||
    cached.dimension !== 1_024 && cached.dimension !== 1_536 ||
    !Array.isArray(cached.vector) || cached.vector.length !== cached.dimension ||
    cached.vector.some((entry) => typeof entry !== "number" || !Number.isFinite(entry)) ||
    !validTokens(cached.inputTokens) || !validTokens(cached.totalTokens)) {
    // A damaged/unreadable paid receipt is not a cache miss. Stop instead of
    // silently issuing another provider request for already accepted work.
    throw new Error(invalidCode);
  }
  return cached as CachedEmbedding;
}

async function main(): Promise<void> {
  failureStage = "configuration";
  const options = parseKnowledgeRetrievalCli(process.argv.slice(2));
  if (options.suiteId === "bright-stackoverflow-50m") {
    if (process.env.AIQSA_BRIGHT_BENCHMARK_ACK !== "RETAINED_BRIGHT_KB") {
      throw new Error("bright_stackoverflow_retrieval_confirmation_required");
    }
  } else {
    assertKnowledgeBenchmarkAck(process.env);
  }
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
  failureStage = "dataset";
  await verifySuiteDownloads(suite);
  const loadedQueries = await loadQueries(suite);
  const allQueries = loadedQueries.queries;
  const queries = selectKnowledgeBenchmarkQueries(
    allQueries,
    options.queryIds,
    options.queryLimit
  );
  const scoreable = options.queryLimit === undefined && options.queryIds.length === 0;
  failureStage = "ingest_state";
  let state = await loadIngestState(options.suiteId);
  const officialIdsBySourceId: Record<string, string[]> = {};
  const sourceIdsByOfficialId: Record<string, string[]> = {};
  const knownOfficialIds = new Set<string>();
  for (const document of Object.values(state.documents)) {
    (officialIdsBySourceId[document.sourceId] ??= []).push(document.officialId);
    (sourceIdsByOfficialId[document.officialId] ??= []).push(document.sourceId);
    knownOfficialIds.add(document.officialId);
  }
  for (const query of queries) {
    for (const documentId of [
      ...Object.keys(query.relevant),
      ...(query.excludedDocumentIds ?? [])
    ]) {
      if (!knownOfficialIds.has(documentId)) {
        throw new Error("knowledge_benchmark_relevant_document_not_ingested");
      }
    }
  }
  const runStamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const generatedRunId = `${options.suiteId}-${options.configLabel}-${runStamp}`;
  const outputDirectory = resolveKnowledgeBenchmarkOutputDirectory(
    benchmarkRoot,
    options.outputDirectory ?? `results/${generatedRunId}`
  );
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    failureStage = "database_identity";
    await assertDatabaseIdentity(prisma);
    let brightAttestation: BrightRetrievalAttestation | null = null;
    if (options.suiteId === "bright-stackoverflow-50m") {
      failureStage = "bright_attestation";
      const hydrated = await hydrateBrightIngestState(prisma, state);
      state = hydrated.state;
      brightAttestation = hydrated.attestation;
    }
    if (options.preflightOnly) {
      emit("retrieval_preflight_complete", {
        boundedQueryCount: loadedQueries.boundedQueryCount,
        corpusDocumentCount: Object.keys(state.documents).length,
        normalizedQueryCount: loadedQueries.normalizedQueryCount,
        queryCount: allQueries.length,
        ...(brightAttestation ?? {}),
        suiteId: options.suiteId,
        zeroOcrAsserted: state.ocr?.assertedZeroOcr === true
      });
      return;
    }
    failureStage = "run_admission";
    const benchmarkRunId = await createBenchmarkRun(
      prisma,
      state.userId!,
      state.knowledgeBaseId!,
      options.suiteId
    );
    const store = createPrismaKnowledgeRetrievalStore(prisma);
    failureStage = "bindings";
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
    failureStage = "embedding_runtime";
    const runtime = await createPrismaKnowledgeEmbeddingRuntime(prisma)
      .resolve(bindings[0]!);
    // Freeze one admitted installation role for the complete diagnostic run.
    // Each query still creates a fresh one-request stage, while mid-run Admin
    // changes cannot silently mix retrieval configurations in one manifest.
    failureStage = "reranker_runtime";
    const configuredReranker = await createPrismaKnowledgeRerankerRuntime(prisma)
      .resolve();
    const reranker: KnowledgeRerankerRoleResolution =
      options.diagnosticDisableReranker
        ? Object.freeze({ kind: "absent" as const })
        : configuredReranker;
    const frozenManifest = buildFrozenManifest(
      state,
      suite,
      allQueries,
      options.configLabel,
      bindings[0]!,
      loadedQueries,
      runtime,
      reranker
    );
    const manifestFingerprint = knowledgeRunManifestFingerprint(frozenManifest);
    const schedule = Object.freeze({
      concurrency: options.concurrency,
      queryStartIntervalMs: options.queryStartIntervalMs,
      rateLimitCooldownMs: options.rateLimitCooldownMs
    });
    failureStage = "retrieval_checkpoint";
    const checkpoint = await prepareRetrievalCheckpoint({
      manifestFingerprint,
      outputDirectory,
      queries,
      resume: options.resume,
      runId: generatedRunId,
      schedule
    });
    const runId = checkpoint.runId;
    emit("run_started", {
      configLabel: options.configLabel,
      datasetFingerprint: knowledgeDatasetFingerprint(frozenManifest),
      diagnosticCandidateAudit: options.diagnosticCandidateAudit,
      diagnosticRerankerDisabled: options.diagnosticDisableReranker,
      manifestFingerprint,
      queryCount: queries.length,
      resultLabel: suite.resultLabel,
      resumedQueryCount: checkpoint?.resumedOutcomes.size ?? 0,
      runId,
      scoreable,
      schedule
    });
    failureStage = "queries";
    await mkdir(cacheRoot, { recursive: true });
    let cacheHits = 0;
    let nextProgressAt = 0;
    let completed = 0;
    let resumedQueryCount = 0;
    const rerankerFallbackReasons = new Map<string, number>();
    const requestPacer = createKnowledgeBenchmarkRequestPacer({
      intervalMs: options.queryStartIntervalMs
    });
    // Public suites contain distinct query ids with identical query text.
    // Coalesce concurrent misses so one cache key produces exactly one paid
    // embedding request and every identical query uses the same vector.
    const pendingEmbeddings = new Map<string, Promise<CachedEmbedding>>();
    const recordFallbackReason = (fallbackReason: string | null): void => {
      if (!fallbackReason) return;
      rerankerFallbackReasons.set(
        fallbackReason,
        (rerankerFallbackReasons.get(fallbackReason) ?? 0) + 1
      );
    };
    const emitProgress = (): void => {
      if (Date.now() < nextProgressAt) return;
      emit("retrieval_progress", {
        cacheHits,
        completedQueries: completed,
        rerankerFallbackReasons: Object.fromEntries(
          [...rerankerFallbackReasons].sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0)
        ),
        resumedQueryCount,
        totalQueries: queries.length
      });
      nextProgressAt = Date.now() + 15_000;
    };
    const outcomes = await mapConcurrentOrdered(
      queries,
      options.concurrency,
      async (query, queryIndex): Promise<KnowledgeRetrievalCheckpointOutcome> => {
        const resumed = checkpoint?.resumedOutcomes.get(queryIndex);
        if (resumed) {
          resumedQueryCount += 1;
          completed += 1;
          recordFallbackReason(resumed.rerankerDiagnostic.fallbackReason);
          emitProgress();
          return resumed;
        }
        await requestPacer.admit();
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
          excludedOccurrenceKeys: [],
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
        const rerankerEvidence = result.rerankerBinding;
        if (options.diagnosticCandidateAudit) {
          const candidateOrder = result.rankingEvidence?.candidateOrder;
          if (!candidateOrder) {
            throw new Error("knowledge_benchmark_candidate_audit_unavailable");
          }
          const relevantSourceIds = Object.keys(query.relevant).flatMap(
            (officialId) => sourceIdsByOfficialId[officialId] ?? []
          );
          if (relevantSourceIds.length === 0) {
            throw new Error("knowledge_benchmark_relevant_document_not_ingested");
          }
          const relevantPassages = await prisma.$queryRaw<Array<{
            chunkId: string;
            sourceId: string;
          }>>(Prisma.sql`
            SELECT
              passage."id" AS "chunkId",
              version."sourceId" AS "sourceId"
            FROM "KnowledgeArtifactPassageIndex" AS passage
            INNER JOIN "KnowledgeHierarchicalIndexArtifact" AS hierarchy
              ON hierarchy."id" = passage."indexArtifactId"
            INNER JOIN "KnowledgeSourceIndexArtifact" AS artifact
              ON artifact."id" = hierarchy."sourceArtifactId"
             AND artifact."sourceVersionId" = hierarchy."sourceVersionId"
            INNER JOIN "KnowledgeSourceVersion" AS version
              ON version."id" = artifact."sourceVersionId"
            WHERE version."sourceId" IN (${Prisma.join(relevantSourceIds)})
          `);
          const candidateRankByChunkId = new Map(
            candidateOrder.map((chunkId, index) => [
              chunkId,
              index + 1
            ])
          );
          const preRerankRankByChunkId = new Map(
            (rerankerEvidence?.orderedCandidateChunkIds ?? []).map((chunkId, index) => [
              chunkId,
              index + 1
            ])
          );
          const ranksBySourceId = new Map<string, number[]>();
          const preRerankRanksBySourceId = new Map<string, number[]>();
          for (const passage of relevantPassages) {
            const rank = candidateRankByChunkId.get(passage.chunkId);
            if (rank !== undefined) {
              const ranks = ranksBySourceId.get(passage.sourceId) ?? [];
              ranks.push(rank);
              ranksBySourceId.set(passage.sourceId, ranks);
            }
            const preRerankRank = preRerankRankByChunkId.get(passage.chunkId);
            if (preRerankRank !== undefined) {
              const ranks = preRerankRanksBySourceId.get(passage.sourceId) ?? [];
              ranks.push(preRerankRank);
              preRerankRanksBySourceId.set(passage.sourceId, ranks);
            }
          }
          const relevantCandidateRanks = Object.fromEntries(
            Object.keys(query.relevant).sort().map((officialId) => {
              const ranks = (sourceIdsByOfficialId[officialId] ?? []).flatMap(
                (sourceId) => ranksBySourceId.get(sourceId) ?? []
              );
              return [officialId, ranks.length === 0 ? null : Math.min(...ranks)];
            })
          );
          const relevantPreRerankRanks = Object.fromEntries(
            Object.keys(query.relevant).sort().map((officialId) => {
              const ranks = (sourceIdsByOfficialId[officialId] ?? []).flatMap(
                (sourceId) => preRerankRanksBySourceId.get(sourceId) ?? []
              );
              return [officialId, ranks.length === 0 ? null : Math.min(...ranks)];
            })
          );
          emit("candidate_audit", {
            candidateCount: candidateOrder.length,
            queryId: query.officialId,
            relevantCandidateRanks,
            relevantPreRerankRanks
          });
        }
        const searchMs = Date.now() - searchStartedAt;
        if (reranker.kind === "ready" && !rerankerEvidence) {
          throw new Error("knowledge_benchmark_reranker_evidence_missing");
        }
        const omittedAdmission = result.rankingEvidence?.rerankOmittedAdmission;
        const providerOmittedCandidateCount = rerankerEvidence?.status === "partial"
          ? rerankerEvidence.relevanceScores.filter((score) => score === null).length
          : 0;
        if ((rerankerEvidence?.status === "partial" && (
          !omittedAdmission ||
          omittedAdmission.omittedCandidateCount !== providerOmittedCandidateCount
        )) || (rerankerEvidence?.status !== "partial" && omittedAdmission)) {
          throw new Error("knowledge_benchmark_rerank_admission_evidence_invalid");
        }
        const rerankerDiagnostic = Object.freeze(reranker.kind === "absent"
          ? {
              fallbackReason: null,
              omittedCandidateCount: 0,
              omittedRejectedCandidateCount: 0,
              status: "disabled" as const,
              timedOut: false
            }
          : reranker.kind === "unavailable"
            ? {
                fallbackReason: "reranker_model_unavailable",
                omittedCandidateCount: 0,
                omittedRejectedCandidateCount: 0,
                status: "degraded" as const,
                timedOut: false
              }
            : {
                fallbackReason: rerankerEvidence!.fallbackReason,
                omittedCandidateCount: omittedAdmission?.omittedCandidateCount ?? 0,
                omittedRejectedCandidateCount:
                  omittedAdmission?.omittedRejectedCandidateCount ?? 0,
                status: rerankerEvidence!.status,
                timedOut: rerankerEvidence!.timedOut
              });
        recordFallbackReason(rerankerDiagnostic.fallbackReason);
        if (rerankerDiagnostic.fallbackReason === "rerank_provider_rate_limited") {
          requestPacer.defer(options.rateLimitCooldownMs);
        }
        const rankedDocumentIds = excludeKnowledgeBenchmarkDocuments(
          expandRankedDocuments(
            // The product result order is authoritative after hosted reranking.
            // A monotonic ordinal score lets the document projection preserve
            // that order even when a partial rerank omitted some scores.
            projectDocumentRanking(result.passages.map((passage, index) => ({
              documentId: passage.documentId,
              passageId: passage.chunkId,
              score: result.passages.length - index
            }))),
            officialIdsBySourceId
          ),
          query.excludedDocumentIds
        );
        const rerankRequestMade = rerankerEvidence !== undefined &&
          rerankerEvidence.inputCandidateCount > 1;
        const outcome = Object.freeze({
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
          rerankerDiagnostic,
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
        if (checkpoint) {
          await writeJsonAtomic(
            checkpointOutcomePath(checkpoint.outcomeDirectory, queryIndex),
            {
              manifestFingerprint,
              outcome,
              schemaVersion: KNOWLEDGE_RETRIEVAL_CHECKPOINT_SCHEMA_VERSION
            }
          );
        }
        completed += 1;
        emitProgress();
        return outcome;
      }
    );
    const metrics = aggregateKnowledgeSuiteMetrics(outcomes);
    const brightMetrics = options.suiteId === "bright-stackoverflow-50m"
      ? aggregateBrightRetrievalMetrics(outcomes, KNOWLEDGE_RESULT_LIMIT, !options.resume)
      : null;
    const rerankAdmission = aggregateKnowledgeRerankAdmissionDiagnostics(outcomes);
    const embedCacheMisses = metrics.usage.embedding.requests;
    const embedCacheHits = queries.length - embedCacheMisses;
    failureStage = "results";
    await mkdir(outputDirectory, { recursive: true });
    {
      await writeJsonAtomic(resolve(outputDirectory, scoreable ? "summary.json" : "smoke-summary.json"), {
        ...(!scoreable ? { scoreable: false } : {}),
        configLabel: options.configLabel,
        createdAt: new Date().toISOString(),
        datasetFingerprint: knowledgeDatasetFingerprint(frozenManifest),
        execution: {
          embedCacheHits,
          embedCacheMisses,
          queryStartIntervalMs: options.queryStartIntervalMs,
          rateLimitCooldownMs: options.rateLimitCooldownMs,
          rerankAdmission,
          rerankerFallbackReasons: Object.fromEntries(
            [...rerankerFallbackReasons].sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0)
          ),
          resumedQueryCount,
          uniqueSources: Object.keys(officialIdsBySourceId).length,
          zeroOcrAsserted: true
        },
        manifest: frozenManifest,
        manifestFingerprint,
        metrics,
        ...(brightMetrics ? { brightMetrics } : {}),
        resultLabel: suite.resultLabel,
        runId,
        schemaVersion: KNOWLEDGE_BENCHMARK_SUMMARY_SCHEMA_VERSION
      });
    }
    // Audit projection with official public dataset ids only.
    await writeJsonAtomic(resolve(outputDirectory, "rankings.json"), {
      manifestFingerprint,
      queries: outcomes.map((outcome) => ({
        queryId: outcome.queryId,
        rankedDocumentIds: outcome.rankedDocumentIds,
        relevantDocumentIds: Object.keys(outcome.relevant).sort(),
        reranker: outcome.rerankerDiagnostic
      })),
      runId,
      schedule,
      schemaVersion: RANKINGS_SCHEMA_VERSION,
      scoreable
    });
    emit("run_complete", {
      cacheHits: embedCacheHits,
      ...(brightMetrics ?? {}),
      exactRelevantHitRate: metrics.exactRelevantHitRate,
      mrr10: metrics.mrr10,
      ndcg10: metrics.ndcg10,
      queryCount: metrics.queryCount,
      recall10: metrics.recall10,
      recall50: metrics.recall50,
      rerankFallbackRate: metrics.rerankFallbackRate,
      rerankAdmission,
      rerankerFallbackReasons: Object.fromEntries(
        [...rerankerFallbackReasons].sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0)
      ),
      resumedQueryCount,
      retrievalMsP50: metrics.retrievalMsP50,
      retrievalMsP95: metrics.retrievalMsP95,
      runId,
      scoreable
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown";
    const candidateCode = typeof error === "object" && error !== null &&
      "code" in error ? String(error.code) : null;
    const safeCandidateCode = candidateCode !== null &&
      /^[A-Za-z0-9_.:-]{1,100}$/u.test(candidateCode)
      ? candidateCode
      : null;
    const errorName = error instanceof Error &&
      /^[A-Za-z0-9_.-]{1,100}$/u.test(error.name)
      ? error.name
      : "unknown";
    const code = /^[A-Za-z0-9_:,.-]{1,200}$/u.test(message)
      ? message
      : `knowledge_benchmark_retrieve_failed:${failureStage}:` +
        `${safeCandidateCode ?? errorName}`;
    emit("retrieve_failed", { code });
    process.exitCode = 1;
  });
}

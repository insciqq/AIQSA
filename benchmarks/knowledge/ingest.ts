import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { Prisma, PrismaClient } from "@prisma/client";
import { createPrismaAuthSessionStore } from "../../lib/server/auth/prismaSessions";
import { createAuthSession } from "../../lib/server/auth/requestAuth";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import {
  KNOWLEDGE_BENCHMARK_APP_PORT,
  KNOWLEDGE_BENCHMARK_DOC_FORMAT_VERSION,
  assertKnowledgeBenchmarkAck,
  assertKnowledgeBenchmarkBaseUrl,
  assertKnowledgeBenchmarkDatabaseUrl,
  decodeConvFinQaCorpus,
  decodeKnowledgeBenchmarkManifest,
  decodeRusScifactCorpus,
  knowledgeBenchmarkUploadClientId,
  knowledgeCorpusContentSha256,
  mapConcurrentOrdered,
  parseJsonLines,
  type KnowledgeBenchmarkDocument,
  type KnowledgeSuiteId,
  type KnowledgeSuiteManifest
} from "./contract";
import { knowledgeBenchmarkUploadRecoveryDisposition } from "./ingestResume";

/** Drives public-corpus ingestion exclusively through the product HTTP
 * boundary of the isolated benchmark stack: knowledge base creation, upload
 * batches, raw text/markdown uploads, per-item settle, and polling to the
 * terminal item states. Only the benchmark identity and the zero-OCR ledger
 * assertion touch the disposable database directly. */

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(benchmarkRoot, "../..");
const datasetsRoot = resolve(benchmarkRoot, ".data/datasets");
const stateRoot = resolve(benchmarkRoot, ".data/state");
const benchmarkEmailSuffix = "@knowledge.benchmark.invalid";
const terminalSuccessStates = new Set(["ready", "ready_with_warnings", "reused"]);
const terminalFailureStates = new Set(["cancelled", "needs_attention"]);
const INGEST_STATE_SCHEMA_VERSION = 1;

type CliOptions = Readonly<{
  batchSize: number | undefined;
  recoverBatchId: string | undefined;
  replaceSourceIds: readonly string[];
  reprocessSourceId: string | undefined;
  settleTimeoutMs: number;
  suiteId: KnowledgeSuiteId;
  uploadConcurrency: number;
}>;

type IngestDocumentState = Readonly<{
  officialId: string;
  sourceId: string;
  state: string;
}>;

type IngestState = {
  completedAt: string | null;
  corpusContentSha256: string;
  datasetSources: readonly Readonly<{ datasetId: string; revision: string }>[];
  docFormatVersion: number;
  documents: Record<string, IngestDocumentState>;
  knowledgeBaseId: string | null;
  ocr: Readonly<{
    assertedZeroOcr: boolean;
    pdfProcessingAttempts: number;
    warningCounts: Readonly<Record<string, number>>;
  }> | null;
  querySplit: string;
  schemaVersion: number;
  suiteId: KnowledgeSuiteId;
  userId: string | null;
};

function emit(event: string, details: Readonly<Record<string, unknown>> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function parseCli(argv: readonly string[]): CliOptions {
  let confirmPaid = false;
  let suiteId: KnowledgeSuiteId | undefined;
  let batchSize: number | undefined;
  let recoverBatchId: string | undefined;
  const replaceSourceIds: string[] = [];
  let reprocessSourceId: string | undefined;
  let settleTimeoutMinutes = 240;
  let uploadConcurrency = 4;
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
      case "--batch-size": {
        const parsed = Number(next);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
          throw new Error("knowledge_benchmark_batch_size_invalid");
        }
        batchSize = parsed;
        index += 1;
        break;
      }
      case "--reprocess-source":
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
          .test(next ?? "")) {
          throw new Error("knowledge_benchmark_source_id_invalid");
        }
        reprocessSourceId = next;
        index += 1;
        break;
      case "--replace-source":
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
          .test(next ?? "")) {
          throw new Error("knowledge_benchmark_source_id_invalid");
        }
        replaceSourceIds.push(next!);
        index += 1;
        break;
      case "--recover-batch":
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
          .test(next ?? "")) {
          throw new Error("knowledge_benchmark_batch_id_invalid");
        }
        recoverBatchId = next;
        index += 1;
        break;
      case "--settle-timeout-minutes": {
        const parsed = Number(next);
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          throw new Error("knowledge_benchmark_settle_timeout_invalid");
        }
        settleTimeoutMinutes = parsed;
        index += 1;
        break;
      }
      case "--upload-concurrency": {
        const parsed = Number(next);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 8) {
          throw new Error("knowledge_benchmark_upload_concurrency_invalid");
        }
        uploadConcurrency = parsed;
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
  if ([recoverBatchId, replaceSourceIds.length > 0, reprocessSourceId]
    .filter(Boolean).length > 1) {
    throw new Error("knowledge_benchmark_recovery_mode_ambiguous");
  }
  return Object.freeze({
    batchSize,
    recoverBatchId,
    replaceSourceIds: Object.freeze([...new Set(replaceSourceIds)]),
    reprocessSourceId,
    settleTimeoutMs: settleTimeoutMinutes * 60_000,
    suiteId,
    uploadConcurrency
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

function suiteDatasetDirectory(suiteId: KnowledgeSuiteId): string {
  return resolve(
    datasetsRoot,
    suiteId === "rusbeir-rus-scifact" ? "rus-scifact" : "convfinqa"
  );
}

function suiteFilePath(suiteId: KnowledgeSuiteId, manifestPath: string): string {
  // download.sh flattens each suite into one directory with stable basenames.
  const flattened = manifestPath === "test.tsv"
    ? "qrels-test.tsv"
    : manifestPath.split("/").at(-1)!;
  return resolve(suiteDatasetDirectory(suiteId), flattened);
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

async function loadSuiteManifest(
  suiteId: KnowledgeSuiteId
): Promise<KnowledgeSuiteManifest> {
  const manifest = decodeKnowledgeBenchmarkManifest(JSON.parse(
    await readFile(resolve(benchmarkRoot, "upstream.json"), "utf8")
  ) as unknown);
  return manifest.suites[suiteId];
}

async function loadCorpus(
  suite: KnowledgeSuiteManifest
): Promise<readonly KnowledgeBenchmarkDocument[]> {
  if (suite.suiteId === "rusbeir-rus-scifact") {
    const rows = parseJsonLines(
      await readFile(suiteFilePath(suite.suiteId, "corpus.jsonl"), "utf8"),
      "knowledge_benchmark_corpus_jsonl_invalid"
    );
    const corpus = decodeRusScifactCorpus(rows);
    if (suite.expectedCorpusDocumentCount !== null &&
      corpus.length !== suite.expectedCorpusDocumentCount) {
      throw new Error("knowledge_benchmark_corpus_count_mismatch");
    }
    return corpus;
  }
  const rows = parseJsonLines(
    await readFile(suiteFilePath(suite.suiteId, "data/ConvFinQA/turn_0.jsonl"), "utf8"),
    "knowledge_benchmark_corpus_jsonl_invalid"
  );
  if (rows.length !== suite.expectedQueryCount) {
    throw new Error("knowledge_benchmark_query_count_mismatch");
  }
  const corpus = decodeConvFinQaCorpus(rows);
  if (suite.expectedCorpusDocumentCount !== null &&
    corpus.length !== suite.expectedCorpusDocumentCount) {
    throw new Error("knowledge_benchmark_corpus_count_mismatch");
  }
  return corpus;
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

async function loadOrCreateState(
  statePath: string,
  suite: KnowledgeSuiteManifest,
  corpusContentSha256: string
): Promise<IngestState> {
  let existing: IngestState | null = null;
  try {
    existing = JSON.parse(await readFile(statePath, "utf8")) as IngestState;
  } catch {
    existing = null;
  }
  if (existing) {
    if (existing.schemaVersion !== INGEST_STATE_SCHEMA_VERSION ||
      existing.suiteId !== suite.suiteId ||
      existing.corpusContentSha256 !== corpusContentSha256 ||
      existing.docFormatVersion !== KNOWLEDGE_BENCHMARK_DOC_FORMAT_VERSION) {
      throw new Error("knowledge_benchmark_state_incompatible");
    }
    return existing;
  }
  return {
    completedAt: null,
    corpusContentSha256,
    datasetSources: suite.sources.map(({ datasetId, revision }) =>
      Object.freeze({ datasetId, revision })),
    docFormatVersion: KNOWLEDGE_BENCHMARK_DOC_FORMAT_VERSION,
    documents: {},
    knowledgeBaseId: null,
    ocr: null,
    querySplit: suite.querySplit,
    schemaVersion: INGEST_STATE_SCHEMA_VERSION,
    suiteId: suite.suiteId,
    userId: null
  };
}

async function ensureBenchmarkIdentity(
  prisma: PrismaClient,
  state: IngestState,
  statePath: string
): Promise<string> {
  if (state.userId) {
    const user = await prisma.user.findUnique({
      select: { status: true },
      where: { id: state.userId }
    });
    if (user?.status !== "active") {
      throw new Error("knowledge_benchmark_user_missing");
    }
    return state.userId;
  }
  const fullAccess = await prisma.group.findUnique({
    select: { id: true },
    where: { systemRole: "full_access" }
  });
  if (!fullAccess) throw new Error("knowledge_benchmark_full_access_group_missing");
  const userId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        displayName: `Knowledge benchmark ${state.suiteId}`,
        email: `${state.suiteId}.${userId}${benchmarkEmailSuffix}`,
        id: userId,
        role: "user",
        status: "active"
      }
    });
    await provisionActiveUser(tx, {
      groups: [{ groupId: fullAccess.id, role: "member" }],
      userId
    });
  });
  state.userId = userId;
  await writeJsonAtomic(statePath, state);
  return userId;
}

async function createSessionCookie(
  prisma: PrismaClient,
  userId: string
): Promise<string> {
  const session = await createAuthSession({
    secureCookie: false,
    sessions: createPrismaAuthSessionStore(prisma),
    userId
  });
  return session.cookie.split(";", 1)[0]!;
}

function requestHeaders(baseUrl: URL, cookie: string): Record<string, string> {
  return {
    accept: "application/json",
    cookie,
    origin: baseUrl.origin,
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "AIQSA Knowledge benchmark ingest"
  };
}

function sanitizedErrorCode(body: unknown, status: number): string {
  const code = body && typeof body === "object" &&
    typeof (body as { error?: unknown }).error === "string" &&
    /^[a-z0-9_]{1,80}$/u.test((body as { error: string }).error)
    ? (body as { error: string }).error
    : `http_${status}`;
  return code;
}

async function apiRequest(
  baseUrl: URL,
  cookie: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(new URL(path, baseUrl), {
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      headers: {
        ...requestHeaders(baseUrl, cookie),
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      method,
      redirect: "error"
    });
    if (response.status === 429 && attempt < 60) {
      await sleep(1_000);
      continue;
    }
    // Serializable upload settlement can lose a benign concurrency race
    // (PostgreSQL 40001 surfaces as 500); bounded retry with backoff keeps
    // the driver's fail-closed behavior for persistent server failures.
    if ([500, 502, 503, 504].includes(response.status) && attempt < 6) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    const parsed = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      throw new Error(`knowledge_benchmark_api_rejected:${
        sanitizedErrorCode(parsed, response.status)}`);
    }
    return parsed;
  }
}

async function replaceSourceBytes(
  baseUrl: URL,
  cookie: string,
  sourceId: string,
  document: KnowledgeBenchmarkDocument
): Promise<void> {
  const form = new FormData();
  form.set("file", new File([document.markdown], document.fileName, {
    type: "text/markdown"
  }));
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(new URL(
      `/api/me/knowledge-sources/${encodeURIComponent(sourceId)}/versions`,
      baseUrl
    ), {
      body: form,
      cache: "no-store",
      headers: requestHeaders(baseUrl, cookie),
      method: "POST",
      redirect: "error"
    });
    if (response.status === 429 && attempt < 60) {
      await response.arrayBuffer().catch(() => null);
      await sleep(1_000);
      continue;
    }
    if ([500, 502, 503, 504].includes(response.status) && attempt < 6) {
      await response.arrayBuffer().catch(() => null);
      await sleep(500 * 2 ** attempt);
      continue;
    }
    const parsed = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      throw new Error(`knowledge_benchmark_replace_rejected:${
        sanitizedErrorCode(parsed, response.status)}`);
    }
    return;
  }
}

async function uploadItemBytes(
  baseUrl: URL,
  cookie: string,
  uploadUrl: string,
  bytes: Buffer
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(new URL(uploadUrl, baseUrl), {
      body: new Uint8Array(bytes),
      cache: "no-store",
      headers: {
        ...requestHeaders(baseUrl, cookie),
        "content-type": "application/octet-stream"
      },
      method: "PUT",
      redirect: "error"
    });
    if (response.status === 429 && attempt < 120) {
      await response.arrayBuffer().catch(() => null);
      await sleep(1_000);
      continue;
    }
    const parsed = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      throw new Error(`knowledge_benchmark_upload_rejected:${
        sanitizedErrorCode(parsed, response.status)}`);
    }
    return;
  }
}

type BatchItemProjection = Readonly<{
  attemptNumber: number;
  clientFileId: string;
  failureCode: string | null;
  id: string;
  sourceId: string | null;
  state: string;
  transport: Readonly<{ kind: string; uploadUrl?: string }> | null;
}>;

function decodeBatch(value: unknown): Readonly<{
  id: string;
  items: readonly BatchItemProjection[];
}> {
  const code = "knowledge_benchmark_batch_projection_invalid";
  const batch = value && typeof value === "object"
    ? (value as { batch?: unknown }).batch
    : null;
  if (!batch || typeof batch !== "object") throw new Error(code);
  const record = batch as Record<string, unknown>;
  if (typeof record.id !== "string" || !Array.isArray(record.items)) {
    throw new Error(code);
  }
  return Object.freeze({
    id: record.id,
    items: Object.freeze(record.items.map((item) => {
      const entry = item as Record<string, unknown>;
      if (typeof entry.id !== "string" ||
        typeof entry.clientFileId !== "string" ||
        typeof entry.state !== "string" ||
        typeof entry.attemptNumber !== "number") {
        throw new Error(code);
      }
      return Object.freeze({
        attemptNumber: entry.attemptNumber,
        clientFileId: entry.clientFileId,
        failureCode: typeof entry.failureCode === "string"
          ? entry.failureCode
          : null,
        id: entry.id,
        sourceId: typeof entry.sourceId === "string" ? entry.sourceId : null,
        state: entry.state,
        transport: entry.transport && typeof entry.transport === "object"
          ? entry.transport as { kind: string; uploadUrl?: string }
          : null
      });
    }))
  });
}

function resolveBatchSize(explicit: number | undefined): number {
  const raw = process.env.AIQSA_KNOWLEDGE_MAX_BATCH_FILES;
  const envLimit = raw && /^[1-9]\d{0,8}$/u.test(raw)
    ? Math.min(Math.max(Number(raw), 1), 500)
    : 100;
  const chosen = explicit ?? envLimit;
  if (chosen > envLimit) {
    throw new Error("knowledge_benchmark_batch_size_exceeds_limit");
  }
  return chosen;
}

async function ingestBatch(
  baseUrl: URL,
  cookie: string,
  knowledgeBaseId: string,
  documents: readonly KnowledgeBenchmarkDocument[],
  uploadConcurrency: number,
  settleTimeoutMs: number
): Promise<ReadonlyMap<string, IngestDocumentState>> {
  const membershipHash = createHash("sha256");
  for (const document of documents) {
    membershipHash.update(document.fileName, "utf8");
    membershipHash.update("\u0000", "utf8");
  }
  const clientBatchId = `kbbench-${membershipHash.digest("hex").slice(0, 40)}`;
  const documentsByClientId = new Map(documents.map((document) => [
    knowledgeBenchmarkUploadClientId(document),
    document
  ]));
  const bytesByClientId = new Map(documents.map((document) => [
    knowledgeBenchmarkUploadClientId(document),
    Buffer.from(document.markdown, "utf8")
  ]));
  const created = decodeBatch(await apiRequest(
    baseUrl,
    cookie,
    "POST",
    `/api/me/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/upload-batches`,
    {
      clientBatchId,
      files: documents.map((document) => {
        const clientFileId = knowledgeBenchmarkUploadClientId(document);
        const bytes = bytesByClientId.get(clientFileId)!;
        return {
          byteSize: bytes.byteLength,
          checksumHint: createHash("sha256")
            .update(bytes)
            .digest("hex"),
          clientFileId,
          fileName: document.fileName,
          mimeType: "text/markdown"
        };
      })
    }
  ));
  const itemPath = (itemId: string): string =>
    `/api/me/knowledge-uploads/${encodeURIComponent(knowledgeBaseId)}/${
      encodeURIComponent(created.id)}/${encodeURIComponent(itemId)}`;
  await mapConcurrentOrdered(
    created.items,
    uploadConcurrency,
    async (item) => {
      let current = item;
      if (current.state === "needs_attention" &&
        knowledgeBenchmarkUploadRecoveryDisposition({
          sourceId: current.sourceId
        }) === "retry") {
        const retried = decodeBatch(await apiRequest(
          baseUrl,
          cookie,
          "POST",
          `${itemPath(current.id)}/retry`,
          { attemptNumber: current.attemptNumber }
        ));
        const replacement = retried.items.find(({ id }) => id === current.id);
        if (!replacement) {
          throw new Error("knowledge_benchmark_retry_projection_invalid");
        }
        current = replacement;
      }
      if (terminalSuccessStates.has(current.state) || current.state === "processing" ||
        terminalFailureStates.has(current.state)) {
        return;
      }
      if (current.state === "queued") {
        if (current.transport?.kind !== "proxy" || !current.transport.uploadUrl) {
          throw new Error("knowledge_benchmark_upload_transport_unexpected");
        }
        await uploadItemBytes(
          baseUrl,
          cookie,
          current.transport.uploadUrl,
          bytesByClientId.get(current.clientFileId)!
        );
      }
      await apiRequest(
        baseUrl,
        cookie,
        "POST",
        `${itemPath(current.id)}/settle`,
        { attemptNumber: current.attemptNumber }
      );
    }
  );
  const deadline = Date.now() + settleTimeoutMs;
  let nextProgressAt = 0;
  for (;;) {
    const batch = decodeBatch(await apiRequest(
      baseUrl,
      cookie,
      "GET",
      `/api/me/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}` +
        `/upload-batches/${encodeURIComponent(created.id)}`
    ));
    const failed = batch.items.filter(({ state }) =>
      terminalFailureStates.has(state));
    const failedReadiness = await mapConcurrentOrdered(
      failed,
      Math.min(uploadConcurrency, 4),
      async (item) => {
        if (!item.sourceId) {
          return Object.freeze({
            disposition: knowledgeBenchmarkUploadRecoveryDisposition({
              sourceId: null
            }),
            item
          });
        }
        const body = await apiRequest(
          baseUrl,
          cookie,
          "GET",
          `/api/me/knowledge-sources/${encodeURIComponent(item.sourceId)}`
        ) as { source?: { readiness?: { state?: unknown } } };
        const sourceState = body.source?.readiness?.state;
        if (sourceState !== "needs_attention" && sourceState !== "processing" &&
          sourceState !== "ready") {
          throw new Error("knowledge_benchmark_source_projection_invalid");
        }
        return Object.freeze({
          disposition: knowledgeBenchmarkUploadRecoveryDisposition({
            sourceId: item.sourceId,
            sourceState
          }),
          item
        });
      }
    );
    const unrecoverable = failedReadiness.filter(({ disposition }) =>
      disposition === "fail" || disposition === "retry");
    if (unrecoverable.length > 0) {
      const codes = [...new Set(unrecoverable.map(({ item }) =>
        item.failureCode ?? "unknown"))].sort();
      throw new Error(`knowledge_benchmark_item_failed:${codes.join(",")}`);
    }
    // Upload items deliberately retain their exact original artifact. After a
    // profile migration or explicit Reprocess, that historical item can stay
    // needs_attention forever even though the same Source has a current ready
    // artifact. Current Source readiness is the product-owned recovery proof;
    // a missing or currently failed Source remains a hard failure above.
    const recovered = failedReadiness
      .filter(({ disposition }) => disposition === "recover")
      .map(({ item }) => item);
    const settled = batch.items.filter(({ sourceId, state }) =>
      terminalSuccessStates.has(state) && sourceId !== null);
    const usable = [...settled, ...recovered];
    if (usable.length === batch.items.length) {
      const recoveredIds = new Set(recovered.map(({ id }) => id));
      return new Map(usable.map((item) => {
        const document = documentsByClientId.get(item.clientFileId);
        if (!document) {
          throw new Error("knowledge_benchmark_upload_client_id_unknown");
        }
        return [
          document.fileName,
          Object.freeze({
            officialId: document.officialId,
            sourceId: item.sourceId!,
            state: recoveredIds.has(item.id) ? "reused" : item.state
          })
        ] as const;
      }));
    }
    if (Date.now() >= deadline) {
      throw new Error("knowledge_benchmark_settle_timeout");
    }
    if (Date.now() >= nextProgressAt) {
      emit("batch_progress", {
        settledItems: settled.length,
        totalItems: batch.items.length
      });
      nextProgressAt = Date.now() + 15_000;
    }
    await sleep(2_000);
  }
}

type BaseReadiness = Readonly<{
  attentionSources: number;
  processingSources: number;
  readySources: number;
  state: string;
  totalSources: number;
}>;

async function readBaseReadiness(
  baseUrl: URL,
  cookie: string,
  knowledgeBaseId: string
): Promise<BaseReadiness> {
  const body = await apiRequest(
    baseUrl,
    cookie,
    "GET",
    `/api/me/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
  ) as { knowledgeBase?: { readiness?: BaseReadiness } };
  const readiness = body.knowledgeBase?.readiness;
  if (!readiness || typeof readiness.state !== "string") {
    throw new Error("knowledge_benchmark_base_projection_invalid");
  }
  return readiness;
}

/** Quiescence-then-assert: waits until the base reports fully ready, then
 * re-reads after a settle delay and requires the identical stable state. */
async function waitForIngestionQuiescence(
  baseUrl: URL,
  cookie: string,
  knowledgeBaseId: string,
  expectedSources: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let nextProgressAt = 0;
  for (;;) {
    const readiness = await readBaseReadiness(baseUrl, cookie, knowledgeBaseId);
    if (readiness.attentionSources > 0) {
      throw new Error("knowledge_benchmark_sources_need_attention");
    }
    if (readiness.state === "ready" &&
      readiness.totalSources === expectedSources &&
      readiness.readySources === expectedSources &&
      readiness.processingSources === 0) {
      await sleep(5_000);
      const settled = await readBaseReadiness(baseUrl, cookie, knowledgeBaseId);
      if (settled.state === "ready" &&
        settled.totalSources === expectedSources &&
        settled.readySources === expectedSources &&
        settled.processingSources === 0) {
        return;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error("knowledge_benchmark_ingestion_quiescence_timeout");
    }
    if (Date.now() >= nextProgressAt) {
      emit("ingestion_progress", {
        processingSources: readiness.processingSources,
        readySources: readiness.readySources,
        totalSources: readiness.totalSources
      });
      nextProgressAt = Date.now() + 15_000;
    }
    await sleep(2_000);
  }
}

async function collectWarningCounts(
  baseUrl: URL,
  cookie: string,
  knowledgeBaseId: string
): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (let page = 1; ; page += 1) {
    const body = await apiRequest(
      baseUrl,
      cookie,
      "GET",
      `/api/me/knowledge-sources?baseId=${encodeURIComponent(knowledgeBaseId)}` +
        `&filter=all&page=${page}&pageSize=100`
    ) as {
      pagination?: { totalPages?: number };
      sources?: readonly { readiness?: { warningCodes?: readonly string[] } }[];
    };
    for (const source of body.sources ?? []) {
      for (const warning of source.readiness?.warningCodes ?? []) {
        if (/^[a-z0-9_]{1,64}$/u.test(warning)) {
          counts[warning] = (counts[warning] ?? 0) + 1;
        }
      }
    }
    const totalPages = body.pagination?.totalPages ?? page;
    if (page >= totalPages) break;
  }
  return Object.freeze(counts);
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  assertKnowledgeBenchmarkAck(process.env);
  loadEnvConfig(repositoryRoot, true, { error() {}, info() {} }, true);
  const appPort = Number(
    process.env.AIQSA_KNOWLEDGE_BENCHMARK_APP_PORT ??
      KNOWLEDGE_BENCHMARK_APP_PORT
  );
  const baseUrl = assertKnowledgeBenchmarkBaseUrl(
    `http://127.0.0.1:${appPort}/`,
    appPort
  );
  const databaseUrl = process.env.AIQSA_KNOWLEDGE_BENCHMARK_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("knowledge_benchmark_database_url_required");
  }
  assertKnowledgeBenchmarkDatabaseUrl(databaseUrl);
  const batchSize = resolveBatchSize(options.batchSize);
  const suite = await loadSuiteManifest(options.suiteId);
  await verifySuiteDownloads(suite);
  const corpus = await loadCorpus(suite);
  const corpusHash = knowledgeCorpusContentSha256(corpus);
  emit("corpus_loaded", {
    corpusContentSha256: corpusHash,
    documents: corpus.length,
    suiteId: suite.suiteId
  });
  await mkdir(stateRoot, { recursive: true });
  const statePath = resolve(stateRoot, `ingest-${suite.suiteId}.json`);
  const state = await loadOrCreateState(statePath, suite, corpusHash);
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await assertDatabaseIdentity(prisma);
    const userId = await ensureBenchmarkIdentity(prisma, state, statePath);
    const cookie = await createSessionCookie(prisma, userId);
    if (options.recoverBatchId) {
      if (!state.knowledgeBaseId) {
        throw new Error("knowledge_benchmark_base_missing");
      }
      const batch = decodeBatch(await apiRequest(
        baseUrl,
        cookie,
        "GET",
        `/api/me/knowledge-bases/${encodeURIComponent(state.knowledgeBaseId)}` +
          `/upload-batches/${encodeURIComponent(options.recoverBatchId)}`
      ));
      const sourceIds = [...new Set(batch.items
        .filter(({ sourceId, state: itemState }) =>
          sourceId !== null && terminalFailureStates.has(itemState))
        .map(({ sourceId }) => sourceId!))];
      await mapConcurrentOrdered(
        sourceIds,
        options.uploadConcurrency,
        async (sourceId) => apiRequest(
          baseUrl,
          cookie,
          "POST",
          `/api/me/knowledge-sources/${encodeURIComponent(sourceId)}/reprocess`
        )
      );
      emit("batch_reprocess_accepted", {
        batchId: options.recoverBatchId,
        sources: sourceIds.length
      });
      return;
    }
    if (options.reprocessSourceId) {
      await apiRequest(
        baseUrl,
        cookie,
        "POST",
        `/api/me/knowledge-sources/${encodeURIComponent(
          options.reprocessSourceId
        )}/reprocess`
      );
      emit("source_reprocess_accepted", { sourceId: options.reprocessSourceId });
      return;
    }
    if (options.replaceSourceIds.length > 0) {
      const replacements = options.replaceSourceIds.map((sourceId) => {
        const fileNames = new Set(Object.entries(state.documents)
          .filter(([, document]) => document.sourceId === sourceId)
          .map(([fileName]) => fileName));
        const documents = corpus.filter(({ fileName }) => fileNames.has(fileName));
        if (documents.length === 0) {
          throw new Error("knowledge_benchmark_source_mapping_missing");
        }
        const contentHashes = new Set(documents.map(({ markdown }) =>
          createHash("sha256").update(markdown, "utf8").digest("hex")));
        if (contentHashes.size !== 1) {
          throw new Error("knowledge_benchmark_source_mapping_ambiguous");
        }
        return Object.freeze({ documents, sourceId });
      });
      await mapConcurrentOrdered(
        replacements,
        options.uploadConcurrency,
        async ({ documents, sourceId }) => {
          await replaceSourceBytes(baseUrl, cookie, sourceId, documents[0]!);
          emit("source_replace_accepted", {
            mappedDocuments: documents.length,
            sourceId
          });
        }
      );
      emit("sources_replace_accepted", { sources: replacements.length });
      return;
    }
    if (!state.knowledgeBaseId) {
      const created = await apiRequest(
        baseUrl,
        cookie,
        "POST",
        "/api/me/knowledge-bases",
        {
          description: `Public retrieval benchmark corpus (${suite.resultLabel}).`,
          name: `Knowledge benchmark ${suite.suiteId}`
        }
      ) as { knowledgeBase?: { id?: string } };
      if (!created.knowledgeBase?.id) {
        throw new Error("knowledge_benchmark_base_create_failed");
      }
      state.knowledgeBaseId = created.knowledgeBase.id;
      await writeJsonAtomic(statePath, state);
    }
    const knowledgeBaseId = state.knowledgeBaseId;
    const pending = corpus.filter(({ fileName }) =>
      !terminalSuccessStates.has(state.documents[fileName]?.state ?? ""));
    emit("ingest_plan", {
      batchSize,
      pendingDocuments: pending.length,
      totalDocuments: corpus.length
    });
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const batchDocuments = pending.slice(offset, offset + batchSize);
      const settled = await ingestBatch(
        baseUrl,
        cookie,
        knowledgeBaseId,
        batchDocuments,
        options.uploadConcurrency,
        options.settleTimeoutMs
      );
      for (const [fileName, documentState] of settled) {
        state.documents[fileName] = documentState;
      }
      await writeJsonAtomic(statePath, state);
      emit("batch_complete", {
        completedDocuments: Object.keys(state.documents).length,
        totalDocuments: corpus.length
      });
    }
    const uniqueSources = new Set(
      Object.values(state.documents).map(({ sourceId }) => sourceId)
    );
    if (Object.keys(state.documents).length !== corpus.length) {
      throw new Error("knowledge_benchmark_documents_incomplete");
    }
    await waitForIngestionQuiescence(
      baseUrl,
      cookie,
      knowledgeBaseId,
      uniqueSources.size,
      options.settleTimeoutMs
    );
    // Zero-OCR assertion. Benchmark text/markdown uploads route to the inline
    // parser, so the PDF/vision processing ledger of this disposable stack
    // must stay empty, and no source may carry an OCR-confidence warning.
    const pdfProcessingAttempts = await prisma.knowledgePdfProcessingAttempt
      .count();
    const warningCounts = await collectWarningCounts(
      baseUrl,
      cookie,
      knowledgeBaseId
    );
    if (pdfProcessingAttempts !== 0 ||
      (warningCounts.low_ocr_confidence ?? 0) !== 0) {
      throw new Error("knowledge_benchmark_ocr_detected");
    }
    state.ocr = Object.freeze({
      assertedZeroOcr: true,
      pdfProcessingAttempts,
      warningCounts
    });
    state.completedAt = new Date().toISOString();
    await writeJsonAtomic(statePath, state);
    emit("ingest_complete", {
      documents: corpus.length,
      reusedDocuments: corpus.length - uniqueSources.size,
      suiteId: suite.suiteId,
      uniqueSources: uniqueSources.size,
      warningCounts
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown";
  const code = /^[A-Za-z0-9_:,.-]{1,200}$/u.test(message)
    ? message
    : "knowledge_benchmark_ingest_failed";
  emit("ingest_failed", { code });
  process.exitCode = 1;
});

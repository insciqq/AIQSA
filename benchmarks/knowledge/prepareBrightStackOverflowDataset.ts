import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  asyncBufferFromFile,
  parquetMetadataAsync,
  parquetReadObjects,
  parquetSchema
} from "hyparquet";
import { KNOWLEDGE_QUERY_MAX_CHARACTERS } from
  "../../lib/server/knowledge/retrievalTypes";
import {
  canonicalJson,
  decodeKnowledgeBenchmarkManifest
} from "./contract";
import {
  BRIGHT_GPT2_ASSET_SHA256,
  BRIGHT_GPT2_ENCODING,
  BRIGHT_GPT2_TOKENIZER_PACKAGE,
  BRIGHT_GPT2_TOKENIZER_VERSION,
  BRIGHT_STACKOVERFLOW_CORPUS_SHARD_ROWS,
  BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT,
  BRIGHT_STACKOVERFLOW_FILES,
  BRIGHT_STACKOVERFLOW_MANIFEST_SCHEMA_VERSION,
  BRIGHT_STACKOVERFLOW_MIN_GPT2_TOKENS,
  BRIGHT_STACKOVERFLOW_PREPARED_FORMAT_VERSION,
  BRIGHT_STACKOVERFLOW_QUERY_COUNT,
  BRIGHT_STACKOVERFLOW_REVISION,
  BRIGHT_STACKOVERFLOW_SUITE_ID,
  assertBrightDatasetReferences,
  assertBrightGpt2Census,
  assertBrightSuiteManifest,
  decodeBrightDocumentRow,
  decodeBrightExampleRow,
  prepareBrightDocument,
  type BrightDecodedExample
} from "./brightStackOverflowContract";
import type {
  BrightTokenWorkerInput,
  BrightTokenWorkerResult
} from "./brightStackOverflowTokenWorker";
import {
  BRIGHT_STACKOVERFLOW_PREPARED_MANIFEST_FINGERPRINT,
  verifyBrightPreparedDataset
} from "./brightStackOverflowPrepared";

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const dataRoot = resolve(benchmarkRoot, ".data");
const datasetsRoot = resolve(dataRoot, "datasets");
const defaultOutput = resolve(dataRoot, "prepared/bright-stackoverflow-50m");
const upstreamManifestPath = resolve(benchmarkRoot, "upstream.json");
const tokenizerWorkerUrl = new URL(
  "./brightStackOverflowTokenWorker.ts",
  import.meta.url
);

type CliOptions = Readonly<{
  output: string;
  tokenWorkers: number;
}>;

type FileReceipt = Readonly<{
  bytes: number;
  path: string;
  sha256: string;
}>;

type CorpusAccumulator = {
  affectedNullDocuments: number;
  affectedReplacementDocuments: number;
  documentCount: number;
  maxPreparedCodePoints: number;
  maxPreparedUtf8Bytes: number;
  maxRawCodePoints: number;
  maxRawUtf8Bytes: number;
  nullCharacterCount: number;
  preparedCodePoints: number;
  preparedHash: ReturnType<typeof createHash>;
  preparedUtf8Bytes: number;
  rawCodePoints: number;
  rawHash: ReturnType<typeof createHash>;
  rawUtf8Bytes: number;
  replacementCharacterCount: number;
};

function emit(event: string, details: Readonly<Record<string, unknown>> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

function parseCli(argv: readonly string[]): CliOptions {
  let output = defaultOutput;
  let tokenWorkers = 2;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--output") {
      if (!next) throw new Error("bright_stackoverflow_output_required");
      output = resolve(benchmarkRoot, next);
      index += 1;
    } else if (argument === "--token-workers") {
      const parsed = Number(next);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 4) {
        throw new Error("bright_stackoverflow_token_workers_invalid");
      }
      tokenWorkers = parsed;
      index += 1;
    } else {
      throw new Error(`bright_stackoverflow_argument_unknown:${argument ?? "missing"}`);
    }
  }
  if (output === dataRoot || !output.startsWith(`${dataRoot}${sep}`)) {
    throw new Error("bright_stackoverflow_output_not_ignored");
  }
  return Object.freeze({ output, tokenWorkers });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyPinnedFile(
  path: string,
  expected: Readonly<{ bytes: number; sha256: string }>
): Promise<void> {
  const file = await stat(path).catch(() => null);
  if (!file || !file.isFile()) throw new Error("bright_stackoverflow_dataset_missing");
  if (file.size !== expected.bytes || await sha256File(path) !== expected.sha256) {
    throw new Error("bright_stackoverflow_dataset_checksum_mismatch");
  }
}

async function writeAtomic(path: string, body: string): Promise<FileReceipt> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, body, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
  const bytes = Buffer.byteLength(body, "utf8");
  return Object.freeze({
    bytes,
    path,
    sha256: createHash("sha256").update(body, "utf8").digest("hex")
  });
}

function relativeReceipt(receipt: FileReceipt, root: string): FileReceipt {
  if (!receipt.path.startsWith(`${root}${sep}`)) {
    throw new Error("bright_stackoverflow_output_path_invalid");
  }
  return Object.freeze({
    ...receipt,
    path: receipt.path.slice(root.length + 1)
  });
}

function frameHash(hash: ReturnType<typeof createHash>, values: readonly string[]): void {
  for (const value of values) {
    hash.update(String(Buffer.byteLength(value, "utf8")), "utf8");
    hash.update(":", "utf8");
    hash.update(value, "utf8");
  }
}

function occurrences(value: string, character: string): number {
  let count = 0;
  for (const candidate of value) if (candidate === character) count += 1;
  return count;
}

function updateCorpusAccumulator(
  accumulator: CorpusAccumulator,
  officialId: string,
  rawText: string,
  preparedText: string
): void {
  const rawUtf8Bytes = Buffer.byteLength(rawText, "utf8");
  const preparedUtf8Bytes = Buffer.byteLength(preparedText, "utf8");
  const rawCodePoints = [...rawText].length;
  const preparedCodePoints = [...preparedText].length;
  const nullCharacters = occurrences(rawText, "\u0000");
  const replacementCharacters = occurrences(rawText, "\uFFFD");
  accumulator.documentCount += 1;
  accumulator.rawUtf8Bytes += rawUtf8Bytes;
  accumulator.preparedUtf8Bytes += preparedUtf8Bytes;
  accumulator.rawCodePoints += rawCodePoints;
  accumulator.preparedCodePoints += preparedCodePoints;
  accumulator.maxRawUtf8Bytes = Math.max(accumulator.maxRawUtf8Bytes, rawUtf8Bytes);
  accumulator.maxPreparedUtf8Bytes = Math.max(
    accumulator.maxPreparedUtf8Bytes,
    preparedUtf8Bytes
  );
  accumulator.maxRawCodePoints = Math.max(accumulator.maxRawCodePoints, rawCodePoints);
  accumulator.maxPreparedCodePoints = Math.max(
    accumulator.maxPreparedCodePoints,
    preparedCodePoints
  );
  accumulator.nullCharacterCount += nullCharacters;
  accumulator.replacementCharacterCount += replacementCharacters;
  if (nullCharacters > 0) accumulator.affectedNullDocuments += 1;
  if (replacementCharacters > 0) accumulator.affectedReplacementDocuments += 1;
  frameHash(accumulator.rawHash, [officialId, rawText]);
  frameHash(accumulator.preparedHash, [officialId, preparedText]);
}

function newCorpusAccumulator(): CorpusAccumulator {
  return {
    affectedNullDocuments: 0,
    affectedReplacementDocuments: 0,
    documentCount: 0,
    maxPreparedCodePoints: 0,
    maxPreparedUtf8Bytes: 0,
    maxRawCodePoints: 0,
    maxRawUtf8Bytes: 0,
    nullCharacterCount: 0,
    preparedCodePoints: 0,
    preparedHash: createHash("sha256"),
    preparedUtf8Bytes: 0,
    rawCodePoints: 0,
    rawHash: createHash("sha256"),
    rawUtf8Bytes: 0,
    replacementCharacterCount: 0
  };
}

function assertSchema(
  schema: ReturnType<typeof parquetSchema>,
  expectedNames: readonly string[],
  code: string
): void {
  const names = schema.children.map(({ element }) => element.name);
  if (names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])) {
    throw new Error(code);
  }
  for (const child of schema.children) {
    const leaf = child.children.length === 0 ? child : null;
    if (leaf && (leaf.element.type !== "BYTE_ARRAY" ||
      leaf.element.logical_type?.type !== "STRING")) {
      throw new Error(code);
    }
  }
}

async function validateParquetMetadata(input: Readonly<{
  documentsPath: string;
  examplesPath: string;
}>): Promise<Readonly<{ documentRowGroups: number; exampleRowGroups: number }>> {
  const [documentsFile, examplesFile] = await Promise.all([
    asyncBufferFromFile(input.documentsPath),
    asyncBufferFromFile(input.examplesPath)
  ]);
  const [documents, examples] = await Promise.all([
    parquetMetadataAsync(documentsFile),
    parquetMetadataAsync(examplesFile)
  ]);
  if (Number(documents.num_rows) !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
    Number(examples.num_rows) !== BRIGHT_STACKOVERFLOW_QUERY_COUNT) {
    throw new Error("bright_stackoverflow_parquet_row_count_mismatch");
  }
  assertSchema(
    parquetSchema(documents),
    ["id", "content"],
    "bright_stackoverflow_document_schema_invalid"
  );
  assertSchema(
    parquetSchema(examples),
    [
      "query",
      "reasoning",
      "id",
      "excluded_ids",
      "gold_ids_long",
      "gold_ids",
      "gold_answer"
    ],
    "bright_stackoverflow_example_schema_invalid"
  );
  return Object.freeze({
    documentRowGroups: documents.row_groups.length,
    exampleRowGroups: examples.row_groups.length
  });
}

async function writeCorpusShards(input: Readonly<{
  documentsPath: string;
  output: string;
}>): Promise<Readonly<{
  accumulator: CorpusAccumulator;
  documentIds: ReadonlySet<string>;
  shards: readonly FileReceipt[];
}>> {
  const file = await asyncBufferFromFile(input.documentsPath);
  const corpusDirectory = resolve(input.output, "corpus");
  await mkdir(corpusDirectory, { mode: 0o700 });
  const accumulator = newCorpusAccumulator();
  const documentIds = new Set<string>();
  const shards: FileReceipt[] = [];
  for (let rowStart = 0, shard = 0;
    rowStart < BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT;
    rowStart += BRIGHT_STACKOVERFLOW_CORPUS_SHARD_ROWS, shard += 1) {
    const rowEnd = Math.min(
      BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT,
      rowStart + BRIGHT_STACKOVERFLOW_CORPUS_SHARD_ROWS
    );
    const rows = await parquetReadObjects({
      columns: ["id", "content"],
      file,
      rowEnd,
      rowStart
    });
    if (rows.length !== rowEnd - rowStart) {
      throw new Error("bright_stackoverflow_corpus_shard_count_mismatch");
    }
    const lines: string[] = [];
    for (const [offset, row] of rows.entries()) {
      const document = decodeBrightDocumentRow(row, rowStart + offset);
      if (documentIds.has(document.officialId)) {
        throw new Error("bright_stackoverflow_document_id_duplicate");
      }
      documentIds.add(document.officialId);
      const prepared = prepareBrightDocument(document);
      updateCorpusAccumulator(
        accumulator,
        document.officialId,
        document.rawText,
        prepared.preparedText
      );
      lines.push(JSON.stringify({
        formatVersion: BRIGHT_STACKOVERFLOW_PREPARED_FORMAT_VERSION,
        officialId: prepared.officialId,
        ordinal: prepared.ordinal,
        sourceId: prepared.sourceId,
        sourceVersionId: prepared.sourceVersionId,
        text: prepared.preparedText
      }));
    }
    const name = `part-${String(shard).padStart(5, "0")}.jsonl`;
    shards.push(relativeReceipt(await writeAtomic(
      resolve(corpusDirectory, name),
      `${lines.join("\n")}\n`
    ), input.output));
  }
  if (accumulator.documentCount !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
    documentIds.size !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT) {
    throw new Error("bright_stackoverflow_document_count_mismatch");
  }
  return Object.freeze({ accumulator, documentIds, shards: Object.freeze(shards) });
}

async function writeQueries(input: Readonly<{
  documentIds: ReadonlySet<string>;
  examplesPath: string;
  output: string;
}>): Promise<Readonly<{
  evaluator: FileReceipt;
  examples: readonly BrightDecodedExample[];
  overProductLimitCount: number;
  runtime: FileReceipt;
}>> {
  const file = await asyncBufferFromFile(input.examplesPath);
  const rows = await parquetReadObjects({ file });
  const examples = Object.freeze(rows.map(decodeBrightExampleRow));
  assertBrightDatasetReferences(input.documentIds, examples);
  const queryIds = new Set<string>();
  let overProductLimitCount = 0;
  for (const { runtime } of examples) {
    if (queryIds.has(runtime.officialId)) {
      throw new Error("bright_stackoverflow_query_id_duplicate");
    }
    queryIds.add(runtime.officialId);
    if ([...runtime.text].length > KNOWLEDGE_QUERY_MAX_CHARACTERS) {
      overProductLimitCount += 1;
    }
  }
  const runtimeBody = `${examples.map(({ runtime }) => JSON.stringify({
    formatVersion: BRIGHT_STACKOVERFLOW_PREPARED_FORMAT_VERSION,
    officialId: runtime.officialId,
    query: runtime.text
  })).join("\n")}\n`;
  const evaluatorBody = `${examples.map(({ evaluator, evaluatorSourceFingerprint }) =>
    JSON.stringify({
      evaluatorSourceFingerprint,
      excludedIds: evaluator.excludedIds,
      formatVersion: BRIGHT_STACKOVERFLOW_PREPARED_FORMAT_VERSION,
      goldAnswer: evaluator.goldAnswer,
      goldIds: evaluator.goldIds,
      officialId: evaluator.officialId
    })).join("\n")}\n`;
  const queryDirectory = resolve(input.output, "queries");
  await mkdir(queryDirectory, { mode: 0o700 });
  const [runtime, evaluator] = await Promise.all([
    writeAtomic(resolve(queryDirectory, "runtime.jsonl"), runtimeBody),
    writeAtomic(resolve(queryDirectory, "evaluator.jsonl"), evaluatorBody)
  ]);
  return Object.freeze({
    evaluator: relativeReceipt(evaluator, input.output),
    examples,
    overProductLimitCount,
    runtime: relativeReceipt(runtime, input.output)
  });
}

function tokenWorker(input: BrightTokenWorkerInput): Promise<BrightTokenWorkerResult> {
  return new Promise((resolveWorker, rejectWorker) => {
    const worker = new Worker(tokenizerWorkerUrl, { workerData: input });
    let settled = false;
    worker.once("message", (message: BrightTokenWorkerResult | { error: string }) => {
      settled = true;
      if ("error" in message) rejectWorker(new Error(message.error));
      else resolveWorker(message);
    });
    worker.once("error", (error) => {
      settled = true;
      rejectWorker(error);
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        rejectWorker(new Error("bright_stackoverflow_token_worker_failed"));
      }
    });
  });
}

async function tokenCensus(input: Readonly<{
  documentsPath: string;
  tokenWorkers: number;
}>): Promise<Readonly<{
  normalizedGpt2Tokens: number;
  rawGpt2Tokens: number;
}>> {
  const rowsPerWorker = Math.ceil(
    BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT /
      input.tokenWorkers /
      BRIGHT_STACKOVERFLOW_CORPUS_SHARD_ROWS
  ) * BRIGHT_STACKOVERFLOW_CORPUS_SHARD_ROWS;
  const work: BrightTokenWorkerInput[] = [];
  for (let rowStart = 0; rowStart < BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT;
    rowStart += rowsPerWorker) {
    work.push(Object.freeze({
      batchRows: BRIGHT_STACKOVERFLOW_CORPUS_SHARD_ROWS,
      documentsPath: input.documentsPath,
      rowEnd: Math.min(BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT, rowStart + rowsPerWorker),
      rowStart
    }));
  }
  const results = await Promise.all(work.map(tokenWorker));
  const documentCount = results.reduce((total, result) =>
    total + result.documentCount, 0);
  const rawGpt2Tokens = results.reduce((total, result) =>
    total + result.rawGpt2Tokens, 0);
  const normalizedGpt2Tokens = results.reduce((total, result) =>
    total + result.normalizedGpt2Tokens, 0);
  if (documentCount !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT) {
    throw new Error("bright_stackoverflow_token_census_count_mismatch");
  }
  assertBrightGpt2Census(rawGpt2Tokens);
  return Object.freeze({ normalizedGpt2Tokens, rawGpt2Tokens });
}

async function tokenizerIdentity(): Promise<Readonly<{
  assetSha256: string;
  encoding: string;
  package: string;
  version: string;
}>> {
  const require = createRequire(import.meta.url);
  const packageJson = JSON.parse(await readFile(
    require.resolve(`${BRIGHT_GPT2_TOKENIZER_PACKAGE}/package.json`),
    "utf8"
  )) as { name?: unknown; version?: unknown };
  const assetSha256 = await sha256File(require.resolve(
    `${BRIGHT_GPT2_TOKENIZER_PACKAGE}/data/r50k_base.tiktoken`
  ));
  if (packageJson.name !== BRIGHT_GPT2_TOKENIZER_PACKAGE ||
    packageJson.version !== BRIGHT_GPT2_TOKENIZER_VERSION ||
    assetSha256 !== BRIGHT_GPT2_ASSET_SHA256) {
    throw new Error("bright_stackoverflow_gpt2_tokenizer_identity_mismatch");
  }
  return Object.freeze({
    assetSha256,
    encoding: BRIGHT_GPT2_ENCODING,
    package: BRIGHT_GPT2_TOKENIZER_PACKAGE,
    version: BRIGHT_GPT2_TOKENIZER_VERSION
  });
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const documentsPath = resolve(
    datasetsRoot,
    BRIGHT_STACKOVERFLOW_SUITE_ID,
    BRIGHT_STACKOVERFLOW_FILES.documents.localName
  );
  const examplesPath = resolve(
    datasetsRoot,
    BRIGHT_STACKOVERFLOW_SUITE_ID,
    BRIGHT_STACKOVERFLOW_FILES.examples.localName
  );
  const startedAt = performance.now();
  const upstream = decodeKnowledgeBenchmarkManifest(JSON.parse(
    await readFile(upstreamManifestPath, "utf8")
  ) as unknown);
  assertBrightSuiteManifest(upstream.suites[BRIGHT_STACKOVERFLOW_SUITE_ID]);
  await Promise.all([
    verifyPinnedFile(documentsPath, BRIGHT_STACKOVERFLOW_FILES.documents),
    verifyPinnedFile(examplesPath, BRIGHT_STACKOVERFLOW_FILES.examples)
  ]);
  const parquet = await validateParquetMetadata({ documentsPath, examplesPath });
  const verifiedAt = performance.now();
  const identity = await tokenizerIdentity();
  if (await pathExists(options.output)) {
    const existing = await verifyBrightPreparedDataset(options.output);
    emit("bright_stackoverflow_dataset_already_prepared", {
      documentCount: existing.corpus.documentCount,
      gpt2Tokens: existing.corpus.rawGpt2Tokens,
      manifestFingerprint: existing.manifestFingerprint,
      queryCount: existing.queries.queryCount
    });
    return;
  }
  await mkdir(dirname(options.output), { mode: 0o700, recursive: true });
  const staging = `${options.output}.building-${process.pid}-${randomUUID()}`;
  await mkdir(staging, { mode: 0o700 });
  try {
    const corpus = await writeCorpusShards({ documentsPath, output: staging });
    const queries = await writeQueries({
      documentIds: corpus.documentIds,
      examplesPath,
      output: staging
    });
    const decodedAt = performance.now();
    const tokens = await tokenCensus({
      documentsPath,
      tokenWorkers: options.tokenWorkers
    });
    const tokenizedAt = performance.now();
    const accumulator = corpus.accumulator;
    const rawFingerprint = accumulator.rawHash.digest("hex");
    const preparedFingerprint = accumulator.preparedHash.digest("hex");
    const manifestWithoutFingerprint = {
      corpus: {
        affectedNullDocuments: accumulator.affectedNullDocuments,
        affectedReplacementDocuments: accumulator.affectedReplacementDocuments,
        documentCount: accumulator.documentCount,
        maxPreparedCodePoints: accumulator.maxPreparedCodePoints,
        maxPreparedUtf8Bytes: accumulator.maxPreparedUtf8Bytes,
        maxRawCodePoints: accumulator.maxRawCodePoints,
        maxRawUtf8Bytes: accumulator.maxRawUtf8Bytes,
        nullCharacterCount: accumulator.nullCharacterCount,
        preparedCodePoints: accumulator.preparedCodePoints,
        preparedFingerprint,
        preparedGpt2Tokens: tokens.normalizedGpt2Tokens,
        preparedUtf8Bytes: accumulator.preparedUtf8Bytes,
        rawCodePoints: accumulator.rawCodePoints,
        rawFingerprint,
        rawGpt2Tokens: tokens.rawGpt2Tokens,
        rawUtf8Bytes: accumulator.rawUtf8Bytes,
        replacementCharacterCount: accumulator.replacementCharacterCount,
        shardRows: BRIGHT_STACKOVERFLOW_CORPUS_SHARD_ROWS,
        shards: corpus.shards
      },
      dataset: {
        datasetId: "xlangai/BRIGHT",
        files: [BRIGHT_STACKOVERFLOW_FILES.documents, BRIGHT_STACKOVERFLOW_FILES.examples],
        revision: BRIGHT_STACKOVERFLOW_REVISION,
        suiteId: BRIGHT_STACKOVERFLOW_SUITE_ID
      },
      decoder: {
        package: "hyparquet",
        version: "1.29.2"
      },
      formatVersion: BRIGHT_STACKOVERFLOW_PREPARED_FORMAT_VERSION,
      gpt2Tokenizer: identity,
      queries: {
        evaluatorFile: queries.evaluator,
        overProductLimitCount: queries.overProductLimitCount,
        productQueryMaxCharacters: KNOWLEDGE_QUERY_MAX_CHARACTERS,
        queryCount: queries.examples.length,
        runtimeFile: queries.runtime
      },
      schemaVersion: BRIGHT_STACKOVERFLOW_MANIFEST_SCHEMA_VERSION
    };
    const manifestFingerprint = createHash("sha256")
      .update(canonicalJson(manifestWithoutFingerprint), "utf8")
      .digest("hex");
    if (manifestFingerprint !== BRIGHT_STACKOVERFLOW_PREPARED_MANIFEST_FINGERPRINT) {
      throw new Error("bright_stackoverflow_prepared_manifest_mismatch");
    }
    await writeAtomic(resolve(staging, "manifest.json"), `${JSON.stringify({
      ...manifestWithoutFingerprint,
      manifestFingerprint
    }, null, 2)}\n`);
    const completedAt = performance.now();
    const elapsedSeconds = (completedAt - startedAt) / 1_000;
    await writeAtomic(resolve(staging, "preflight-report.json"), `${JSON.stringify({
      corpusMiBPerSecond: accumulator.rawUtf8Bytes / 1_048_576 / elapsedSeconds,
      datasetVerificationMs: Math.round(verifiedAt - startedAt),
      decodeNormalizeAndShardMs: Math.round(decodedAt - verifiedAt),
      documentCount: accumulator.documentCount,
      gpt2CensusMs: Math.round(tokenizedAt - decodedAt),
      gpt2TokensPerSecond: Math.round(tokens.rawGpt2Tokens /
        ((tokenizedAt - decodedAt) / 1_000)),
      manifestFingerprint,
      parquet,
      queryCount: queries.examples.length,
      schemaVersion: 1,
      tokenWorkers: options.tokenWorkers,
      totalMs: Math.round(completedAt - startedAt)
    }, null, 2)}\n`);
    await rename(staging, options.output);
    emit("bright_stackoverflow_dataset_prepared", {
      documentCount: accumulator.documentCount,
      gpt2Tokens: tokens.rawGpt2Tokens,
      manifestFingerprint,
      minimumGpt2Tokens: BRIGHT_STACKOVERFLOW_MIN_GPT2_TOKENS,
      queryCount: queries.examples.length,
      totalMs: Math.round(completedAt - startedAt)
    });
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    const code = /^bright_stackoverflow_[a-z0-9_:.-]+$/u.test(message)
      ? message
      : "bright_stackoverflow_dataset_preflight_failed";
    process.stderr.write(`${JSON.stringify({ event: "bright_stackoverflow_dataset_failed", code })}\n`);
    process.exitCode = 1;
  });
}

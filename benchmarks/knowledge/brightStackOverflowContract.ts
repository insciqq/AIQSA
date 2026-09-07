import { createHash } from "node:crypto";
import {
  canonicalJson,
  type KnowledgeSuiteManifest
} from "./contract";

export const BRIGHT_STACKOVERFLOW_SUITE_ID = "bright-stackoverflow-50m" as const;
export const BRIGHT_STACKOVERFLOW_DATASET_ID = "xlangai/BRIGHT" as const;
export const BRIGHT_STACKOVERFLOW_REVISION =
  "3066d29c9651a576c8aba4832d249807b181ecae" as const;
export const BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT = 107_081 as const;
export const BRIGHT_STACKOVERFLOW_QUERY_COUNT = 117 as const;
export const BRIGHT_STACKOVERFLOW_MIN_GPT2_TOKENS = 50_000_000 as const;
export const BRIGHT_STACKOVERFLOW_CORPUS_SHARD_ROWS = 1_000 as const;
export const BRIGHT_STACKOVERFLOW_SOURCE_NAME =
  "BRIGHT Stack Overflow passage" as const;
export const BRIGHT_STACKOVERFLOW_FILE_NAME =
  "bright-stackoverflow-passage.txt" as const;
export const BRIGHT_STACKOVERFLOW_MEDIA_TYPE = "text/plain" as const;
export const BRIGHT_STACKOVERFLOW_PREPARED_FORMAT_VERSION = 1 as const;
export const BRIGHT_STACKOVERFLOW_MANIFEST_SCHEMA_VERSION = 1 as const;
export const BRIGHT_GPT2_TOKENIZER_PACKAGE = "gpt-tokenizer" as const;
export const BRIGHT_GPT2_TOKENIZER_VERSION = "4.0.0" as const;
export const BRIGHT_GPT2_ENCODING = "gpt2" as const;
export const BRIGHT_GPT2_ASSET_SHA256 =
  "306cd27f03c1a714eca7108e03d66b7dc042abe8c258b44c199a7ed9838dd930" as const;

export const BRIGHT_STACKOVERFLOW_FILES = Object.freeze({
  documents: Object.freeze({
    bytes: 39_493_317,
    localName: "documents.parquet",
    path: "documents/stackoverflow-00000-of-00001.parquet",
    sha256: "d54559692f925666c3c6b1d33a696a64ef324cf5aaeff9d6f4d11fba5cd5ac8b"
  }),
  examples: Object.freeze({
    bytes: 250_458,
    localName: "examples.parquet",
    path: "examples/stackoverflow-00000-of-00001.parquet",
    sha256: "97d417ba449ef70c9c9ae2937e9df106654a2554ce1533b090cb64b998a077e1"
  })
});

const documentKeys = Object.freeze(["content", "id"]);
const preparedDocumentKeys = Object.freeze([
  "formatVersion",
  "officialId",
  "ordinal",
  "sourceId",
  "sourceVersionId",
  "text"
]);
const preparedRuntimeQueryKeys = Object.freeze([
  "formatVersion",
  "officialId",
  "query"
]);
const preparedEvaluatorQueryKeys = Object.freeze([
  "evaluatorSourceFingerprint",
  "excludedIds",
  "formatVersion",
  "goldAnswer",
  "goldIds",
  "officialId"
]);
const exampleKeys = Object.freeze([
  "excluded_ids",
  "gold_answer",
  "gold_ids",
  "gold_ids_long",
  "id",
  "query",
  "reasoning"
]);
const sha256Pattern = /^[0-9a-f]{64}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type BrightStackOverflowDocument = Readonly<{
  officialId: string;
  ordinal: number;
  rawText: string;
}>;

export type BrightPreparedDocument = Readonly<{
  officialId: string;
  ordinal: number;
  preparedText: string;
  sourceId: string;
  sourceVersionId: string;
}>;

export type BrightRuntimeQuery = Readonly<{
  officialId: string;
  text: string;
}>;

export type BrightEvaluationQuery = Readonly<{
  excludedIds: readonly string[];
  goldAnswer: string;
  goldIds: readonly string[];
  officialId: string;
}>;

export type BrightDecodedExample = Readonly<{
  evaluator: BrightEvaluationQuery;
  evaluatorSourceFingerprint: string;
  runtime: BrightRuntimeQuery;
}>;

export type BrightPreparedEvaluationQuery = BrightEvaluationQuery & Readonly<{
  evaluatorSourceFingerprint: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string
): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])) {
    throw new Error(code);
  }
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function officialDocumentId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 ||
    /[\u0000\r\n]/u.test(value) || Buffer.byteLength(value, "utf8") > 1_024) {
    throw new Error("bright_stackoverflow_document_id_invalid");
  }
  return value;
}

function queryId(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,5})$/u.test(value)) {
    throw new Error("bright_stackoverflow_query_id_invalid");
  }
  return value;
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim() || /\u0000/u.test(value)) {
    throw new Error(code);
  }
  return value;
}

function stringList(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) =>
    typeof item !== "string" || item.length < 1 || item.length > 512 ||
    /[\u0000\r\n]/u.test(item))) {
    throw new Error(code);
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) throw new Error(code);
  return Object.freeze([...result]);
}

/**
 * Dataset-bound opaque UUIDv8. Public BRIGHT ids remain only in ignored
 * benchmark mapping state and never become product Source names or metadata.
 */
export function brightDeterministicUuid(purpose: string, ...values: string[]): string {
  if (!purpose || values.some((value) => value.includes("\u0000"))) {
    throw new Error("bright_stackoverflow_identity_input_invalid");
  }
  const hash = createHash("sha256");
  for (const value of [
    "aiqsa:bright-stackoverflow-50m:v1",
    purpose,
    BRIGHT_STACKOVERFLOW_REVISION,
    ...values
  ]) {
    hash.update(String(Buffer.byteLength(value, "utf8")), "utf8");
    hash.update(":", "utf8");
    hash.update(value, "utf8");
  }
  const bytes = hash.digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
  if (!uuidPattern.test(uuid)) {
    throw new Error("bright_stackoverflow_identity_invalid");
  }
  return uuid;
}

export function decodeBrightDocumentRow(
  value: unknown,
  ordinal: number
): BrightStackOverflowDocument {
  if (!isRecord(value) || !Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error("bright_stackoverflow_document_row_invalid");
  }
  assertExactKeys(value, documentKeys, "bright_stackoverflow_document_row_invalid");
  if (typeof value.content !== "string" || !value.content.trim()) {
    throw new Error("bright_stackoverflow_document_row_invalid");
  }
  return Object.freeze({
    officialId: officialDocumentId(value.id),
    ordinal,
    rawText: value.content
  });
}

export function prepareBrightDocument(
  document: BrightStackOverflowDocument
): BrightPreparedDocument {
  const preparedText = normalizeBrightDocumentText(document.rawText);
  const sourceId = brightDeterministicUuid("source", document.officialId);
  const sourceVersionId = brightDeterministicUuid(
    "source-version",
    sourceId,
    sha256Utf8(preparedText)
  );
  return Object.freeze({
    officialId: document.officialId,
    ordinal: document.ordinal,
    preparedText,
    sourceId,
    sourceVersionId
  });
}

/** Strictly revalidates an ignored prepared-shard row before product work. */
export function decodeBrightPreparedDocumentRow(
  value: unknown
): BrightPreparedDocument {
  if (!isRecord(value)) {
    throw new Error("bright_stackoverflow_prepared_document_invalid");
  }
  assertExactKeys(
    value,
    preparedDocumentKeys,
    "bright_stackoverflow_prepared_document_invalid"
  );
  if (value.formatVersion !== BRIGHT_STACKOVERFLOW_PREPARED_FORMAT_VERSION ||
    !Number.isSafeInteger(value.ordinal) || Number(value.ordinal) < 0 ||
    Number(value.ordinal) >= BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
    typeof value.text !== "string") {
    throw new Error("bright_stackoverflow_prepared_document_invalid");
  }
  const officialId = officialDocumentId(value.officialId);
  const preparedText = normalizeBrightDocumentText(value.text);
  if (preparedText !== value.text) {
    throw new Error("bright_stackoverflow_prepared_document_invalid");
  }
  const sourceId = brightDeterministicUuid("source", officialId);
  const sourceVersionId = brightDeterministicUuid(
    "source-version",
    sourceId,
    sha256Utf8(preparedText)
  );
  if (value.sourceId !== sourceId || value.sourceVersionId !== sourceVersionId) {
    throw new Error("bright_stackoverflow_prepared_identity_mismatch");
  }
  return Object.freeze({
    officialId,
    ordinal: Number(value.ordinal),
    preparedText,
    sourceId,
    sourceVersionId
  });
}

export function normalizeBrightDocumentText(rawText: string): string {
  const preparedText = rawText
    .replaceAll("\uFFFD", " ")
    .replace(/\r\n?/gu, "\n")
    .replaceAll("\u0000", "")
    .trim();
  if (!preparedText) throw new Error("bright_stackoverflow_document_text_invalid");
  return preparedText;
}

export function decodeBrightPreparedRuntimeQueryRow(
  value: unknown
): BrightRuntimeQuery {
  if (!isRecord(value)) throw new Error("bright_stackoverflow_runtime_query_invalid");
  assertExactKeys(
    value,
    preparedRuntimeQueryKeys,
    "bright_stackoverflow_runtime_query_invalid"
  );
  if (value.formatVersion !== BRIGHT_STACKOVERFLOW_PREPARED_FORMAT_VERSION) {
    throw new Error("bright_stackoverflow_runtime_query_invalid");
  }
  return Object.freeze({
    officialId: queryId(value.officialId),
    text: requiredText(value.query, "bright_stackoverflow_runtime_query_invalid")
  });
}

export function decodeBrightPreparedEvaluationQueryRow(
  value: unknown
): BrightPreparedEvaluationQuery {
  const code = "bright_stackoverflow_evaluator_query_invalid";
  if (!isRecord(value)) throw new Error(code);
  assertExactKeys(value, preparedEvaluatorQueryKeys, code);
  if (value.formatVersion !== BRIGHT_STACKOVERFLOW_PREPARED_FORMAT_VERSION ||
    typeof value.evaluatorSourceFingerprint !== "string" ||
    !sha256Pattern.test(value.evaluatorSourceFingerprint)) {
    throw new Error(code);
  }
  const goldIds = stringList(value.goldIds, code);
  const excludedIds = stringList(value.excludedIds, code);
  if (goldIds.length === 0 || excludedIds.some((id) => goldIds.includes(id))) {
    throw new Error(code);
  }
  return Object.freeze({
    evaluatorSourceFingerprint: value.evaluatorSourceFingerprint,
    excludedIds,
    goldAnswer: requiredText(value.goldAnswer, code),
    goldIds,
    officialId: queryId(value.officialId)
  });
}

export function decodeBrightExampleRow(value: unknown): BrightDecodedExample {
  if (!isRecord(value)) throw new Error("bright_stackoverflow_example_row_invalid");
  assertExactKeys(value, exampleKeys, "bright_stackoverflow_example_row_invalid");
  const officialId = queryId(value.id);
  const query = requiredText(value.query, "bright_stackoverflow_query_invalid");
  const reasoning = requiredText(value.reasoning, "bright_stackoverflow_reasoning_invalid");
  const goldAnswer = requiredText(
    value.gold_answer,
    "bright_stackoverflow_gold_answer_invalid"
  );
  const goldIds = stringList(value.gold_ids, "bright_stackoverflow_gold_ids_invalid");
  const goldIdsLong = stringList(
    value.gold_ids_long,
    "bright_stackoverflow_gold_ids_long_invalid"
  );
  const excludedRaw = stringList(
    value.excluded_ids,
    "bright_stackoverflow_excluded_ids_invalid"
  );
  if (goldIds.length === 0 || goldIdsLong.length === 0 ||
    (excludedRaw.includes("N/A") && excludedRaw.length !== 1)) {
    throw new Error("bright_stackoverflow_example_row_invalid");
  }
  const excludedIds = Object.freeze(excludedRaw.filter((id) => id !== "N/A"));
  const goldSet = new Set(goldIds);
  if (excludedIds.some((id) => goldSet.has(id))) {
    throw new Error("bright_stackoverflow_qrel_overlap");
  }
  return Object.freeze({
    evaluator: Object.freeze({
      excludedIds,
      goldAnswer,
      goldIds,
      officialId
    }),
    evaluatorSourceFingerprint: sha256Utf8(canonicalJson({
      excludedIds: excludedRaw,
      goldAnswer,
      goldIds,
      goldIdsLong,
      officialId,
      query,
      reasoning
    })),
    runtime: Object.freeze({ officialId, text: query })
  });
}

export function assertBrightDatasetReferences(
  documentIds: ReadonlySet<string>,
  examples: readonly BrightDecodedExample[]
): void {
  if (documentIds.size !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT) {
    throw new Error("bright_stackoverflow_document_count_mismatch");
  }
  if (examples.length !== BRIGHT_STACKOVERFLOW_QUERY_COUNT ||
    new Set(examples.map(({ runtime }) => runtime.officialId)).size !== examples.length) {
    throw new Error("bright_stackoverflow_query_count_mismatch");
  }
  for (const { evaluator } of examples) {
    if (evaluator.goldIds.some((id) => !documentIds.has(id))) {
      throw new Error("bright_stackoverflow_gold_id_missing");
    }
    if (evaluator.excludedIds.some((id) => !documentIds.has(id))) {
      throw new Error("bright_stackoverflow_excluded_id_missing");
    }
  }
}

export function assertBrightSuiteManifest(suite: KnowledgeSuiteManifest): void {
  const source = suite.sources[0];
  const expectedFiles = Object.values(BRIGHT_STACKOVERFLOW_FILES);
  if (
    suite.suiteId !== BRIGHT_STACKOVERFLOW_SUITE_ID ||
    suite.family !== "BRIGHT" ||
    suite.dataset !== "Stack Overflow" ||
    suite.querySplit !== "stackoverflow" ||
    suite.expectedCorpusDocumentCount !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
    suite.expectedExcludedQueryCount !== 0 ||
    suite.expectedQueryCount !== BRIGHT_STACKOVERFLOW_QUERY_COUNT ||
    suite.sources.length !== 1 ||
    !source ||
    source.datasetId !== BRIGHT_STACKOVERFLOW_DATASET_ID ||
    source.revision !== BRIGHT_STACKOVERFLOW_REVISION ||
    source.files.length !== expectedFiles.length
  ) {
    throw new Error("bright_stackoverflow_manifest_invalid");
  }
  const files = new Map(source.files.map((file) => [file.path, file]));
  for (const expected of expectedFiles) {
    const file = files.get(expected.path);
    if (!file || file.bytes !== expected.bytes || file.sha256 !== expected.sha256) {
      throw new Error("bright_stackoverflow_manifest_invalid");
    }
  }
}

export function assertBrightGpt2Census(tokenCount: number): void {
  if (!Number.isSafeInteger(tokenCount) ||
    tokenCount < BRIGHT_STACKOVERFLOW_MIN_GPT2_TOKENS) {
    throw new Error("bright_stackoverflow_gpt2_token_floor_not_met");
  }
}

export function assertSha256(value: string, code: string): string {
  if (!sha256Pattern.test(value)) throw new Error(code);
  return value;
}

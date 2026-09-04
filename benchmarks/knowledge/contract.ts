import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";

/** Opt-in public Knowledge retrieval benchmark contract.
 *
 * Pure schemas and functions only: manifest decoding, deterministic document
 * normalization, frozen run manifests, retrieval metrics, and comparison
 * guards. Nothing in this module touches the network, the filesystem outside
 * path resolution, or a database, so everything is unit-testable with tiny
 * synthetic fixtures. */

export const KNOWLEDGE_BENCHMARK_ACK_ENV = "AIQSA_KNOWLEDGE_BENCHMARK_ACK";
export const KNOWLEDGE_BENCHMARK_ACK_VALUE = "DISPOSABLE_PAID_KB";
export const KNOWLEDGE_BENCHMARK_APP_PORT = 3147;
export const KNOWLEDGE_BENCHMARK_POSTGRES_PORT = 15447;
export const KNOWLEDGE_BENCHMARK_MAX_CONCURRENCY = 16;
/** Version of the deterministic benchmark document formatter below. Part of
 * every frozen run manifest and cache key. */
export const KNOWLEDGE_BENCHMARK_DOC_FORMAT_VERSION = 3;

/** Deterministic encoding-artifact hygiene applied uniformly to every
 * benchmark document body/title: the official corpora carry occasional
 * U+FFFD replacement characters (mojibake in the upstream source data) that
 * the product's text-shape validation rejects as hostile input. Replacing
 * them with a single space is content-neutral, language-neutral, identical
 * for all documents, and versioned through the doc format version above. */
export function sanitizeBenchmarkText(value: string): string {
  return value.replaceAll("�", " ");
}
export const KNOWLEDGE_BENCHMARK_SUMMARY_SCHEMA_VERSION = 1;

export const KNOWLEDGE_BENCHMARK_SUITE_IDS = [
  "rusbeir-rus-scifact",
  "t2ragbench-convfinqa",
  "bright-stackoverflow-50m"
] as const;
export type KnowledgeSuiteId = (typeof KNOWLEDGE_BENCHMARK_SUITE_IDS)[number];

export const KNOWLEDGE_BENCHMARK_CONFIG_LABELS = ["A", "B", "C"] as const;
export type KnowledgeConfigLabel =
  (typeof KNOWLEDGE_BENCHMARK_CONFIG_LABELS)[number];

const suiteIdSet = new Set<string>(KNOWLEDGE_BENCHMARK_SUITE_IDS);
const configLabelSet = new Set<string>(KNOWLEDGE_BENCHMARK_CONFIG_LABELS);
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const revisionPattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const uploadSafeOfficialIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 ||
    value.includes("\u0000")) {
    throw new Error(code);
  }
  return value;
}

function sourceString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.includes("\u0000")) {
    throw new Error(code);
  }
  return value;
}

function sha256HexUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stable JSON with lexicographically sorted object keys so fingerprints do
 * not depend on property insertion order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  if (value === undefined) throw new Error("knowledge_benchmark_canonical_undefined");
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Dataset manifest (upstream.json)
// ---------------------------------------------------------------------------

export type KnowledgeManifestFile = Readonly<{
  bytes: number;
  path: string;
  sha256: string;
}>;

export type KnowledgeManifestSource = Readonly<{
  datasetId: string;
  files: readonly KnowledgeManifestFile[];
  revision: string;
}>;

export type KnowledgeSuiteManifest = Readonly<{
  dataset: string;
  expectedCorpusDocumentCount: number | null;
  expectedExcludedQueryCount: number;
  expectedQueryCount: number;
  family: string;
  licenseNote: string;
  querySplit: string;
  resultLabel: string;
  sources: readonly KnowledgeManifestSource[];
  suiteId: KnowledgeSuiteId;
}>;

export type KnowledgeBenchmarkManifest = Readonly<{
  formatVersion: 1;
  suites: Readonly<Record<KnowledgeSuiteId, KnowledgeSuiteManifest>>;
}>;

function decodeManifestFile(value: unknown, code: string): KnowledgeManifestFile {
  if (!isRecord(value)) throw new Error(code);
  const path = requiredString(value.path, code);
  const sha256 = requiredString(value.sha256, code);
  if (!sha256Pattern.test(sha256)) {
    // A placeholder such as "PIN_ME" is refused here: every pinned checksum
    // must be a full lowercase hex SHA-256 before any download or run.
    throw new Error(`${code}_sha256_unpinned`);
  }
  if (!Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1) {
    throw new Error(code);
  }
  if (path.includes("..") || path.startsWith("/")) throw new Error(code);
  return Object.freeze({ bytes: Number(value.bytes), path, sha256 });
}

function decodeManifestSource(value: unknown, code: string): KnowledgeManifestSource {
  if (!isRecord(value)) throw new Error(code);
  const datasetId = requiredString(value.datasetId, code);
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(datasetId)) {
    throw new Error(code);
  }
  const revision = requiredString(value.revision, code);
  if (!revisionPattern.test(revision)) {
    // Refuses "PIN_ME" and branch names: only a full commit hash is a pin.
    throw new Error(`${code}_revision_unpinned`);
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error(code);
  }
  return Object.freeze({
    datasetId,
    files: Object.freeze(value.files.map((file) =>
      decodeManifestFile(file, code))),
    revision
  });
}

function decodeSuiteManifest(
  suiteId: KnowledgeSuiteId,
  value: unknown
): KnowledgeSuiteManifest {
  const code = `knowledge_benchmark_manifest_suite_invalid:${suiteId}`;
  if (!isRecord(value)) throw new Error(code);
  const expectedCorpusDocumentCount = value.expectedCorpusDocumentCount;
  if (expectedCorpusDocumentCount !== null &&
    (!Number.isSafeInteger(expectedCorpusDocumentCount) ||
      Number(expectedCorpusDocumentCount) < 1)) {
    throw new Error(code);
  }
  if (!Number.isSafeInteger(value.expectedQueryCount) ||
    Number(value.expectedQueryCount) < 1) {
    throw new Error(code);
  }
  if (!Number.isSafeInteger(value.expectedExcludedQueryCount) ||
    Number(value.expectedExcludedQueryCount) < 0 ||
    Number(value.expectedExcludedQueryCount) >= Number(value.expectedQueryCount)) {
    throw new Error(code);
  }
  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    throw new Error(code);
  }
  return Object.freeze({
    dataset: requiredString(value.dataset, code),
    expectedCorpusDocumentCount: expectedCorpusDocumentCount === null
      ? null
      : Number(expectedCorpusDocumentCount),
    expectedExcludedQueryCount: Number(value.expectedExcludedQueryCount),
    expectedQueryCount: Number(value.expectedQueryCount),
    family: requiredString(value.family, code),
    licenseNote: requiredString(value.licenseNote, code),
    querySplit: requiredString(value.querySplit, code),
    resultLabel: requiredString(value.resultLabel, code),
    sources: Object.freeze(value.sources.map((source) =>
      decodeManifestSource(source, code))),
    suiteId
  });
}

export function decodeKnowledgeBenchmarkManifest(
  value: unknown
): KnowledgeBenchmarkManifest {
  if (!isRecord(value) || value.formatVersion !== 1 ||
    !isRecord(value.suites)) {
    throw new Error("knowledge_benchmark_manifest_invalid");
  }
  const keys = Object.keys(value.suites).sort();
  if (keys.length !== KNOWLEDGE_BENCHMARK_SUITE_IDS.length ||
    keys.some((key) => !suiteIdSet.has(key))) {
    throw new Error("knowledge_benchmark_manifest_suites_invalid");
  }
  const suites = Object.fromEntries(KNOWLEDGE_BENCHMARK_SUITE_IDS.map(
    (suiteId) => [
      suiteId,
      decodeSuiteManifest(suiteId, (value.suites as Record<string, unknown>)[suiteId])
    ]
  )) as Record<KnowledgeSuiteId, KnowledgeSuiteManifest>;
  return Object.freeze({ formatVersion: 1, suites: Object.freeze(suites) });
}

// ---------------------------------------------------------------------------
// Deterministic benchmark documents
// ---------------------------------------------------------------------------

export type KnowledgeBenchmarkDocument = Readonly<{
  /** Deterministic UTF-8 Markdown body uploaded through the product text
   * ingestion path. */
  markdown: string;
  /** Official public dataset identifier (corpus `_id` or `context_id`). */
  officialId: string;
  /** Stable upload file name; the private doc-id ↔ official-id mapping is
   * `fileName ↔ officialId` and is recorded in the ingest state file. */
  fileName: string;
  suiteId: KnowledgeSuiteId;
}>;

export type KnowledgeBenchmarkQuery = Readonly<{
  /** Dataset-declared documents removed from the returned order before
   * metrics. Omitted by suites whose protocol has no exclusion list. */
  excludedDocumentIds?: readonly string[];
  officialId: string;
  /** Official relevant document ids with graded gains (qrels score, or 1 for
   * the ConvFinQA context mapping). */
  relevant: Readonly<Record<string, number>>;
  text: string;
}>;

/** Product upload client ids are transport identities, not display names.
 * Keep them on the already-bounded official public id so a Unicode semantic
 * filename remains valid without lossy transliteration. */
export function knowledgeBenchmarkUploadClientId(
  document: KnowledgeBenchmarkDocument
): string {
  if (!uploadSafeOfficialIdPattern.test(document.officialId)) {
    throw new Error("knowledge_benchmark_upload_client_id_invalid");
  }
  return document.officialId;
}

export function isKnowledgeBenchmarkOfficialId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\u0000\r\n]/u.test(value) && Buffer.byteLength(value, "utf8") <= 1_024;
}

function officialId(value: unknown, code: string): string {
  const id = requiredString(value, code);
  if (!isKnowledgeBenchmarkOfficialId(id)) throw new Error(code);
  return id;
}

export function knowledgeBenchmarkFileName(
  suiteId: KnowledgeSuiteId,
  documentId: string
): string {
  const prefix = suiteId === "rusbeir-rus-scifact"
    ? "scifact"
    : suiteId === "t2ragbench-convfinqa"
      ? "convfinqa"
      : "bright-stackoverflow";
  if (!uploadSafeOfficialIdPattern.test(documentId)) {
    throw new Error("knowledge_benchmark_document_id_invalid");
  }
  return `${prefix}-${documentId}.md`;
}

export function parseJsonLines(text: string, code: string): readonly unknown[] {
  return Object.freeze(text.split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(code);
      }
    }));
}

/** rus-SciFact corpus row → deterministic Markdown document. The official
 * title becomes the single heading and the official text the body; neither is
 * rewritten, translated, or augmented. */
export function normalizeRusScifactCorpusRow(
  value: unknown
): KnowledgeBenchmarkDocument {
  const code = "knowledge_benchmark_scifact_corpus_row_invalid";
  if (!isRecord(value)) throw new Error(code);
  const id = officialId(value._id, code);
  const title = sanitizeBenchmarkText(typeof value.title === "string" ? value.title : "");
  if (title.includes("\u0000") || title.includes("\n")) throw new Error(code);
  const text = sanitizeBenchmarkText(requiredString(value.text, code));
  const markdown = title.length > 0
    ? `# ${title}\n\n${text}\n`
    : `${text}\n`;
  return Object.freeze({
    fileName: knowledgeBenchmarkFileName("rusbeir-rus-scifact", id),
    markdown,
    officialId: id,
    suiteId: "rusbeir-rus-scifact"
  });
}

export function decodeRusScifactCorpus(
  rows: readonly unknown[]
): readonly KnowledgeBenchmarkDocument[] {
  const documents = rows.map(normalizeRusScifactCorpusRow);
  if (new Set(documents.map(({ officialId: id }) => id)).size !== documents.length) {
    throw new Error("knowledge_benchmark_scifact_corpus_duplicate_id");
  }
  return Object.freeze([...documents].sort((left, right) =>
    left.officialId < right.officialId ? -1 :
      left.officialId > right.officialId ? 1 : 0));
}

export type KnowledgeQrelRow = Readonly<{
  corpusId: string;
  queryId: string;
  score: number;
}>;

export function parseQrelsTsv(text: string): readonly KnowledgeQrelRow[] {
  const code = "knowledge_benchmark_qrels_invalid";
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines[0] !== "query-id\tcorpus-id\tscore") throw new Error(code);
  const rows = lines.slice(1).map((line) => {
    const parts = line.split("\t");
    if (parts.length !== 3) throw new Error(code);
    const score = Number(parts[2]);
    if (!Number.isSafeInteger(score) || score < 1) throw new Error(code);
    return Object.freeze({
      corpusId: officialId(parts[1], code),
      queryId: officialId(parts[0], code),
      score
    });
  });
  if (rows.length === 0) throw new Error(code);
  const pairs = new Set(rows.map(({ corpusId, queryId }) =>
    `${queryId}\u0000${corpusId}`));
  if (pairs.size !== rows.length) throw new Error(code);
  return Object.freeze(rows);
}

/** Official test queries: exactly the query ids present in the official test
 * qrels, with the original (untranslated, unprocessed) query text. */
export function decodeRusScifactQueries(
  rows: readonly unknown[],
  qrels: readonly KnowledgeQrelRow[]
): readonly KnowledgeBenchmarkQuery[] {
  const code = "knowledge_benchmark_scifact_query_row_invalid";
  const relevantByQuery = new Map<string, Record<string, number>>();
  for (const row of qrels) {
    const relevant = relevantByQuery.get(row.queryId) ?? {};
    relevant[row.corpusId] = row.score;
    relevantByQuery.set(row.queryId, relevant);
  }
  const textById = new Map<string, string>();
  for (const row of rows) {
    if (!isRecord(row)) throw new Error(code);
    const id = officialId(row._id, code);
    if (textById.has(id)) {
      throw new Error("knowledge_benchmark_scifact_query_duplicate_id");
    }
    textById.set(id, requiredString(row.text, code));
  }
  return Object.freeze([...relevantByQuery.keys()].sort().map((queryId) => {
    const text = textById.get(queryId);
    if (text === undefined) {
      throw new Error("knowledge_benchmark_scifact_query_missing");
    }
    return Object.freeze({
      officialId: queryId,
      relevant: Object.freeze({ ...relevantByQuery.get(queryId) }),
      text
    });
  }));
}

export type ConvFinQaRow = Readonly<{
  companyCik: number;
  companyDateAdded: string;
  companyFounded: string;
  companyHeadquarters: string;
  companyIndustry: string;
  companyName: string;
  companySector: string;
  companySymbol: string;
  context: string;
  contextId: string;
  fileName: string;
  id: string;
  pageNumber: string;
  question: string;
  reportYear: string;
}>;

const convFinQaMetadataFields = [
  ["company_name", "companyName"],
  ["company_symbol", "companySymbol"],
  ["report_year", "reportYear"],
  ["page_number", "pageNumber"],
  ["file_name", "fileName"],
  ["company_sector", "companySector"],
  ["company_industry", "companyIndustry"],
  ["company_headquarters", "companyHeadquarters"],
  ["company_date_added", "companyDateAdded"],
  ["company_founded", "companyFounded"]
] as const;

function convFinQaMetadataString(value: unknown, code: string): string {
  const normalized = sanitizeBenchmarkText(requiredString(value, code)).trim();
  if (normalized.length === 0 || normalized.includes("\n") ||
    normalized.includes("\r")) {
    throw new Error(code);
  }
  return normalized;
}

function convFinQaUploadFileName(row: ConvFinQaRow): string {
  const sourceStem = row.fileName.replace(/\.pdf$/iu, "").replaceAll("/", "-");
  const semanticStem = [
    row.companyName,
    row.companySymbol,
    row.reportYear,
    sourceStem
  ].join("-").normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  if (semanticStem.length === 0 || semanticStem.length > 200) {
    throw new Error("knowledge_benchmark_convfinqa_metadata_invalid");
  }
  return `convfinqa-${semanticStem}.md`;
}

function convFinQaStableMetadata(row: ConvFinQaRow): Readonly<Record<string, string>> {
  return Object.freeze({
    company_cik: String(row.companyCik),
    ...Object.fromEntries(convFinQaMetadataFields.map(([sourceKey, rowKey]) =>
      [sourceKey, row[rowKey]]))
  });
}

function convFinQaMarkdown(row: ConvFinQaRow): string {
  const suffix = Object.entries(convFinQaStableMetadata(row))
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");
  return `${row.context}\n\n${suffix}\n`;
}

function decodeConvFinQaSourceRow(value: unknown): ConvFinQaRow {
  const code = "knowledge_benchmark_convfinqa_row_invalid";
  if (!isRecord(value)) throw new Error(code);
  const companyCik = value.company_cik;
  if (!Number.isSafeInteger(companyCik) || Number(companyCik) < 0) {
    throw new Error(code);
  }
  return Object.freeze({
    companyCik: Number(companyCik),
    companyDateAdded: convFinQaMetadataString(value.company_date_added, code),
    companyFounded: convFinQaMetadataString(value.company_founded, code),
    companyHeadquarters: convFinQaMetadataString(value.company_headquarters, code),
    companyIndustry: convFinQaMetadataString(value.company_industry, code),
    companyName: convFinQaMetadataString(value.company_name, code),
    companySector: convFinQaMetadataString(value.company_sector, code),
    companySymbol: convFinQaMetadataString(value.company_symbol, code),
    context: sanitizeBenchmarkText(requiredString(value.context, code)),
    contextId: officialId(value.context_id, code),
    fileName: convFinQaMetadataString(value.file_name, code),
    id: officialId(value.id, code),
    pageNumber: convFinQaMetadataString(value.page_number, code),
    // The pinned official artifact contains five rows whose question is the
    // empty string. They still contribute their complete context to the
    // corpus, but are not scoreable retrieval queries.
    question: sourceString(value.question, code),
    reportYear: convFinQaMetadataString(value.report_year, code)
  });
}

/** Official T²-RAGBench ConvFinQA turn_0 row. The `context` field already
 * contains pre-text, the Markdown table, and post-text joined in official
 * order; it is kept byte-for-byte as the document body and tables are never
 * re-derived. */
export function decodeConvFinQaRow(value: unknown): ConvFinQaRow {
  const row = decodeConvFinQaSourceRow(value);
  if (row.question.trim().length === 0) {
    throw new Error("knowledge_benchmark_convfinqa_row_invalid");
  }
  return row;
}

/** Corpus construction per the official rule: deduplicate ONLY by the official
 * `context_id`; every unique context becomes one benchmark document. Rows that
 * share a `context_id` must carry identical context text. */
export function decodeConvFinQaCorpus(
  rows: readonly unknown[]
): readonly KnowledgeBenchmarkDocument[] {
  const contexts = new Map<string, ConvFinQaRow>();
  for (const value of rows) {
    const row = decodeConvFinQaSourceRow(value);
    const existing = contexts.get(row.contextId);
    if (existing === undefined) {
      contexts.set(row.contextId, row);
    } else if (existing.context !== row.context) {
      throw new Error("knowledge_benchmark_convfinqa_context_conflict");
    } else if (canonicalJson(convFinQaStableMetadata(existing)) !==
      canonicalJson(convFinQaStableMetadata(row))) {
      throw new Error("knowledge_benchmark_convfinqa_metadata_conflict");
    }
  }
  if (contexts.size === 0) {
    throw new Error("knowledge_benchmark_convfinqa_corpus_empty");
  }
  const documents = [...contexts.keys()].sort().map((contextId) => {
    const row = contexts.get(contextId)!;
    return Object.freeze({
      fileName: convFinQaUploadFileName(row),
      markdown: convFinQaMarkdown(row),
      officialId: contextId,
      suiteId: "t2ragbench-convfinqa" as const
    });
  });
  if (new Set(documents.map(({ fileName }) => fileName)).size !== documents.length) {
    throw new Error("knowledge_benchmark_convfinqa_filename_conflict");
  }
  return Object.freeze(documents);
}

/** Queries: the full official turn_0 split; the relevant document of a query
 * is exactly its official `context_id`. */
export function decodeConvFinQaQueries(
  rows: readonly unknown[]
): readonly KnowledgeBenchmarkQuery[] {
  const decoded = rows.map(decodeConvFinQaSourceRow);
  if (new Set(decoded.map(({ id }) => id)).size !== decoded.length) {
    throw new Error("knowledge_benchmark_convfinqa_query_duplicate_id");
  }
  return Object.freeze(decoded
    .filter(({ question }) => question.trim().length > 0)
    .map((row) => Object.freeze({
    officialId: row.id,
    relevant: Object.freeze({ [row.contextId]: 1 }),
    text: row.question
  })));
}

/** Selects an exact non-scoreable diagnostic subset without changing the
 * official query contract. Repeated ids are rejected so a retry batch cannot
 * silently overweight one failure, and caller order is retained for an
 * operator-readable audit ranking. */
export function selectKnowledgeBenchmarkQueries(
  queries: readonly KnowledgeBenchmarkQuery[],
  queryIds: readonly string[],
  queryLimit: number | undefined
): readonly KnowledgeBenchmarkQuery[] {
  if (queryIds.length > 0 && queryLimit !== undefined) {
    throw new Error("knowledge_benchmark_query_selection_ambiguous");
  }
  if (new Set(queryIds).size !== queryIds.length) {
    throw new Error("knowledge_benchmark_query_id_duplicate");
  }
  if (queryIds.length === 0) {
    return Object.freeze(queryLimit === undefined
      ? [...queries]
      : queries.slice(0, queryLimit));
  }
  const byId = new Map(queries.map((query) => [query.officialId, query]));
  return Object.freeze(queryIds.map((queryId) => {
    const query = byId.get(queryId);
    if (!query) throw new Error("knowledge_benchmark_query_id_not_found");
    return query;
  }));
}

/** Stable identity of the exact scoreable query set. It prevents two runs
 * over the same corpus revision from becoming comparable if query admission
 * or relevance labels differ. */
export function knowledgeQuerySetContentSha256(
  queries: readonly KnowledgeBenchmarkQuery[]
): string {
  if (queries.length === 0 ||
    new Set(queries.map(({ officialId }) => officialId)).size !== queries.length) {
    throw new Error("knowledge_benchmark_query_set_invalid");
  }
  const hash = createHash("sha256");
  for (const query of [...queries].sort((left, right) =>
    left.officialId < right.officialId ? -1 :
      left.officialId > right.officialId ? 1 : 0)) {
    hash.update(query.officialId, "utf8");
    hash.update("\u0000", "utf8");
    hash.update(query.text, "utf8");
    hash.update("\u0000", "utf8");
    hash.update(canonicalJson(query.relevant), "utf8");
    hash.update("\u0000", "utf8");
    if (query.excludedDocumentIds !== undefined) {
      const excluded = [...query.excludedDocumentIds].sort();
      if (new Set(excluded).size !== excluded.length ||
        excluded.some((id) => !isKnowledgeBenchmarkOfficialId(id) ||
          Object.hasOwn(query.relevant, id))) {
        throw new Error("knowledge_benchmark_query_set_invalid");
      }
      hash.update(canonicalJson(excluded), "utf8");
      hash.update("\u0000", "utf8");
    }
  }
  return hash.digest("hex");
}

/** Applies an upstream evaluation exclusion only after product retrieval so
 * evaluator-only labels cannot influence candidate generation or ranking. */
export function excludeKnowledgeBenchmarkDocuments(
  rankedDocumentIds: readonly string[],
  excludedDocumentIds: readonly string[] | undefined
): readonly string[] {
  if (excludedDocumentIds === undefined || excludedDocumentIds.length === 0) {
    return Object.freeze([...rankedDocumentIds]);
  }
  if (new Set(excludedDocumentIds).size !== excludedDocumentIds.length ||
    excludedDocumentIds.some((id) => !isKnowledgeBenchmarkOfficialId(id))) {
    throw new Error("knowledge_benchmark_excluded_documents_invalid");
  }
  const excluded = new Set(excludedDocumentIds);
  return Object.freeze(rankedDocumentIds.filter((id) => !excluded.has(id)));
}

/** Deterministic content hash of a normalized corpus, independent of input
 * order. Part of the frozen run manifest and of every cache key. */
export function knowledgeCorpusContentSha256(
  documents: readonly KnowledgeBenchmarkDocument[]
): string {
  const hash = createHash("sha256");
  for (const document of [...documents].sort((left, right) =>
    left.fileName < right.fileName ? -1 :
      left.fileName > right.fileName ? 1 : 0)) {
    hash.update(document.fileName, "utf8");
    hash.update("\u0000", "utf8");
    hash.update(document.markdown, "utf8");
    hash.update("\u0000", "utf8");
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Frozen run manifest
// ---------------------------------------------------------------------------

export type KnowledgeCandidateLimits = Readonly<{
  final: number;
  lexical: number;
  vector: number;
}>;

export type KnowledgeQueryPreparation = Readonly<{
  boundedQueryCount: number;
  focusedRequestVersion: number | null;
  normalizedQueryCount: number;
}>;

export type KnowledgeFrozenRunManifest = Readonly<{
  candidateLimits: KnowledgeCandidateLimits;
  chunkingProfile: string;
  configLabel: KnowledgeConfigLabel;
  corpusContentSha256: string;
  datasetSources: readonly Readonly<{ datasetId: string; revision: string }>[];
  /** Version of the benchmark document normalizer that produced the corpus. */
  docFormatVersion: number;
  embeddingDimension: number;
  embeddingFormatterVersion: string;
  embeddingModelId: string;
  excludedQueryCount: number;
  indexProfile: string;
  queryCount: number;
  queryInstructionVersion: string;
  queryPreparation: KnowledgeQueryPreparation;
  querySetContentSha256: string;
  querySplit: string;
  rankingProfile: string;
  rerankerModelId: string | null;
  suiteId: KnowledgeSuiteId;
  tokenizerFingerprint: string;
}>;

const frozenManifestCode = "knowledge_benchmark_frozen_manifest_invalid";

function decodeCandidateLimits(value: unknown): KnowledgeCandidateLimits {
  if (!isRecord(value)) throw new Error(frozenManifestCode);
  const bounded = (candidate: unknown): number => {
    if (!Number.isSafeInteger(candidate) || Number(candidate) < 1 ||
      Number(candidate) > 10_000) {
      throw new Error(frozenManifestCode);
    }
    return Number(candidate);
  };
  return Object.freeze({
    final: bounded(value.final),
    lexical: bounded(value.lexical),
    vector: bounded(value.vector)
  });
}

export function decodeKnowledgeFrozenRunManifest(
  value: unknown
): KnowledgeFrozenRunManifest {
  if (!isRecord(value)) throw new Error(frozenManifestCode);
  if (typeof value.suiteId !== "string" || !suiteIdSet.has(value.suiteId)) {
    throw new Error(frozenManifestCode);
  }
  if (typeof value.configLabel !== "string" ||
    !configLabelSet.has(value.configLabel)) {
    throw new Error(frozenManifestCode);
  }
  if (!Array.isArray(value.datasetSources) || value.datasetSources.length === 0) {
    throw new Error(frozenManifestCode);
  }
  const datasetSources = Object.freeze(value.datasetSources.map((source) => {
    if (!isRecord(source)) throw new Error(frozenManifestCode);
    const revision = requiredString(source.revision, frozenManifestCode);
    if (!revisionPattern.test(revision)) throw new Error(frozenManifestCode);
    return Object.freeze({
      datasetId: requiredString(source.datasetId, frozenManifestCode),
      revision
    });
  }));
  const corpusContentSha256 = requiredString(
    value.corpusContentSha256,
    frozenManifestCode
  );
  const querySetContentSha256 = requiredString(
    value.querySetContentSha256,
    frozenManifestCode
  );
  if (!sha256Pattern.test(corpusContentSha256) ||
    !sha256Pattern.test(querySetContentSha256)) {
    throw new Error(frozenManifestCode);
  }
  if (!Number.isSafeInteger(value.embeddingDimension) ||
    Number(value.embeddingDimension) < 1 ||
    !Number.isSafeInteger(value.docFormatVersion) ||
    Number(value.docFormatVersion) < 1 ||
    !Number.isSafeInteger(value.queryCount) || Number(value.queryCount) < 1 ||
    !Number.isSafeInteger(value.excludedQueryCount) ||
    Number(value.excludedQueryCount) < 0) {
    throw new Error(frozenManifestCode);
  }
  if (!isRecord(value.queryPreparation) ||
    !Number.isSafeInteger(value.queryPreparation.boundedQueryCount) ||
    Number(value.queryPreparation.boundedQueryCount) < 0 ||
    Number(value.queryPreparation.boundedQueryCount) > Number(value.queryCount) ||
    !Number.isSafeInteger(value.queryPreparation.normalizedQueryCount) ||
    Number(value.queryPreparation.normalizedQueryCount) < 0 ||
    Number(value.queryPreparation.normalizedQueryCount) > Number(value.queryCount) ||
    value.queryPreparation.focusedRequestVersion !== null && (
      !Number.isSafeInteger(value.queryPreparation.focusedRequestVersion) ||
      Number(value.queryPreparation.focusedRequestVersion) < 1
    )) {
    throw new Error(frozenManifestCode);
  }
  const rerankerModelId = value.rerankerModelId;
  if (rerankerModelId !== null && (typeof rerankerModelId !== "string" ||
    rerankerModelId.length === 0)) {
    throw new Error(frozenManifestCode);
  }
  return Object.freeze({
    candidateLimits: decodeCandidateLimits(value.candidateLimits),
    chunkingProfile: requiredString(value.chunkingProfile, frozenManifestCode),
    configLabel: value.configLabel as KnowledgeConfigLabel,
    corpusContentSha256,
    datasetSources,
    docFormatVersion: Number(value.docFormatVersion),
    embeddingDimension: Number(value.embeddingDimension),
    embeddingFormatterVersion: requiredString(
      value.embeddingFormatterVersion,
      frozenManifestCode
    ),
    embeddingModelId: requiredString(value.embeddingModelId, frozenManifestCode),
    excludedQueryCount: Number(value.excludedQueryCount),
    indexProfile: requiredString(value.indexProfile, frozenManifestCode),
    queryCount: Number(value.queryCount),
    queryInstructionVersion: requiredString(
      value.queryInstructionVersion,
      frozenManifestCode
    ),
    queryPreparation: Object.freeze({
      boundedQueryCount: Number(value.queryPreparation.boundedQueryCount),
      focusedRequestVersion: value.queryPreparation.focusedRequestVersion === null
        ? null
        : Number(value.queryPreparation.focusedRequestVersion),
      normalizedQueryCount: Number(value.queryPreparation.normalizedQueryCount)
    }),
    querySetContentSha256,
    querySplit: requiredString(value.querySplit, frozenManifestCode),
    rankingProfile: requiredString(value.rankingProfile, frozenManifestCode),
    rerankerModelId: rerankerModelId as string | null,
    suiteId: value.suiteId as KnowledgeSuiteId,
    tokenizerFingerprint: requiredString(
      value.tokenizerFingerprint,
      frozenManifestCode
    )
  });
}

/** Identity of the frozen data side of a run: dataset id + revision + split
 * plus the normalized corpus content. Baseline-vs-candidate comparison is
 * admissible only when this fingerprint is identical. */
export function knowledgeDatasetFingerprint(
  manifest: KnowledgeFrozenRunManifest
): string {
  return sha256HexUtf8(canonicalJson({
    corpusContentSha256: manifest.corpusContentSha256,
    datasetSources: manifest.datasetSources,
    docFormatVersion: manifest.docFormatVersion,
    excludedQueryCount: manifest.excludedQueryCount,
    queryCount: manifest.queryCount,
    queryPreparation: manifest.queryPreparation,
    querySetContentSha256: manifest.querySetContentSha256,
    querySplit: manifest.querySplit,
    suiteId: manifest.suiteId
  }));
}

/** Identity of the declared retrieval configuration: the §13 label plus the
 * complete pipeline identity that label owns (embedding, formatter, query
 * instruction, tokenizer, chunking, index, ranking, candidate limits, and
 * reranker). Two runs under one label must agree on all of it. */
export function knowledgeConfigFingerprint(
  manifest: KnowledgeFrozenRunManifest
): string {
  return sha256HexUtf8(canonicalJson({
    candidateLimits: manifest.candidateLimits,
    chunkingProfile: manifest.chunkingProfile,
    configLabel: manifest.configLabel,
    embeddingDimension: manifest.embeddingDimension,
    embeddingFormatterVersion: manifest.embeddingFormatterVersion,
    embeddingModelId: manifest.embeddingModelId,
    indexProfile: manifest.indexProfile,
    queryInstructionVersion: manifest.queryInstructionVersion,
    rankingProfile: manifest.rankingProfile,
    rerankerModelId: manifest.rerankerModelId,
    tokenizerFingerprint: manifest.tokenizerFingerprint
  }));
}

export function knowledgeRunManifestFingerprint(
  manifest: KnowledgeFrozenRunManifest
): string {
  return sha256HexUtf8(canonicalJson({
    config: knowledgeConfigFingerprint(manifest),
    dataset: knowledgeDatasetFingerprint(manifest)
  }));
}

/** Comparison guard: scores from different frozen manifests must never be
 * merged. A baseline-vs-candidate pair is admissible only when the entire
 * dataset fingerprint (dataset id + revision + split + corpus content +
 * embedding/chunking/index identity) is identical and only the declared
 * configuration label differs. */
export function assertComparableKnowledgeRuns(
  baseline: KnowledgeFrozenRunManifest,
  candidate: KnowledgeFrozenRunManifest
): void {
  if (knowledgeDatasetFingerprint(baseline) !==
    knowledgeDatasetFingerprint(candidate)) {
    throw new Error("knowledge_benchmark_runs_not_comparable");
  }
  if (baseline.configLabel === candidate.configLabel &&
    knowledgeConfigFingerprint(baseline) !==
      knowledgeConfigFingerprint(candidate)) {
    throw new Error("knowledge_benchmark_config_label_ambiguous");
  }
  if (baseline.configLabel === candidate.configLabel) {
    throw new Error("knowledge_benchmark_runs_same_config");
  }
}

/** Anti-gaming guard (§15): one global ranking profile for every suite. The
 * two per-suite manifests of one configuration must agree on everything that
 * is not dataset identity. */
export function assertSingleGlobalRankingProfile(
  left: KnowledgeFrozenRunManifest,
  right: KnowledgeFrozenRunManifest
): void {
  if (left.suiteId === right.suiteId) {
    throw new Error("knowledge_benchmark_macro_same_suite");
  }
  if (knowledgeConfigFingerprint(left) !== knowledgeConfigFingerprint(right)) {
    throw new Error("knowledge_benchmark_ranking_profile_not_global");
  }
}

// ---------------------------------------------------------------------------
// Document-level ranking projection
// ---------------------------------------------------------------------------

export type KnowledgeRankedPassage = Readonly<{
  documentId: string;
  passageId: string;
  score: number;
}>;

/** Projects passage-level results onto a document ranking: each document is
 * ranked by its best passage score, with a deterministic tie-break on
 * (score desc, documentId asc, passageId asc). */
export function projectDocumentRanking(
  passages: readonly KnowledgeRankedPassage[]
): readonly string[] {
  const best = new Map<string, KnowledgeRankedPassage>();
  for (const passage of passages) {
    if (!Number.isFinite(passage.score)) {
      throw new Error("knowledge_benchmark_passage_score_invalid");
    }
    const current = best.get(passage.documentId);
    if (!current || passage.score > current.score ||
      (passage.score === current.score &&
        passage.passageId < current.passageId)) {
      best.set(passage.documentId, passage);
    }
  }
  return Object.freeze([...best.values()]
    .sort((left, right) =>
      right.score - left.score ||
      (left.documentId < right.documentId ? -1 :
        left.documentId > right.documentId ? 1 : 0) ||
      (left.passageId < right.passageId ? -1 :
        left.passageId > right.passageId ? 1 : 0))
    .map(({ documentId }) => documentId));
}

/** Expands ranked private source ids to official document ids. Byte-identical
 * corpus files settle onto one product Source ("reused"); such a source
 * expands to all of its official ids in sorted order at its rank. */
export function expandRankedDocuments(
  rankedSourceIds: readonly string[],
  officialIdsBySourceId: Readonly<Record<string, readonly string[]>>
): readonly string[] {
  const seen = new Set<string>();
  const expanded: string[] = [];
  for (const sourceId of rankedSourceIds) {
    const officialIds = officialIdsBySourceId[sourceId];
    if (!officialIds || officialIds.length === 0) {
      throw new Error("knowledge_benchmark_source_mapping_missing");
    }
    for (const id of [...officialIds].sort()) {
      if (seen.has(id)) {
        throw new Error("knowledge_benchmark_source_mapping_duplicate");
      }
      seen.add(id);
      expanded.push(id);
    }
  }
  return Object.freeze(expanded);
}

// ---------------------------------------------------------------------------
// Retrieval metrics (§12.1)
// ---------------------------------------------------------------------------

function relevantGains(
  relevant: Readonly<Record<string, number>>
): readonly number[] {
  const gains = Object.values(relevant).filter((gain) => gain > 0);
  return gains;
}

/** nDCG@k with the standard trec_eval definition:
 * DCG@k = Σ_{i=1..k} rel(d_i) / log2(i + 1); IDCG from the relevance gains
 * sorted descending; nDCG = DCG / IDCG, and 0 when there is no relevant
 * document. */
export function ndcgAtK(
  rankedDocumentIds: readonly string[],
  relevant: Readonly<Record<string, number>>,
  k: number
): number {
  if (!Number.isSafeInteger(k) || k < 1) {
    throw new Error("knowledge_benchmark_metric_k_invalid");
  }
  const ideal = [...relevantGains(relevant)].sort((left, right) => right - left);
  if (ideal.length === 0) return 0;
  let dcg = 0;
  rankedDocumentIds.slice(0, k).forEach((documentId, index) => {
    const gain = relevant[documentId] ?? 0;
    if (gain > 0) dcg += gain / Math.log2(index + 2);
  });
  let idcg = 0;
  ideal.slice(0, k).forEach((gain, index) => {
    idcg += gain / Math.log2(index + 2);
  });
  return idcg === 0 ? 0 : dcg / idcg;
}

/** Recall@k = |relevant ∩ top-k| / |relevant|. */
export function recallAtK(
  rankedDocumentIds: readonly string[],
  relevant: Readonly<Record<string, number>>,
  k: number
): number {
  if (!Number.isSafeInteger(k) || k < 1) {
    throw new Error("knowledge_benchmark_metric_k_invalid");
  }
  const total = relevantGains(relevant).length;
  if (total === 0) return 0;
  const found = rankedDocumentIds.slice(0, k)
    .filter((documentId) => (relevant[documentId] ?? 0) > 0).length;
  return found / total;
}

/** MRR@k = 1 / rank of the first relevant document within the top k, else 0. */
export function mrrAtK(
  rankedDocumentIds: readonly string[],
  relevant: Readonly<Record<string, number>>,
  k: number
): number {
  if (!Number.isSafeInteger(k) || k < 1) {
    throw new Error("knowledge_benchmark_metric_k_invalid");
  }
  const index = rankedDocumentIds.slice(0, k)
    .findIndex((documentId) => (relevant[documentId] ?? 0) > 0);
  return index < 0 ? 0 : 1 / (index + 1);
}

/** Exact relevant-document hit: every officially relevant document appears
 * somewhere in the returned ranking. */
export function exactRelevantDocumentHit(
  rankedDocumentIds: readonly string[],
  relevant: Readonly<Record<string, number>>
): boolean {
  const returned = new Set(rankedDocumentIds);
  const ids = Object.entries(relevant)
    .filter(([, gain]) => gain > 0)
    .map(([documentId]) => documentId);
  return ids.length > 0 && ids.every((documentId) => returned.has(documentId));
}

/** Nearest-rank percentile on a non-empty list (p in [0, 100]). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0 || !Number.isFinite(p) || p < 0 || p > 100) {
    throw new Error("knowledge_benchmark_percentile_invalid");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

export type KnowledgeUsageTotals = Readonly<{
  costMicros: number | null;
  requests: number;
  tokens: number;
}>;

export type KnowledgeQueryOutcome = Readonly<{
  candidatesAfterRerank: number;
  candidatesBeforeRerank: number;
  embeddingUsage: KnowledgeUsageTotals;
  queryId: string;
  rankedDocumentIds: readonly string[];
  relevant: Readonly<Record<string, number>>;
  rerankApplied: boolean;
  rerankFallback: boolean;
  rerankMs: number | null;
  rerankerUsage: KnowledgeUsageTotals;
  retrievalMs: number;
}>;

export type KnowledgeSuiteMetrics = Readonly<{
  exactRelevantHitRate: number;
  meanCandidatesAfterRerank: number;
  meanCandidatesBeforeRerank: number;
  mrr10: number;
  ndcg10: number;
  queryCount: number;
  recall10: number;
  recall50: number;
  rerankFallbackRate: number;
  rerankMsP50: number | null;
  rerankMsP95: number | null;
  retrievalMsP50: number;
  retrievalMsP95: number;
  usage: Readonly<{
    embedding: KnowledgeUsageTotals;
    reranker: KnowledgeUsageTotals;
  }>;
}>;

function addUsage(
  left: KnowledgeUsageTotals,
  right: KnowledgeUsageTotals
): KnowledgeUsageTotals {
  return Object.freeze({
    costMicros: left.costMicros === null && right.costMicros === null
      ? null
      : (left.costMicros ?? 0) + (right.costMicros ?? 0),
    requests: left.requests + right.requests,
    tokens: left.tokens + right.tokens
  });
}

const emptyUsage: KnowledgeUsageTotals = Object.freeze({
  costMicros: null,
  requests: 0,
  tokens: 0
});

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function aggregateKnowledgeSuiteMetrics(
  outcomes: readonly KnowledgeQueryOutcome[]
): KnowledgeSuiteMetrics {
  if (outcomes.length === 0) {
    throw new Error("knowledge_benchmark_no_query_outcomes");
  }
  if (new Set(outcomes.map(({ queryId }) => queryId)).size !== outcomes.length) {
    throw new Error("knowledge_benchmark_query_outcomes_duplicate");
  }
  const rerankDurations = outcomes
    .map(({ rerankMs }) => rerankMs)
    .filter((value): value is number => value !== null);
  return Object.freeze({
    exactRelevantHitRate: mean(outcomes.map((outcome) =>
      exactRelevantDocumentHit(outcome.rankedDocumentIds, outcome.relevant)
        ? 1
        : 0)),
    meanCandidatesAfterRerank: mean(outcomes.map(
      ({ candidatesAfterRerank }) => candidatesAfterRerank)),
    meanCandidatesBeforeRerank: mean(outcomes.map(
      ({ candidatesBeforeRerank }) => candidatesBeforeRerank)),
    mrr10: mean(outcomes.map((outcome) =>
      mrrAtK(outcome.rankedDocumentIds, outcome.relevant, 10))),
    ndcg10: mean(outcomes.map((outcome) =>
      ndcgAtK(outcome.rankedDocumentIds, outcome.relevant, 10))),
    queryCount: outcomes.length,
    recall10: mean(outcomes.map((outcome) =>
      recallAtK(outcome.rankedDocumentIds, outcome.relevant, 10))),
    recall50: mean(outcomes.map((outcome) =>
      recallAtK(outcome.rankedDocumentIds, outcome.relevant, 50))),
    rerankFallbackRate: mean(outcomes.map(({ rerankFallback }) =>
      rerankFallback ? 1 : 0)),
    rerankMsP50: rerankDurations.length === 0
      ? null
      : percentile(rerankDurations, 50),
    rerankMsP95: rerankDurations.length === 0
      ? null
      : percentile(rerankDurations, 95),
    retrievalMsP50: percentile(outcomes.map(({ retrievalMs }) => retrievalMs), 50),
    retrievalMsP95: percentile(outcomes.map(({ retrievalMs }) => retrievalMs), 95),
    usage: Object.freeze({
      embedding: outcomes.reduce(
        (total, { embeddingUsage }) => addUsage(total, embeddingUsage),
        emptyUsage
      ),
      reranker: outcomes.reduce(
        (total, { rerankerUsage }) => addUsage(total, rerankerUsage),
        emptyUsage
      )
    })
  });
}

export type KnowledgeMacroMetrics = Readonly<{
  exactRelevantHitRate: number;
  mrr10: number;
  ndcg10: number;
  recall10: number;
  recall50: number;
  rerankFallbackRate: number;
  suiteCount: number;
  usage: Readonly<{
    embedding: KnowledgeUsageTotals;
    reranker: KnowledgeUsageTotals;
  }>;
}>;

/** Macro aggregate of the two public suites: the unweighted mean of each
 * per-suite quality metric (usage/cost totals are summed; duration
 * percentiles stay per-suite). */
export function macroKnowledgeAggregate(
  suites: readonly KnowledgeSuiteMetrics[]
): KnowledgeMacroMetrics {
  if (suites.length < 2) {
    throw new Error("knowledge_benchmark_macro_requires_two_suites");
  }
  return Object.freeze({
    exactRelevantHitRate: mean(suites.map(
      ({ exactRelevantHitRate }) => exactRelevantHitRate)),
    mrr10: mean(suites.map(({ mrr10 }) => mrr10)),
    ndcg10: mean(suites.map(({ ndcg10 }) => ndcg10)),
    recall10: mean(suites.map(({ recall10 }) => recall10)),
    recall50: mean(suites.map(({ recall50 }) => recall50)),
    rerankFallbackRate: mean(suites.map(
      ({ rerankFallbackRate }) => rerankFallbackRate)),
    suiteCount: suites.length,
    usage: Object.freeze({
      embedding: suites.reduce(
        (total, { usage }) => addUsage(total, usage.embedding),
        emptyUsage
      ),
      reranker: suites.reduce(
        (total, { usage }) => addUsage(total, usage.reranker),
        emptyUsage
      )
    })
  });
}

// ---------------------------------------------------------------------------
// Run summaries and comparison (§14.1 gate arithmetic)
// ---------------------------------------------------------------------------

export type KnowledgeRunSummary = Readonly<{
  configLabel: KnowledgeConfigLabel;
  createdAt: string;
  datasetFingerprint: string;
  manifest: KnowledgeFrozenRunManifest;
  manifestFingerprint: string;
  metrics: KnowledgeSuiteMetrics;
  resultLabel: string;
  runId: string;
  schemaVersion: number;
}>;

function decodeUsageTotals(value: unknown): KnowledgeUsageTotals {
  const code = "knowledge_benchmark_summary_invalid";
  if (!isRecord(value)) throw new Error(code);
  const costMicros = value.costMicros;
  if (costMicros !== null && typeof costMicros !== "number") {
    throw new Error(code);
  }
  if (typeof value.requests !== "number" || typeof value.tokens !== "number") {
    throw new Error(code);
  }
  return Object.freeze({
    costMicros: costMicros as number | null,
    requests: value.requests,
    tokens: value.tokens
  });
}

function decodeSuiteMetrics(value: unknown): KnowledgeSuiteMetrics {
  const code = "knowledge_benchmark_summary_invalid";
  if (!isRecord(value) || !isRecord(value.usage)) throw new Error(code);
  const finiteNumber = (candidate: unknown): number => {
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
      throw new Error(code);
    }
    return candidate;
  };
  const optionalNumber = (candidate: unknown): number | null =>
    candidate === null ? null : finiteNumber(candidate);
  return Object.freeze({
    exactRelevantHitRate: finiteNumber(value.exactRelevantHitRate),
    meanCandidatesAfterRerank: finiteNumber(value.meanCandidatesAfterRerank),
    meanCandidatesBeforeRerank: finiteNumber(value.meanCandidatesBeforeRerank),
    mrr10: finiteNumber(value.mrr10),
    ndcg10: finiteNumber(value.ndcg10),
    queryCount: finiteNumber(value.queryCount),
    recall10: finiteNumber(value.recall10),
    recall50: finiteNumber(value.recall50),
    rerankFallbackRate: finiteNumber(value.rerankFallbackRate),
    rerankMsP50: optionalNumber(value.rerankMsP50),
    rerankMsP95: optionalNumber(value.rerankMsP95),
    retrievalMsP50: finiteNumber(value.retrievalMsP50),
    retrievalMsP95: finiteNumber(value.retrievalMsP95),
    usage: Object.freeze({
      embedding: decodeUsageTotals(value.usage.embedding),
      reranker: decodeUsageTotals(value.usage.reranker)
    })
  });
}

export function decodeKnowledgeRunSummary(value: unknown): KnowledgeRunSummary {
  const code = "knowledge_benchmark_summary_invalid";
  if (!isRecord(value) ||
    value.schemaVersion !== KNOWLEDGE_BENCHMARK_SUMMARY_SCHEMA_VERSION) {
    throw new Error(code);
  }
  const manifest = decodeKnowledgeFrozenRunManifest(value.manifest);
  const summary = Object.freeze({
    configLabel: manifest.configLabel,
    createdAt: requiredString(value.createdAt, code),
    datasetFingerprint: knowledgeDatasetFingerprint(manifest),
    manifest,
    manifestFingerprint: knowledgeRunManifestFingerprint(manifest),
    metrics: decodeSuiteMetrics(value.metrics),
    resultLabel: requiredString(value.resultLabel, code),
    runId: requiredString(value.runId, code),
    schemaVersion: KNOWLEDGE_BENCHMARK_SUMMARY_SCHEMA_VERSION
  });
  // A summary edited to claim a different identity than its frozen manifest
  // is refused rather than trusted.
  if (requiredString(value.datasetFingerprint, code) !== summary.datasetFingerprint ||
    requiredString(value.manifestFingerprint, code) !== summary.manifestFingerprint ||
    value.configLabel !== manifest.configLabel) {
    throw new Error("knowledge_benchmark_summary_fingerprint_mismatch");
  }
  return summary;
}

export type KnowledgeSuiteComparison = Readonly<{
  baseline: KnowledgeSuiteMetrics;
  candidate: KnowledgeSuiteMetrics;
  /** Absolute deltas in percentage points for rate metrics. */
  deltaPp: Readonly<{
    exactRelevantHitRate: number;
    mrr10: number;
    ndcg10: number;
    recall10: number;
    recall50: number;
  }>;
  ndcg10RegressionWithinBound: boolean;
  recall50RegressionWithinBound: boolean;
  resultLabel: string;
  suiteId: KnowledgeSuiteId;
}>;

export type KnowledgeComparison = Readonly<{
  baselineConfig: KnowledgeConfigLabel;
  candidateConfig: KnowledgeConfigLabel;
  gate: Readonly<{
    macroNdcg10ImprovedAtLeast5PercentRelative: boolean | null;
    noSuiteNdcg10RegressionOver1Pp: boolean;
    noSuiteRecall50RegressionOver1Pp: boolean;
  }>;
  macro: Readonly<{
    baselineNdcg10: number;
    candidateNdcg10: number;
    deltaPp: number;
    relativeDelta: number | null;
  }> | null;
  suites: readonly KnowledgeSuiteComparison[];
}>;

const PP = 100;

/** Compares one baseline configuration against one candidate configuration.
 * Every baseline/candidate pair must share the per-suite dataset fingerprint
 * and differ only in the declared configuration label; the macro gate needs
 * both suites on both sides. */
export function compareKnowledgeRuns(
  baselines: readonly KnowledgeRunSummary[],
  candidates: readonly KnowledgeRunSummary[]
): KnowledgeComparison {
  if (baselines.length === 0 || candidates.length === 0) {
    throw new Error("knowledge_benchmark_comparison_empty");
  }
  const label = (summaries: readonly KnowledgeRunSummary[]):
    KnowledgeConfigLabel => {
    const labels = new Set(summaries.map(({ configLabel }) => configLabel));
    if (labels.size !== 1) {
      throw new Error("knowledge_benchmark_comparison_mixed_config");
    }
    return summaries[0]!.configLabel;
  };
  const baselineConfig = label(baselines);
  const candidateConfig = label(candidates);
  const uniqueSuites = (summaries: readonly KnowledgeRunSummary[]): void => {
    if (new Set(summaries.map(({ manifest }) => manifest.suiteId)).size !==
      summaries.length) {
      throw new Error("knowledge_benchmark_comparison_duplicate_suite");
    }
  };
  uniqueSuites(baselines);
  uniqueSuites(candidates);
  if (baselines.length === 2) {
    assertSingleGlobalRankingProfile(baselines[0]!.manifest, baselines[1]!.manifest);
  }
  if (candidates.length === 2) {
    assertSingleGlobalRankingProfile(candidates[0]!.manifest, candidates[1]!.manifest);
  }
  const suites: KnowledgeSuiteComparison[] = [];
  for (const baseline of [...baselines].sort((left, right) =>
    left.manifest.suiteId < right.manifest.suiteId ? -1 : 1)) {
    const candidate = candidates.find(({ manifest }) =>
      manifest.suiteId === baseline.manifest.suiteId);
    if (!candidate) {
      throw new Error("knowledge_benchmark_comparison_suite_missing");
    }
    assertComparableKnowledgeRuns(baseline.manifest, candidate.manifest);
    const deltaPp = Object.freeze({
      exactRelevantHitRate: (candidate.metrics.exactRelevantHitRate -
        baseline.metrics.exactRelevantHitRate) * PP,
      mrr10: (candidate.metrics.mrr10 - baseline.metrics.mrr10) * PP,
      ndcg10: (candidate.metrics.ndcg10 - baseline.metrics.ndcg10) * PP,
      recall10: (candidate.metrics.recall10 - baseline.metrics.recall10) * PP,
      recall50: (candidate.metrics.recall50 - baseline.metrics.recall50) * PP
    });
    suites.push(Object.freeze({
      baseline: baseline.metrics,
      candidate: candidate.metrics,
      deltaPp,
      ndcg10RegressionWithinBound: deltaPp.ndcg10 >= -1,
      recall50RegressionWithinBound: deltaPp.recall50 >= -1,
      resultLabel: baseline.resultLabel,
      suiteId: baseline.manifest.suiteId
    }));
  }
  const macroAvailable = suites.length >= 2;
  let macro: KnowledgeComparison["macro"] = null;
  if (macroAvailable) {
    const baselineNdcg10 = mean(suites.map(({ baseline }) => baseline.ndcg10));
    const candidateNdcg10 = mean(suites.map(({ candidate }) => candidate.ndcg10));
    macro = Object.freeze({
      baselineNdcg10,
      candidateNdcg10,
      deltaPp: (candidateNdcg10 - baselineNdcg10) * PP,
      relativeDelta: baselineNdcg10 === 0
        ? null
        : (candidateNdcg10 - baselineNdcg10) / baselineNdcg10
    });
  }
  return Object.freeze({
    baselineConfig,
    candidateConfig,
    gate: Object.freeze({
      macroNdcg10ImprovedAtLeast5PercentRelative:
        macro === null || macro.relativeDelta === null
          ? null
          : macro.relativeDelta >= 0.05,
      noSuiteNdcg10RegressionOver1Pp: suites.every(
        ({ ndcg10RegressionWithinBound }) => ndcg10RegressionWithinBound),
      noSuiteRecall50RegressionOver1Pp: suites.every(
        ({ recall50RegressionWithinBound }) => recall50RegressionWithinBound)
    }),
    macro,
    suites: Object.freeze(suites)
  });
}

// ---------------------------------------------------------------------------
// Caching (§11.8)
// ---------------------------------------------------------------------------

/** Cache keys are hex digests of a canonical JSON record, so no query or
 * document text ever reaches a file name or console line. */
export function knowledgeBenchmarkCacheKey(
  parts: Readonly<Record<string, string | number | null>>
): string {
  return sha256HexUtf8(canonicalJson(parts));
}

/** Query embedding cache key with exactly the §11.8 fields: dataset id,
 * dataset revision, split, corpus content hash, embedding model, embedding
 * dimension, embedding formatter version, query instruction version,
 * tokenizer fingerprint, chunking profile, and index profile. The query text
 * itself is only ever present as a hash. */
export function queryEmbeddingCacheKey(
  manifest: KnowledgeFrozenRunManifest,
  queryText: string
): string {
  return knowledgeBenchmarkCacheKey({
    chunkingProfile: manifest.chunkingProfile,
    contentSha256: manifest.corpusContentSha256,
    datasetSources: canonicalJson(manifest.datasetSources),
    embeddingDimension: manifest.embeddingDimension,
    embeddingFormatterVersion: manifest.embeddingFormatterVersion,
    embeddingModelId: manifest.embeddingModelId,
    indexProfile: manifest.indexProfile,
    kind: "query_embedding",
    queryInstructionVersion: manifest.queryInstructionVersion,
    querySha256: sha256HexUtf8(queryText),
    querySplit: manifest.querySplit,
    tokenizerFingerprint: manifest.tokenizerFingerprint
  });
}

// ---------------------------------------------------------------------------
// Runner utilities
// ---------------------------------------------------------------------------

/** Runs bounded independent work concurrently while preserving input order.
 * On failure it stops admitting new work, waits for already-started work to
 * settle, and only then rejects so callers can safely clean up shared state. */
export async function mapConcurrentOrdered<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>
): Promise<readonly R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
    concurrency > KNOWLEDGE_BENCHMARK_MAX_CONCURRENCY) {
    throw new Error("knowledge_benchmark_concurrency_invalid");
  }
  if (items.length === 0) return Object.freeze([]);
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      try {
        results[index] = await operation(items[index]!, index);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    worker
  ));
  if (failed) throw firstError;
  return Object.freeze(results);
}

export type KnowledgeBenchmarkRequestPacer = Readonly<{
  /** Waits until the next globally admitted query start. */
  admit(): Promise<void>;
  /** Pushes the next admission into the future after a provider capacity signal. */
  defer(milliseconds: number): void;
}>;

/**
 * Serializes benchmark query admissions and keeps their starts separated.
 * Scheduling waits live outside per-query retrieval timing and never retry a
 * product operation. A 429 can defer future independent queries without
 * changing the already-settled deterministic fallback for the failed query.
 */
export function createKnowledgeBenchmarkRequestPacer(input: Readonly<{
  intervalMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}>): KnowledgeBenchmarkRequestPacer {
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 0 ||
    input.intervalMs > 600_000) {
    throw new Error("knowledge_benchmark_request_interval_invalid");
  }
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  let nextAdmissionAt = 0;
  let admissionTail = Promise.resolve();
  const admit = (): Promise<void> => {
    const admission = admissionTail.then(async () => {
      while (true) {
        const waitMs = Math.max(0, nextAdmissionAt - now());
        if (waitMs === 0) break;
        await sleep(waitMs);
      }
      nextAdmissionAt = now() + input.intervalMs;
    });
    admissionTail = admission.catch(() => undefined);
    return admission;
  };
  return Object.freeze({
    admit,
    defer(milliseconds: number): void {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 ||
        milliseconds > 3_600_000) {
        throw new Error("knowledge_benchmark_rate_limit_cooldown_invalid");
      }
      nextAdmissionAt = Math.max(nextAdmissionAt, now() + milliseconds);
    }
  });
}

/** Explicit paid-work acknowledgement: any command that can trigger paid
 * embedding or reranker traffic against the disposable stack refuses to run
 * without AIQSA_KNOWLEDGE_BENCHMARK_ACK=DISPOSABLE_PAID_KB. */
export function assertKnowledgeBenchmarkAck(
  env: Readonly<Record<string, string | undefined>>
): void {
  if (env[KNOWLEDGE_BENCHMARK_ACK_ENV] !== KNOWLEDGE_BENCHMARK_ACK_VALUE) {
    throw new Error("knowledge_benchmark_ack_required");
  }
}

export function assertKnowledgeBenchmarkBaseUrl(
  value: string,
  expectedPort: number
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("knowledge_benchmark_base_url_invalid");
  }
  if (parsed.protocol !== "http:" || !loopbackHosts.has(parsed.hostname) ||
    parsed.username || parsed.password || parsed.pathname !== "/" ||
    parsed.search || parsed.hash || parsed.port !== String(expectedPort) ||
    expectedPort === 3000) {
    throw new Error("knowledge_benchmark_base_url_not_isolated");
  }
  return parsed;
}

export function assertKnowledgeBenchmarkDatabaseUrl(
  value: string,
  options?: Readonly<{ allowContainerHost?: boolean }>
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("knowledge_benchmark_database_url_invalid");
  }
  const queryKeys = [...parsed.searchParams.keys()];
  const hostAllowed = loopbackHosts.has(parsed.hostname) ||
    (options?.allowContainerHost === true && parsed.hostname === "postgres");
  const portAllowed = loopbackHosts.has(parsed.hostname)
    ? parsed.port === String(KNOWLEDGE_BENCHMARK_POSTGRES_PORT)
    : parsed.port === "5432";
  if (parsed.protocol !== "postgresql:" || !hostAllowed || !portAllowed ||
    parsed.username !== "aiqsa_benchmark" ||
    parsed.password !== "aiqsa-knowledge-benchmark-dev-password" ||
    parsed.pathname !== "/aiqsa_knowledge_benchmark" ||
    queryKeys.length !== 1 || queryKeys[0] !== "schema" ||
    parsed.searchParams.get("schema") !== "public" || parsed.hash) {
    throw new Error("knowledge_benchmark_database_url_not_isolated");
  }
  return parsed;
}

export function resolveKnowledgeBenchmarkOutputDirectory(
  benchmarkRoot: string,
  candidate: string
): string {
  const resultsRoot = resolve(benchmarkRoot, "results");
  const output = resolve(benchmarkRoot, candidate);
  if (output === resultsRoot || !output.startsWith(`${resultsRoot}${sep}`)) {
    throw new Error("knowledge_benchmark_output_directory_not_isolated");
  }
  return output;
}

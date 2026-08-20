import type {
  KnowledgeExactEntryKind,
  KnowledgeLexicalLanguage
} from "./hierarchicalIndex";
import type {
  KnowledgeExactSearchField,
  KnowledgeSourceDiscoveryField
} from "./retrievalTypes";

export const KNOWLEDGE_HIERARCHICAL_QUERY_MAX_CHARACTERS = 500;
export const KNOWLEDGE_HIERARCHICAL_SCOPE_MAX_ARTIFACTS = 999;
export const KNOWLEDGE_HIERARCHICAL_RESULT_LIMIT_MAX = 100;
export const KNOWLEDGE_EXACT_REGEX_MAX_CHARACTERS = 128;
export const KNOWLEDGE_EXACT_SCAN_MAX_BYTES = 4 * 1024 * 1024;
export const KNOWLEDGE_EXACT_CURSOR_MAX_OFFSET = 10_000;

export type KnowledgeOwnerHierarchicalScope = Readonly<{
  ownerUserId: string;
  scopeKind?: "owner";
  sourceArtifactIds: readonly string[];
}>;

export type KnowledgeAdmittedRunHierarchicalScope = Readonly<{
  runId: string;
  scopeKind: "admitted_run";
  sourceArtifactIds: readonly string[];
  userId: string;
}>;

export type KnowledgeHierarchicalScope =
  | KnowledgeAdmittedRunHierarchicalScope
  | KnowledgeOwnerHierarchicalScope;

export type KnowledgeLexicalTargetLevel = "document" | "passage" | "section";
export type KnowledgeLexicalMatchedField =
  | "body"
  | "context"
  | "description"
  | "entities"
  | "filename"
  | "heading"
  | "keywords"
  | "source_name"
  | "summary"
  | "tags"
  | "title";

export type KnowledgeLexicalIndexHit = Readonly<{
  indexArtifactId: string;
  label: string;
  languageConfig: KnowledgeLexicalLanguage;
  level: KnowledgeLexicalTargetLevel;
  matchedFields: readonly KnowledgeLexicalMatchedField[];
  page: number | null;
  pageEnd: number | null;
  queryVariant: "english" | "russian" | "simple";
  rank: number;
  sourceArtifactId: string;
  targetId: string;
  text: string | null;
}>;

export type KnowledgeExactOperation = KnowledgeExactEntryKind | "phrase" | "regex" | "token";

export type KnowledgeExactIndexHit = Readonly<{
  field: Exclude<KnowledgeExactSearchField, "any">;
  indexArtifactId: string;
  kind: KnowledgeExactOperation;
  page: number | null;
  pageEnd: number | null;
  passageId: string | null;
  sectionId: string | null;
  sourceArtifactId: string;
  value: string;
}>;

export type KnowledgeExactSearchPage = Readonly<{
  nextCursor: string | null;
  results: readonly KnowledgeExactIndexHit[];
  scannedBytes: number;
  scanTruncated: boolean;
}>;

export type KnowledgeMetadataDiscoveryHit = Readonly<{
  indexArtifactId: string;
  kind: KnowledgeSourceDiscoveryField;
  similarity: number;
  sourceArtifactId: string;
  value: string;
}>;

export type KnowledgeSourceMetadataDiscoveryHit = Readonly<{
  indexArtifactId: string;
  matchedFields: readonly KnowledgeSourceDiscoveryField[];
  similarity: number;
  sourceArtifactId: string;
}>;

export type KnowledgeMetadataDiscoveryPage = Readonly<{
  nextCursor: string | null;
  results: readonly KnowledgeSourceMetadataDiscoveryHit[];
}>;

export type KnowledgeHierarchicalRetrievalRepository = Readonly<{
  discoverDocuments(input: KnowledgeHierarchicalScope & {
    limit: number;
    query: string;
  }): Promise<readonly KnowledgeLexicalIndexHit[]>;
  discoverMetadata(input: KnowledgeHierarchicalScope & {
    limit: number;
    query: string;
  }): Promise<readonly KnowledgeMetadataDiscoveryHit[]>;
  discoverSourceMetadata(input: KnowledgeHierarchicalScope & {
    cursor?: string;
    fields?: readonly KnowledgeSourceDiscoveryField[];
    limit: number;
    query: string;
  }): Promise<KnowledgeMetadataDiscoveryPage>;
  discoverSections(input: KnowledgeHierarchicalScope & {
    limit: number;
    query: string;
  }): Promise<readonly KnowledgeLexicalIndexHit[]>;
  findExact(input: KnowledgeHierarchicalScope & {
    caseSensitive?: boolean;
    cursor?: string;
    limit: number;
    field?: KnowledgeExactSearchField;
    operation: KnowledgeExactOperation;
    query: string;
  }): Promise<KnowledgeExactSearchPage>;
  searchPassages(input: KnowledgeHierarchicalScope & {
    limit: number;
    query: string;
  }): Promise<readonly KnowledgeLexicalIndexHit[]>;
}>;

export type KnowledgeHierarchicalQueryErrorCode =
  | "knowledge_exact_cursor_invalid"
  | "knowledge_exact_pattern_unsafe"
  | "knowledge_exact_query_timed_out"
  | "knowledge_index_query_invalid"
  | "knowledge_index_scope_invalid";

export class KnowledgeHierarchicalQueryError extends Error {
  constructor(readonly code: KnowledgeHierarchicalQueryErrorCode) {
    super(code);
    this.name = "KnowledgeHierarchicalQueryError";
  }
}

function normalizedInput(value: string, maximum: number): string {
  const normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) throw new KnowledgeHierarchicalQueryError("knowledge_index_query_invalid");
  return normalized;
}

export function decodeKnowledgeHierarchicalScope(
  input: KnowledgeHierarchicalScope
): KnowledgeHierarchicalScope {
  const sourceArtifactIds = [...new Set(input.sourceArtifactIds.map((value) => value.trim()))];
  if (
    sourceArtifactIds.length < 1 ||
    sourceArtifactIds.length > KNOWLEDGE_HIERARCHICAL_SCOPE_MAX_ARTIFACTS ||
    sourceArtifactIds.some((value) => !value || value.length > 256)
  ) throw new KnowledgeHierarchicalQueryError("knowledge_index_scope_invalid");
  if (input.scopeKind === "admitted_run") {
    const runId = input.runId.trim();
    const userId = input.userId.trim();
    if (!runId || runId.length > 256 || !userId || userId.length > 256) {
      throw new KnowledgeHierarchicalQueryError("knowledge_index_scope_invalid");
    }
    return Object.freeze({
      runId,
      scopeKind: "admitted_run" as const,
      sourceArtifactIds: Object.freeze(sourceArtifactIds),
      userId
    });
  }
  const ownerUserId = input.ownerUserId.trim();
  if (!ownerUserId || ownerUserId.length > 256) {
    throw new KnowledgeHierarchicalQueryError("knowledge_index_scope_invalid");
  }
  return Object.freeze({
    ownerUserId,
    sourceArtifactIds: Object.freeze(sourceArtifactIds)
  });
}

export function decodeKnowledgeHierarchicalQuery(query: string): string {
  return normalizedInput(query, KNOWLEDGE_HIERARCHICAL_QUERY_MAX_CHARACTERS);
}

export function decodeKnowledgeHierarchicalLimit(limit: number): number {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > KNOWLEDGE_HIERARCHICAL_RESULT_LIMIT_MAX
  ) throw new KnowledgeHierarchicalQueryError("knowledge_index_query_invalid");
  return limit;
}

function quantifiedGroup(pattern: string): boolean {
  return /\((?:[^()\\]|\\.)*(?:[*+?]|\{\d+(?:,\d*)?\})(?:[^()\\]|\\.)*\)(?:[*+?]|\{\d)/u
    .test(pattern);
}

function excessiveQuantifier(pattern: string): boolean {
  for (const match of pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/gu)) {
    const minimum = Number(match[1]);
    const maximum = match[2] === undefined || match[2] === "" ? minimum : Number(match[2]);
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) ||
      minimum > 256 || maximum > 256 || maximum < minimum) return true;
  }
  return false;
}

function nestingDepth(pattern: string): number {
  let depth = 0;
  let maximum = 0;
  let escaped = false;
  let characterClass = false;
  for (const character of pattern) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") characterClass = true;
    if (character === "]") characterClass = false;
    if (characterClass) continue;
    if (character === "(") maximum = Math.max(maximum, ++depth);
    if (character === ")") depth -= 1;
    if (depth < 0) return Number.MAX_SAFE_INTEGER;
  }
  return depth === 0 && !characterClass ? maximum : Number.MAX_SAFE_INTEGER;
}

export function decodeKnowledgeSafeRegex(pattern: string): string {
  const normalized = normalizedInput(pattern, KNOWLEDGE_EXACT_REGEX_MAX_CHARACTERS);
  const literalCharacters = normalized.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (
    literalCharacters < 2 ||
    normalized.split("|").length > 16 ||
    nestingDepth(normalized) > 4 ||
    /\(\?/u.test(normalized) ||
    /\\[1-9]/u.test(normalized) ||
    /\.\*[+?]?|\.\+[+?]?/u.test(normalized) ||
    /(?:[*+?]|\{\d+(?:,\d*)?\}){2}/u.test(normalized) ||
    quantifiedGroup(normalized) ||
    excessiveQuantifier(normalized)
  ) throw new KnowledgeHierarchicalQueryError("knowledge_exact_pattern_unsafe");
  try {
    new RegExp(normalized, "u");
  } catch {
    throw new KnowledgeHierarchicalQueryError("knowledge_exact_pattern_unsafe");
  }
  return normalized;
}

export function encodeKnowledgeExactCursor(offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > KNOWLEDGE_EXACT_CURSOR_MAX_OFFSET) {
    throw new KnowledgeHierarchicalQueryError("knowledge_exact_cursor_invalid");
  }
  return Buffer.from(`1:${offset}`, "utf8").toString("base64url");
}

export function decodeKnowledgeExactCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!cursor || cursor.length > 64 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw new KnowledgeHierarchicalQueryError("knowledge_exact_cursor_invalid");
  }
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new KnowledgeHierarchicalQueryError("knowledge_exact_cursor_invalid");
  }
  const match = /^1:(0|[1-9]\d*)$/u.exec(decoded);
  const offset = match ? Number(match[1]) : Number.NaN;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > KNOWLEDGE_EXACT_CURSOR_MAX_OFFSET ||
    encodeKnowledgeExactCursor(offset) !== cursor
  ) throw new KnowledgeHierarchicalQueryError("knowledge_exact_cursor_invalid");
  return offset;
}

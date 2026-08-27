import { createHash } from "node:crypto";
import type { KnowledgeChunkLayoutKind, KnowledgeChunkPlanEntry } from "./chunking";
import {
  decodeKnowledgeDocumentContext,
  type KnowledgeDocumentContextV1
} from "./documentContext";
import type { StoredKnowledgeNormalizedDocument } from "./normalizedDocument";

/**
 * Version 4 is the language-neutral lexical derivation: no per-language
 * routing metadata, no stopword dictionaries, no heuristic frequency
 * keywords. Version-3 rows built before the cutover stay readable and
 * retrievable until their artifacts are superseded through the normal safe
 * profile reindex; retrieval selects exactly one ready index per artifact,
 * preferring the highest compatible version.
 */
export const KNOWLEDGE_HIERARCHICAL_INDEX_VERSION = 4;
export const KNOWLEDGE_HIERARCHICAL_COMPATIBLE_INDEX_VERSIONS =
  Object.freeze([3, KNOWLEDGE_HIERARCHICAL_INDEX_VERSION] as const);
export const KNOWLEDGE_HIERARCHICAL_MAX_EXACT_ENTRIES = 10_000;
export const KNOWLEDGE_HIERARCHICAL_MAX_EXACT_ENTRIES_PER_PASSAGE = 50;
export const KNOWLEDGE_EXACT_QUERY_MAX_VALUES = 64;
export const KNOWLEDGE_DOCUMENT_CONTEXT_MAX_BYTES = 256 * 1_024;

const MAX_SUMMARY_CHARACTERS = 4_000;
const MAX_METADATA_CHARACTERS = 16_384;
const MAX_ENTITIES = 64;
const MAX_TAGS = 64;

export type KnowledgeExactEntryKind =
  | "date"
  | "filename"
  | "heading"
  | "identifier"
  | "number"
  | "tag"
  | "title";

export type KnowledgeHierarchicalDocumentPlan = Readonly<{
  contentHash: string;
  description: string;
  documentType: string;
  entities: readonly string[];
  fileName: string;
  /** Parser-provided language hints; display/diagnostics only, never routing. */
  languages: readonly string[];
  metadataText: string;
  outline: readonly string[];
  pageCount: number;
  sourceName: string;
  summary: string;
  tags: readonly string[];
  title: string | null;
}>;

export type KnowledgeHierarchicalSectionPlan = Readonly<{
  contentHash: string;
  entities: readonly string[];
  headingPath: readonly string[];
  id: string;
  label: string;
  /** Parser-provided language hints; display/diagnostics only, never routing. */
  languages: readonly string[];
  ordinal: number;
  page: number;
  pageEnd: number;
  passageEnd: number;
  passageStart: number;
  summary: string;
}>;

export type KnowledgeHierarchicalPassagePlan = Readonly<{
  contentHash: string;
  contextPrefix: string;
  documentContext: KnowledgeDocumentContextV1 | null;
  embeddingTextHash: string;
  headingPath: readonly string[];
  id: string;
  /** Parser-provided language hints; display/diagnostics only, never routing. */
  languages: readonly string[];
  /** Structured layout identity persisted on the passage row (FR-12). */
  layoutKind: KnowledgeChunkLayoutKind;
  ordinal: number;
  page: number;
  pageEnd: number;
  sectionId: string;
  sourceBlockEnd: number;
  sourceBlockIds: readonly string[];
  sourceBlockStart: number;
  text: string;
  tokenCount: number;
}>;

export type KnowledgeHierarchicalExactEntryPlan = Readonly<{
  id: string;
  kind: KnowledgeExactEntryKind;
  normalizedValue: string;
  ordinal: number;
  page: number | null;
  pageEnd: number | null;
  passageId: string | null;
  sectionId: string | null;
  value: string;
  valueHash: string;
}>;

export type KnowledgeHierarchicalIndexPlan = Readonly<{
  checksum: string;
  derivationMode: "legacy_chunks" | "normalized_v2";
  document: KnowledgeHierarchicalDocumentPlan;
  exactEntries: readonly KnowledgeHierarchicalExactEntryPlan[];
  exactIndex: Readonly<{
    candidateCount: number;
    retainedCount: number;
    truncated: boolean;
  }>;
  id: string;
  passages: readonly KnowledgeHierarchicalPassagePlan[];
  schemaVersion: typeof KNOWLEDGE_HIERARCHICAL_INDEX_VERSION;
  sections: readonly KnowledgeHierarchicalSectionPlan[];
  sourceArtifactId: string;
}>;

export type KnowledgeHierarchicalIndexErrorCode =
  | "knowledge_hierarchical_exact_entry_limit_exceeded"
  | "knowledge_hierarchical_index_input_invalid";

export class KnowledgeHierarchicalIndexError extends Error {
  constructor(readonly code: KnowledgeHierarchicalIndexErrorCode) {
    super(code);
    this.name = "KnowledgeHierarchicalIndexError";
  }
}

function sha256(...values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values) hash.update(value, "utf8").update("\0", "utf8");
  return hash.digest("hex");
}

function stableId(prefix: string, ...values: readonly string[]): string {
  return `${prefix}_${sha256(...values).slice(0, 40)}`;
}

/**
 * Language-neutral Unicode hygiene: invisible format characters (zero-width
 * spaces/joiners, bidi controls, BOM, soft hyphen — \p{Cf}) are removed so
 * hidden controls cannot split or shadow an exact value, and every control
 * character (\p{Cc}, including C1) becomes ordinary whitespace. Data-type
 * validation only — never a natural-language assumption.
 */
function compactText(value: string, maximum = Number.MAX_SAFE_INTEGER): string {
  return value
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function boundedSummary(values: readonly string[]): string {
  return compactText(values.filter(Boolean).join(" "), MAX_SUMMARY_CHARACTERS);
}

function uniqueBounded(values: readonly string[], maximum: number, itemMaximum = 256): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of values) {
    const value = compactText(candidate, itemMaximum);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= maximum) break;
  }
  return result;
}

/**
 * FR-10 decision: heuristic frequency keywords were removed from ranking
 * signals entirely instead of re-deriving them without stopword dictionaries.
 * Their only ranking consumers were the B-weighted document/section FTS text
 * and the metadata text, where a language-neutral top-by-frequency list
 * degenerates into function words for every language; the full body text is
 * already lexically indexed, and titles, filenames, headings, tags, and typed
 * entities remain first-class signals.
 */
function words(value: string): string[] {
  return value.normalize("NFKC").match(/[\p{L}\p{M}\p{N}_-]+/gu) ?? [];
}

function entities(value: string): string[] {
  return uniqueBounded(words(value).filter((word) =>
    word.length >= 2 && (
      /[\p{L}]/u.test(word) && /\d/u.test(word) ||
      /^\p{Lu}[\p{L}\p{M}-]+$/u.test(word) ||
      /^(?=.*\p{L})[\p{Lu}\d_-]{3,}$/u.test(word)
    )
  ), MAX_ENTITIES, 128);
}

/** Bounded BCP-47-shaped parser hints; display/diagnostics only, never used
 * to select an FTS configuration, retriever, threshold, or chunker. */
function canonicalLanguages(values: readonly string[]): string[] {
  return uniqueBounded(values.map((value) => value.toLowerCase()), 16, 32)
    .filter((value) => /^[a-z]{2,8}(?:-[a-z0-9]{1,8}){0,2}$/u.test(value))
    .sort((left, right) => left.localeCompare(right, "und"));
}

export function knowledgeExactNormalizedValue(value: string): string {
  return compactText(value, 512).toLocaleLowerCase("und");
}

export function knowledgeHierarchicalIndexArtifactId(sourceArtifactId: string): string {
  return stableId(
    "khi",
    sourceArtifactId,
    String(KNOWLEDGE_HIERARCHICAL_INDEX_VERSION)
  );
}

const chunkLayoutKinds = new Set<KnowledgeChunkLayoutKind>([
  "body",
  "field_ambiguous",
  "field_pair",
  "table_ambiguous",
  "table_row",
  "table_row_projection"
]);

function assertChunks(chunks: readonly KnowledgeChunkPlanEntry[]): void {
  if (
    chunks.length < 1 ||
    chunks.some((chunk, index) =>
      chunk.index !== index ||
      !chunk.text.trim() ||
      !chunkLayoutKinds.has(chunk.layoutKind) ||
      !Number.isSafeInteger(chunk.page) || chunk.page < 1 ||
      !Number.isSafeInteger(chunk.pageEnd) || chunk.pageEnd < chunk.page ||
      !Number.isSafeInteger(chunk.sourceBlockStart) || chunk.sourceBlockStart < 0 ||
      !Number.isSafeInteger(chunk.sourceBlockEnd) || chunk.sourceBlockEnd < chunk.sourceBlockStart ||
      !Number.isSafeInteger(chunk.tokenCount) || chunk.tokenCount < 1 ||
      chunk.contextPrefix.length > 1_024 ||
      chunk.documentContext !== null && (
        decodeKnowledgeDocumentContext(chunk.documentContext) === null ||
        Buffer.byteLength(JSON.stringify(chunk.documentContext), "utf8") >
          KNOWLEDGE_DOCUMENT_CONTEXT_MAX_BYTES
      ) ||
      !/^[0-9a-f]{64}$/u.test(chunk.contentHash) ||
      !/^[0-9a-f]{64}$/u.test(chunk.embeddingTextHash)
    )
  ) throw new KnowledgeHierarchicalIndexError("knowledge_hierarchical_index_input_invalid");
}

function chunkLanguages(
  document: StoredKnowledgeNormalizedDocument | null,
  chunk: KnowledgeChunkPlanEntry
): string[] {
  if (!document) return [];
  return canonicalLanguages(document.blocks.flatMap((block) =>
    block.order >= chunk.sourceBlockStart && block.order <= chunk.sourceBlockEnd
      ? block.languageHints
      : []
  ));
}

type MutableSection = {
  chunks: KnowledgeChunkPlanEntry[];
  headingPath: readonly string[];
  ordinal: number;
};

function sectionGroups(chunks: readonly KnowledgeChunkPlanEntry[]): MutableSection[] {
  const groups: MutableSection[] = [];
  for (const chunk of chunks) {
    const previous = groups.at(-1);
    const sameHeading = previous &&
      previous.headingPath.length === chunk.headingPath.length &&
      previous.headingPath.every((value, index) => value === chunk.headingPath[index]);
    if (previous && sameHeading) {
      previous.chunks.push(chunk);
    } else {
      groups.push({ chunks: [chunk], headingPath: chunk.headingPath, ordinal: groups.length });
    }
  }
  return groups;
}

function matches(value: string, pattern: RegExp, capture = 0): string[] {
  return [...value.matchAll(pattern)].flatMap((match) => {
    const selected = match[capture];
    return selected ? [selected] : [];
  });
}

function exactDateValues(value: string): string[] {
  return matches(value, /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/gu);
}

function exactIdentifierValues(value: string): string[] {
  return (value.normalize("NFKC").match(
    /[\p{L}\p{M}\p{N}_]+(?:[.-][\p{L}\p{M}\p{N}_]+)*/gu
  ) ?? []).filter((candidate) =>
    candidate.length >= 3 && candidate.length <= 64 &&
    /\p{L}/u.test(candidate) && /\d/u.test(candidate));
}

function exactNumberValues(value: string): string[] {
  return matches(
    value,
    /(?:^|[^\p{L}\p{N}_-])([+-]?\d+(?:[.,]\d+)?)(?=$|[^\p{L}\p{N}_-])/gu,
    1
  );
}

/** Query-side exact candidates share the index-side identifier/date/number
 * grammar. The bounded normalized set is safe to pass to one SQL `unnest` lane. */
export function knowledgeExactQueryValues(query: string): string[] {
  const compact = compactText(query, 3_000);
  if (!compact) return [];
  const filenameLike = compact.match(
    /[\p{L}\p{M}\p{N}_-]+(?:\.[\p{L}\p{M}\p{N}_-]+)+/gu
  ) ?? [];
  const quoted = matches(compact, /["“«]([^"”»]{2,512})["”»]/gu, 1);
  const candidates = [
    ...exactIdentifierValues(compact),
    ...exactDateValues(compact),
    ...exactNumberValues(compact),
    ...filenameLike,
    ...quoted,
    compact
  ];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = knowledgeExactNormalizedValue(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= KNOWLEDGE_EXACT_QUERY_MAX_VALUES) break;
  }
  return result;
}

type ExactSeed = Readonly<{
  kind: KnowledgeExactEntryKind;
  page: number | null;
  pageEnd: number | null;
  passageId: string | null;
  sectionId: string | null;
  value: string;
}>;

function exactSeeds(
  document: KnowledgeHierarchicalDocumentPlan,
  sections: readonly KnowledgeHierarchicalSectionPlan[],
  passages: readonly KnowledgeHierarchicalPassagePlan[]
): ExactSeed[] {
  const seeds: ExactSeed[] = [{
    kind: "filename",
    page: null,
    pageEnd: null,
    passageId: null,
    sectionId: null,
    value: document.fileName
  }];
  if (document.title) seeds.push({
    kind: "title",
    page: null,
    pageEnd: null,
    passageId: null,
    sectionId: null,
    value: document.title
  });
  if (document.sourceName !== document.title && document.sourceName !== document.fileName) {
    seeds.push({
      kind: "title",
      page: null,
      pageEnd: null,
      passageId: null,
      sectionId: null,
      value: document.sourceName
    });
  }
  for (const tag of document.tags) seeds.push({
    kind: "tag",
    page: null,
    pageEnd: null,
    passageId: null,
    sectionId: null,
    value: tag
  });
  for (const section of sections) {
    for (const heading of uniqueBounded([
      ...section.headingPath,
      section.headingPath.join(" › ")
    ], 17)) seeds.push({
      kind: "heading",
      page: section.page,
      pageEnd: section.pageEnd,
      passageId: null,
      sectionId: section.id,
      value: heading
    });
  }
  for (const passage of passages) {
    const dateValues = exactDateValues(passage.text);
    const identifierValues = exactIdentifierValues(passage.text);
    const numberValues = exactNumberValues(passage.text);
    for (const [kind, values] of [
      ["date", dateValues],
      ["identifier", identifierValues],
      ["number", numberValues]
    ] as const) {
      for (const value of values) seeds.push({
        kind,
        page: passage.page,
        pageEnd: passage.pageEnd,
        passageId: passage.id,
        sectionId: passage.sectionId,
        value
      });
    }
  }
  return seeds;
}

export function buildKnowledgeHierarchicalIndex(input: Readonly<{
  description?: string;
  document: StoredKnowledgeNormalizedDocument | null;
  fileName: string;
  mimeType: string;
  sourceArtifactId: string;
  sourceName: string;
  tags?: readonly string[];
  chunks: readonly KnowledgeChunkPlanEntry[];
}>): KnowledgeHierarchicalIndexPlan {
  assertChunks(input.chunks);
  const sourceArtifactId = compactText(input.sourceArtifactId, 256);
  const fileName = compactText(input.fileName, 512);
  const sourceName = compactText(input.sourceName, 512) || fileName;
  const description = compactText(input.description ?? "", 4_000);
  const mimeType = compactText(input.mimeType, 255);
  if (!sourceArtifactId || !fileName || !sourceName || !mimeType) {
    throw new KnowledgeHierarchicalIndexError("knowledge_hierarchical_index_input_invalid");
  }
  const tags = uniqueBounded(input.tags ?? [], MAX_TAGS);
  const id = knowledgeHierarchicalIndexArtifactId(sourceArtifactId);
  const title = input.document?.title ? compactText(input.document.title, 512) || null : null;
  const documentLanguages = canonicalLanguages(input.document?.languages ?? []);
  const allText = input.chunks.map((chunk) => chunk.text).join("\n");
  const outline = uniqueBounded(input.chunks.flatMap((chunk) =>
    chunk.headingPath.length > 0 ? [chunk.headingPath.join(" › ")] : []
  ), 512, 512);
  const summary = boundedSummary(input.chunks.map((chunk) => chunk.text));
  const documentEntities = entities(allText);
  const document: KnowledgeHierarchicalDocumentPlan = Object.freeze({
    contentHash: input.document?.contentHash ?? sha256(...input.chunks.map((chunk) => chunk.contentHash)),
    description,
    documentType: mimeType,
    entities: Object.freeze(documentEntities),
    fileName,
    languages: Object.freeze(documentLanguages),
    metadataText: compactText([
      fileName,
      sourceName,
      title ?? "",
      description,
      ...tags,
      ...outline,
      ...documentEntities
    ].join(" "), MAX_METADATA_CHARACTERS).toLocaleLowerCase("und"),
    outline: Object.freeze(outline),
    pageCount: input.document?.pageCount ?? Math.max(...input.chunks.map((chunk) => chunk.pageEnd)),
    sourceName,
    summary,
    tags: Object.freeze(tags),
    title
  });

  const groups = sectionGroups(input.chunks);
  const chunkSection = new Map<number, string>();
  const sections = groups.map((group): KnowledgeHierarchicalSectionPlan => {
    const first = group.chunks[0]!;
    const last = group.chunks.at(-1)!;
    const sectionText = group.chunks.map((chunk) => chunk.text).join("\n");
    const languages = canonicalLanguages(group.chunks.flatMap((chunk) =>
      chunkLanguages(input.document, chunk)
    ));
    const sectionId = stableId(
      "kis",
      id,
      String(group.ordinal),
      group.headingPath.join("\0"),
      String(first.sourceBlockStart),
      String(last.sourceBlockEnd),
      ...group.chunks.map((chunk) => chunk.contentHash)
    );
    for (const chunk of group.chunks) chunkSection.set(chunk.index, sectionId);
    return Object.freeze({
      contentHash: sha256(
        group.headingPath.join("\0"),
        ...group.chunks.map((chunk) => chunk.contentHash)
      ),
      entities: Object.freeze(entities(sectionText)),
      headingPath: Object.freeze([...group.headingPath]),
      id: sectionId,
      label: compactText(group.headingPath.at(-1) ?? title ?? fileName, 512),
      languages: Object.freeze(languages),
      ordinal: group.ordinal,
      page: Math.min(...group.chunks.map((chunk) => chunk.page)),
      pageEnd: Math.max(...group.chunks.map((chunk) => chunk.pageEnd)),
      passageEnd: last.index,
      passageStart: first.index,
      summary: boundedSummary(group.chunks.map((chunk) => chunk.text))
    });
  });

  const passages = input.chunks.map((chunk): KnowledgeHierarchicalPassagePlan => {
    const languages = chunkLanguages(input.document, chunk);
    const sectionId = chunkSection.get(chunk.index);
    if (!sectionId) {
      throw new KnowledgeHierarchicalIndexError("knowledge_hierarchical_index_input_invalid");
    }
    return Object.freeze({
      contentHash: chunk.contentHash,
      contextPrefix: chunk.contextPrefix,
      documentContext: chunk.documentContext,
      embeddingTextHash: chunk.embeddingTextHash,
      headingPath: Object.freeze([...chunk.headingPath]),
      id: stableId("kip", id, String(chunk.index), chunk.contentHash),
      languages: Object.freeze(languages),
      layoutKind: chunk.layoutKind,
      ordinal: chunk.index,
      page: chunk.page,
      pageEnd: chunk.pageEnd,
      sectionId,
      sourceBlockEnd: chunk.sourceBlockEnd,
      sourceBlockIds: Object.freeze([...chunk.sourceBlockIds]),
      sourceBlockStart: chunk.sourceBlockStart,
      text: chunk.text,
      tokenCount: chunk.tokenCount
    });
  });

  const exactKindPriority: Readonly<Record<KnowledgeExactEntryKind, number>> = {
    filename: 0,
    title: 1,
    heading: 2,
    tag: 3,
    identifier: 4,
    date: 5,
    number: 6
  };
  type PreparedExactSeed = ExactSeed & Readonly<{
    discoveryOrdinal: number;
    key: string;
    normalizedValue: string;
    value: string;
  }>;
  const seenExact = new Set<string>();
  const preparedSeeds: PreparedExactSeed[] = [];
  for (const [discoveryOrdinal, seed] of exactSeeds(document, sections, passages).entries()) {
    const value = compactText(seed.value, 512);
    const normalizedValue = knowledgeExactNormalizedValue(value);
    if (!value || !normalizedValue) continue;
    const key = [
      seed.kind,
      normalizedValue,
      seed.sectionId ?? "",
      seed.passageId ?? ""
    ].join("\0");
    if (seenExact.has(key)) continue;
    seenExact.add(key);
    preparedSeeds.push({ ...seed, discoveryOrdinal, key, normalizedValue, value });
  }
  preparedSeeds.sort((left, right) =>
    exactKindPriority[left.kind] - exactKindPriority[right.kind] ||
    left.discoveryOrdinal - right.discoveryOrdinal ||
    left.normalizedValue.localeCompare(right.normalizedValue, "und") ||
    left.key.localeCompare(right.key, "und"));

  const passageCounts = new Map<string, number>();
  const retainedSeeds: PreparedExactSeed[] = [];
  for (const seed of preparedSeeds) {
    if (seed.passageId) {
      const count = passageCounts.get(seed.passageId) ?? 0;
      if (count >= KNOWLEDGE_HIERARCHICAL_MAX_EXACT_ENTRIES_PER_PASSAGE) continue;
      passageCounts.set(seed.passageId, count + 1);
    }
    if (retainedSeeds.length < KNOWLEDGE_HIERARCHICAL_MAX_EXACT_ENTRIES) {
      retainedSeeds.push(seed);
    }
  }

  const exactEntries: KnowledgeHierarchicalExactEntryPlan[] = [];
  for (const seed of retainedSeeds) {
    const ordinal = exactEntries.length;
    exactEntries.push(Object.freeze({
      id: stableId("kie", id, String(ordinal), seed.key),
      kind: seed.kind,
      normalizedValue: seed.normalizedValue,
      ordinal,
      page: seed.page,
      pageEnd: seed.pageEnd,
      passageId: seed.passageId,
      sectionId: seed.sectionId,
      value: seed.value,
      valueHash: sha256(seed.value)
    }));
  }
  const exactIndex = Object.freeze({
    candidateCount: preparedSeeds.length,
    retainedCount: exactEntries.length,
    truncated: preparedSeeds.length > exactEntries.length
  });

  const withoutChecksum = Object.freeze({
    derivationMode: input.document ? "normalized_v2" as const : "legacy_chunks" as const,
    document,
    exactEntries: Object.freeze(exactEntries),
    exactIndex,
    id,
    passages: Object.freeze(passages),
    schemaVersion: KNOWLEDGE_HIERARCHICAL_INDEX_VERSION,
    sections: Object.freeze(sections),
    sourceArtifactId
  });
  return Object.freeze({
    ...withoutChecksum,
    checksum: sha256(JSON.stringify(withoutChecksum))
  });
}

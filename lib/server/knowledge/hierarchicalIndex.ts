import { createHash } from "node:crypto";
import type { KnowledgeChunkPlanEntry } from "./chunking";
import type { StoredKnowledgeNormalizedDocument } from "./normalizedDocument";

export const KNOWLEDGE_HIERARCHICAL_INDEX_VERSION = 1;
export const KNOWLEDGE_HIERARCHICAL_MAX_EXACT_ENTRIES = 10_000;

const MAX_SUMMARY_CHARACTERS = 4_000;
const MAX_METADATA_CHARACTERS = 16_384;
const MAX_KEYWORDS = 64;
const MAX_ENTITIES = 64;
const MAX_TAGS = 64;

export type KnowledgeLexicalLanguage = "english" | "mixed" | "russian" | "unknown";
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
  keywords: readonly string[];
  languageConfig: KnowledgeLexicalLanguage;
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
  keywords: readonly string[];
  label: string;
  languageConfig: KnowledgeLexicalLanguage;
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
  embeddingTextHash: string;
  headingPath: readonly string[];
  id: string;
  languageConfig: KnowledgeLexicalLanguage;
  languages: readonly string[];
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

const STOP_WORDS = new Set([
  "about", "after", "also", "and", "are", "for", "from", "into", "its", "that", "the",
  "their", "this", "through", "under", "was", "were", "with",
  "без", "был", "для", "или", "как", "над", "под", "при", "про", "что", "это"
]);

function sha256(...values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values) hash.update(value, "utf8").update("\0", "utf8");
  return hash.digest("hex");
}

function stableId(prefix: string, ...values: readonly string[]): string {
  return `${prefix}_${sha256(...values).slice(0, 40)}`;
}

function compactText(value: string, maximum = Number.MAX_SAFE_INTEGER): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
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

function words(value: string): string[] {
  return value.normalize("NFKC").match(/[\p{L}\p{M}\p{N}_-]+/gu) ?? [];
}

function keywords(value: string): string[] {
  const counts = new Map<string, number>();
  for (const word of words(value)) {
    const normalized = word.toLocaleLowerCase("und");
    if (normalized.length < 3 || STOP_WORDS.has(normalized) || /^\d+$/u.test(normalized)) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts]
    .sort(([left, leftCount], [right, rightCount]) =>
      rightCount - leftCount || left.localeCompare(right, "und"))
    .slice(0, MAX_KEYWORDS)
    .map(([value]) => value);
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

function canonicalLanguages(values: readonly string[]): string[] {
  return uniqueBounded(values.map((value) => value.toLowerCase()), 16, 32)
    .filter((value) => /^[a-z]{2,8}(?:-[a-z0-9]{1,8}){0,2}$/u.test(value))
    .sort((left, right) => left.localeCompare(right, "und"));
}

function inferredLanguage(text: string): KnowledgeLexicalLanguage {
  const russianCharacters = text.match(/[А-Яа-яЁё]/gu)?.length ?? 0;
  const englishCharacters = text.match(/[A-Za-z]/gu)?.length ?? 0;
  if (russianCharacters > 0 && englishCharacters > 0) {
    const smaller = Math.min(russianCharacters, englishCharacters);
    const larger = Math.max(russianCharacters, englishCharacters);
    return smaller / larger >= 0.1 ? "mixed" : russianCharacters > englishCharacters
      ? "russian"
      : "english";
  }
  if (russianCharacters > 0) return "russian";
  if (englishCharacters > 0) return "english";
  return "unknown";
}

export function knowledgeLexicalLanguage(
  languages: readonly string[],
  fallbackText: string
): KnowledgeLexicalLanguage {
  const bases = new Set(languages.map((value) => value.toLowerCase().split("-")[0]));
  const russian = bases.has("ru");
  const english = bases.has("en");
  if (russian && english) return "mixed";
  if (russian) return "russian";
  if (english) return "english";
  return inferredLanguage(fallbackText);
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

function assertChunks(chunks: readonly KnowledgeChunkPlanEntry[]): void {
  if (
    chunks.length < 1 ||
    chunks.some((chunk, index) =>
      chunk.index !== index ||
      !chunk.text.trim() ||
      !Number.isSafeInteger(chunk.page) || chunk.page < 1 ||
      !Number.isSafeInteger(chunk.pageEnd) || chunk.pageEnd < chunk.page ||
      !Number.isSafeInteger(chunk.sourceBlockStart) || chunk.sourceBlockStart < 0 ||
      !Number.isSafeInteger(chunk.sourceBlockEnd) || chunk.sourceBlockEnd < chunk.sourceBlockStart ||
      !Number.isSafeInteger(chunk.tokenCount) || chunk.tokenCount < 1 ||
      chunk.contextPrefix.length > 1_024 ||
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
    const dateValues = matches(
      passage.text,
      /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/gu
    );
    const identifierValues = words(passage.text).filter((value) =>
      value.length >= 3 && value.length <= 64 && /\p{L}/u.test(value) && /\d/u.test(value)
    );
    const numberValues = matches(
      passage.text,
      /(?:^|[^\p{L}\p{N}_-])([+-]?\d+(?:[.,]\d+)?)(?=$|[^\p{L}\p{N}_-])/gu,
      1
    );
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
  const documentKeywords = keywords(allText);
  const documentEntities = entities(allText);
  const document: KnowledgeHierarchicalDocumentPlan = Object.freeze({
    contentHash: input.document?.contentHash ?? sha256(...input.chunks.map((chunk) => chunk.contentHash)),
    description,
    documentType: mimeType,
    entities: Object.freeze(documentEntities),
    fileName,
    keywords: Object.freeze(documentKeywords),
    languageConfig: knowledgeLexicalLanguage(documentLanguages, allText),
    languages: Object.freeze(documentLanguages),
    metadataText: compactText([
      fileName,
      sourceName,
      title ?? "",
      description,
      ...tags,
      ...outline,
      ...documentKeywords,
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
      keywords: Object.freeze(keywords(sectionText)),
      label: compactText(group.headingPath.at(-1) ?? title ?? fileName, 512),
      languageConfig: knowledgeLexicalLanguage(languages, sectionText),
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
      embeddingTextHash: chunk.embeddingTextHash,
      headingPath: Object.freeze([...chunk.headingPath]),
      id: stableId("kip", id, String(chunk.index), chunk.contentHash),
      languageConfig: knowledgeLexicalLanguage(languages, chunk.text),
      languages: Object.freeze(languages),
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

  const seenExact = new Set<string>();
  const exactEntries: KnowledgeHierarchicalExactEntryPlan[] = [];
  for (const seed of exactSeeds(document, sections, passages)) {
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
    const ordinal = exactEntries.length;
    exactEntries.push(Object.freeze({
      id: stableId("kie", id, String(ordinal), key),
      kind: seed.kind,
      normalizedValue,
      ordinal,
      page: seed.page,
      pageEnd: seed.pageEnd,
      passageId: seed.passageId,
      sectionId: seed.sectionId,
      value,
      valueHash: sha256(value)
    }));
    if (exactEntries.length > KNOWLEDGE_HIERARCHICAL_MAX_EXACT_ENTRIES) {
      throw new KnowledgeHierarchicalIndexError(
        "knowledge_hierarchical_exact_entry_limit_exceeded"
      );
    }
  }

  const withoutChecksum = Object.freeze({
    derivationMode: input.document ? "normalized_v2" as const : "legacy_chunks" as const,
    document,
    exactEntries: Object.freeze(exactEntries),
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

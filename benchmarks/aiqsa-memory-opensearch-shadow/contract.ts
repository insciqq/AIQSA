import { createHash } from "node:crypto";

export const MEMORY_OPENSEARCH_SHADOW_QUALIFICATION_VERSION =
  "memory-opensearch-shadow-v2" as const;

export const MEMORY_OPENSEARCH_SHADOW_REQUIRED_COHORTS = Object.freeze([
  "English",
  "Russian",
  "Spanish",
  "Serbian-Latin",
  "Serbian-Cyrillic",
  "Ukrainian-or-Bulgarian",
  "Turkish",
  "Arabic",
  "Hebrew",
  "Hindi",
  "CJK",
  "Thai",
  "accented",
  "mixed-script",
  "cross-script-transliteration",
  "identifiers-and-digits"
] as const);

export type MemoryOpenSearchShadowCohort =
  (typeof MEMORY_OPENSEARCH_SHADOW_REQUIRED_COHORTS)[number];

export type MemoryOpenSearchShadowDocument = Readonly<{
  chat: "PRIMARY" | "SECONDARY";
  key: string;
  text: string;
}>;

export type MemoryOpenSearchShadowCase = Readonly<{
  cohort: MemoryOpenSearchShadowCohort;
  documents: readonly MemoryOpenSearchShadowDocument[];
  expectedDocumentKey: string;
  expectedMode: "FOLDED" | "NGRAM" | "TRANSLITERATED" | "UNICODE";
  highVolume: boolean;
  key: string;
  sourceScope?: "SECONDARY";
  terms: readonly string[];
}>;

export const MEMORY_OPENSEARCH_SHADOW_CORPUS = Object.freeze([
  {
    cohort: "English",
    documents: [
      { chat: "PRIMARY", key: "en-cedar", text: "cedar deployment window alpha" },
      { chat: "PRIMARY", key: "en-cedar-decoy", text: "cedar archive window" }
    ],
    expectedDocumentKey: "en-cedar",
    expectedMode: "UNICODE",
    highVolume: true,
    key: "english-exact",
    terms: ["cedar", "alpha"]
  },
  {
    cohort: "English",
    documents: [
      { chat: "SECONDARY", key: "en-scope", text: "aurora route secondary" },
      { chat: "PRIMARY", key: "en-scope-decoy", text: "aurora route primary" }
    ],
    expectedDocumentKey: "en-scope",
    expectedMode: "UNICODE",
    highVolume: true,
    key: "english-selected-source",
    sourceScope: "SECONDARY",
    terms: ["aurora", "route"]
  },
  {
    cohort: "Russian",
    documents: [
      { chat: "PRIMARY", key: "ru-kedr", text: "кедровое развёртывание альфа" },
      { chat: "PRIMARY", key: "ru-kedr-decoy", text: "кедровое архивирование" }
    ],
    expectedDocumentKey: "ru-kedr",
    expectedMode: "UNICODE",
    highVolume: true,
    key: "russian-exact",
    terms: ["кедровое", "альфа"]
  },
  {
    cohort: "Russian",
    documents: [
      { chat: "PRIMARY", key: "ru-yo", text: "ёлка зелёная север" },
      { chat: "PRIMARY", key: "ru-yo-decoy", text: "ёлка зимняя" }
    ],
    expectedDocumentKey: "ru-yo",
    expectedMode: "UNICODE",
    highVolume: true,
    key: "russian-yo-distinction",
    terms: ["ёлка", "север"]
  },
  {
    cohort: "Spanish",
    documents: [
      { chat: "PRIMARY", key: "es-manana", text: "reunión café mañana proyecto ámbar" },
      { chat: "PRIMARY", key: "es-manana-decoy", text: "mañana reunión ordinaria" }
    ],
    expectedDocumentKey: "es-manana",
    expectedMode: "UNICODE",
    highVolume: true,
    key: "spanish-accented",
    terms: ["mañana", "ámbar"]
  },
  {
    cohort: "Spanish",
    documents: [
      { chat: "PRIMARY", key: "es-inflection", text: "migraciones seguras archivo" }
    ],
    expectedDocumentKey: "es-inflection",
    expectedMode: "NGRAM",
    highVolume: true,
    key: "spanish-subword",
    terms: ["migracion"]
  },
  {
    cohort: "Serbian-Latin",
    documents: [
      { chat: "PRIMARY", key: "sr-latin", text: "Aleksandar projekat Dunav" },
      { chat: "PRIMARY", key: "sr-latin-decoy", text: "Aleksandar arhiva" }
    ],
    expectedDocumentKey: "sr-latin",
    expectedMode: "UNICODE",
    highVolume: false,
    key: "serbian-latin",
    terms: ["Aleksandar", "Dunav"]
  },
  {
    cohort: "Serbian-Cyrillic",
    documents: [
      { chat: "PRIMARY", key: "sr-cyrillic", text: "Александар пројекат Дунав" },
      { chat: "PRIMARY", key: "sr-cyrillic-decoy", text: "пројекат архива" }
    ],
    expectedDocumentKey: "sr-cyrillic",
    expectedMode: "UNICODE",
    highVolume: false,
    key: "serbian-cyrillic",
    terms: ["Александар", "Дунав"]
  },
  {
    cohort: "Ukrainian-or-Bulgarian",
    documents: [
      { chat: "PRIMARY", key: "uk-project", text: "проєкт ґанок Київ" },
      { chat: "PRIMARY", key: "uk-project-decoy", text: "проєкт архів" }
    ],
    expectedDocumentKey: "uk-project",
    expectedMode: "UNICODE",
    highVolume: false,
    key: "ukrainian-cyrillic",
    terms: ["ґанок", "Київ"]
  },
  {
    cohort: "Turkish",
    documents: [
      { chat: "PRIMARY", key: "tr-istanbul", text: "İstanbul ışık projesi" },
      { chat: "PRIMARY", key: "tr-istanbul-decoy", text: "İstanbul arşiv" }
    ],
    expectedDocumentKey: "tr-istanbul",
    expectedMode: "UNICODE",
    highVolume: false,
    key: "turkish-dotted-dotless",
    terms: ["İstanbul", "ışık"]
  },
  {
    cohort: "Arabic",
    documents: [
      { chat: "PRIMARY", key: "ar-moon", text: "مشروع القمر الأزرق" },
      { chat: "PRIMARY", key: "ar-moon-decoy", text: "مشروع القمر القديم" }
    ],
    expectedDocumentKey: "ar-moon",
    expectedMode: "UNICODE",
    highVolume: false,
    key: "arabic",
    terms: ["القمر", "الأزرق"]
  },
  {
    cohort: "Hebrew",
    documents: [
      { chat: "PRIMARY", key: "he-bridge", text: "פרויקט גשר כחול" },
      { chat: "PRIMARY", key: "he-bridge-decoy", text: "פרויקט גשר ישן" }
    ],
    expectedDocumentKey: "he-bridge",
    expectedMode: "UNICODE",
    highVolume: false,
    key: "hebrew",
    terms: ["גשר", "כחול"]
  },
  {
    cohort: "Hindi",
    documents: [
      { chat: "PRIMARY", key: "hi-lotus", text: "नीला कमल परियोजना" },
      { chat: "PRIMARY", key: "hi-lotus-decoy", text: "कमल पुराना" }
    ],
    expectedDocumentKey: "hi-lotus",
    expectedMode: "UNICODE",
    highVolume: false,
    key: "hindi",
    terms: ["नीला", "परियोजना"]
  },
  {
    cohort: "CJK",
    documents: [
      { chat: "PRIMARY", key: "cjk-tokyo", text: "東京計画青い橋" },
      { chat: "PRIMARY", key: "cjk-tokyo-decoy", text: "東京記録古い道" }
    ],
    expectedDocumentKey: "cjk-tokyo",
    expectedMode: "UNICODE",
    highVolume: true,
    key: "cjk-segmentation",
    terms: ["東京計画", "青い橋"]
  },
  {
    cohort: "CJK",
    documents: [
      { chat: "PRIMARY", key: "cjk-short", text: "東京 青空" }
    ],
    expectedDocumentKey: "cjk-short",
    expectedMode: "UNICODE",
    highVolume: true,
    key: "cjk-short-term",
    terms: ["東京"]
  },
  {
    cohort: "Thai",
    documents: [
      { chat: "PRIMARY", key: "th-bridge", text: "โครงการสะพานสีน้ำเงิน" },
      { chat: "PRIMARY", key: "th-bridge-decoy", text: "โครงการถนนเก่า" }
    ],
    expectedDocumentKey: "th-bridge",
    expectedMode: "UNICODE",
    highVolume: false,
    key: "thai-segmentation",
    terms: ["สะพาน", "สีน้ำเงิน"]
  },
  {
    cohort: "accented",
    documents: [
      { chat: "PRIMARY", key: "accent-fold", text: "café résumé dossier" }
    ],
    expectedDocumentKey: "accent-fold",
    expectedMode: "FOLDED",
    highVolume: false,
    key: "accent-folding",
    terms: ["cafe", "resume"]
  },
  {
    cohort: "accented",
    documents: [
      { chat: "PRIMARY", key: "accent-nfkc", text: "Café Mañana canonical" }
    ],
    expectedDocumentKey: "accent-nfkc",
    expectedMode: "UNICODE",
    highVolume: false,
    key: "canonical-equivalence",
    terms: ["Café", "Mañana"]
  },
  {
    cohort: "mixed-script",
    documents: [
      { chat: "PRIMARY", key: "mixed", text: "Project Δelta 東京 42" },
      { chat: "PRIMARY", key: "mixed-decoy", text: "Project archive 41" }
    ],
    expectedDocumentKey: "mixed",
    expectedMode: "UNICODE",
    highVolume: false,
    key: "mixed-script",
    terms: ["Δelta", "東京", "42"]
  },
  {
    cohort: "cross-script-transliteration",
    documents: [
      { chat: "PRIMARY", key: "translit", text: "Александар Београд" }
    ],
    expectedDocumentKey: "translit",
    expectedMode: "TRANSLITERATED",
    highVolume: false,
    key: "generic-transliteration",
    terms: ["Aleksandar", "Beograd"]
  },
  {
    cohort: "identifiers-and-digits",
    documents: [
      { chat: "PRIMARY", key: "digits", text: "ticket ZX-٤٢ code १२३४" },
      { chat: "PRIMARY", key: "digits-decoy", text: "ticket ZX-٤١ archived" }
    ],
    expectedDocumentKey: "digits",
    expectedMode: "UNICODE",
    highVolume: false,
    key: "unicode-digits",
    terms: ["ZX-٤٢", "१२३४"]
  },
  {
    cohort: "English",
    documents: [
      { chat: "PRIMARY", key: "typo", text: "database migrations archive" }
    ],
    expectedDocumentKey: "typo",
    expectedMode: "NGRAM",
    highVolume: true,
    key: "transposition-typo",
    terms: ["migratoin"]
  }
] as const satisfies readonly MemoryOpenSearchShadowCase[]);

export const MEMORY_OPENSEARCH_SHADOW_CORPUS_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify({
    cases: MEMORY_OPENSEARCH_SHADOW_CORPUS,
    version: MEMORY_OPENSEARCH_SHADOW_QUALIFICATION_VERSION
  }))
  .digest("hex");

export function qualificationPercentile(
  values: readonly number[],
  percentile: number
): number {
  if (values.length < 1 || !Number.isFinite(percentile) || percentile < 0 ||
    percentile > 1 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("memory_shadow_qualification_metric_invalid");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(percentile * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

export function qualificationSignedPercentile(
  values: readonly number[],
  percentile: number
): number {
  if (values.length < 1 || !Number.isFinite(percentile) || percentile < 0 ||
    percentile > 1 || values.some((value) =>
      !Number.isFinite(value) || value < -1 || value > 1)) {
    throw new Error("memory_shadow_qualification_metric_invalid");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(percentile * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

export function qualificationJaccard(
  left: readonly string[],
  right: readonly string[]
): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const value of leftSet) if (rightSet.has(value)) intersection += 1;
  return intersection / union.size;
}

/** PRD 14.3 permits an explicitly reviewed low-overlap cohort when there is
 * no end-to-end regression. A strict additive expansion qualifies only when
 * every PostgreSQL top-10 candidate remains in the OpenSearch top 10 and the
 * first relevant rank never worsens. */
export function qualificationAdditiveOverlapReview(input: Readonly<{
  firstRelevantReciprocalRankDeltas: readonly number[];
  top10BaselineContained: readonly boolean[];
}>): boolean {
  if (input.firstRelevantReciprocalRankDeltas.length < 1 ||
    input.firstRelevantReciprocalRankDeltas.length !==
      input.top10BaselineContained.length ||
    input.firstRelevantReciprocalRankDeltas.some((value) =>
      !Number.isFinite(value) || value < -1 || value > 1)) {
    throw new Error("memory_shadow_qualification_metric_invalid");
  }
  return input.top10BaselineContained.every(Boolean) &&
    input.firstRelevantReciprocalRankDeltas.every((value) => value >= 0);
}

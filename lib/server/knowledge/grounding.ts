import { createHash } from "node:crypto";
import {
  decodeKnowledgeCitationHandle,
  knowledgeCitationHandlesFromText
} from "../../contracts/knowledge";
import {
  knowledgeEvidenceReceiptHash,
  type KnowledgeEvidencePackage,
  type KnowledgeEvidencePackageItem
} from "./evidencePackage";
import { gateKnowledgeUniversalClaimsV1 } from "./knowledgeStrategyExecution";
import {
  assessKnowledgeObservationGroundingV1,
  createKnowledgeObservationGroundingVocabularyV1,
  type KnowledgeObservationGroundingVocabularyV1
} from "./observationGrounding";
import {
  createKnowledgeTableDocumentContext,
  decodeKnowledgeDocumentContext,
  isCompleteKnowledgeTableRowProjectionSequence,
  type KnowledgeDocumentContextV1,
  type KnowledgeTableRowProjectionLocatorV1
} from "./documentContext";

export const KNOWLEDGE_GROUNDING_VERSION = 4 as const;
export const KNOWLEDGE_GROUNDING_MAX_REPAIRS = 1 as const;

export const knowledgeGroundingIssueCodes = [
  "coverage_overclaim",
  "general_knowledge_unseparated",
  "internal_identity",
  "invalid_handle",
  "numeric_or_date_mismatch",
  "source_instruction_followed",
  "unsupported_claim"
] as const;

export type KnowledgeGroundingIssueCode = typeof knowledgeGroundingIssueCodes[number];

export type KnowledgeGroundingResult = Readonly<{
  diagnostics: Readonly<{
    citationCoverage: number;
    citationPrecision: number;
    citedClaimCount: number;
    issueCodes: readonly KnowledgeGroundingIssueCode[];
    sourceClaimCount: number;
    unsupportedClaimCount: number;
  }>;
  finalAnswerHash: string;
  finalText: string;
  originalAnswerHash: string;
  outcome: "no_answer" | "passed" | "repaired";
  receiptHash: string;
  repairCount: 0 | 1;
  sessionId: string;
  version: typeof KNOWLEDGE_GROUNDING_VERSION;
}>;

type ClaimAssessment = Readonly<{
  cited: boolean;
  citationCount: number;
  issueCodes: readonly KnowledgeGroundingIssueCode[];
  keep: boolean;
  sourceClaim: boolean;
  text: string;
  validCitationCount: number;
}>;

const explicitGeneralKnowledge = /^(?:#{1,6}\s*)?(?:general knowledge|in general|outside (?:the )?selected sources|inference|общие сведения|в общем случае|вне выбранных источников|логический вывод|вывод)\s*[:—-]/iu;
const honestNoAnswer = /(?:could(?:n't| not) find|could not reliably attach citations|not (?:found|stated|specified) in (?:the )?selected sources|insufficient evidence|selected sources contain conflicting information|cannot reliably choose one version|не удалось найти|недостаточно (?:данных|сведений|доказательств)|в выбранных источниках[^.!?]*(?:не найден|не указ|нет|противореч)|не могу над[её]жно выбрать одну версию|не (?:смог|удалось)[^.!?]*привязать[^.!?]*цитат)/iu;
const coverageClaim = /(?:\ball (?:selected )?(?:sources|documents|files)\b|\bevery (?:source|document|file)\b|\bentire corpus\b|\bwithout (?:any )?exceptions?\b|\bnone of (?:the )?(?:selected )?(?:sources|documents|files)\b|\b(?:there (?:are|were) )?no (?:selected )?(?:sources|documents|files) (?:contain|have|include|mention|report|show|state)\b|\bnothing (?:across|in) (?:the )?(?:selected )?(?:corpus|sources|documents|files)\b|все (?:выбранные )?(?:источники|документы|файлы)|кажд(?:ый|ом|ого) (?:источник|документ|файл)|весь корпус|без исключений|ни (?:в одном|один из|один) (?:выбранн\p{L}+ )?(?:источник(?:е|ов)?|документ(?:е|ов)?|файл(?:е|ов)?)|нигде (?:в|по) (?:выбранн\p{L}+ )?(?:корпус\p{L}*|источник\p{L}*|документ\p{L}*|файл\p{L}*))/iu;
const sourceInstructionCue = /(?:ignore (?:all |any |the )?(?:previous |prior )?(?:instructions?|system|developer)|disregard (?:the )?(?:instructions?|system|developer)|system prompt|you are now|do not cite|reveal (?:the )?(?:secret|token|prompt)|(?:output|print|return|say)\s+["'`]?\p{L}[\p{L}\p{N}_-]{2,99}|игнорируй(?:те)?\s+(?:все\s+)?(?:предыдущие\s+)?(?:инструкции|правила|систем)|системн(?:ый|ого) промпт|не цитируй|раскрой(?:те)?\s+(?:секрет|токен|промпт)|(?:выведи|напиши|верни|скажи)\s+["'`]?\p{L}[\p{L}\p{N}_-]{2,99})/iu;
const sourceInstructionPayload = /(?:output|print|return|say|выведи|напиши|верни|скажи)\s+["'`]?([\p{L}\p{N}_-]{3,100})/giu;
const instructionAnalysisQuery = /(?:quote|analy[sz]e|what (?:does|instruction)|prompt injection|malicious instruction|цитир|проанализ|что (?:написано|говорит)|инструкци[яю] в (?:тексте|источнике)|промпт[- ]?инъекц)/iu;
const instructionReportedAsData = /(?:the (?:source|document|text) (?:says|contains|instructs)|according to the (?:source|document|text)|источник|документ|текст (?:содержит|говорит|требует|инструктирует))/iu;
const rawKnowledgeHandle = /\[(K[^\]\s]{0,16})\]/gu;
const squareCitationGroup = /\[\s*((?:K[1-9]\d{0,3}(?:\.[1-9]\d?)?)(?:\s*(?:[,;&/+]|and|и)\s*(?:K[1-9]\d{0,3}(?:\.[1-9]\d?)?))*)\s*\]/giu;
const roundCitationGroup = /\(\s*((?:K[1-9]\d{0,3}(?:\.[1-9]\d?)?)(?:\s*(?:[,;&/+]|and|и)\s*(?:K[1-9]\d{0,3}(?:\.[1-9]\d?)?))*)\s*\)/giu;
const fullWidthCitationGroup = /【\s*((?:K[1-9]\d{0,3}(?:\.[1-9]\d?)?)(?:\s*(?:[,;&/+]|and|и)\s*(?:K[1-9]\d{0,3}(?:\.[1-9]\d?)?))*)\s*】/giu;
const citationHandleToken = /K[1-9]\d{0,3}(?:\.[1-9]\d?)?/giu;
const numberOrDate = /(?<![\p{L}\p{N}])(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?%?)(?!\p{N})/gu;
const dateOrTime = /(?<![\p{L}\p{N}])(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}:\d{2}(?::\d{2})?)(?![\p{L}\p{N}])/gu;
const scalarNumber = /(?<![\p{L}\p{N}])[+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?%?(?!\p{N})/gu;
const numericComparisonClaim = /(?:[<>≤≥]=?|±|\b(?:above|below|under|over|maximum|minimum|at\s+(?:(?:or\s+)?(?:above|below)|least|most)|less\s+than|more\s+than|greater\s+than|lower\s+than|higher\s+than|no\s+(?:less|more|greater|fewer)\s+than|up\s+to|(?:or|and)\s+(?:more|less|above|below))\b|(?:^|\s)(?:выше|ниже|максимум|минимум|не\s+(?:менее|более|больше|меньше|выше|ниже|превышает)|меньше|больше|свыше|превышает|(?:и|или)\s+(?:более|менее|больше|меньше|выше|ниже))(?=$|\s|[.,;:])|\d\s*\+)/u;
const citationRun = /(?:\[(?:K[1-9]\d{0,3}(?:\.[1-9]\d?)?)\]\s*)+/giu;
const trailingEnglishMetricLabel = /^\s*(?:[,;:—-]\s*)?for\s+(?:the\s+)?(?:(?:metric|indicator|measure)\s+([\p{L}\p{N}][\p{L}\p{M}\p{N}_ -]{0,100})|([\p{L}\p{N}][\p{L}\p{M}\p{N}_ -]{0,100}?)\s+(?:metric|indicator|measure))\s*[.!?]?\s*$/iu;
const trailingRussianMetricLabel = /^\s*(?:[,;:—-]\s*)?для\s+(?:показател(?:я|ю|е|ем)|метрик(?:и|е|у|ой)|индикатор(?:а|у|е|ом))\s+([\p{L}\p{N}][\p{L}\p{M}\p{N}_ -]{0,100})\s*[.!?]?\s*$/iu;
const word = /[\p{L}\p{N}][\p{L}\p{M}\p{N}_-]*/gu;
const stopWords = new Set([
  "about", "after", "also", "and", "are", "as", "at", "been", "being", "between", "but", "by", "can",
  "could", "does", "for", "from", "have", "into", "its", "more", "not", "that", "the",
  "their", "there", "these", "this", "those", "to", "was", "were", "which", "will", "with",
  "без", "был", "была", "были", "быть", "для", "до", "его", "или", "как", "который", "между",
  "может", "на", "она", "они", "от", "по", "после", "при", "про", "также", "того", "этого", "это"
]);
const genericClaimWords = new Set([
  "another", "conflict", "day", "days", "document", "file", "measurement", "measurements", "metric",
  "metrics", "one", "recorded", "report", "result", "results", "source", "states", "value",
  "values", "version", "versions", "while", "year", "years", "день", "дней", "дня", "документ", "значение", "значения",
  "измерение", "измерения", "источник", "отчет", "отчёт", "показатель", "показатели",
  "результат", "результаты", "составляет", "версия", "версии", "конфликт"
]);
const unitWord = /^(?:g|kg|l|mg|ml|mmol|mol|percent|г|кг|л|мг|мл|ммоль|моль|процент\p{L}*)$/iu;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\u2212/gu, "-")
    .toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function tokens(value: string): string[] {
  return (normalized(value).match(word) ?? [])
    .filter((entry) => entry.length > 1 && !stopWords.has(entry));
}

function labelStem(value: string): string {
  if (value.length <= 4) return value;
  if (/^[a-z]+$/u.test(value)) {
    return value.replace(/(?:ations?|ments?|ingly|edly|ing|ers?|ed|es|s)$/u, "") || value;
  }
  if (/^[а-яё]+$/u.test(value)) {
    return value.replace(
      /(?:иями|ями|ами|ого|ему|ому|ими|ий|ый|ая|яя|ое|ее|ые|ие|ых|их|ую|юю|ов|ев|ам|ям|ах|ях|ом|ем|ой|ей|ы|и|а|я|у|ю|е|о)$/u,
      ""
    ) || value;
  }
  return value;
}

function labelTokens(value: string): string[] {
  return [...new Set(tokens(claimPayload(value))
    .filter((token) => !genericClaimWords.has(token) && !unitWord.test(token) &&
      !/^\d/u.test(token) && !monthNumber(token))
    .map(labelStem)
    .filter((token) => token.length >= 2))];
}

function acronymLabelTokens(value: string): string[] {
  return [...new Set((claimPayload(value).match(word) ?? []).flatMap((token) => {
    const letters = [...token].filter((character) => /\p{L}/u.test(character));
    const uppercase = letters.filter((character) =>
      character === character.toLocaleUpperCase() &&
      character !== character.toLocaleLowerCase()).length;
    const normalizedToken = normalized(token);
    return uppercase >= 2 && !unitWord.test(normalizedToken) && !monthNumber(normalizedToken)
      ? [labelStem(normalizedToken)]
      : [];
  }))];
}

function numericTokens(value: string): string[] {
  return [...new Set(normalized(value).match(numberOrDate) ?? [])];
}

function canonicalScalar(value: string): string {
  const percent = value.endsWith("%");
  const parsed = Number(value.replace(/%$/u, "").replace(",", "."));
  if (!Number.isFinite(parsed)) return value;
  return `${Object.is(parsed, -0) ? 0 : parsed}${percent ? "%" : ""}`;
}

function scalarTokens(value: string): string[] {
  const withoutDates = normalized(value).replace(dateOrTime, " ");
  return [...new Set((withoutDates.match(scalarNumber) ?? [])
    .filter((entry) => {
      const plain = entry.replace(/%$/u, "");
      if (!/^\d{4}$/u.test(plain)) return true;
      const year = Number(plain);
      return year < 1900 || year > 2100;
    })
    .map(canonicalScalar))];
}

function dateTokens(value: string): string[] {
  return [...new Set((normalized(value).match(dateOrTime) ?? []).map((entry) => {
    if (/^\d{1,2}:\d{2}/u.test(entry)) return entry;
    const parts = entry.split(/[./-]/u).map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part))) return entry;
    const [first, second, third] = parts;
    const year = first! >= 1_000 ? first! : third! < 100 ? 2_000 + third! : third!;
    const month = first! >= 1_000 ? second! : second!;
    const day = first! >= 1_000 ? third! : first!;
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-` +
      String(day).padStart(2, "0");
  }))];
}

const monthNumbers: Readonly<Record<string, string>> = Object.freeze({
  april: "04", august: "08", december: "12", february: "02", january: "01",
  july: "07", june: "06", march: "03", may: "05", november: "11", october: "10",
  september: "09"
});

function monthNumber(value: string): string | null {
  const latin = monthNumbers[value];
  if (latin) return latin;
  if (/^январ/iu.test(value)) return "01";
  if (/^феврал/iu.test(value)) return "02";
  if (/^март/iu.test(value)) return "03";
  if (/^апрел/iu.test(value)) return "04";
  if (/^ма(?:й|я|е|ю)$/iu.test(value)) return "05";
  if (/^июн/iu.test(value)) return "06";
  if (/^июл/iu.test(value)) return "07";
  if (/^август/iu.test(value)) return "08";
  if (/^сентябр/iu.test(value)) return "09";
  if (/^октябр/iu.test(value)) return "10";
  if (/^ноябр/iu.test(value)) return "11";
  if (/^декабр/iu.test(value)) return "12";
  return null;
}

function temporalTokens(value: string): string[] {
  const text = normalized(value);
  const result = new Set(dateTokens(text));
  for (const date of dateTokens(text)) {
    const match = /^(\d{4})-(\d{2})-\d{2}$/u.exec(date);
    if (match) {
      result.add(`y${match[1]}`);
      result.add(`m${match[2]}`);
      result.add(`${match[1]}-${match[2]}`);
    }
  }
  for (const match of text.matchAll(/[\p{L}ё]+/giu)) {
    const month = monthNumber(match[0]);
    if (!month) continue;
    result.add(`m${month}`);
    const start = Math.max(0, (match.index ?? 0) - 12);
    const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 12);
    const year = /(?:19|20|21)\d{2}/u.exec(text.slice(start, end))?.[0];
    if (year) {
      result.add(`y${year}`);
      result.add(`${year}-${month}`);
    }
  }
  for (const year of text.match(/(?<!\d)(?:19|20|21)\d{2}(?!\d)/gu) ?? []) {
    result.add(`y${year}`);
  }
  return [...result];
}

function withoutCitationMarkup(value: string): string {
  return value.replace(rawKnowledgeHandle, "").replace(/\s+/gu, " ").trim();
}

function normalizeCitationSyntax(value: string): string {
  const normalizeGroup = (match: string, body: string): string => {
    const handles = body.match(citationHandleToken)?.map((handle) => handle.toUpperCase()) ?? [];
    return handles.length > 0 && handles.every((handle) => decodeKnowledgeCitationHandle(handle))
      ? handles.map((handle) => `[${handle}]`).join("")
      : match;
  };
  return [squareCitationGroup, roundCitationGroup, fullWidthCitationGroup]
    .reduce((answer, pattern) => answer.replace(pattern, normalizeGroup), value);
}

function substantive(value: string): boolean {
  const plain = withoutCitationMarkup(value)
    .replace(/^(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)/u, "")
    .trim();
  return tokens(plain).length >= 3 || numericTokens(plain).length > 0;
}

function sentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function citedHandles(value: string): string[] {
  return [...new Set(knowledgeCitationHandlesFromText(value))];
}

function rawHandles(value: string): string[] {
  return [...value.matchAll(rawKnowledgeHandle)].flatMap((match) => match[1] ? [match[1]] : []);
}

function itemSupportText(item: KnowledgeEvidencePackageItem): string {
  return [
    item.excerpt ?? "",
    item.baseName ?? "",
    item.sourceName ?? "",
    item.fileName ?? "",
    item.headingPath.join(" ")
  ].join("\n");
}

function itemObservationText(item: KnowledgeEvidencePackageItem): string {
  return [item.excerpt ?? "", item.headingPath.join(" ")].join("\n");
}

type TypedGroundingCandidate = Readonly<{
  context: KnowledgeDocumentContextV1;
  item: KnowledgeEvidencePackageItem;
}>;

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function projectionEvidenceIdentity(item: KnowledgeEvidencePackageItem, rowId: string): string | null {
  if (!item.knowledgeBaseId || !item.sourceArtifactId || !item.sourceId || !item.sourceVersionId ||
    !item.documentId || !item.documentVersionId || !item.sectionId || !item.locator ||
    !Number.isSafeInteger(item.sourceVersionNumber) || item.sourceVersionNumber === null ||
    item.sourceVersionNumber < 1) return null;
  return JSON.stringify([
    rowId,
    item.knowledgeBaseId,
    item.sourceArtifactId,
    item.sourceId,
    item.sourceVersionId,
    item.sourceVersionNumber,
    item.documentId,
    item.documentVersionId,
    item.sectionId,
    item.locator.page,
    item.headingPath
  ]);
}

function mergedProjectionContext(
  items: readonly KnowledgeEvidencePackageItem[]
): TypedGroundingCandidate | null {
  if (items.length < 1 || items.some((item) => item.state !== "available" || !item.excerpt ||
    item.textTruncated !== false || item.contextBoundaries?.layoutKind !== "table_row_projection" ||
    !item.contextBoundaries.documentContext)) return null;
  const decoded = items.map((item) => ({
    context: decodeKnowledgeDocumentContext(item.contextBoundaries!.documentContext!),
    item
  }));
  if (decoded.some(({ context }) => context?.locator.kind !== "table_row_projection")) return null;
  const projections = decoded as Array<Readonly<{
    context: KnowledgeDocumentContextV1 & Readonly<{
      locator: KnowledgeTableRowProjectionLocatorV1;
    }>;
    item: KnowledgeEvidencePackageItem;
  }>>;
  projections.sort((left, right) =>
    left.context.locator.projectionIndex - right.context.locator.projectionIndex);
  const locators = projections.map(({ context }) => context.locator);
  if (!isCompleteKnowledgeTableRowProjectionSequence(locators)) return null;
  const first = projections[0]!;
  const identity = projectionEvidenceIdentity(first.item, first.context.locator.rowId);
  if (!identity || projections.some(({ context, item }) =>
    context.locator.rowId !== first.context.locator.rowId ||
    context.locator.blockId !== first.context.locator.blockId ||
    context.locator.rowIndex !== first.context.locator.rowIndex ||
    context.locator.rowKind !== first.context.locator.rowKind ||
    projectionEvidenceIdentity(item, context.locator.rowId) !== identity ||
    !sameStrings(item.headingPath, first.item.headingPath))) return null;

  const headerRows = new Set<number>();
  const headers = new Map<string, KnowledgeTableRowProjectionLocatorV1["headerLineage"][number]>();
  const cells: Array<Readonly<{ columnEnd: number; columnStart: number; text: string }>> = [];
  for (const { context } of projections) {
    const locator = context.locator;
    for (const header of locator.headerLineage) {
      if (header.columnStart < locator.columnStart || header.columnEnd > locator.columnEnd) return null;
      headerRows.add(header.rowIndex);
      headers.set(JSON.stringify([
        header.columnStart,
        header.columnEnd,
        header.rowIndex,
        header.text
      ]), header);
    }
    for (const observation of context.observations) {
      const origin = observation.origin;
      if (origin.kind !== "table_cell" || origin.columnStart < locator.columnStart ||
        origin.columnEnd > locator.columnEnd || !observation.rawValue) return null;
      cells.push(Object.freeze({
        columnEnd: origin.columnEnd,
        columnStart: origin.columnStart,
        text: observation.rawValue
      }));
    }
  }
  if (headerRows.size > 1 || cells.length < 1 || cells.length > 200) return null;
  try {
    const context = createKnowledgeTableDocumentContext({
      blockId: first.context.locator.blockId,
      cells: Object.freeze(cells),
      headerLineage: Object.freeze([...headers.values()].sort((left, right) =>
        left.columnStart - right.columnStart || left.columnEnd - right.columnEnd ||
        left.rowIndex - right.rowIndex || left.text.localeCompare(right.text))),
      rowIndex: first.context.locator.rowIndex,
      rowKind: first.context.locator.rowKind
    });
    return Object.freeze({ context, item: first.item });
  } catch {
    return null;
  }
}

function typedGroundingCandidates(
  items: readonly KnowledgeEvidencePackageItem[]
): readonly TypedGroundingCandidate[] {
  const direct: TypedGroundingCandidate[] = [];
  const groups = new Map<string, KnowledgeEvidencePackageItem[]>();
  for (const item of items) {
    const rawContext = item.contextBoundaries?.documentContext;
    if (item.state !== "available" || !item.excerpt || item.textTruncated !== false || !rawContext) {
      continue;
    }
    const context = decodeKnowledgeDocumentContext(rawContext);
    if (!context) continue;
    if (context.locator.kind !== "table_row_projection") {
      direct.push(Object.freeze({ context, item }));
      continue;
    }
    const key = projectionEvidenceIdentity(item, context.locator.rowId);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const merged = mergedProjectionContext(group);
    if (merged) direct.push(merged);
  }
  return Object.freeze(direct);
}

function claimPayload(value: string): string {
  return withoutCitationMarkup(value)
    .replace(/^(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)/u, "")
    .trim();
}

function observationLabelTokens(
  value: string,
  evidenceLabelVocabulary: ReadonlySet<string>
): string[] {
  return [...new Set([
    ...labelTokens(value).filter((token) => evidenceLabelVocabulary.has(token)),
    ...acronymLabelTokens(value)
  ])];
}

function explicitTrailingObservationLabels(value: string): string[] {
  const english = trailingEnglishMetricLabel.exec(value);
  const russian = trailingRussianMetricLabel.exec(value);
  const label = english?.[1] ?? english?.[2] ?? russian?.[1];
  return label ? [...new Set([...labelTokens(label), ...acronymLabelTokens(label)])] : [];
}

function itemsSupportScalarsAndDates(
  items: readonly KnowledgeEvidencePackageItem[],
  value: string,
  evidenceLabelVocabulary: ReadonlySet<string>,
  observationVocabulary: KnowledgeObservationGroundingVocabularyV1,
  additionalRequiredLabels: readonly string[] = []
): boolean {
  if (numericComparisonClaim.test(normalized(value))) return false;
  const typedItems = items.filter((item) => item.contextBoundaries?.documentContext);
  if (typedGroundingCandidates(typedItems).some(({ context, item }) =>
    assessKnowledgeObservationGroundingV1({
      claim: value,
      context,
      requiredMetricTokens: additionalRequiredLabels,
      sourceVersionNumber: item.sourceVersionNumber,
      vocabulary: observationVocabulary
    }).supported)) return true;
  return items.filter((item) => !item.contextBoundaries?.documentContext &&
    item.contextBoundaries?.layoutKind !== "field_ambiguous" &&
    item.contextBoundaries?.layoutKind !== "table_ambiguous").some((item) => {
    const observation = itemObservationText(item);
    const supportScalars = new Set(scalarTokens(item.excerpt ?? ""));
    const supportDates = new Set(temporalTokens(itemSupportText(item)));
    const requiredLabels = new Set([
      ...observationLabelTokens(value, evidenceLabelVocabulary),
      ...additionalRequiredLabels
    ]);
    const supportLabels = new Set(tokens(observation).map(labelStem));
    return scalarTokens(value).every((token) => supportScalars.has(token)) &&
      temporalTokens(value).every((token) => supportDates.has(token)) &&
      [...requiredLabels].every((token) => supportLabels.has(token));
  });
}

type CitedObservationSegment = Readonly<{
  continuesPreviousObservation: boolean;
  explicitLabels: readonly string[];
  hasDates: boolean;
  hasLabels: boolean;
  hasScalars: boolean;
  items: readonly KnowledgeEvidencePackageItem[];
  text: string;
}>;

function assembledObservationMismatch(
  segments: readonly CitedObservationSegment[],
  evidenceLabelVocabulary: ReadonlySet<string>,
  observationVocabulary: KnowledgeObservationGroundingVocabularyV1
): boolean {
  let group: CitedObservationSegment[] = [];
  let groupHasDates = false;
  let groupHasLabels = false;
  let groupHasScalars = false;
  const mismatches = (): boolean => {
    if (group.length < 2 || !groupHasScalars || (!groupHasDates && !groupHasLabels)) return false;
    const observation = group.map((segment) => segment.text).join(" ");
    const candidates = group.flatMap((segment) => segment.items);
    const explicitLabels = group.flatMap((segment) => segment.explicitLabels);
    return !itemsSupportScalarsAndDates(
      candidates,
      observation,
      evidenceLabelVocabulary,
      observationVocabulary,
      explicitLabels
    );
  };
  for (const segment of segments) {
    const beginsNewLabeledObservation = groupHasScalars && groupHasLabels && segment.hasLabels &&
      !segment.hasDates && !segment.hasScalars && !segment.continuesPreviousObservation;
    if (beginsNewLabeledObservation || (groupHasDates && segment.hasDates) ||
      (groupHasScalars && segment.hasScalars)) {
      if (mismatches()) return true;
      group = [];
      groupHasDates = false;
      groupHasLabels = false;
      groupHasScalars = false;
    }
    group.push(segment);
    groupHasDates ||= segment.hasDates;
    groupHasLabels ||= segment.hasLabels;
    groupHasScalars ||= segment.hasScalars;
  }
  return mismatches();
}

function sourceLocalNumericAssessment(
  claim: string,
  byHandle: ReadonlyMap<string, KnowledgeEvidencePackageItem>
): Readonly<{ mismatch: boolean; uncited: boolean }> {
  const hasEvidenceValues = (value: string): boolean =>
    scalarTokens(claimPayload(value)).length > 0 || temporalTokens(claimPayload(value)).length > 0;
  if (!hasEvidenceValues(claim)) return { mismatch: false, uncited: false };
  const evidenceLabelVocabulary = new Set([...byHandle.values()].flatMap((item) =>
    item.state === "available" && item.excerpt
      ? tokens(itemObservationText(item)).map(labelStem)
      : []));
  const observationVocabulary = createKnowledgeObservationGroundingVocabularyV1(
    typedGroundingCandidates([...byHandle.values()]).map(({ context }) => context)
  );
  let cursor = 0;
  let mismatch = false;
  let uncited = false;
  let lastCitedItems: readonly KnowledgeEvidencePackageItem[] = [];
  const citedObservationSegments: CitedObservationSegment[] = [];
  for (const match of claim.matchAll(citationRun)) {
    const start = match.index ?? 0;
    const segment = claim.slice(cursor, start);
    const items = citedHandles(match[0]).flatMap((handle) => {
      const item = byHandle.get(handle);
      return item?.state === "available" && item.excerpt ? [item] : [];
    });
    lastCitedItems = items;
    const hasDates = temporalTokens(segment).length > 0;
    const hasLabels = observationLabelTokens(segment, evidenceLabelVocabulary).length > 0;
    const hasScalars = scalarTokens(segment).length > 0;
    if ((hasDates || hasLabels || hasScalars) && items.length > 0) {
      citedObservationSegments.push({
        continuesPreviousObservation: false,
        explicitLabels: [],
        hasDates,
        hasLabels,
        hasScalars,
        items,
        text: segment
      });
    }
    if (hasEvidenceValues(segment)) {
      if (items.length === 0) uncited = true;
      else if (!itemsSupportScalarsAndDates(
        items,
        segment,
        evidenceLabelVocabulary,
        observationVocabulary
      )) mismatch = true;
    }
    cursor = start + match[0].length;
  }
  const trailing = claim.slice(cursor);
  if (hasEvidenceValues(trailing)) uncited = true;
  const trailingLabels = explicitTrailingObservationLabels(trailing);
  if (!hasEvidenceValues(trailing) && trailingLabels.length > 0 && lastCitedItems.length > 0) {
    citedObservationSegments.push({
      continuesPreviousObservation: true,
      explicitLabels: trailingLabels,
      hasDates: false,
      hasLabels: true,
      hasScalars: false,
      items: lastCitedItems,
      text: trailing
    });
  }
  if (assembledObservationMismatch(
    citedObservationSegments,
    evidenceLabelVocabulary,
    observationVocabulary
  )) mismatch = true;
  return { mismatch, uncited };
}

function internalIdentityPresent(
  claim: string,
  items: readonly KnowledgeEvidencePackageItem[]
): boolean {
  const sentinels = items.flatMap((item) => [
    item.id,
    item.knowledgeBaseId,
    item.sourceId,
    item.sourceVersionId,
    item.sourceArtifactId,
    item.documentId,
    item.documentVersionId,
    item.sectionId,
    item.passageId,
    item.contentHash
  ].filter((entry): entry is string => Boolean(entry && entry.length >= 8)));
  return sentinels.some((entry) => claim.includes(entry));
}

function sourceInstructionFollowed(
  claim: string,
  query: string,
  items: readonly KnowledgeEvidencePackageItem[]
): boolean {
  const excerpts = items.flatMap((item) => item.state === "available" && item.excerpt
    ? [item.excerpt]
    : []);
  if (!excerpts.some((excerpt) => sourceInstructionCue.test(excerpt))) return false;
  if (instructionAnalysisQuery.test(query) && instructionReportedAsData.test(claim)) return false;
  if (sourceInstructionCue.test(claim)) return true;
  const normalizedClaim = normalized(withoutCitationMarkup(claim));
  return excerpts.some((excerpt) => [...excerpt.matchAll(sourceInstructionPayload)]
    .some((match) => match[1] && normalizedClaim.includes(normalized(match[1]))));
}

function assessClaim(
  claim: string,
  input: KnowledgeEvidencePackage,
  byHandle: ReadonlyMap<string, KnowledgeEvidencePackageItem>,
  answerHasAvailableCitation: boolean
): ClaimAssessment {
  const parsed = citedHandles(claim);
  const raw = rawHandles(claim);
  const citedItems = parsed.flatMap((handle) => {
    const item = byHandle.get(handle);
    return item ? [item] : [];
  });
  const availableCitedItems = citedItems.filter((item) =>
    item.state === "available" && Boolean(item.excerpt));
  const numericAssessment = sourceLocalNumericAssessment(claim, byHandle);
  const instructionFollowed = sourceInstructionFollowed(
    claim,
    input.originalIntent.query,
    citedItems.length > 0 ? citedItems : input.items
  );
  if ((!substantive(claim) && !instructionFollowed) || honestNoAnswer.test(claim) ||
    (explicitGeneralKnowledge.test(claim) && !instructionFollowed)) {
    return {
      cited: false,
      citationCount: 0,
      issueCodes: [],
      keep: true,
      sourceClaim: false,
      text: claim,
      validCitationCount: 0
    };
  }
  const invalid = raw.filter((handle) => !decodeKnowledgeCitationHandle(handle) || !byHandle.has(handle));
  const issues = new Set<KnowledgeGroundingIssueCode>();
  if (invalid.length > 0) issues.add("invalid_handle");
  if (internalIdentityPresent(claim, input.items)) issues.add("internal_identity");
  if (instructionFollowed) issues.add("source_instruction_followed");
  const universalClaimGate = gateKnowledgeUniversalClaimsV1(
    claim,
    input.strategyCoverage,
    input.groundingDispatch?.manifestHash
  );
  const coverageClaimPresent = coverageClaim.test(claim) || universalClaimGate.claims.length > 0;
  if (coverageClaimPresent && (!input.coverage.verified || !input.groundingDispatch ||
    !universalClaimGate.allowed || universalClaimGate.claims.length === 0)) {
    issues.add("coverage_overclaim");
  }
  if (numericAssessment.uncited) {
    issues.add("unsupported_claim");
  } else if (raw.length === 0 && !answerHasAvailableCitation) {
    issues.add("general_knowledge_unseparated");
  } else if (raw.length > 0 && availableCitedItems.length === 0) {
    issues.add("unsupported_claim");
  } else if (numericAssessment.mismatch) {
    issues.add("numeric_or_date_mismatch");
  }
  return {
    cited: raw.length > 0,
    citationCount: raw.length,
    issueCodes: [...issues],
    keep: issues.size === 0,
    sourceClaim: raw.length > 0 || numericAssessment.uncited || numericAssessment.mismatch ||
      !answerHasAvailableCitation,
    text: claim,
    validCitationCount: availableCitedItems.length
  };
}

function noAnswerText(query: string): string {
  const russian = /\p{Script=Cyrillic}/u.test(query);
  return russian
    ? "Мне не удалось найти в выбранных источниках достаточно подтверждений для надёжного ответа."
    : "I couldn't find enough support in the selected sources to answer reliably.";
}

function citationBindingFailureText(query: string): string {
  const russian = /\p{Script=Cyrillic}/u.test(query);
  return russian
    ? "Я нашёл релевантные сведения в выбранных источниках, но не смог надёжно привязать к ответу цитаты; попробуйте повторить запрос."
    : "I found relevant information in the selected sources but could not reliably attach citations to the answer; please try again.";
}

export function groundKnowledgeAnswer(input: Readonly<{
  answer: string;
  evidence: KnowledgeEvidencePackage;
}>): KnowledgeGroundingResult {
  if (input.evidence.structuredClarifications?.length) {
    const finalText = input.evidence.structuredClarifications.join("\n");
    const passed = input.answer.trim() === finalText;
    return {
      diagnostics: {
        citationCoverage: 1,
        citationPrecision: 1,
        citedClaimCount: 0,
        issueCodes: [],
        sourceClaimCount: 0,
        unsupportedClaimCount: 0
      },
      finalAnswerHash: hash(finalText),
      finalText,
      originalAnswerHash: hash(input.answer),
      outcome: passed ? "passed" : "repaired",
      receiptHash: knowledgeEvidenceReceiptHash(input.evidence),
      repairCount: passed ? 0 : KNOWLEDGE_GROUNDING_MAX_REPAIRS,
      sessionId: input.evidence.sessionId,
      version: KNOWLEDGE_GROUNDING_VERSION
    };
  }
  const originalText = input.answer.trim();
  const normalizedAnswer = normalizeCitationSyntax(originalText);
  const citationSyntaxRepaired = normalizedAnswer !== originalText;
  const byHandle = new Map(input.evidence.items.map((item) => [item.handle, item]));
  const answerHasAvailableCitation = citedHandles(normalizedAnswer).some((handle) => {
    const item = byHandle.get(handle);
    return item?.state === "available" && Boolean(item.excerpt);
  });
  const assessments = sentences(normalizedAnswer).map((claim) =>
    assessClaim(claim, input.evidence, byHandle, answerHasAvailableCitation));
  const issueCodes = new Set(assessments.flatMap((claim) => claim.issueCodes));
  const sourceClaims = assessments.filter((claim) => claim.sourceClaim);
  const supported = sourceClaims.filter((claim) => claim.keep);
  const totalCitations = assessments.reduce((total, claim) => total + claim.citationCount, 0);
  const validCitations = assessments.reduce((total, claim) =>
    total + (claim.keep ? claim.validCitationCount : 0), 0);
  const mustRepair = issueCodes.size > 0 || input.evidence.items.every((item) =>
    item.state !== "available");
  let finalText = normalizedAnswer;
  let outcome: KnowledgeGroundingResult["outcome"] = citationSyntaxRepaired
    ? "repaired"
    : "passed";
  let repairCount: 0 | 1 = citationSyntaxRepaired ? KNOWLEDGE_GROUNDING_MAX_REPAIRS : 0;
  if (mustRepair) {
    repairCount = KNOWLEDGE_GROUNDING_MAX_REPAIRS;
    const safeClaims = assessments.filter((claim) => claim.keep).map((claim) => claim.text);
    const hasSupportedSourceClaim = supported.length > 0;
    const fallback = issueCodes.size === 1 && issueCodes.has("general_knowledge_unseparated") &&
      input.evidence.items.some((item) => item.state === "available" && Boolean(item.excerpt))
      ? citationBindingFailureText(input.evidence.originalIntent.query)
      : noAnswerText(input.evidence.originalIntent.query);
    finalText = hasSupportedSourceClaim && safeClaims.length > 0
      ? `${safeClaims.join(" ")}\n\n${fallback}`
      : fallback;
    outcome = hasSupportedSourceClaim ? "repaired" : "no_answer";
  }
  const citationCoverage = sourceClaims.length === 0 ? 1 : supported.length / sourceClaims.length;
  const citationPrecision = totalCitations === 0 ? (sourceClaims.length === 0 ? 1 : 0) :
    validCitations / totalCitations;
  return {
    diagnostics: {
      citationCoverage,
      citationPrecision,
      citedClaimCount: sourceClaims.filter((claim) => claim.cited).length,
      issueCodes: [...issueCodes].sort(),
      sourceClaimCount: sourceClaims.length,
      unsupportedClaimCount: sourceClaims.length - supported.length
    },
    finalAnswerHash: hash(finalText),
    finalText,
    originalAnswerHash: hash(input.answer),
    outcome,
    receiptHash: knowledgeEvidenceReceiptHash(input.evidence),
    repairCount,
    sessionId: input.evidence.sessionId,
    version: KNOWLEDGE_GROUNDING_VERSION
  };
}

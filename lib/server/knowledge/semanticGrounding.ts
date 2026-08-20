import { knowledgeCitationHandlesFromText } from "../../contracts/knowledge";
import type {
  KnowledgeEvidencePackage,
  KnowledgeEvidencePackageItem
} from "./evidencePackage";

export const KNOWLEDGE_SEMANTIC_GROUNDING_CONTRACT_VERSION = 1 as const;
export const KNOWLEDGE_SEMANTIC_CONFIDENCE_SCALE = 1_000_000 as const;
export const KNOWLEDGE_SEMANTIC_NEIGHBORHOOD_VERSION = 2 as const;

export const knowledgeSemanticClaimTypes = Object.freeze([
  "comparison",
  "coverage_claim",
  "derived_arithmetic",
  "explicit_inference",
  "general_knowledge",
  "non_factual",
  "source_fact",
  "source_summary",
  "temporal_observation",
  "versioned_fact"
] as const);

export const knowledgeSemanticGroundingDecisions = Object.freeze([
  "contradicted",
  "supported",
  "uncertain",
  "unsupported"
] as const);

export const knowledgeSemanticReasonFamilies = Object.freeze([
  "deterministic_receipt",
  "entailed",
  "insufficient_context",
  "no_evidence",
  "not_supported",
  "same_context_conflict",
  "structural_baseline"
] as const);

export type KnowledgeSemanticClaimType = typeof knowledgeSemanticClaimTypes[number];
export type KnowledgeSemanticGroundingDecision =
  typeof knowledgeSemanticGroundingDecisions[number];
export type KnowledgeSemanticReasonFamily = typeof knowledgeSemanticReasonFamilies[number];
export type KnowledgeSemanticSourceShape = "list" | "prose" | "table_cell";
export type KnowledgeSemanticNeighborhoodRule =
  | "inline"
  | "none"
  | "table_cell"
  | "table_row_inherited";
export type KnowledgeSemanticLocatorState = "deleted" | "invalid" | "missing" | "valid";

export type KnowledgeSemanticGroundingClaim = Readonly<{
  answerEnd: number;
  answerStart: number;
  citationHandles: readonly string[];
  context: readonly string[];
  evidenceItems: readonly KnowledgeEvidencePackageItem[];
  locatorStates: readonly Readonly<{
    handle: string;
    state: KnowledgeSemanticLocatorState;
  }>[];
  neighborhoodRule: KnowledgeSemanticNeighborhoodRule;
  neighborhoodVersion: typeof KNOWLEDGE_SEMANTIC_NEIGHBORHOOD_VERSION;
  ordinal: number;
  sourceShape: KnowledgeSemanticSourceShape;
  text: string;
  type: KnowledgeSemanticClaimType;
  unknownCitationHandles: readonly string[];
}>;

export type KnowledgeSemanticGroundingPrediction = Readonly<{
  attributableHandles: readonly string[];
  confidence: number;
  decision: KnowledgeSemanticGroundingDecision;
  claimOrdinal: number;
  reasonFamily: KnowledgeSemanticReasonFamily;
  validatorProfile: string;
  validatorVersion: number;
  version: typeof KNOWLEDGE_SEMANTIC_GROUNDING_CONTRACT_VERSION;
}>;

const rawCitation = /\[\s*(K[^\]\s]{0,16})\s*\]/gu;
const citationMarkup = /\[(?:K[1-9]\d{0,3}(?:\.[1-9]\d?)?)\]/gu;
const tableSeparatorCell = /^:?-{3,}:?$/u;
const generalKnowledge = /^(?:general knowledge|in general|outside (?:the )?selected sources|общие сведения|в общем случае|вне выбранных источников)\s*[:—-]/iu;
const explicitInference = /^(?:inference|therefore|thus|logical inference|вывод|следовательно|логический вывод)\s*[:—-]?/iu;
const honestNoAnswer = /(?:could(?:n't| not) find|not (?:found|stated|specified) in (?:the )?selected sources|insufficient evidence|не удалось найти|недостаточно (?:данных|сведений|доказательств)|в выбранных источниках[^.!?]*(?:не найден|не указ|нет))/iu;
const coverageClaim = /(?:\ball (?:selected )?(?:sources|documents|files)\b|\bevery (?:source|document|file)\b|\bentire corpus\b|все (?:выбранные )?(?:источники|документы|файлы)|кажд(?:ый|ом|ого) (?:источник|документ|файл)|весь корпус)/iu;
const arithmeticClaim = /(?:\b(?:average|difference|mean|median|percent change|sum|total)\b|\d+(?:[.,]\d+)?\s+[+*/-]\s+\d+(?:[.,]\d+)?|(?:итог|разниц|средн|сумм|процентн\p{L}* изменен)\p{L}*)/iu;
const versionClaim = /(?:\b(?:edition|revision|version)\b|\b(?:current|latest|previous) policy\b|(?:редакц|верси|текущ\p{L}* политик|предыдущ\p{L}* политик)\p{L}*)/iu;
const comparisonClaim = /(?:\b(?:but|compare|compared|comparison|conflict|difference|differs?|disagree|versus|whereas|while)\b|(?<![\p{L}\p{N}])(?:конфликт|но|однако|различ|расход|сравн|тогда как)\p{L}*(?![\p{L}\p{N}]))/iu;
const summaryClaim = /(?:\b(?:summary|summarizes|overview)\b|\b(?:обзор|сводк|резюме)\p{L}*\b)/iu;
const dateLike = /(?<![\p{L}\p{N}])(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})(?![\p{L}\p{N}])/u;
const token = /[\p{L}\p{N}][\p{L}\p{M}\p{N}_-]*/gu;
const trailingCitationMarkup = /(?:\s*\[K[1-9]\d{0,3}(?:\.[1-9]\d?)?\])+\s*[.!?;:]?\s*$/u;
const englishPredicate = /\b(?:am|are|became|becomes?|can|contains?|did|does|equals?|fell|grew|had|has|have|includes?|increased|is|may|measured|measures?|must|needs?|permits?|prohibits?|remained|remains?|reports?|requires?|should|states?|supports?|uses?|was|were|will)\b/iu;
const russianPredicate = /(?<![\p{L}\p{N}])(?:актив(?:ен|на|но|ны)|включ(?:ен|ена|ено|ены|ён|ёна|ёно|ёны)|доступ(?:ен|на|но|ны)|заверш(?:ен|ена|ено|ены|ён|ёна|ёно|ёны)|запрещ(?:ен|ена|ено|ены|ён|ёна|ёно|ёны)|имеет|использует|может|нужен|нужна|нужно|нужны|остается|остаётся|поддерживает|показал|показала|показывает|приостанов(?:лен|лена|лено|лены)|равен|равна|равно|равны|разреш(?:ен|ена|ено|ены|ён|ёна|ёно|ёны)|составляет|сообщает|требует|требуется|является|[\p{L}]{4,}(?:ает|яет|ует|юет|еет|ёт|ет|ит|ат|ят|ут|ют|ется|ётся|ются|ились|илась|ился))(?![\p{L}\p{N}])/iu;
const captionPrefix = /^(?:(?:caption|chart|diagram|fig(?:ure)?\.?|table)\s*(?:№\s*)?\d*|(?:график|диаграмма|подпись|рис(?:унок)?|таблица)\s*(?:№\s*)?\d*)\s*(?:[:.—-]\s*)?/iu;
const citationHeader = /^(?:citation(?:s)?|cite|evidence|reference(?:s)?|source(?:s)?|доказательств(?:о|а)?|источник(?:и)?|ссылк\p{L}*)$/iu;

type Line = Readonly<{
  end: number;
  start: number;
  text: string;
}>;

type Cell = Readonly<{
  end: number;
  start: number;
  text: string;
}>;

type RelativeRange = Readonly<{
  end: number;
  start: number;
}>;

type ListLine = Readonly<{
  content: string;
  indent: number;
  line: Line;
}>;

type BlockContext = Readonly<{
  citationScopes: readonly (readonly string[])[];
  values: readonly string[];
}>;

type ClaimDraft = Readonly<{
  answerEnd: number;
  answerStart: number;
  citationHandles?: readonly string[];
  context: readonly string[];
  neighborhoodRule?: KnowledgeSemanticNeighborhoodRule;
  sourceShape: KnowledgeSemanticSourceShape;
  text: string;
}>;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function lines(value: string): Line[] {
  const result: Line[] = [];
  let start = 0;
  for (const raw of value.split("\n")) {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    result.push(Object.freeze({ end: start + text.length, start, text }));
    start += raw.length + 1;
  }
  return result;
}

function handles(value: string): string[] {
  return unique(knowledgeCitationHandlesFromText(value));
}

function unknownHandles(value: string): string[] {
  const valid = new Set(handles(value));
  return unique([...value.matchAll(rawCitation)].flatMap((match) => {
    const candidate = match[1];
    return candidate && !valid.has(candidate) ? [candidate] : [];
  }));
}

function sameHandles(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function unescapedPipeIndexes(value: string): number[] {
  const result: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "|") continue;
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) result.push(index);
  }
  return result;
}

function tableCells(line: Line): Cell[] {
  const pipeIndexes = unescapedPipeIndexes(line.text);
  if (pipeIndexes.length < 2) return [];
  const result: Cell[] = [];
  for (let index = 0; index < pipeIndexes.length - 1; index += 1) {
    const rawStart = pipeIndexes[index]! + 1;
    const rawEnd = pipeIndexes[index + 1]!;
    const raw = line.text.slice(rawStart, rawEnd);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const start = line.start + rawStart + leading;
    const end = line.start + rawEnd - trailing;
    result.push(Object.freeze({ end, start, text: raw.trim() }));
  }
  return result;
}

function tableLine(line: Line): boolean {
  const trimmed = line.text.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && tableCells(line).length > 0;
}

function tableSeparator(line: Line): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => tableSeparatorCell.test(cell.text));
}

function withoutMarkup(value: string): string {
  return value.replace(citationMarkup, "").replace(/\s+/gu, " ")
    .replace(/\s+([,.;:!?])/gu, "$1").trim();
}

function substantive(value: string, contextual = false): boolean {
  const normalized = withoutMarkup(value)
    .replace(/^(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)/u, "")
    .trim();
  const tokenCount = (normalized.match(token) ?? []).length;
  return tokenCount >= 2 || tokenCount >= 1 && (contextual || handles(value).length > 0) ||
    /\d/u.test(normalized) || honestNoAnswer.test(normalized);
}

function claimType(value: string, claimText = value): KnowledgeSemanticClaimType {
  const text = withoutMarkup(value);
  const localText = withoutMarkup(claimText);
  if (!substantive(value)) return "non_factual";
  if (generalKnowledge.test(localText)) return "general_knowledge";
  if (explicitInference.test(localText)) return "explicit_inference";
  if (honestNoAnswer.test(localText)) return "source_summary";
  if (coverageClaim.test(text)) return "coverage_claim";
  if (arithmeticClaim.test(text)) return "derived_arithmetic";
  if (versionClaim.test(text)) return "versioned_fact";
  if (comparisonClaim.test(text)) return "comparison";
  if (dateLike.test(text)) return "temporal_observation";
  if (summaryClaim.test(text)) return "source_summary";
  return "source_fact";
}

function trimRange(value: string, range: RelativeRange): RelativeRange | null {
  const raw = value.slice(range.start, range.end);
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  const start = range.start + leading;
  const end = range.end - trailing;
  return start < end ? Object.freeze({ end, start }) : null;
}

function predicateHasSubject(value: string, predicate: RegExp): boolean {
  const match = predicate.exec(value);
  if (!match || match.index === undefined) return false;
  return (value.slice(0, match.index).match(token) ?? []).length > 0;
}

function independentProposition(value: string): boolean {
  const normalized = withoutMarkup(value)
    .replace(/^[\s,;:]+/u, "")
    .replace(/^(?:\(?[\p{L}\p{N}]{1,4}\)|\d+[.)])\s+/u, "")
    .trim();
  if ((normalized.match(token) ?? []).length < 2) return false;
  if (/^[^:;]{1,80}\s*(?::|—|=)\s*\S+/u.test(normalized)) return true;
  return predicateHasSubject(normalized, englishPredicate) ||
    predicateHasSubject(normalized, russianPredicate);
}

type CoordinationCandidate = Readonly<{
  leftEnd: number;
  rightStart: number;
}>;

function coordinationCandidates(value: string): CoordinationCandidate[] {
  const result: CoordinationCandidate[] = [];
  for (const match of value.matchAll(/,\s*(?:and|и)\s+|\s+(?:and|и)\s+/giu)) {
    const start = match.index ?? 0;
    result.push(Object.freeze({
      leftEnd: match[0].startsWith(",") ? start + 1 : start,
      rightStart: start + match[0].length
    }));
  }
  for (const match of value.matchAll(/,\s+/gu)) {
    const start = match.index ?? 0;
    if (/^\s*(?:and|и)\s+/iu.test(value.slice(start + 1))) continue;
    result.push(Object.freeze({ leftEnd: start + 1, rightStart: start + match[0].length }));
  }
  return result.sort((left, right) =>
    left.leftEnd - right.leftEnd || right.rightStart - left.rightStart);
}

function coordinatedRanges(value: string, range: RelativeRange): RelativeRange[] {
  const local = value.slice(range.start, range.end);
  const result: RelativeRange[] = [];
  let start = 0;
  for (const candidate of coordinationCandidates(local)) {
    if (candidate.leftEnd <= start || candidate.rightStart >= local.length) continue;
    const left = trimRange(local, { end: candidate.leftEnd, start });
    const right = trimRange(local, { end: local.length, start: candidate.rightStart });
    if (!left || !right || !independentProposition(local.slice(left.start, left.end)) ||
      !independentProposition(local.slice(right.start, right.end))) continue;
    result.push(Object.freeze({
      end: range.start + left.end,
      start: range.start + left.start
    }));
    start = candidate.rightStart;
  }
  const finalRange = trimRange(local, { end: local.length, start });
  if (finalRange) {
    result.push(Object.freeze({
      end: range.start + finalRange.end,
      start: range.start + finalRange.start
    }));
  }
  return result.length > 1 ? result : [range];
}

function claimRanges(value: string, contextual: boolean): RelativeRange[] {
  const whole = trimRange(value, { end: value.length, start: 0 });
  if (!whole) return [];
  if (comparisonClaim.test(withoutMarkup(value))) return [whole];
  const boundaries = [...value.matchAll(/;(?=\s*\S)/gu)]
    .map((match) => (match.index ?? 0) + match[0].length);
  const ends = [...boundaries, value.length];
  const candidates = ends.map((end, index) => ({
    end,
    start: index === 0 ? 0 : ends[index - 1]!
  })).map((range) => trimRange(value, range)).filter(
    (range): range is RelativeRange => range !== null
  );
  const semicolonRanges = candidates.length > 1 && candidates.every((range) =>
    substantive(value.slice(range.start, range.end), contextual))
    ? candidates
    : [whole];
  return semicolonRanges.flatMap((range) => coordinatedRanges(value, range));
}

function trailingHandles(value: string): string[] {
  const match = trailingCitationMarkup.exec(value);
  return match ? handles(match[0]) : [];
}

function shareTrailingSyntacticCitations(
  sentence: string,
  drafts: readonly ClaimDraft[]
): readonly ClaimDraft[] {
  if (drafts.length < 2 || unknownHandles(sentence).length > 0) return drafts;
  const terminal = trailingHandles(sentence);
  if (terminal.length === 0 || !sameHandles(handles(sentence), terminal)) return drafts;
  const localHandles = drafts.map((draft) => handles(draft.text));
  if (!localHandles.slice(0, -1).every((entry) => entry.length === 0) ||
    !sameHandles(localHandles.at(-1) ?? [], terminal)) return drafts;
  if (drafts.some((draft) => ["general_knowledge", "source_summary"].includes(
    claimType([...draft.context, draft.text].join(" "), draft.text)
  ))) return drafts;
  return Object.freeze(drafts.map((draft) => Object.freeze({
    ...draft,
    citationHandles: Object.freeze([...terminal]),
    neighborhoodRule: "inline" as const
  })));
}

function proseDrafts(line: Line, headingContext: readonly string[]): ClaimDraft[] {
  const prefix = /^(\s*(?:[-*+]\s+|\d+[.)]\s+))/u.exec(line.text);
  const sourceShape: KnowledgeSemanticSourceShape = prefix ? "list" : "prose";
  const contentStart = prefix?.[1]?.length ?? 0;
  const content = line.text.slice(contentStart);
  const drafts: ClaimDraft[] = [];
  const contextual = sourceShape === "list" || headingContext.length > 0;
  const sentenceBoundaries = [...content.matchAll(
    /[.!?]+(?=\s+(?:[\p{Lu}\p{Lt}#*+-]|\d+[.)]\s)|$)/gu
  )].map((match) => (match.index ?? 0) + match[0].length);
  if (sentenceBoundaries.at(-1) !== content.length) sentenceBoundaries.push(content.length);
  let relative = 0;
  for (const sentenceBoundary of sentenceBoundaries) {
    const sentence = content.slice(relative, sentenceBoundary);
    const sentenceDrafts: ClaimDraft[] = [];
    for (const range of claimRanges(sentence, contextual)) {
      const raw = sentence.slice(range.start, range.end);
      const leading = raw.length - raw.trimStart().length;
      const trailing = raw.length - raw.trimEnd().length;
      const text = raw.trim();
      if (text && substantive(text, contextual)) {
        sentenceDrafts.push(Object.freeze({
          answerEnd: line.start + contentStart + relative + range.start + raw.length - trailing,
          answerStart: line.start + contentStart + relative + range.start + leading,
          context: Object.freeze([...headingContext]),
          sourceShape,
          text
        }));
      }
    }
    drafts.push(...shareTrailingSyntacticCitations(sentence, sentenceDrafts));
    relative = sentenceBoundary;
  }
  return drafts;
}

function citationOnly(value: string): boolean {
  return handles(value).length > 0 && unknownHandles(value).length === 0 &&
    /^[\s.,;:!?]*$/u.test(value.replace(citationMarkup, ""));
}

function resolveCitationScopes(scopes: readonly (readonly string[])[]): string[] {
  const explicit = scopes.filter((scope) => scope.length > 0);
  if (explicit.length === 0 || explicit.some((scope) => !sameHandles(scope, explicit[0]!))) {
    return [];
  }
  return [...explicit[0]!];
}

function inheritBlockCitations(
  drafts: readonly ClaimDraft[],
  scopes: readonly (readonly string[])[]
): ClaimDraft[] {
  const inherited = resolveCitationScopes(scopes);
  if (inherited.length === 0 || drafts.length === 0 || drafts.some((draft) =>
    (draft.citationHandles ?? handles(draft.text)).length > 0 ||
    unknownHandles(draft.text).length > 0)) return [...drafts];
  return drafts.map((draft) => Object.freeze({
    ...draft,
    citationHandles: Object.freeze([...inherited]),
    neighborhoodRule: "inline" as const
  }));
}

function markdownListLine(line: Line): ListLine | null {
  const match = /^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/u.exec(line.text);
  if (!match?.[2]) return null;
  return Object.freeze({
    content: match[2],
    indent: match[1]?.length ?? 0,
    line
  });
}

function listDrafts(block: readonly ListLine[], context: readonly string[]): ClaimDraft[] {
  const drafts: ClaimDraft[] = [];
  const parents: Array<Readonly<{
    citationScopes: readonly (readonly string[])[];
    indent: number;
    value: string;
  }>> = [];
  for (let index = 0; index < block.length; index += 1) {
    const entry = block[index]!;
    while (parents.at(-1) && parents.at(-1)!.indent >= entry.indent) parents.pop();
    const next = block[index + 1];
    const normalized = withoutMarkup(entry.content);
    if (normalized.endsWith(":") && next && next.indent > entry.indent) {
      const terminal = trailingHandles(entry.content);
      parents.push(Object.freeze({
        citationScopes: terminal.length > 0 && sameHandles(handles(entry.content), terminal) &&
          unknownHandles(entry.content).length === 0
          ? Object.freeze([Object.freeze(terminal)])
          : Object.freeze([]),
        indent: entry.indent,
        value: normalized
      }));
      continue;
    }
    const lineContext = Object.freeze([...context, ...parents.map((parent) => parent.value)]);
    const lineDrafts = proseDrafts(entry.line, lineContext);
    drafts.push(...inheritBlockCitations(
      lineDrafts,
      parents.flatMap((parent) => parent.citationScopes)
    ));
  }
  return drafts;
}

function tableDrafts(
  table: readonly Line[],
  headingContext: readonly string[],
  tableCitationScopes: readonly (readonly string[])[] = []
): ClaimDraft[] {
  if (table.length < 3 || !tableSeparator(table[1]!)) return [];
  const headers = tableCells(table[0]!).map((cell) => withoutMarkup(cell.text));
  const localTableCitation = table.slice(2).some((row) =>
    handles(row.text).length > 0 || unknownHandles(row.text).length > 0);
  const inheritedTableHandles = localTableCitation
    ? []
    : resolveCitationScopes(tableCitationScopes);
  const drafts: ClaimDraft[] = [];
  for (const row of table.slice(2)) {
    const cells = tableCells(row);
    if (cells.length < 2 || tableSeparator(row)) continue;
    const rowWidthUnambiguous = cells.length === headers.length;
    const rowCitationCells = cells.flatMap((cell, index) =>
      index > 0 && citationHeader.test(headers[index] ?? "") && citationOnly(cell.text)
        ? [{ cell, index }]
        : []);
    const inlineValueCitation = cells.some((cell, index) =>
      index > 0 && !rowCitationCells.some((entry) => entry.index === index) &&
      handles(cell.text).length > 0);
    const rowHasAmbiguousCitation = unknownHandles(row.text).length > 0 ||
      handles(cells[0]?.text ?? "").length > 0;
    const inheritedRowHandles = rowWidthUnambiguous && rowCitationCells.length === 1 &&
      !inlineValueCitation && !rowHasAmbiguousCitation
      ? handles(rowCitationCells[0]!.cell.text)
      : [];
    const subject = withoutMarkup(cells[0]?.text ?? "");
    for (let index = 1; index < cells.length; index += 1) {
      const cell = cells[index]!;
      if (rowCitationCells.some((entry) => entry.index === index) ||
        !substantive(cell.text, true)) continue;
      const inlineHandles = handles(cell.text);
      const inherited = inlineHandles.length > 0
        ? inlineHandles
        : unknownHandles(cell.text).length > 0
          ? []
          : inheritedRowHandles.length > 0
            ? inheritedRowHandles
            : rowWidthUnambiguous
              ? inheritedTableHandles
              : [];
      drafts.push(Object.freeze({
        answerEnd: cell.end,
        answerStart: cell.start,
        citationHandles: Object.freeze(inherited),
        context: Object.freeze([
          ...headingContext,
          ...(subject ? [`${headers[0] || "row"}: ${subject}`] : []),
          ...(headers[index] ? [headers[index]!] : [])
        ]),
        neighborhoodRule: inlineHandles.length > 0
          ? "table_cell"
          : inherited.length > 0
            ? "table_row_inherited"
            : "none",
        sourceShape: "table_cell",
        text: cell.text
      }));
    }
  }
  return drafts;
}

function markdownHeading(line: Line): Readonly<{ level: number; value: string }> | null {
  const match = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line.text);
  if (!match?.[1] || !match[2]) return null;
  const value = withoutMarkup(match[2]);
  return value ? Object.freeze({ level: match[1].length, value }) : null;
}

function contextLine(line: Line, next: Line): BlockContext | null {
  const bold = /^\s*\*\*(.+?)\*\*\s*$/u.exec(line.text);
  const normalized = withoutMarkup(bold?.[1] ?? line.text);
  if (!normalized || citationOnly(line.text)) return null;
  const nextIsStructured = tableLine(next) || markdownListLine(next) !== null;
  const caption = captionPrefix.exec(normalized);
  const captionRemainder = caption ? normalized.slice(caption[0].length).trim() : "";
  const shortColonLead = normalized.endsWith(":") &&
    (normalized.match(token) ?? []).length <= 6;
  const isContext = bold !== null || caption !== null && (
    nextIsStructured || !independentProposition(captionRemainder)
  ) || shortColonLead && (nextIsStructured || !independentProposition(normalized));
  if (!isContext) return null;
  const terminal = trailingHandles(line.text);
  const citationScopes = terminal.length > 0 && sameHandles(handles(line.text), terminal) &&
    unknownHandles(line.text).length === 0
    ? Object.freeze([Object.freeze(terminal)])
    : Object.freeze([]);
  return Object.freeze({
    citationScopes,
    values: Object.freeze([normalized])
  });
}

function mergeBlockContext(
  current: BlockContext | null,
  additional: BlockContext
): BlockContext {
  return Object.freeze({
    citationScopes: Object.freeze([
      ...(current?.citationScopes ?? []),
      ...additional.citationScopes
    ]),
    values: Object.freeze([...(current?.values ?? []), ...additional.values])
  });
}

function citationScopeAt(
  answerLines: readonly Line[],
  index: number
): Readonly<{ nextIndex: number; scope: readonly string[] }> {
  const line = answerLines[index];
  if (!line || !citationOnly(line.text)) {
    return Object.freeze({ nextIndex: index, scope: Object.freeze([]) });
  }
  return Object.freeze({
    nextIndex: index + 1,
    scope: Object.freeze(handles(line.text))
  });
}

function locatorState(item: KnowledgeEvidencePackageItem): KnowledgeSemanticLocatorState {
  if (item.state === "deleted") return "deleted";
  if (item.locator === null) return "missing";
  if (!Number.isSafeInteger(item.locator.page) || item.locator.page < 1) return "invalid";
  if (item.locator.ranges !== undefined && (
    item.locator.ranges.length < 1 || item.locator.ranges.length > 64 ||
    item.locator.ranges.some((range) =>
      !/^[A-Z]{1,3}[1-9]\d*:[A-Z]{1,3}[1-9]\d*$/u.test(range.range) ||
      !range.sheet || range.sheet.length > 256 ||
      !Number.isSafeInteger(range.sheetIndex) || range.sheetIndex < 0 || range.sheetIndex >= 64)
  )) return "invalid";
  if (item.locator.blockCoordinates !== undefined && (
    item.locator.blockCoordinates.length > 256 ||
    item.locator.blockCoordinates.some((coordinate) =>
      !Number.isSafeInteger(coordinate.page) || coordinate.page < 1 ||
      [coordinate.x, coordinate.y, coordinate.width, coordinate.height].some((value) =>
        !Number.isFinite(value) || value < 0))
  )) return "invalid";
  return "valid";
}

function freezeClaim(
  draft: ClaimDraft,
  ordinal: number,
  byHandle: ReadonlyMap<string, KnowledgeEvidencePackageItem>
): KnowledgeSemanticGroundingClaim {
  const citationHandles = unique(draft.citationHandles ?? handles(draft.text));
  const evidenceItems = citationHandles.flatMap((handle) => {
    const item = byHandle.get(handle);
    return item ? [item] : [];
  });
  return Object.freeze({
    answerEnd: draft.answerEnd,
    answerStart: draft.answerStart,
    citationHandles: Object.freeze(citationHandles),
    context: Object.freeze([...draft.context]),
    evidenceItems: Object.freeze(evidenceItems),
    locatorStates: Object.freeze(evidenceItems.map((item) => Object.freeze({
      handle: item.handle,
      state: locatorState(item)
    }))),
    neighborhoodRule: draft.neighborhoodRule ??
      (citationHandles.length > 0 ? "inline" : "none"),
    neighborhoodVersion: KNOWLEDGE_SEMANTIC_NEIGHBORHOOD_VERSION,
    ordinal,
    sourceShape: draft.sourceShape,
    text: draft.text,
    type: claimType([...draft.context, draft.text].join(" "), draft.text),
    unknownCitationHandles: Object.freeze(unknownHandles(draft.text))
  });
}

/**
 * Produces private claim-local neighborhoods for a shadow semantic validator.
 * It deliberately never adds uncited Evidence Package items to a claim.
 */
export function segmentKnowledgeSemanticClaims(input: Readonly<{
  answer: string;
  evidence: KnowledgeEvidencePackage;
}>): readonly KnowledgeSemanticGroundingClaim[] {
  const answerLines = lines(input.answer);
  const drafts: ClaimDraft[] = [];
  const headings: Array<string | undefined> = [];
  let pendingContext: BlockContext | null = null;
  for (let index = 0; index < answerLines.length;) {
    const line = answerLines[index]!;
    if (!line.text.trim()) {
      pendingContext = null;
      index += 1;
      continue;
    }
    const heading = markdownHeading(line);
    if (heading) {
      headings.length = heading.level;
      headings[heading.level - 1] = heading.value;
      pendingContext = null;
      index += 1;
      continue;
    }
    const inheritedContext = Object.freeze([
      ...headings.filter((value): value is string => value !== undefined),
      ...(pendingContext?.values ?? [])
    ]);
    if (tableLine(line)) {
      const table: Line[] = [];
      while (index < answerLines.length && tableLine(answerLines[index]!)) {
        table.push(answerLines[index]!);
        index += 1;
      }
      const trailing = citationScopeAt(answerLines, index);
      drafts.push(...tableDrafts(table, inheritedContext, [
        ...(pendingContext?.citationScopes ?? []),
        trailing.scope
      ]));
      pendingContext = null;
      index = trailing.nextIndex;
      continue;
    }
    const firstListLine = markdownListLine(line);
    if (firstListLine) {
      const block: ListLine[] = [firstListLine];
      index += 1;
      while (index < answerLines.length) {
        const entry = markdownListLine(answerLines[index]!);
        if (!entry) break;
        block.push(entry);
        index += 1;
      }
      const trailing = citationScopeAt(answerLines, index);
      drafts.push(...inheritBlockCitations(listDrafts(block, inheritedContext), [
        ...(pendingContext?.citationScopes ?? []),
        trailing.scope
      ]));
      pendingContext = null;
      index = trailing.nextIndex;
      continue;
    }
    const next = answerLines[index + 1];
    const additionalContext = next?.text.trim() ? contextLine(line, next) : null;
    if (additionalContext) {
      pendingContext = mergeBlockContext(pendingContext, additionalContext);
      index += 1;
      continue;
    }
    if (citationOnly(line.text)) {
      pendingContext = null;
      index += 1;
      continue;
    }
    const trailing = citationScopeAt(answerLines, index + 1);
    drafts.push(...inheritBlockCitations(proseDrafts(line, inheritedContext), [
      ...(pendingContext?.citationScopes ?? []),
      trailing.scope
    ]));
    pendingContext = null;
    index = trailing.nextIndex === index + 1 ? index + 1 : trailing.nextIndex;
  }
  const byHandle = new Map(input.evidence.items.map((item) => [item.handle, item]));
  return Object.freeze(drafts.map((draft, index) => freezeClaim(draft, index + 1, byHandle)));
}

export function knowledgeSemanticClaimValidationText(
  claim: KnowledgeSemanticGroundingClaim
): string {
  return [...claim.context, claim.text].filter(Boolean).join(" — ");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strictly decodes content-free validator output and rejects cross-neighborhood attribution. */
export function decodeKnowledgeSemanticGroundingPrediction(
  claim: KnowledgeSemanticGroundingClaim,
  value: unknown
): KnowledgeSemanticGroundingPrediction | null {
  if (!record(value) || Object.keys(value).some((key) => ![
    "attributableHandles",
    "claimOrdinal",
    "confidence",
    "decision",
    "reasonFamily",
    "validatorProfile",
    "validatorVersion",
    "version"
  ].includes(key))) return null;
  const confidence = knowledgeSemanticConfidence(value.confidence);
  if (value.version !== KNOWLEDGE_SEMANTIC_GROUNDING_CONTRACT_VERSION ||
    value.claimOrdinal !== claim.ordinal ||
    !knowledgeSemanticGroundingDecisions.includes(
      value.decision as KnowledgeSemanticGroundingDecision
    ) ||
    !knowledgeSemanticReasonFamilies.includes(value.reasonFamily as KnowledgeSemanticReasonFamily) ||
    confidence === null ||
    typeof value.validatorProfile !== "string" ||
    !/^[a-z0-9][a-z0-9_.-]{0,79}$/u.test(value.validatorProfile) ||
    !Number.isSafeInteger(value.validatorVersion) || Number(value.validatorVersion) < 1 ||
    Number(value.validatorVersion) > 10_000 || !Array.isArray(value.attributableHandles) ||
    value.attributableHandles.some((handle) => typeof handle !== "string")) return null;
  const attributableHandles = value.attributableHandles as string[];
  const allowed = new Set(claim.citationHandles);
  if (attributableHandles.length !== new Set(attributableHandles).size ||
    attributableHandles.some((handle) => !allowed.has(handle))) return null;
  return Object.freeze({
    attributableHandles: Object.freeze([...attributableHandles]),
    claimOrdinal: claim.ordinal,
    confidence,
    decision: value.decision as KnowledgeSemanticGroundingDecision,
    reasonFamily: value.reasonFamily as KnowledgeSemanticReasonFamily,
    validatorProfile: value.validatorProfile,
    validatorVersion: Number(value.validatorVersion),
    version: KNOWLEDGE_SEMANTIC_GROUNDING_CONTRACT_VERSION
  });
}

/**
 * Shared JS/PostgreSQL receipt number contract. Six fixed decimal places keep
 * JSON.stringify away from exponent notation and round-trip through JSONB's
 * NUMERIC rendering without changing the canonical receipt bytes.
 */
export function knowledgeSemanticConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return null;
  }
  const canonical = Number(value.toFixed(6));
  if (value !== canonical) return null;
  return Object.is(canonical, -0) ? 0 : canonical;
}

export const MEMORY_CARDINALITY_PARSER_VERSION =
  "memory-cardinality-parser-v1";

export const MEMORY_CARDINALITY_REJECTION_REASONS = [
  "AMBIGUOUS_NOUN_COUNT_CONTEXT",
  "CONFLICTING_CARDINALS",
  "CURRENCY",
  "DATE_OR_TIME",
  "DECIMAL",
  "DURATION",
  "EMPTY",
  "FRACTION",
  "IDENTIFIER",
  "INPUT_TOO_LONG",
  "INVALID_CARDINAL_SYNTAX",
  "INVALID_INPUT",
  "LIST_POSITION",
  "NO_CARDINAL",
  "ORDINAL",
  "OUT_OF_RANGE",
  "PERCENTAGE",
  "RANGE",
  "RATE",
  "UNSUPPORTED_CONTEXT",
  "UNSUPPORTED_NUMBER_WORD",
  "VAGUE_QUANTIFIER"
] as const;

export type MemoryCardinalityRejectionReason =
  (typeof MEMORY_CARDINALITY_REJECTION_REASONS)[number];

export type MemoryCardinalityParserInput = Readonly<{
  context: "EXACT_NOUN_COUNT";
  exactText: string;
  languageTag: string;
}>;

export type MemoryCardinalityParseResult =
  | Readonly<{
      normalizedText: string;
      parserVersion: typeof MEMORY_CARDINALITY_PARSER_VERSION;
      status: "ACCEPTED";
      value: number;
    }>
  | Readonly<{
      parserVersion: typeof MEMORY_CARDINALITY_PARSER_VERSION;
      reason: MemoryCardinalityRejectionReason;
      status: "REJECTED";
    }>;

const MAX_CARDINALITY_INPUT_CHARACTERS = 256;
const MAX_CARDINALITY = 1_000_000;

type WordAtom = Readonly<{
  kind: "HUNDRED" | "MILLION" | "SMALL" | "THOUSAND" | "TENS";
  value: number;
}>;

type WordToken = Readonly<{
  end: number;
  start: number;
  value: string;
}>;

type CardinalCandidate = Readonly<{
  end: number;
  specialNounCount: boolean;
  start: number;
  value: number;
}>;

const decimalZeroCodePoints = Object.freeze([
  0x0030, 0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66,
  0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6,
  0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810,
  0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40,
  0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50,
  0xabf0, 0xff10, 0x104a0, 0x10d30, 0x11066, 0x110f0,
  0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650,
  0x116c0, 0x11730, 0x118e0, 0x11950, 0x11c50, 0x11d50,
  0x11da0, 0x16a60, 0x16ac0, 0x16b50, 0x1d7ce
]);

const englishAtoms = new Map<string, WordAtom>([
  ["zero", { kind: "SMALL", value: 0 }],
  ["one", { kind: "SMALL", value: 1 }],
  ["two", { kind: "SMALL", value: 2 }],
  ["three", { kind: "SMALL", value: 3 }],
  ["four", { kind: "SMALL", value: 4 }],
  ["five", { kind: "SMALL", value: 5 }],
  ["six", { kind: "SMALL", value: 6 }],
  ["seven", { kind: "SMALL", value: 7 }],
  ["eight", { kind: "SMALL", value: 8 }],
  ["nine", { kind: "SMALL", value: 9 }],
  ["ten", { kind: "SMALL", value: 10 }],
  ["eleven", { kind: "SMALL", value: 11 }],
  ["twelve", { kind: "SMALL", value: 12 }],
  ["thirteen", { kind: "SMALL", value: 13 }],
  ["fourteen", { kind: "SMALL", value: 14 }],
  ["fifteen", { kind: "SMALL", value: 15 }],
  ["sixteen", { kind: "SMALL", value: 16 }],
  ["seventeen", { kind: "SMALL", value: 17 }],
  ["eighteen", { kind: "SMALL", value: 18 }],
  ["nineteen", { kind: "SMALL", value: 19 }],
  ["twenty", { kind: "TENS", value: 20 }],
  ["thirty", { kind: "TENS", value: 30 }],
  ["forty", { kind: "TENS", value: 40 }],
  ["fifty", { kind: "TENS", value: 50 }],
  ["sixty", { kind: "TENS", value: 60 }],
  ["seventy", { kind: "TENS", value: 70 }],
  ["eighty", { kind: "TENS", value: 80 }],
  ["ninety", { kind: "TENS", value: 90 }],
  ["hundred", { kind: "HUNDRED", value: 100 }],
  ["thousand", { kind: "THOUSAND", value: 1_000 }],
  ["million", { kind: "MILLION", value: 1_000_000 }]
]);

const englishSpecialCounts = new Map<string, number>([
  ["pair", 2],
  ["dozen", 12]
]);

const russianAtoms = new Map<string, WordAtom>();

function addRussianWords(
  kind: WordAtom["kind"],
  value: number,
  words: readonly string[]
): void {
  for (const word of words) russianAtoms.set(word, { kind, value });
}

addRussianWords("SMALL", 0, ["ноль", "нуля", "нулю", "нулём", "нулем"]);
addRussianWords("SMALL", 1, [
  "один", "одна", "одно", "одного", "одной", "одну", "одному", "одним", "одном"
]);
addRussianWords("SMALL", 2, ["два", "две", "двух", "двум", "двумя"]);
addRussianWords("SMALL", 3, ["три", "трех", "трёх", "трем", "трём", "тремя"]);
addRussianWords("SMALL", 4, ["четыре", "четырех", "четырёх", "четырем", "четырём"]);
addRussianWords("SMALL", 5, ["пять", "пяти", "пятью"]);
addRussianWords("SMALL", 6, ["шесть", "шести", "шестью"]);
addRussianWords("SMALL", 7, ["семь", "семи", "семью"]);
addRussianWords("SMALL", 8, ["восемь", "восьми", "восемью"]);
addRussianWords("SMALL", 9, ["девять", "девяти", "девятью"]);
addRussianWords("SMALL", 10, ["десять", "десяти", "десятью"]);
addRussianWords("SMALL", 11, ["одиннадцать", "одиннадцати"]);
addRussianWords("SMALL", 12, ["двенадцать", "двенадцати"]);
addRussianWords("SMALL", 13, ["тринадцать", "тринадцати"]);
addRussianWords("SMALL", 14, ["четырнадцать", "четырнадцати"]);
addRussianWords("SMALL", 15, ["пятнадцать", "пятнадцати"]);
addRussianWords("SMALL", 16, ["шестнадцать", "шестнадцати"]);
addRussianWords("SMALL", 17, ["семнадцать", "семнадцати"]);
addRussianWords("SMALL", 18, ["восемнадцать", "восемнадцати"]);
addRussianWords("SMALL", 19, ["девятнадцать", "девятнадцати"]);
addRussianWords("TENS", 20, ["двадцать", "двадцати"]);
addRussianWords("TENS", 30, ["тридцать", "тридцати"]);
addRussianWords("TENS", 40, ["сорок", "сорока"]);
addRussianWords("TENS", 50, ["пятьдесят", "пятидесяти"]);
addRussianWords("TENS", 60, ["шестьдесят", "шестидесяти"]);
addRussianWords("TENS", 70, ["семьдесят", "семидесяти"]);
addRussianWords("TENS", 80, ["восемьдесят", "восьмидесяти"]);
addRussianWords("TENS", 90, ["девяносто", "девяноста"]);
addRussianWords("HUNDRED", 100, ["сто", "ста"]);
addRussianWords("HUNDRED", 200, ["двести", "двухсот", "двумстам"]);
addRussianWords("HUNDRED", 300, ["триста", "трехсот", "трёхсот", "тремстам", "трёмстам"]);
addRussianWords("HUNDRED", 400, ["четыреста", "четырехсот", "четырёхсот"]);
addRussianWords("HUNDRED", 500, ["пятьсот", "пятисот"]);
addRussianWords("HUNDRED", 600, ["шестьсот", "шестисот"]);
addRussianWords("HUNDRED", 700, ["семьсот", "семисот"]);
addRussianWords("HUNDRED", 800, ["восемьсот", "восьмисот"]);
addRussianWords("HUNDRED", 900, ["девятьсот", "девятисот"]);
addRussianWords("THOUSAND", 1_000, [
  "тысяча", "тысячи", "тысяч", "тысячу", "тысяче", "тысячей", "тысячах"
]);
addRussianWords("MILLION", 1_000_000, [
  "миллион", "миллиона", "миллионов", "миллиону", "миллионом", "миллионах"
]);

const unsupportedNumberWords = new Set([
  "uno", "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho",
  "nueve", "diez", "jedan", "jedna", "jedno", "dva", "dve", "tri", "četiri",
  "cetiri", "pet", "šest", "sest", "sedam", "osam", "devet", "deset"
]);

function rejected(reason: MemoryCardinalityRejectionReason): MemoryCardinalityParseResult {
  return Object.freeze({
    parserVersion: MEMORY_CARDINALITY_PARSER_VERSION,
    reason,
    status: "REJECTED" as const
  });
}

function asciiDecimalDigit(character: string): string {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return character;
  for (const zero of decimalZeroCodePoints) {
    const offset = codePoint - zero;
    if (offset >= 0 && offset <= 9) return String(offset);
  }
  return character;
}

function normalizeCardinalityText(value: string): string {
  return Array.from(value.normalize("NFKC"), asciiDecimalDigit)
    .join("")
    .replace(/[\p{Zs}\s]+/gu, " ")
    .trim()
    .toLowerCase();
}

function wordTokens(value: string): readonly WordToken[] {
  return Array.from(value.matchAll(/\p{L}+/gu), (match) => ({
    end: (match.index ?? 0) + match[0].length,
    start: match.index ?? 0,
    value: match[0]
  }));
}

function parseEnglishUnderThousand(words: readonly string[]): number | null {
  if (words.length === 0) return 0;
  if (words.length === 1 && englishSpecialCounts.has(words[0]!)) {
    return englishSpecialCounts.get(words[0]!) ?? null;
  }
  const conjunctionIndex = words.indexOf("and");
  if (conjunctionIndex >= 0 && (
    conjunctionIndex !== 2 || words[1] !== "hundred" ||
    words.lastIndexOf("and") !== conjunctionIndex
  )) return null;
  const cardinalWords = conjunctionIndex < 0
    ? words
    : [...words.slice(0, conjunctionIndex), ...words.slice(conjunctionIndex + 1)];
  const atoms = cardinalWords.map((word) => englishAtoms.get(word));
  if (atoms.some((atom) => !atom)) return null;
  let index = 0;
  let total = 0;
  if (atoms[index]?.kind === "SMALL" && (atoms[index]?.value ?? 0) >= 1 &&
    (atoms[index]?.value ?? 0) <= 9 && atoms[index + 1]?.kind === "HUNDRED") {
    total = (atoms[index]?.value ?? 0) * 100;
    index += 2;
  } else if (atoms[index]?.kind === "HUNDRED") {
    return null;
  }
  const remaining = atoms.slice(index);
  if (remaining.length === 0) return total;
  if (remaining.length === 1 && remaining[0]?.kind === "SMALL") {
    return total + (remaining[0]?.value ?? 0);
  }
  if (remaining[0]?.kind === "TENS" && remaining.length <= 2 &&
    (remaining.length === 1 || remaining[1]?.kind === "SMALL" &&
      (remaining[1]?.value ?? 0) >= 1 && (remaining[1]?.value ?? 0) <= 9)) {
    return total + (remaining[0]?.value ?? 0) + (remaining[1]?.value ?? 0);
  }
  return null;
}

function withoutLeadingAnd(words: readonly string[]): readonly string[] {
  return words[0] === "and" ? words.slice(1) : words;
}

function parseEnglishWords(words: readonly string[]): number | null {
  const millionIndex = words.indexOf("million");
  if (millionIndex >= 0) {
    if (millionIndex !== 1 || words.length !== 2 || words[0] !== "one") return null;
    return MAX_CARDINALITY;
  }
  const thousandIndex = words.indexOf("thousand");
  if (thousandIndex >= 0) {
    if (words.lastIndexOf("thousand") !== thousandIndex) return null;
    const left = parseEnglishUnderThousand(words.slice(0, thousandIndex));
    const rightWords = withoutLeadingAnd(words.slice(thousandIndex + 1));
    const right = parseEnglishUnderThousand(rightWords);
    if (left === null || left < 1 || right === null) return null;
    return left * 1_000 + right;
  }
  return parseEnglishUnderThousand(words);
}

function parseRussianUnderThousand(words: readonly string[]): number | null {
  if (words.length === 0) return 0;
  const atoms = words.map((word) => russianAtoms.get(word));
  if (atoms.some((atom) => !atom)) return null;
  let index = 0;
  let total = 0;
  if (atoms[index]?.kind === "HUNDRED") {
    total += atoms[index]?.value ?? 0;
    index += 1;
  }
  if (atoms[index]?.kind === "TENS") {
    total += atoms[index]?.value ?? 0;
    index += 1;
    if (atoms[index]?.kind === "SMALL" && (atoms[index]?.value ?? 0) >= 1 &&
      (atoms[index]?.value ?? 0) <= 9) {
      total += atoms[index]?.value ?? 0;
      index += 1;
    }
  } else if (atoms[index]?.kind === "SMALL") {
    total += atoms[index]?.value ?? 0;
    index += 1;
  }
  return index === atoms.length ? total : null;
}

function parseRussianWords(words: readonly string[]): number | null {
  const atoms = words.map((word) => russianAtoms.get(word));
  const millionIndex = atoms.findIndex((atom) => atom?.kind === "MILLION");
  if (millionIndex >= 0) {
    if (atoms.map((atom) => atom?.kind).lastIndexOf("MILLION") !== millionIndex) {
      return null;
    }
    const left = millionIndex === 0
      ? 1
      : parseRussianUnderThousand(words.slice(0, millionIndex));
    if (left !== 1 || millionIndex !== words.length - 1) return null;
    return MAX_CARDINALITY;
  }
  const thousandIndex = atoms.findIndex((atom) => atom?.kind === "THOUSAND");
  if (thousandIndex >= 0) {
    if (atoms.map((atom) => atom?.kind).lastIndexOf("THOUSAND") !== thousandIndex) {
      return null;
    }
    const left = thousandIndex === 0
      ? 1
      : parseRussianUnderThousand(words.slice(0, thousandIndex));
    const right = parseRussianUnderThousand(words.slice(thousandIndex + 1));
    if (left === null || left < 1 || right === null) return null;
    return left * 1_000 + right;
  }
  return parseRussianUnderThousand(words);
}

function recognizedWordRuns(
  value: string,
  tokens: readonly WordToken[],
  atoms: ReadonlyMap<string, WordAtom>,
  parser: (words: readonly string[]) => number | null,
  connectors: ReadonlySet<string> = new Set()
): Readonly<{ candidates: readonly CardinalCandidate[]; invalid: boolean }> {
  const candidates: CardinalCandidate[] = [];
  const specialCounts = atoms === englishAtoms
    ? englishSpecialCounts
    : new Map<string, number>();
  let invalid = false;
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index]!;
    if (!atoms.has(token.value) && !specialCounts.has(token.value)) {
      index += 1;
      continue;
    }
    const run: WordToken[] = [token];
    index += 1;
    while (index < tokens.length) {
      const next = tokens[index]!;
      const gap = value.slice(run.at(-1)!.end, next.start);
      const recognized = atoms.has(next.value) || specialCounts.has(next.value) ||
        connectors.has(next.value);
      if (!recognized || !/^[\s-]*$/u.test(gap)) break;
      run.push(next);
      index += 1;
    }
    while (run.at(-1) && connectors.has(run.at(-1)!.value)) run.pop();
    const words = run.map(({ value: word }) => word);
    const parsed = parser(words);
    if (parsed === null) {
      invalid = true;
      continue;
    }
    candidates.push({
      end: run.at(-1)!.end,
      specialNounCount: words.length === 1 &&
        specialCounts.has(words[0]!),
      start: run[0]!.start,
      value: parsed
    });
  }
  return Object.freeze({ candidates: Object.freeze(candidates), invalid });
}

function digitCandidates(value: string): readonly CardinalCandidate[] {
  const pattern = /(?<![\p{L}\p{N}_])(?:\d{1,3}(?:[ ,]\d{3})+|\d+)(?![\p{L}\p{N}_])/gu;
  return Object.freeze(Array.from(value.matchAll(pattern), (match) => ({
    end: (match.index ?? 0) + match[0].length,
    specialNounCount: false,
    start: match.index ?? 0,
    value: Number.parseInt(match[0].replace(/[ ,]/gu, ""), 10)
  })));
}

function hasDecimal(value: string): boolean {
  for (const match of value.matchAll(/\d+[.,]\d+/gu)) {
    if (match[0].includes(",") && /^\d{1,3}(?:,\d{3})+$/u.test(match[0])) continue;
    return true;
  }
  return false;
}

function rejectionFromContext(value: string): MemoryCardinalityRejectionReason | null {
  if (/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/gu.test(value)) {
    return "DATE_OR_TIME";
  }
  if (/\b\d+\s*(?:-|–|—|…|\.\.)\s*\d+\b|\b(?:between|from|от)\b.*\b(?:and|to|до)\b/gu.test(value)) {
    return "RANGE";
  }
  if (hasDecimal(value)) return "DECIMAL";
  if (/\b\d+\s*\/\s*\d+\b|\b(?:half|quarter)\b|(?:^|[^\p{L}\p{N}_])(?:половин\p{L}*|четверт\p{L}*)(?=$|[^\p{L}\p{N}_])/gu.test(value)) {
    return "FRACTION";
  }
  if (/%|\b(?:percent|percentage)\b|(?:^|[^\p{L}\p{N}_])процент\p{L}*(?=$|[^\p{L}\p{N}_])/gu.test(value)) {
    return "PERCENTAGE";
  }
  if (/\b\d+(?:st|nd|rd|th)\b|\d+\s*[-‐‑‒–—]?\s*(?:й|я|е|го|му|м)(?=$|[^\p{L}\p{N}_])|\b(?:first|second|third|fourth|fifth)\b|(?:^|[^\p{L}\p{N}_])(?:трет\p{L}*|перв\p{L}*|втор\p{L}*)(?=$|[^\p{L}\p{N}_])/gu.test(value)) {
    return "ORDINAL";
  }
  if (/^\s*\d+\s*[.)]/u.test(value)) return "LIST_POSITION";
  if (/\b(?:about|approximately|around|roughly|many|few|several)\b|(?:^|[^\p{L}\p{N}_])(?:около|примерно|приблизительно|несколько|много|мало)(?=$|[^\p{L}\p{N}_])/gu.test(value)) {
    return "VAGUE_QUANTIFIER";
  }
  if (/\b(?:per|each)\b|\/(?:hour|day|week|month|year)\b|(?:^|[^\p{L}\p{N}_])(?:в|за)\s+(?:час|день|недел\p{L}*|месяц\p{L}*|год)(?=$|[^\p{L}\p{N}_])/gu.test(value)) {
    return "RATE";
  }
  if (/\b(?:for|during)\b.*\b(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b|(?:^|[^\p{L}\p{N}_])(?:секунд\p{L}*|минут\p{L}*|час\p{L}*|дн(?:я|ей)|недел\p{L}*|месяц\p{L}*|лет|год(?:а|ов)?)(?=$|[^\p{L}\p{N}_])/gu.test(value)) {
    return "DURATION";
  }
  if (/[$€£¥₽]|\b(?:usd|eur|rub|dollars?|euros?)\b|(?:^|[^\p{L}\p{N}_])рубл\p{L}*(?=$|[^\p{L}\p{N}_])/gu.test(value)) {
    return "CURRENCY";
  }
  if (/\b(?:version|ver|build|model)\b|(?:^|[^\p{L}\p{N}_])(?:верси\p{L}*|сборк\p{L}*|модел\p{L}*)(?=$|[^\p{L}\p{N}_])|(?<![\p{L}\p{N}_])\p{L}[\p{L}\d]*[-_]\d+(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])\p{L}+\d+(?![\p{L}\p{N}_])/gu.test(value)) {
    return "IDENTIFIER";
  }
  if (/(?:^|\s)[−-]\s*\d+/u.test(value)) return "OUT_OF_RANGE";
  return null;
}

function hasNounContext(value: string, candidate: CardinalCandidate): boolean {
  const remainder = `${value.slice(0, candidate.start)} ${value.slice(candidate.end)}`
    .replace(/\b(?:and|of|и|из)\b/gu, " ");
  return /\p{L}{2,}/u.test(remainder);
}

/**
 * Parses only a caller-attested exact noun-count span. This is deliberately
 * not a raw-query/history number finder: source binding and offsets belong to
 * the structured consumer, while this leaf owns numeric syntax alone.
 */
export function parseMemoryCardinality(
  input: MemoryCardinalityParserInput
): MemoryCardinalityParseResult {
  if (input.context !== "EXACT_NOUN_COUNT") return rejected("UNSUPPORTED_CONTEXT");
  const languageTag = typeof input.languageTag === "string"
    ? input.languageTag.normalize("NFKC").toLowerCase()
    : "";
  if (!/^(?:[a-z]{2,8}(?:-[a-z0-9]{1,8})*|mixed)$/u.test(languageTag)) {
    return rejected("UNSUPPORTED_CONTEXT");
  }
  if (typeof input.exactText !== "string" || input.exactText.includes("\u0000")) {
    return rejected("INVALID_INPUT");
  }
  if (Array.from(input.exactText).length > MAX_CARDINALITY_INPUT_CHARACTERS) {
    return rejected("INPUT_TOO_LONG");
  }
  const normalizedText = normalizeCardinalityText(input.exactText);
  if (!normalizedText) return rejected("EMPTY");
  const contextualRejection = rejectionFromContext(normalizedText);
  if (contextualRejection) return rejected(contextualRejection);

  const tokens = wordTokens(normalizedText);
  const digits = digitCandidates(normalizedText);
  const primaryLanguage = languageTag.split("-", 1)[0];
  const languageUnspecified = primaryLanguage === "und" || languageTag === "mixed";
  const englishEnabled = primaryLanguage === "en" || languageUnspecified;
  const russianEnabled = primaryLanguage === "ru" || languageUnspecified;
  const english = recognizedWordRuns(
    normalizedText,
    tokens,
    englishEnabled ? englishAtoms : new Map(),
    parseEnglishWords,
    new Set(["and"])
  );
  const russian = recognizedWordRuns(
    normalizedText,
    tokens,
    russianEnabled ? russianAtoms : new Map(),
    parseRussianWords
  );
  if (english.invalid || russian.invalid) return rejected("INVALID_CARDINAL_SYNTAX");
  const candidates = [...digits, ...english.candidates, ...russian.candidates];
  const unsupportedLanguageNumberWord = tokens.some(({ value }) =>
    unsupportedNumberWords.has(value) ||
    !englishEnabled && (englishAtoms.has(value) || englishSpecialCounts.has(value)) ||
    !russianEnabled && russianAtoms.has(value));
  if (unsupportedLanguageNumberWord) {
    return rejected("UNSUPPORTED_NUMBER_WORD");
  }
  if (candidates.length > 1) return rejected("CONFLICTING_CARDINALS");
  if (candidates.length === 0) {
    return rejected("NO_CARDINAL");
  }
  const candidate = candidates[0]!;
  if (!Number.isSafeInteger(candidate.value) || candidate.value < 1 ||
    candidate.value > MAX_CARDINALITY) {
    return rejected("OUT_OF_RANGE");
  }
  if (!hasNounContext(normalizedText, candidate)) {
    return rejected("AMBIGUOUS_NOUN_COUNT_CONTEXT");
  }
  if (candidate.specialNounCount && !/\p{L}{2,}/u.test(
    normalizedText.slice(candidate.end)
  )) {
    return rejected("AMBIGUOUS_NOUN_COUNT_CONTEXT");
  }
  return Object.freeze({
    normalizedText,
    parserVersion: MEMORY_CARDINALITY_PARSER_VERSION,
    status: "ACCEPTED" as const,
    value: candidate.value
  });
}

export const DEFAULT_CONTEXT_SAFETY_MARGIN_RATIO = 0.1;

const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

export type ApproxTokenCodePointCount = Readonly<{
  codePoint: number;
  occurrences: number;
}>;

export type ApproxTokenProjectedPart =
  | Readonly<{
      counts: readonly ApproxTokenCodePointCount[];
      kind: "code_points";
    }>
  | Readonly<{
      kind: "value";
      value: unknown;
    }>;

export type ContextBudgetMessage = {
  contextTurnId?: string;
  content: {
    blocks: unknown[];
  };
  id: string;
  role: "assistant" | "user";
};

export type ContextTruncationSummary = {
  approxDroppedTokens: number;
  approxFinalTokens: number;
  approxOriginalTokens: number;
  budgetTokens: number;
  contextWindow: number;
  droppedMessages: number;
  keptMessages: number;
  maxOutputTokens: number;
  safetyMarginTokens: number;
};

export type ContextBudgetInput = {
  contextWindow: number;
  /** Token estimate for messages and prompt text; defaults to the character
   * weights of `estimateApproxTokens`. */
  estimateTokens?: (value: unknown) => number;
  maxOutputTokens?: number;
  messageExtraTokens?: Record<string, number>;
  messages: ContextBudgetMessage[];
  prompt?: {
    developer?: string | null;
    system?: string | null;
  };
  safetyMarginRatio?: number;
};

export type ContextBudgetLimits = {
  budgetTokens: number;
  contextWindow: number;
  maxOutputTokens: number;
  safetyMarginTokens: number;
};

export type ContextBudgetResult =
  | {
      approxFinalTokens: number;
      budgetTokens: number;
      messages: ContextBudgetMessage[];
      ok: true;
    }
  | {
      approxCurrentTokens: number;
      approxPromptTokens: number;
      budgetTokens: number;
      code: "context_too_large";
      contextWindow: number;
      maxOutputTokens: number;
      ok: false;
      safetyMarginTokens: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text every token estimate measures: text blocks joined by newlines,
 * other values as JSON. */
export function stringifyForEstimate(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (isRecord(value) && Array.isArray(value.blocks)) {
    return value.blocks
      .map((block) => {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          return block.text;
        }

        return JSON.stringify(block) ?? "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return JSON.stringify(value) ?? "";
}

export function estimateApproxTokens(value: unknown): number {
  const text = stringifyForEstimate(value);
  return text ? tokensFromUnits(approximateTokenUnits(text)) : 0;
}

/** Alphabetic scripts that current tokenizers encode in a few characters per
 * token. Weights are tokens per character, calibrated on 2026-09-26 against the
 * least efficient measured tokenizer (Anthropic count_tokens) with o200k as the
 * lower bound, so estimates never fall below the real count: Cyrillic prose
 * 0.24–0.44, technical Cyrillic up to 0.51; Greek, Hebrew and Arabic 0.27–0.79.
 * CJK (about one token per character) and Latin with diacritics (which splits
 * neighbouring words) keep the conservative one-token weight. */
const CYRILLIC_TOKEN_WEIGHT = 0.5;
const RTL_GREEK_TOKEN_WEIGHT = 0.8;

type CodePointRange = readonly [first: number, last: number];

const CYRILLIC_RANGES: readonly CodePointRange[] = [[0x0400, 0x052f], [0x1c80, 0x1c8f], [0x2de0, 0x2dff], [0xa640, 0xa69f]];
const GREEK_HEBREW_ARABIC_RANGES: readonly CodePointRange[] = [
  [0x0370, 0x03ff], [0x1f00, 0x1fff], [0x0590, 0x05ff], [0x0600, 0x06ff],
  [0x0750, 0x077f], [0x08a0, 0x08ff], [0xfb1d, 0xfdff], [0xfe70, 0xfeff]
];

/** Code point ranges whose every character has the same weight, so stored
 * history can be measured by counting characters per class instead of per
 * code point. The last class is common one-token scripts with no
 * pictographic character in them; characters outside every class are
 * weighed one by one. */
export const APPROX_TOKEN_WEIGHT_CLASSES: readonly Readonly<{ ranges: readonly CodePointRange[]; weight: number }>[] = [
  { ranges: [[0x0001, 0x007f]], weight: 0.25 },
  { ranges: CYRILLIC_RANGES, weight: CYRILLIC_TOKEN_WEIGHT },
  { ranges: GREEK_HEBREW_ARABIC_RANGES, weight: RTL_GREEK_TOKEN_WEIGHT },
  // Latin-1 (without © and ®), Latin Extended, IPA and combining marks;
  // general punctuation (without ‼ and ⁉); CJK punctuation (without 〰 and
  // 〽) and kana; CJK ideographs; Hangul; fullwidth forms.
  { ranges: [
    [0x0080, 0x00a8], [0x00aa, 0x00ad], [0x00af, 0x036f],
    [0x2000, 0x203b], [0x203d, 0x2048], [0x204a, 0x206f],
    [0x3000, 0x302f], [0x3031, 0x303c], [0x303e, 0x30ff],
    [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xac00, 0xd7af], [0xff00, 0xffef]
  ], weight: 1 }
];

function inRanges(ranges: readonly CodePointRange[], codePoint: number): boolean {
  for (const [first, last] of ranges) {
    if (codePoint >= first && codePoint <= last) return true;
  }
  return false;
}

/** Weights are summed in twentieths of a token, so an estimate is exact and
 * independent of the order its characters are counted in. */
const UNITS_PER_TOKEN = 20;
const weightUnits = (weight: number) => Math.round(weight * UNITS_PER_TOKEN);
const ASCII_UNITS = weightUnits(0.25);
const CYRILLIC_UNITS = weightUnits(CYRILLIC_TOKEN_WEIGHT);
const RTL_GREEK_UNITS = weightUnits(RTL_GREEK_TOKEN_WEIGHT);
const DEFAULT_UNITS = weightUnits(1);
const PICTOGRAPHIC_UNITS = weightUnits(2);

function approximateTokenWeightUnits(codePoint: number): number {
  if (codePoint <= 0x7f) return ASCII_UNITS;
  if (inRanges(CYRILLIC_RANGES, codePoint)) return CYRILLIC_UNITS;
  if (inRanges(GREEK_HEBREW_ARABIC_RANGES, codePoint)) return RTL_GREEK_UNITS;
  return EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(codePoint)) ? PICTOGRAPHIC_UNITS : DEFAULT_UNITS;
}

function tokensFromUnits(total: number): number {
  return Math.ceil(total / UNITS_PER_TOKEN);
}

function approximateTokenUnits(text: string): number {
  let total = 0;
  for (const character of text) {
    total += approximateTokenWeightUnits(character.codePointAt(0) ?? 0);
  }
  return total;
}

function approximateTokenUnitsFromCodePointCounts(
  counts: readonly ApproxTokenCodePointCount[]
): Readonly<{ occurrences: number; units: number }> {
  let occurrences = 0;
  let units = 0;
  for (const count of counts) {
    if (
      !Number.isSafeInteger(count.codePoint) ||
      count.codePoint < 0 ||
      count.codePoint > 0x10ffff ||
      !Number.isSafeInteger(count.occurrences) ||
      count.occurrences <= 0
    ) {
      continue;
    }
    occurrences += count.occurrences;
    units += approximateTokenWeightUnits(count.codePoint) * count.occurrences;
  }
  return { occurrences, units };
}

export function estimateApproxTokensFromProjectedParts(
  parts: readonly ApproxTokenProjectedPart[]
): number {
  let total = 0;
  let projectedParts = 0;
  for (const part of parts) {
    const projection = part.kind === "code_points"
      ? approximateTokenUnitsFromCodePointCounts(part.counts)
      : (() => {
          const text = JSON.stringify(part.value) ?? "";
          return { occurrences: text ? 1 : 0, units: approximateTokenUnits(text) };
        })();
    if (projection.occurrences === 0) continue;
    if (projectedParts > 0) {
      total += approximateTokenWeightUnits("\n".codePointAt(0)!);
    }
    total += projection.units;
    projectedParts += 1;
  }
  return tokensFromUnits(total);
}

export function calculateContextBudgetLimits({
  contextWindow,
  maxOutputTokens = 0,
  provider,
  safetyMarginRatio = DEFAULT_CONTEXT_SAFETY_MARGIN_RATIO
}: Pick<ContextBudgetInput, "contextWindow" | "maxOutputTokens" | "safetyMarginRatio"> & {
  provider?: string;
}): ContextBudgetLimits {
  const normalizedContextWindow = Math.max(0, Math.floor(contextWindow));
  const requestedMaxOutputTokens = Math.max(0, Math.floor(maxOutputTokens));
  const normalizedMaxOutputTokens =
    provider === "fake" && requestedMaxOutputTokens >= normalizedContextWindow ? 0 : requestedMaxOutputTokens;
  const safetyMarginTokens = Math.floor(normalizedContextWindow * safetyMarginRatio);

  return {
    budgetTokens: Math.max(0, normalizedContextWindow - normalizedMaxOutputTokens - safetyMarginTokens),
    contextWindow: normalizedContextWindow,
    maxOutputTokens: normalizedMaxOutputTokens,
    safetyMarginTokens
  };
}

function extraTokensForMessage(input: ContextBudgetInput, message: ContextBudgetMessage): number {
  const value = input.messageExtraTokens?.[message.id] ?? 0;

  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

function messageTokens(input: ContextBudgetInput, message: ContextBudgetMessage): number {
  return (input.estimateTokens ?? estimateApproxTokens)(message.content) + extraTokensForMessage(input, message);
}

function promptTokens(input: ContextBudgetInput): number {
  const estimate = input.estimateTokens ?? estimateApproxTokens;
  return estimate(input.prompt?.system ?? "") + estimate(input.prompt?.developer ?? "");
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** The exact fit check of a prompt and its messages. It never removes a
 * message: history leaves a request only after context notes cover it, which
 * the run planner owns. */
export function applyContextBudget(input: ContextBudgetInput): ContextBudgetResult {
  if (!Number.isFinite(input.contextWindow) || input.contextWindow <= 0 || input.messages.length === 0) {
    return {
      approxFinalTokens: 0,
      budgetTokens: Number.POSITIVE_INFINITY,
      messages: input.messages,
      ok: true
    };
  }

  const { budgetTokens, contextWindow, maxOutputTokens, safetyMarginTokens } = calculateContextBudgetLimits(input);
  const estimatedPromptTokens = promptTokens(input);
  const messageTokenTotal = sum(input.messages.map((message) => messageTokens(input, message)));
  const approxFinalTokens = estimatedPromptTokens + messageTokenTotal;
  if (approxFinalTokens <= budgetTokens) {
    return { approxFinalTokens, budgetTokens, messages: input.messages, ok: true };
  }
  return {
    approxCurrentTokens: messageTokenTotal,
    approxPromptTokens: estimatedPromptTokens,
    budgetTokens,
    code: "context_too_large",
    contextWindow,
    maxOutputTokens,
    ok: false,
    safetyMarginTokens
  };
}

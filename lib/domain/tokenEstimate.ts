import { estimateApproxTokens, stringifyForEstimate } from "./contextBudget";

/**
 * Provider-aware context token estimate. The reference count is the o200k_base
 * encoding (exact for the GPT-4o/GPT-5 family behind OpenAI and codex-lb);
 * other families scale it per content class by multipliers calibrated against
 * their official counters so the estimate never falls below them. The pure-JS
 * encoder loads synchronously on first use; where it is absent (the pruned
 * worker image) the estimate keeps the character weights. An estimate without
 * a profile is always the character-weight `estimateApproxTokens`: persisted
 * evidence and the browser projection recompute that value.
 */
export type TokenEstimateFamily = "anthropic" | "deepseek" | "gemini" | "openai" | "unknown";

export type TokenEstimateProfile = Readonly<{ family: TokenEstimateFamily }>;

export type TokenContentClass =
  | "base64"
  | "cjk"
  | "code"
  | "cyrillic_prose"
  | "json"
  | "latin_prose"
  | "other_script";

export type ReferenceTokenCounter = (text: string) => number;

type MultiplierTable = Readonly<Record<TokenContentClass, number>>;

const CONTENT_CLASSES = [
  "latin_prose", "cyrillic_prose", "code", "json", "base64", "cjk", "other_script"
] as const satisfies readonly TokenContentClass[];

/** Calibrated 2026-09-26 with scripts/calibrate-token-estimate.ts (the table
 * is in contextBudget.test.ts): the largest official count to o200k ratio of
 * the class plus at least 2%, rounded up to 0.05. o200k itself is the floor. */
const MEASURED_FAMILY_MULTIPLIERS: Readonly<Record<Exclude<TokenEstimateFamily, "unknown">, MultiplierTable>> = {
  anthropic: {
    base64: 1.45, cjk: 1.7, code: 1.65, cyrillic_prose: 1.6, json: 1.65, latin_prose: 1.55, other_script: 2.4
  },
  deepseek: {
    base64: 1.05, cjk: 1, code: 1.1, cyrillic_prose: 1.2, json: 1.15, latin_prose: 1.05, other_script: 1.4
  },
  gemini: {
    base64: 1.1, cjk: 1, code: 1.3, cyrillic_prose: 1.1, json: 1.2, latin_prose: 1.05, other_script: 1.3
  },
  openai: {
    base64: 1, cjk: 1, code: 1, cyrillic_prose: 1, json: 1, latin_prose: 1, other_script: 1
  }
};

function maximumMultipliers(): MultiplierTable {
  const tables = Object.values(MEASURED_FAMILY_MULTIPLIERS);
  return Object.fromEntries(CONTENT_CLASSES.map((contentClass) =>
    [contentClass, Math.max(...tables.map((table) => table[contentClass]))])) as MultiplierTable;
}

/** An unrecognized family (OpenRouter, custom endpoints) takes the largest
 * multiplier any calibrated family needs for the class. */
export const TOKEN_ESTIMATE_MULTIPLIERS: Readonly<Record<TokenEstimateFamily, MultiplierTable>> = {
  ...MEASURED_FAMILY_MULTIPLIERS,
  unknown: maximumMultipliers()
};

export const TOKEN_ESTIMATE_LIMITS = Object.freeze({
  /** UTF-16 code units per classified and encoded chunk. */
  chunkCodeUnits: 1_024,
  /** Texts of at most this many chunks are encoded completely. */
  exactChunks: 32,
  /** Longer texts encode a systematic sample of about this many chunks... */
  sampleChunks: 32,
  /** ...plus the first chunks of every content class the sample missed, at
   * most `sampleChunks` more in total. */
  classSampleMinimum: 2,
  /** A sampled count is raised by this factor. */
  sampledMargin: 1.05,
  /** Shorter texts are cheap to encode and are not memoized. */
  memoMinimumCodeUnits: 256,
  memoMaxEntries: 512,
  /** Retained memo keys in UTF-16 code units (about 8 MB). */
  memoMaxCodeUnits: 4 * 1_024 * 1_024
});

const PROFILES: Readonly<Record<TokenEstimateFamily, TokenEstimateProfile>> = {
  anthropic: Object.freeze({ family: "anthropic" }),
  deepseek: Object.freeze({ family: "deepseek" }),
  gemini: Object.freeze({ family: "gemini" }),
  openai: Object.freeze({ family: "openai" }),
  unknown: Object.freeze({ family: "unknown" })
};

/** OpenAI model identifiers (GPT, o-series, Codex): o200k tokenization. */
const OPENAI_MODEL_ID = /^(?:gpt-|chatgpt-|codex-|o[1-9](?:$|[-.]))/iu;

/**
 * The profile for an admitted provider family. OpenAI-compatible routes are
 * OpenAI only for OpenAI model identifiers (codex-lb); other compatible
 * endpoints, OpenRouter and unrecognized families take the unknown profile.
 * The verification-only fake provider has no tokenizer and keeps the
 * character weights (null).
 */
export function tokenEstimateProfileFor(input: Readonly<{
  modelId?: string | null;
  provider: string;
}>): TokenEstimateProfile | null {
  switch (input.provider) {
    case "fake":
      return null;
    case "anthropic":
    case "deepseek":
    case "gemini":
    case "openai":
      return PROFILES[input.provider];
    case "openai_compatible":
      return OPENAI_MODEL_ID.test(input.modelId?.trim() ?? "") ? PROFILES.openai : PROFILES.unknown;
    default:
      return PROFILES.unknown;
  }
}

const LATIN = 1;
const CYRILLIC = 2;
const CODE = 4;
const JSON_TEXT = 8;
const BASE64 = 16;
const CJK = 32;
const OTHER_SCRIPT = 64;
const CLASS_BITS: Readonly<Record<TokenContentClass, number>> = {
  base64: BASE64, cjk: CJK, code: CODE, cyrillic_prose: CYRILLIC, json: JSON_TEXT, latin_prose: LATIN, other_script: OTHER_SCRIPT
};
/** Runs of base64/hex/token alphabet at least this long are dense payload. */
const DENSE_RUN = 32;

function isCyrillic(code: number): boolean {
  return (code >= 0x0400 && code <= 0x052f) || (code >= 0x1c80 && code <= 0x1c8f) ||
    (code >= 0x2de0 && code <= 0x2dff) || (code >= 0xa640 && code <= 0xa69f);
}

/** Hangul, CJK symbols, kana, ideographs (including the high surrogates of
 * planes 2 and 3) and fullwidth forms. */
function isCjk(code: number): boolean {
  return (code >= 0x1100 && code <= 0x11ff) || (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xa960 && code <= 0xa97f) || (code >= 0xac00 && code <= 0xd7ff) ||
    (code >= 0xd840 && code <= 0xd87f) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef);
}

function isLatinExtended(code: number): boolean {
  return (code >= 0x00c0 && code <= 0x024f && code !== 0x00d7 && code !== 0x00f7) ||
    (code >= 0x1e00 && code <= 0x1eff);
}

/** Greek, Armenian, Hebrew, Arabic, Indic, Thai and other alphabets and
 * abugidas; checked after Cyrillic, CJK and extended Latin. */
function isOtherScript(code: number): boolean {
  return (code >= 0x0370 && code <= 0x1fff) || (code >= 0xa000 && code <= 0xabff) ||
    (code >= 0xfb1d && code <= 0xfdff) || (code >= 0xfe70 && code <= 0xfeff);
}

function isDenseAlphabet(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ||
    code === 0x2b || code === 0x2d || code === 0x2f || code === 0x3d || code === 0x5f;
}

/** Content classes of one chunk as bits: one structural class (base64, JSON,
 * code) or prose, plus every script that holds a real share of its letters.
 * Latin letters inside a structural class are covered by that class. */
function chunkClassMask(text: string, start: number, end: number): number {
  let latin = 0;
  let cyrillic = 0;
  let cjk = 0;
  let other = 0;
  let keys = 0;
  let structure = 0;
  let code = 0;
  let dense = 0;
  let run = 0;
  let previous = 0;
  for (let index = start; index < end; index += 1) {
    const character = text.charCodeAt(index);
    if (isDenseAlphabet(character)) {
      run += 1;
    } else {
      if (run >= DENSE_RUN) dense += run;
      run = 0;
    }
    if (character < 0x80) {
      if ((character >= 0x41 && character <= 0x5a) || (character >= 0x61 && character <= 0x7a)) latin += 1;
      else if (character === 0x3a) {
        structure += 1;
        if (previous === 0x22) keys += 1;
      } else if (character === 0x7b || character === 0x7d) {
        structure += 1;
        code += 1;
      } else if (character === 0x22 || character === 0x5b || character === 0x5d) structure += 1;
      else if (character === 0x3b || character === 0x28 || character === 0x29 || character === 0x3d ||
        character === 0x3c || character === 0x3e) code += 1;
    } else if (isCyrillic(character)) cyrillic += 1;
    else if (isCjk(character)) cjk += 1;
    else if (isLatinExtended(character)) latin += 1;
    else if (isOtherScript(character)) other += 1;
    previous = character;
  }
  if (run >= DENSE_RUN) dense += run;
  const length = end - start;
  const letters = latin + cyrillic + cjk + other;
  let scripts = 0;
  if (cyrillic > 0 && cyrillic * 100 >= letters * 15) scripts |= CYRILLIC;
  if (cjk > 0 && cjk * 100 >= letters * 5) scripts |= CJK;
  if (other > 0 && other * 100 >= letters * 5) scripts |= OTHER_SCRIPT;
  if (dense * 2 >= length) return BASE64 | scripts;
  if (keys * 100 >= length || structure * 100 >= length * 12) return JSON_TEXT | scripts;
  if (code * 100 >= length * 5) return CODE | scripts;
  return scripts === 0 || latin * 100 >= letters * 15 ? LATIN | scripts : scripts;
}

/** A chunk never splits a surrogate pair. */
function chunkEnd(text: string, start: number): number {
  const end = Math.min(text.length, start + TOKEN_ESTIMATE_LIMITS.chunkCodeUnits);
  if (end >= text.length) return end;
  const last = text.charCodeAt(end - 1);
  return last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
}

type Chunk = Readonly<{ end: number; mask: number; start: number }>;

function chunks(text: string): Chunk[] {
  const result: Chunk[] = [];
  for (let start = 0; start < text.length;) {
    const end = chunkEnd(text, start);
    result.push({ end, mask: chunkClassMask(text, start, end), start });
    start = end;
  }
  return result;
}

export type ReferenceTokenMeasure = Readonly<{
  /** True when the counts scale a sample of the chunks. */
  sampled: boolean;
  /** Reference (o200k) tokens per content-class bit set. */
  tokensByClasses: ReadonlyMap<number, number>;
}>;

type ClassGroup = { chunks: number; length: number; sampledChunks: number; sampledLength: number; sampledTokens: number };

/**
 * Reference tokens of a text, per content-class set. Chunks are encoded
 * separately; a word cut at a chunk boundary only adds tokens. A text longer
 * than `exactChunks` chunks encodes a bounded, deterministic sample instead:
 * every stride-th chunk plus the first chunks of each class the stride
 * missed, scaled per class by the sampled density.
 */
export function measureReferenceTokens(text: string, count: ReferenceTokenCounter): ReferenceTokenMeasure {
  const parts = chunks(text);
  const tokensByClasses = new Map<number, number>();
  if (parts.length <= TOKEN_ESTIMATE_LIMITS.exactChunks) {
    for (const part of parts) {
      tokensByClasses.set(part.mask, (tokensByClasses.get(part.mask) ?? 0) + count(text.slice(part.start, part.end)));
    }
    return { sampled: false, tokensByClasses };
  }
  const groups = new Map<number, ClassGroup>();
  for (const part of parts) {
    const group = groups.get(part.mask) ?? { chunks: 0, length: 0, sampledChunks: 0, sampledLength: 0, sampledTokens: 0 };
    group.chunks += 1;
    group.length += part.end - part.start;
    groups.set(part.mask, group);
  }
  const taken = new Set<number>();
  const take = (index: number) => {
    const part = parts[index]!;
    const group = groups.get(part.mask)!;
    taken.add(index);
    group.sampledChunks += 1;
    group.sampledLength += part.end - part.start;
    group.sampledTokens += count(text.slice(part.start, part.end));
  };
  const stride = Math.ceil(parts.length / TOKEN_ESTIMATE_LIMITS.sampleChunks);
  for (let index = 0; index < parts.length; index += stride) take(index);
  let extra = 0;
  for (let index = 0; index < parts.length && extra < TOKEN_ESTIMATE_LIMITS.sampleChunks; index += 1) {
    const group = groups.get(parts[index]!.mask)!;
    if (taken.has(index) || group.sampledChunks >= Math.min(TOKEN_ESTIMATE_LIMITS.classSampleMinimum, group.chunks)) continue;
    take(index);
    extra += 1;
  }
  // A class left unsampled by the bound takes the densest sampled class.
  let densest = 0;
  for (const group of groups.values()) {
    if (group.sampledLength > 0) densest = Math.max(densest, group.sampledTokens / group.sampledLength);
  }
  for (const [mask, group] of groups) {
    const density = group.sampledLength > 0 ? group.sampledTokens / group.sampledLength : densest;
    tokensByClasses.set(mask, density * group.length);
  }
  return { sampled: true, tokensByClasses };
}

/** Content classes present in a text (diagnostics and calibration). */
export function tokenContentClasses(text: string): readonly TokenContentClass[] {
  let union = 0;
  for (const part of chunks(text)) union |= part.mask;
  return CONTENT_CLASSES.filter((contentClass) => (union & CLASS_BITS[contentClass]) !== 0);
}

const classMultipliers = new Map<TokenEstimateFamily, Float64Array>();

/** The largest multiplier among the classes of a chunk. */
function classesMultiplier(family: TokenEstimateFamily, mask: number): number {
  let table = classMultipliers.get(family);
  if (!table) {
    table = new Float64Array(128);
    for (let bits = 0; bits < 128; bits += 1) {
      let multiplier = 1;
      for (const contentClass of CONTENT_CLASSES) {
        if ((bits & CLASS_BITS[contentClass]) !== 0) {
          multiplier = Math.max(multiplier, TOKEN_ESTIMATE_MULTIPLIERS[family][contentClass]);
        }
      }
      table[bits] = multiplier;
    }
    classMultipliers.set(family, table);
  }
  return table[mask]!;
}

/** Family estimate of a reference measure; o200k is the floor. */
export function tokenEstimateFromMeasure(measure: ReferenceTokenMeasure, profile: TokenEstimateProfile): number {
  let total = 0;
  for (const [mask, tokens] of measure.tokensByClasses) total += tokens * classesMultiplier(profile.family, mask);
  return Math.ceil(measure.sampled ? total * TOKEN_ESTIMATE_LIMITS.sampledMargin : total);
}

/** Context tokens of a value for a provider family. Without a profile, or
 * without a reference counter, this is exactly `estimateApproxTokens`. */
export type ContextTokenEstimate = (value: unknown, profile: TokenEstimateProfile | null | undefined) => number;

/**
 * An estimate over one reference counter, loaded on first use, with a bounded
 * LRU memo of reference measures per text: the planner and budget measure the
 * same texts many times per round, and the measure is family-independent.
 */
export function createContextTokenEstimate(loadCounter: () => ReferenceTokenCounter | null): ContextTokenEstimate {
  let counter: ReferenceTokenCounter | null | undefined;
  const memo = new Map<string, ReferenceTokenMeasure>();
  let memoCodeUnits = 0;
  const measure = (text: string, count: ReferenceTokenCounter): ReferenceTokenMeasure => {
    if (text.length < TOKEN_ESTIMATE_LIMITS.memoMinimumCodeUnits) return measureReferenceTokens(text, count);
    const cached = memo.get(text);
    if (cached) {
      memo.delete(text);
      memo.set(text, cached);
      return cached;
    }
    const measured = measureReferenceTokens(text, count);
    if (text.length <= TOKEN_ESTIMATE_LIMITS.memoMaxCodeUnits) {
      memo.set(text, measured);
      memoCodeUnits += text.length;
      while (memo.size > TOKEN_ESTIMATE_LIMITS.memoMaxEntries || memoCodeUnits > TOKEN_ESTIMATE_LIMITS.memoMaxCodeUnits) {
        const oldest = memo.keys().next().value!;
        memo.delete(oldest);
        memoCodeUnits -= oldest.length;
      }
    }
    return measured;
  };
  return (value, profile) => {
    if (!profile) return estimateApproxTokens(value);
    const text = stringifyForEstimate(value);
    if (!text) return 0;
    if (counter === undefined) counter = loadCounter();
    if (!counter) return estimateApproxTokens(text);
    try {
      return tokenEstimateFromMeasure(measure(text, counter), profile);
    } catch {
      return estimateApproxTokens(text);
    }
  };
}

/** User and tool text may contain special-token strings; they count as text. */
const ENCODE_OPTIONS = Object.freeze({ disallowedSpecial: new Set<string>() });

/** A synchronous optional load: bundlers include the pure-JS encoder, while
 * unbundled workers without the package keep the character weights. */
function loadO200kCounter(): ReferenceTokenCounter | null {
  try {
    const encoding: unknown = require("gpt-tokenizer/encoding/o200k_base");
    const countTokens = typeof encoding === "object" && encoding !== null
      ? (encoding as Record<string, unknown>).countTokens : undefined;
    return typeof countTokens === "function"
      ? (text) => (countTokens as (text: string, options: typeof ENCODE_OPTIONS) => number)(text, ENCODE_OPTIONS)
      : null;
  } catch {
    return null;
  }
}

export const estimateContextTokens: ContextTokenEstimate = createContextTokenEstimate(loadO200kCounter);

/** The estimate bound to one admitted provider family and model. */
export function contextTokenEstimator(input: Readonly<{
  modelId?: string | null;
  provider: string;
}>): (value: unknown) => number {
  const profile = tokenEstimateProfileFor(input);
  return (value) => estimateContextTokens(value, profile);
}

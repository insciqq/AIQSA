import {
  clipWorkspaceActivityBytes,
  maskWorkspaceSecretPrefix,
  workspaceSecretReplacements,
  type WorkspaceSecretMatch
} from "./activityText";
import type { WorkspaceToolResult } from "./runtime";

/**
 * A cut or chunk boundary can leave part of a value on each side. Fragments
 * of at least this many characters, with a letter or digit, are masked there;
 * shorter ones carry negligible information and would mislabel ordinary text.
 */
export const WORKSPACE_SECRET_FRAGMENT_MIN_LENGTH = 4;
/** Larger values (whole files, browser states) are still masked whole, but not as fragments. */
const FRAGMENT_VALUE_MAX_LENGTH = 16 * 1_024;
const MAX_DEPTH = 64;
/** Envelope fields that carry guest output; their ends are where the guest cuts or chunks it. */
const OUTPUT_KEYS = new Set(["content", "data", "message", "stderr", "stdout"]);
/** Head+tail omission of a failed command's output (`operationFailure.ts`), raw and JSON-escaped. */
const OMISSIONS = [/\n… \[\d+ bytes omitted\] …\n/gu, /\\n… \[\d+ bytes omitted\] …\\n/gu];
const MEANINGFUL = /[\p{L}\p{N}]/u;

type Pattern = Readonly<{ replacement: string; value: string }>;
type GramIndex = ReadonlyMap<string, readonly Readonly<{ offset: number; pattern: Pattern }>[]>;
type Boundaries = Readonly<{ end?: boolean; markers?: boolean; quotes?: boolean; start?: boolean }>;
type Range = Readonly<{ from: number; replacement: string; to: number }>;

class DepthExceeded extends Error {}

function gramIndex(patterns: readonly Pattern[]): GramIndex {
  const index = new Map<string, { offset: number; pattern: Pattern }[]>();
  for (const pattern of patterns) {
    if (pattern.value.length > FRAGMENT_VALUE_MAX_LENGTH) continue;
    for (let offset = 0; offset + WORKSPACE_SECRET_FRAGMENT_MIN_LENGTH <= pattern.value.length; offset += 1) {
      const gram = pattern.value.slice(offset, offset + WORKSPACE_SECRET_FRAGMENT_MIN_LENGTH);
      const entries = index.get(gram);
      if (entries) entries.push({ offset, pattern });
      else index.set(gram, [{ offset, pattern }]);
    }
  }
  return index;
}

/** Unescaped quotes of JSON text, paired as string literals; keys are skipped. */
function literalBoundaries(text: string, starts: number[], ends: number[]): void {
  const quotes: number[] = [];
  for (let index = text.indexOf("\""); index >= 0; index = text.indexOf("\"", index + 1)) {
    let slashes = 0;
    while (index - slashes - 1 >= 0 && text[index - slashes - 1] === "\\") slashes += 1;
    if (slashes % 2 === 0) quotes.push(index);
  }
  for (let pair = 0; pair < quotes.length; pair += 2) {
    const open = quotes[pair]!;
    const close = quotes[pair + 1];
    if (close !== undefined && /^\s*:/u.test(text.slice(close + 1, close + 64))) continue;
    starts.push(open + 1);
    // An unclosed final literal was cut by the byte bound.
    ends.push(close ?? text.length);
  }
}

/**
 * Masks exact delivered secret values in Workspace tool output before the
 * result is persisted, projected to a model or shown in activity. This is
 * exact matching, not DLP: encoded or transformed copies stay visible.
 */
export class WorkspaceSecretOutputMask {
  private readonly raw: readonly Pattern[];
  private readonly escaped: readonly Pattern[];
  private readonly rawGrams: GramIndex;
  private readonly escapedGrams: GramIndex;

  constructor(matches: readonly WorkspaceSecretMatch[]) {
    this.raw = workspaceSecretReplacements(matches.map((match) => ({ name: match.name ?? "", value: match.value })));
    // Unparsed envelope text carries values inside JSON string literals.
    const variants = this.raw.map((pattern) => ({ ...pattern, value: JSON.stringify(pattern.value).slice(1, -1) }))
      .filter((variant, index) => variant.value !== this.raw[index]!.value);
    this.escaped = [...this.raw, ...variants].sort((left, right) => right.value.length - left.value.length);
    this.rawGrams = gramIndex(this.raw);
    this.escapedGrams = gramIndex(this.escaped);
  }

  get empty(): boolean {
    return this.raw.length === 0;
  }

  /**
   * One normalized result with the same shape. Masking never grows a text
   * entry beyond the configured output bound; an overflow is clipped and
   * reported as truncated.
   */
  result(result: WorkspaceToolResult, maxBytes: number): Readonly<{ masked: boolean; result: WorkspaceToolResult }> {
    if (this.empty) return { masked: false, result };
    let masked = false;
    let truncated = result.truncated === true;
    const content = result.content.map((entry) => {
      if (entry.type === "json" && entry.value !== undefined) {
        const state = { changed: false };
        let value: unknown;
        try {
          value = this.walk(entry.value, undefined, 0, state);
        } catch (error) {
          if (!(error instanceof DepthExceeded)) throw error;
          // Fail closed: an unwalkable value is replaced by its masked text.
          const text = this.text(JSON.stringify(entry.value), result.truncated === true);
          masked = true;
          return { text, type: "text" as const };
        }
        if (!state.changed) return entry;
        masked = true;
        return { ...entry, value };
      }
      if (typeof entry.text !== "string") return entry;
      const text = this.text(entry.text, result.truncated === true);
      if (text === entry.text) return entry;
      masked = true;
      const bound = Math.max(maxBytes, Buffer.byteLength(entry.text));
      if (Buffer.byteLength(text) <= bound) return { ...entry, text };
      truncated = true;
      return { ...entry, text: clipWorkspaceActivityBytes(text, bound) };
    });
    if (!masked) return { masked: false, result };
    return { masked: true, result: { ...result, content, ...(truncated ? { truncated: true } : {}) } };
  }

  /** A text entry: an official JSON envelope keeps its layout; anything else is masked as escaped text. */
  text(value: string, cut: boolean): string {
    const json = /^\s*[[{]/u.test(value);
    if (json) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = undefined;
      }
      if (typeof parsed === "object" && parsed !== null) {
        try {
          const state = { changed: false };
          const next = this.walk(parsed, undefined, 0, state);
          if (!state.changed) return value;
          return JSON.stringify(next, null, JSON.stringify(parsed, null, 2) === value ? 2 : undefined);
        } catch (error) {
          if (!(error instanceof DepthExceeded)) throw error;
        }
      }
    }
    return this.mask(value, this.escaped, this.escapedGrams, { end: cut, markers: true, quotes: json });
  }

  private walk(value: unknown, key: string | undefined, depth: number, state: { changed: boolean }): unknown {
    if (depth > MAX_DEPTH) throw new DepthExceeded();
    if (typeof value === "string") {
      const next = this.mask(value, this.raw, this.rawGrams,
        key !== undefined && OUTPUT_KEYS.has(key) ? { end: true, markers: true, start: true } : {});
      if (next !== value) state.changed = true;
      return next;
    }
    if (Array.isArray(value)) return value.map((item) => this.walk(item, key, depth + 1, state));
    if (typeof value !== "object" || value === null) return value;
    // fromEntries defines own properties, so a "__proto__" key stays data.
    return Object.fromEntries(Object.entries(value).map(([name, item]) => {
      const masked = this.mask(name, this.raw, this.rawGrams, {});
      if (masked !== name) state.changed = true;
      return [masked, this.walk(item, name, depth + 1, state)];
    }));
  }

  private mask(value: string, patterns: readonly Pattern[], grams: GramIndex, boundaries: Boundaries): string {
    const text = maskWorkspaceSecretPrefix(value, value.length, patterns).text;
    const starts: number[] = boundaries.start ? [0] : [];
    const ends: number[] = boundaries.end ? [text.length] : [];
    if (boundaries.markers) {
      for (const omission of OMISSIONS) {
        for (const match of text.matchAll(omission)) {
          ends.push(match.index);
          starts.push(match.index + match[0].length);
        }
      }
    }
    if (boundaries.quotes) literalBoundaries(text, starts, ends);
    if (!starts.length && !ends.length) return text;
    const ranges: Range[] = [];
    for (const end of ends) {
      const range = this.prefixEndingAt(text, end, grams);
      if (range) ranges.push(range);
    }
    for (const start of starts) {
      const range = this.suffixStartingAt(text, start, grams);
      if (range) ranges.push(range);
    }
    if (!ranges.length) return text;
    ranges.sort((left, right) => left.from - right.from || right.to - left.to);
    let cursor = 0;
    let result = "";
    for (const range of ranges) {
      if (range.from < cursor) continue;
      result += text.slice(cursor, range.from) + range.replacement;
      cursor = range.to;
    }
    return result + text.slice(cursor);
  }

  /** The longest proper prefix of a value that ends exactly at `end`. */
  private prefixEndingAt(text: string, end: number, grams: GramIndex): Range | null {
    if (end < WORKSPACE_SECRET_FRAGMENT_MIN_LENGTH) return null;
    let best: Range | null = null;
    for (const { offset, pattern } of grams.get(text.slice(end - WORKSPACE_SECRET_FRAGMENT_MIN_LENGTH, end)) ?? []) {
      const length = offset + WORKSPACE_SECRET_FRAGMENT_MIN_LENGTH;
      if (length >= pattern.value.length || length > end || (best && end - best.from >= length)) continue;
      if (!text.startsWith(pattern.value.slice(0, offset), end - length)) continue;
      if (!MEANINGFUL.test(pattern.value.slice(0, length))) continue;
      best = { from: end - length, replacement: pattern.replacement, to: end };
    }
    return best;
  }

  /** The longest proper suffix of a value that starts exactly at `start`. */
  private suffixStartingAt(text: string, start: number, grams: GramIndex): Range | null {
    let best: Range | null = null;
    for (const { offset, pattern } of grams.get(text.slice(start, start + WORKSPACE_SECRET_FRAGMENT_MIN_LENGTH)) ?? []) {
      const length = pattern.value.length - offset;
      if (offset === 0 || start + length > text.length || (best && best.to - start >= length)) continue;
      if (!text.startsWith(pattern.value.slice(offset), start)) continue;
      if (!MEANINGFUL.test(pattern.value.slice(offset))) continue;
      best = { from: start, replacement: pattern.replacement, to: start + length };
    }
    return best;
  }
}

import { SAVED_SECRET_MARKER, savedSecretFoldedValues, savedSecretLineFeeds } from "./savedSecrets";
import {
  redactionMarkerRanges,
  redactSecrets,
  redactSecretsInWindows,
  UNPROCESSED_TEXT_PLACEHOLDER,
  type SecretWindowOptions
} from "./secrets";

/**
 * One screening for text that is stored, embedded, shown or searched with: recognized secrets (`./secrets.ts`) and
 * the owner's saved secret values (`./savedSecrets.ts`) are found in the same text before anything is replaced, and
 * each stretch they cover, overlapping or touching, is replaced once by one marker. Replacing one kind first broke
 * the other (review 2026-11-23): a saved login taken out of `https://login:password@host` left an address the
 * detector no longer recognized, so the password stayed, and a saved value ending inside a token left its tail.
 *
 * Recognized secrets are also looked for with the saved values already out, the order screening used before, and
 * what that finds is mapped back onto the text: a token written right after a saved value stands alone only then.
 * So nothing either order removed stays. Markers already in the text are kept as they are, so screening screened
 * text changes nothing.
 *
 * Line breaks become LF in the text and in the values before anything is matched, so CRLF text and an LF value (or
 * the reverse) still match: a value inside a text is still inside it once both have LF line breaks. The result's
 * line breaks are LF.
 *
 * A saved value matches with any run of whitespace in the text standing for any run of whitespace in the value
 * (review 2026-11-23): callers fold whitespace after screening (a search query, a title, a passage header), so a
 * passphrase split by a line break, left whole by an exact match, was folded back into the saved value. Matching is
 * literal (`savedCovers`): a value was once compiled into a regular expression, and a value starting with an emoji
 * made the search restart inside its surrogate pair and match at the same offset forever, while a large valid value
 * (a 118 KB file) failed to compile, so every search of its owner failed. Only a value's trimmed words are covered;
 * whitespace at its edges is not.
 */

/** A stretch of the text to replace, with the marker it would take; on a tie for the longest, the lower rank's. */
type Cover = Readonly<{ end: number; placeholder: string; rank: number; start: number }>;
type Group = { best: Cover; end: number; onlyMarkers: boolean; start: number };
type Replacement = Readonly<{ outputEnd: number; outputStart: number; sourceEnd: number; sourceStart: number }>;

const SAVED_RANK = 0;
const RECOGNIZED_RANK = 1;
const WITHHELD_RANK = 2;
const MARKER_RANK = 3;

export type ScreenedText = Readonly<{ redacted: boolean; text: string }>;

/**
 * The text with each maximal run of whitespace as one space, and where each of its characters starts in the source:
 * `sourceOffsets[i]` for character `i`, with one more entry, the source's length, after the last. The source is cut
 * into these characters without a gap, so a stretch `[start, end)` of the folded text is `[sourceOffsets[start],
 * sourceOffsets[end])` of the source, a space standing for its whole run.
 */
type FoldedText = Readonly<{ sourceOffsets: Int32Array; text: string }>;

function foldedWithOffsets(source: string): FoldedText {
  const sourceOffsets = new Int32Array(source.length + 1);
  const parts: string[] = [];
  let length = 0;
  let cursor = 0;
  const keepUntil = (end: number): void => {
    for (let offset = cursor; offset < end; offset += 1) {
      sourceOffsets[length] = offset;
      length += 1;
    }
    parts.push(source.slice(cursor, end));
  };
  for (const run of source.matchAll(/\s+/gu)) {
    keepUntil(run.index);
    sourceOffsets[length] = run.index;
    length += 1;
    parts.push(" ");
    cursor = run.index + run[0].length;
  }
  keepUntil(source.length);
  sourceOffsets[length] = source.length;
  return { sourceOffsets: sourceOffsets.subarray(0, length + 1), text: parts.join("") };
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** A stretch widened to whole characters, so a value holding half a surrogate pair never leaves the other half alone. */
function wholeCharacters(source: string, start: number, end: number): Readonly<{ end: number; start: number }> {
  const splitsAt = (offset: number): boolean => offset > 0 && offset < source.length &&
    isHighSurrogate(source.charCodeAt(offset - 1)) && isLowSurrogate(source.charCodeAt(offset));
  return { end: splitsAt(end) ? end + 1 : end, start: splitsAt(start) ? start - 1 : start };
}

/**
 * Every occurrence of the saved values, overlapping ones included, as stretches of the source: each value folded and
 * trimmed (`savedSecretFoldedValues`) is found literally in the folded source, so a run of whitespace in the text
 * stands for any run in the value. Each search restarts one code unit past the last match's start, which always
 * makes progress, whatever the value holds.
 */
function savedCovers(source: string, values: readonly string[]): Cover[] {
  const folded = savedSecretFoldedValues(values);
  if (folded.length === 0) return [];
  const { sourceOffsets, text } = foldedWithOffsets(source);
  const covers: Cover[] = [];
  for (const value of folded) {
    for (let start = text.indexOf(value); start !== -1; start = text.indexOf(value, start + 1)) {
      const span = wholeCharacters(source, sourceOffsets[start], sourceOffsets[start + value.length]);
      covers.push({ ...span, placeholder: SAVED_SECRET_MARKER, rank: SAVED_RANK });
    }
  }
  return covers;
}

/** Recognized secrets, and with windows the text withheld unscanned past their bound. */
function recognizedCovers(text: string, windows: SecretWindowOptions | undefined): Cover[] {
  if (!windows) {
    return redactSecrets(text).spans.map((span) =>
      ({ end: span.end, placeholder: span.placeholder, rank: RECOGNIZED_RANK, start: span.start }));
  }
  const result = redactSecretsInWindows(text, windows);
  return [
    ...result.spans.map((span) => ({ end: span.end, placeholder: span.placeholder, rank: RECOGNIZED_RANK, start: span.start })),
    ...result.withheld.map((range) => ({ ...range, placeholder: UNPROCESSED_TEXT_PLACEHOLDER, rank: WITHHELD_RANK }))
  ];
}

function outranks(candidate: Cover, current: Cover): boolean {
  const candidateLength = candidate.end - candidate.start;
  const currentLength = current.end - current.start;
  return candidateLength > currentLength || (candidateLength === currentLength && candidate.rank < current.rank);
}

/** Covers that overlap or touch, joined; each group takes the marker of its longest cover. */
function grouped(covers: readonly Cover[]): Group[] {
  const sorted = covers.filter((cover) => cover.end > cover.start)
    .sort((left, right) => left.start - right.start || right.end - left.end || left.rank - right.rank);
  const groups: Group[] = [];
  for (const cover of sorted) {
    const last = groups.at(-1);
    if (last && cover.start <= last.end) {
      last.end = Math.max(last.end, cover.end);
      last.onlyMarkers &&= cover.rank === MARKER_RANK;
      if (outranks(cover, last.best)) last.best = cover;
    } else {
      groups.push({ best: cover, end: cover.end, onlyMarkers: cover.rank === MARKER_RANK, start: cover.start });
    }
  }
  return groups;
}

/** The text with each group replaced by its marker; a group of markers already in the text stays as written. */
function replaced(text: string, groups: readonly Group[]): Readonly<{ replacements: Replacement[]; text: string }> {
  const replacements: Replacement[] = [];
  let output = "";
  let cursor = 0;
  for (const group of groups) {
    output += text.slice(cursor, group.start);
    const marker = group.onlyMarkers ? text.slice(group.start, group.end) : group.best.placeholder;
    replacements.push({ outputEnd: output.length + marker.length, outputStart: output.length, sourceEnd: group.end,
      sourceStart: group.start });
    output += marker;
    cursor = group.end;
  }
  return { replacements, text: output + text.slice(cursor) };
}

/** Where a position of the replaced text falls in the source: a start inside a marker at the marker's source start, an end at its source end. */
function sourcePosition(replacements: readonly Replacement[], position: number, edge: "end" | "start"): number {
  let shift = 0;
  for (const replacement of replacements) {
    const before = edge === "start" ? position < replacement.outputStart : position <= replacement.outputStart;
    if (before) break;
    const inside = edge === "start" ? position < replacement.outputEnd : position <= replacement.outputEnd;
    if (inside) return edge === "start" ? replacement.sourceStart : replacement.sourceEnd;
    shift = replacement.sourceEnd - replacement.outputEnd;
  }
  return position + shift;
}

/** Recognized secrets of the text with the saved values replaced, as stretches of the text itself. */
function coversWithoutSavedValues(text: string, saved: readonly Cover[], windows: SecretWindowOptions | undefined): Cover[] {
  const { replacements, text: view } = replaced(text, grouped(saved));
  return recognizedCovers(view, windows).map((cover) => ({
    ...cover,
    end: sourcePosition(replacements, cover.end, "end"),
    start: sourcePosition(replacements, cover.start, "start")
  }));
}

/**
 * The text with recognized secrets and the saved values replaced in one pass, line breaks as LF. With `windows`,
 * text of any length is scanned in bounded windows and what lies past their bound is withheld behind
 * `UNPROCESSED_TEXT_PLACEHOLDER` (`redactSecretsInWindows`); without, the caller bounds the text.
 */
export function redactSecretsAndSavedValues(
  text: string,
  savedValues: readonly string[],
  windows?: SecretWindowOptions
): ScreenedText {
  const source = savedSecretLineFeeds(text);
  const markers = redactionMarkerRanges(source).map((range): Cover =>
    ({ ...range, placeholder: source.slice(range.start, range.end), rank: MARKER_RANK }));
  const saved = savedCovers(source, savedValues);
  const found = [...saved, ...recognizedCovers(source, windows)];
  if (saved.length > 0) found.push(...coversWithoutSavedValues(source, saved, windows));
  // What lies wholly inside a marker hides nothing more (a saved value that is part of a marker's name).
  const covers = [...markers, ...found.filter((cover) =>
    !markers.some((marker) => marker.start <= cover.start && cover.end <= marker.end))];
  const groups = grouped(covers);
  return { redacted: groups.some((group) => !group.onlyMarkers), text: replaced(source, groups).text };
}

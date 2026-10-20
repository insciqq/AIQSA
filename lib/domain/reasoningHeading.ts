import type { ModelRunSseEvent } from "./modelRunEvents";
import { takeUtf16SafePrefix } from "./utf16";

/**
 * Live reasoning headings (operator decision 2026-10-20). While an answer has
 * no text yet, its status line may show the model's own latest reasoning
 * heading: the bold title a reasoning summary part opens with, otherwise the
 * first sentence or line of the latest reasoning paragraph. A heading is
 * untrusted model text reduced to one bounded plain line. It reaches the
 * browser only on the live stream, as a provider lifecycle `summary` that is
 * never a durable row and never answer output, and only reasoning the answer
 * will also show (summaries, thinking) produces one.
 */
export const REASONING_HEADING_MAX_CHARACTERS = 80;
/** The opening of a paragraph kept to find its heading, never the whole thinking. */
const PARAGRAPH_SCAN_CHARACTERS = 400;
/** An unclosed bold opening this long is read as plain text. */
const BOLD_TITLE_SCAN_CHARACTERS = 160;

// Line breaks and controls become spaces; invisible formatting that could
// reorder or hide the label (bidi overrides, zero-width marks) is dropped.
const lineBreaking = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
const invisibleFormatting = /[\u00ad\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/gu;
const sentenceEnd = /[.!?\u2026](?=\s)|[\u3002\uff01\uff1f]/u;

/** One plain, whitespace-collapsed line of at most the heading bound, or null. */
export function boundReasoningHeading(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const line = value.replace(lineBreaking, " ").replace(invisibleFormatting, "").replace(/\s+/gu, " ").trim();
  if (!line) return null;
  return line.length <= REASONING_HEADING_MAX_CHARACTERS
    ? line
    : `${takeUtf16SafePrefix(line, REASONING_HEADING_MAX_CHARACTERS - 1).trimEnd()}…`;
}

function plainHeading(text: string): string | null {
  const heading = boundReasoningHeading(text.replace(/\*\*|__|`/gu, ""));
  return heading && heading.endsWith(".") && !heading.endsWith("..") ? heading.slice(0, -1).trimEnd() || null : heading;
}

/**
 * The heading of one reasoning paragraph read so far. It is `complete` once
 * more text cannot change it; `final` marks the paragraph's whole text.
 */
export function reasoningParagraphHeading(
  text: string,
  final = false
): Readonly<{ complete: boolean; heading: string | null }> {
  const body = text.replace(/^\s+/u, "").replace(/^(?:#{1,6}|[-*+])[ \t]+/u, "");
  const bold = /^(?:\*\*|__)/u.exec(body)?.[0];
  if (bold) {
    const close = body.indexOf(bold, bold.length);
    const title = close > bold.length ? plainHeading(body.slice(bold.length, close)) : null;
    if (title) return { complete: true, heading: title };
    if (close < 0 && !final && body.length < BOLD_TITLE_SCAN_CHARACTERS) return { complete: false, heading: null };
  }
  const newline = body.indexOf("\n");
  const sentence = sentenceEnd.exec(body);
  const ends = [newline, sentence ? sentence.index + 1 : -1].filter((index) => index >= 0);
  if (ends.length > 0) return { complete: true, heading: plainHeading(body.slice(0, Math.min(...ends))) };
  return final || body.length > REASONING_HEADING_MAX_CHARACTERS
    ? { complete: true, heading: plainHeading(body) }
    : { complete: false, heading: null };
}

export type ReasoningHeadingTracker = Readonly<{
  /** Streamed text of the open unit; returns a heading the first time one is determined. */
  append(text: string): string | null;
  /** Ends the unit (a summary part or thinking block) and returns its heading if not reported yet. */
  finish(): string | null;
}>;

/**
 * Reports each heading of streamed reasoning once. With `paragraphs` every
 * blank line opens a new heading (thinking text); without it one unit (a
 * summary part) has one heading. When one delta settles several paragraphs
 * only the latest heading is returned, and a heading equal to the previous
 * one is not reported again.
 */
export function createReasoningHeadingTracker(options: Readonly<{ paragraphs: boolean }>): ReasoningHeadingTracker {
  let paragraph = "";
  let reported = false;
  // A trailing newline (and indentation) that may open a paragraph break.
  let carry = "";
  let last: string | null = null;

  const add = (text: string) => {
    if (text && paragraph.length < PARAGRAPH_SCAN_CHARACTERS) {
      paragraph = takeUtf16SafePrefix(paragraph + text, PARAGRAPH_SCAN_CHARACTERS);
    }
  };
  const settle = (final: boolean): string | null => {
    if (reported) return null;
    const { complete, heading } = reasoningParagraphHeading(paragraph, final);
    if (!complete) return null;
    reported = true;
    if (!heading || heading === last) return null;
    last = heading;
    return heading;
  };
  const reset = () => {
    paragraph = "";
    reported = false;
  };

  return {
    append(text) {
      if (!options.paragraphs) {
        add(text);
        return settle(false);
      }
      const previousCarry = carry.length;
      const input = carry + text;
      let latest: string | null = null;
      let start = 0;
      for (const match of input.matchAll(/\n[ \t]*\n/gu)) {
        // Carried characters already belong to the paragraph.
        add(input.slice(Math.max(start, previousCarry), match.index));
        latest = settle(true) ?? latest;
        reset();
        start = match.index + match[0].length;
      }
      add(input.slice(Math.max(start, previousCarry)));
      carry = /\n[ \t]*$/u.exec(input.slice(start))?.[0] ?? "";
      return settle(false) ?? latest;
    },
    finish() {
      const heading = settle(true);
      reset();
      carry = "";
      return heading;
    }
  };
}

/** The live heading event: a provider lifecycle summary, never answer output or a durable row. */
export function reasoningHeadingEvent(heading: string): ModelRunSseEvent {
  return {
    data: { artifactType: "summary", payload: { heading, stage: "reasoning", status: "running" } },
    type: "artifact"
  };
}

/** The bounded heading a live `summary` payload carries, or null for any other payload. */
export function decodeReasoningHeading(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  return record.stage === "reasoning" && record.status === "running" ? boundReasoningHeading(record.heading) : null;
}

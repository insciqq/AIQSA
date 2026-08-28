import { estimateApproxTokens } from "../../../domain/contextBudget";
import {
  memorySha256,
  normalizeMemorySearchText
} from "../persistence/lexical";
import { detectMemoryTextLanguage, type MemoryTextLanguage } from "./language";
import type {
  MemoryRecallRoundMessageJoin,
  MemoryRecallRoundProjection
} from "./rounds";

export const MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION =
  "memory-recall-round-segment-v1";
export const MEMORY_RECALL_ROUND_SEGMENT_TARGET_CHARACTERS = 3_000;
export const MEMORY_RECALL_ROUND_SEGMENT_MAX_CHARACTERS = 4_000;
export const MEMORY_RECALL_ROUND_SEGMENT_OVERLAP_CHARACTERS = 400;
export const MEMORY_RECALL_ROUND_SEGMENT_MAX_PER_ROUND = 80;
export const MEMORY_RECALL_ROUND_SEGMENT_CONTEXT_MAX_CHARACTERS = 1_000;

export type MemoryRecallRoundSegmentPosition =
  | "MIDDLE"
  | "PREFIX"
  | "SINGLE"
  | "SUFFIX";

export type MemoryRecallRoundSegmentMessageJoin = Readonly<{
  messageId: string;
  ordinal: number;
  role: MemoryRecallRoundMessageJoin["role"];
  safeTextHash: string;
  segmentEndOffset: number;
  segmentStartOffset: number;
  sourceEndOffset: number;
  sourceMessageContentHash: string;
  sourceMessageUpdatedAt: string;
  sourceStartOffset: number;
}>;

export type MemoryRecallRoundSegmentProjection = Readonly<{
  approxTokens: number;
  chatId: string;
  contextualKeyPolicyVersion: string;
  contextualKeyState: "GENERATED" | "RAW_FALLBACK";
  contextualNarrativeText: string;
  contextualSearchHash: string;
  contextualSearchText: string;
  evidenceRootHash: string;
  id: string;
  languageCode: MemoryTextLanguage;
  messageJoins: readonly MemoryRecallRoundSegmentMessageJoin[];
  occurredFrom: string;
  occurredTo: string;
  ordinal: number;
  position: MemoryRecallRoundSegmentPosition;
  projectionVersion: typeof MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION;
  publicationState: "ACTIVE" | "SUPPRESSED";
  rawEndOffsetUtf16: number;
  rawSafeText: string;
  rawSafeTextHash: string;
  rawStartOffsetUtf16: number;
  redactionReasonCodes: readonly string[];
  redactionState: "EXCLUDED" | "NOT_NEEDED" | "REDACTED";
  roundId: string;
  safetyClass: "HIGHLY_SENSITIVE" | "NORMAL" | "SECRET_TAINTED" | "SENSITIVE";
  sourceRevision: number;
  supportingRoundIds: readonly string[];
  userId: string;
}>;

export type MemoryRecallRoundSegmentSource = Omit<Pick<
  MemoryRecallRoundProjection,
  | "chatId"
  | "contextualKeyPolicyVersion"
  | "contextualKeyState"
  | "contextualNarrativeText"
  | "evidenceRootHash"
  | "id"
  | "messageJoins"
  | "occurredFrom"
  | "occurredTo"
  | "rawSafeText"
  | "redactionReasonCodes"
  | "redactionState"
  | "safetyClass"
  | "sourceRevision"
  | "supportingRoundIds"
  | "userId"
>, "redactionState" | "safetyClass"> & Readonly<{
  publicationState?: "ACTIVE" | "SUPPRESSED";
  redactionState: "EXCLUDED" | "NOT_NEEDED" | "REDACTED";
  safetyClass: "HIGHLY_SENSITIVE" | "NORMAL" | "SECRET_TAINTED" | "SENSITIVE";
}>;

type Span = Readonly<{ end: number; start: number }>;

const redactionPlaceholderPattern = /\[REDACTED:[A-Z_]+\]/gu;

function completeUtf16Boundary(value: string, index: number): number {
  const bounded = Math.max(0, Math.min(index, value.length));
  if (bounded > 0 && bounded < value.length) {
    const previous = value.charCodeAt(bounded - 1);
    const next = value.charCodeAt(bounded);
    if (previous >= 0xD800 && previous <= 0xDBFF &&
      next >= 0xDC00 && next <= 0xDFFF) return bounded - 1;
  }
  return bounded;
}

function redactionSpans(value: string): readonly Span[] {
  return [...value.matchAll(redactionPlaceholderPattern)].map((match) => ({
    end: match.index + match[0].length,
    start: match.index
  }));
}

function outsideRedaction(
  index: number,
  spans: readonly Span[],
  direction: "END" | "START",
  hardEnd = Number.MAX_SAFE_INTEGER
): number {
  const containing = spans.find((span) => index > span.start && index < span.end);
  if (!containing) return index;
  if (direction === "END" && containing.end <= hardEnd) return containing.end;
  return containing.start;
}

function paragraphBoundary(value: string, from: number, hardEnd: number): number | null {
  const index = value.indexOf("\n\n", from);
  return index >= from && index <= hardEnd ? index : null;
}

function sentenceBoundary(value: string, from: number, hardEnd: number): number | null {
  for (let index = from; index < hardEnd; index += 1) {
    if (!".!?…".includes(value[index] ?? "")) continue;
    let end = index + 1;
    while (end < hardEnd && `\"'»”)]`.includes(value[end] ?? "")) end += 1;
    if (end >= value.length || /\s/u.test(value[end] ?? "")) return end;
  }
  return null;
}

function segmentSpans(value: string): readonly Span[] {
  if (!value || value.length > 200_000) {
    throw new Error("memory_recall_round_segment_source_invalid");
  }
  if (value.length <= MEMORY_RECALL_ROUND_SEGMENT_MAX_CHARACTERS) {
    return Object.freeze([{ end: value.length, start: 0 }]);
  }
  const placeholders = redactionSpans(value);
  const spans: Span[] = [];
  let start = 0;
  while (start < value.length) {
    if (spans.length >= MEMORY_RECALL_ROUND_SEGMENT_MAX_PER_ROUND) {
      throw new Error("memory_recall_round_segment_limit_exceeded");
    }
    const targetEnd = Math.min(
      value.length,
      start + MEMORY_RECALL_ROUND_SEGMENT_TARGET_CHARACTERS
    );
    const hardEnd = Math.min(
      value.length,
      start + MEMORY_RECALL_ROUND_SEGMENT_MAX_CHARACTERS
    );
    let end = targetEnd === value.length
      ? value.length
      : paragraphBoundary(value, targetEnd, hardEnd) ??
        sentenceBoundary(value, targetEnd, hardEnd) ??
        targetEnd;
    end = outsideRedaction(
      completeUtf16Boundary(value, end),
      placeholders,
      "END",
      hardEnd
    );
    end = completeUtf16Boundary(value, end);
    if (end <= start || end - start > MEMORY_RECALL_ROUND_SEGMENT_MAX_CHARACTERS) {
      throw new Error("memory_recall_round_segment_boundary_invalid");
    }
    spans.push({ end, start });
    if (end === value.length) break;
    const overlapStart = end - MEMORY_RECALL_ROUND_SEGMENT_OVERLAP_CHARACTERS;
    const nextStart = completeUtf16Boundary(
      value,
      outsideRedaction(overlapStart, placeholders, "START")
    );
    if (nextStart <= start || nextStart >= end) {
      throw new Error("memory_recall_round_segment_boundary_invalid");
    }
    start = nextStart;
  }
  return Object.freeze(spans);
}

function boundedUtf16(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return value.slice(0, completeUtf16Boundary(value, maximum));
}

function contextualNarrative(round: MemoryRecallRoundSegmentSource): string {
  if (round.contextualKeyState !== "GENERATED") return "";
  return boundedUtf16(
    normalizeMemorySearchText(round.contextualNarrativeText),
    MEMORY_RECALL_ROUND_SEGMENT_CONTEXT_MAX_CHARACTERS
  ).trim();
}

function segmentSearchText(rawSafeText: string, narrative: string): string {
  const raw = boundedUtf16(
    normalizeMemorySearchText(rawSafeText),
    MEMORY_RECALL_ROUND_SEGMENT_MAX_CHARACTERS
  ).trim();
  if (!raw) throw new Error("memory_recall_round_segment_search_invalid");
  if (!narrative) return raw;
  const prefix = "Contextual narrative (derived):\n";
  const separator = "\n\nAuthoritative raw segment:\n";
  const available = MEMORY_RECALL_ROUND_SEGMENT_MAX_CHARACTERS -
    prefix.length - separator.length - raw.length;
  if (available <= 0) return raw;
  const boundedNarrative = boundedUtf16(narrative, available).trim();
  return boundedNarrative
    ? `${prefix}${boundedNarrative}${separator}${raw}`
    : raw;
}

function intersectMessages(
  round: MemoryRecallRoundSegmentSource,
  span: Span
): readonly MemoryRecallRoundSegmentMessageJoin[] {
  const intersections = round.messageJoins.flatMap((join) => {
    const roundStart = Math.max(span.start, join.roundStartOffset);
    const roundEnd = Math.min(span.end, join.roundEndOffset);
    if (roundEnd <= roundStart) return [];
    const sourceStartOffset = join.sourceStartOffset +
      (roundStart - join.roundStartOffset);
    const sourceEndOffset = sourceStartOffset + (roundEnd - roundStart);
    return [{
      messageId: join.messageId,
      ordinal: join.ordinal,
      role: join.role,
      safeTextHash: join.safeTextHash,
      segmentEndOffset: roundEnd - span.start,
      segmentStartOffset: roundStart - span.start,
      sourceEndOffset,
      sourceMessageContentHash: join.sourceMessageContentHash,
      sourceMessageUpdatedAt: join.sourceMessageUpdatedAt,
      sourceStartOffset
    }];
  });
  if (intersections.length === 0) {
    throw new Error("memory_recall_round_segment_source_map_missing");
  }
  return Object.freeze(intersections);
}

function positionFor(index: number, count: number): MemoryRecallRoundSegmentPosition {
  if (count === 1) return "SINGLE";
  if (index === 0) return "PREFIX";
  if (index === count - 1) return "SUFFIX";
  return "MIDDLE";
}

export function projectMemoryRecallRoundSegments(
  round: MemoryRecallRoundSegmentSource
): readonly MemoryRecallRoundSegmentProjection[] {
  const spans = segmentSpans(round.rawSafeText);
  const narrative = contextualNarrative(round);
  return Object.freeze(spans.map((span, ordinal) => {
    const rawSafeText = round.rawSafeText.slice(span.start, span.end);
    const rawSafeTextHash = memorySha256(rawSafeText);
    const contextualSearchText = segmentSearchText(rawSafeText, narrative);
    return Object.freeze({
      approxTokens: estimateApproxTokens(rawSafeText),
      chatId: round.chatId,
      contextualKeyPolicyVersion: round.contextualKeyPolicyVersion,
      contextualKeyState: round.contextualKeyState,
      contextualNarrativeText: narrative,
      contextualSearchHash: memorySha256(contextualSearchText),
      contextualSearchText,
      evidenceRootHash: round.evidenceRootHash,
      id: memorySha256({
        domain: "aiqsa.memory.recall-round-segment",
        ordinal,
        projectionVersion: MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION,
        rawEndOffsetUtf16: span.end,
        rawSafeTextHash,
        rawStartOffsetUtf16: span.start,
        roundId: round.id,
        userId: round.userId
      }),
      languageCode: detectMemoryTextLanguage(rawSafeText),
      messageJoins: intersectMessages(round, span),
      occurredFrom: round.occurredFrom,
      occurredTo: round.occurredTo,
      ordinal,
      position: positionFor(ordinal, spans.length),
      projectionVersion: MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION,
      publicationState: round.publicationState ?? "ACTIVE",
      rawEndOffsetUtf16: span.end,
      rawSafeText,
      rawSafeTextHash,
      rawStartOffsetUtf16: span.start,
      redactionReasonCodes: Object.freeze([...round.redactionReasonCodes]),
      redactionState: round.redactionState,
      roundId: round.id,
      safetyClass: round.safetyClass,
      sourceRevision: round.sourceRevision,
      supportingRoundIds: Object.freeze([...round.supportingRoundIds]),
      userId: round.userId
    });
  }));
}

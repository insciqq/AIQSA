import {
  KNOWLEDGE_CANDIDATE_LIMIT,
  KNOWLEDGE_RESULT_LIMIT
} from "./retrievalTypes";

export const KNOWLEDGE_FOCUSED_REQUEST_VERSION = 1 as const;
export const KNOWLEDGE_FOCUSED_QUERY_MAX_CHARACTERS = 3_000 as const;
export const KNOWLEDGE_FOCUSED_NEIGHBOR_WINDOW = 1 as const;

export type KnowledgeFocusedRequestV1 = Readonly<{
  candidateLimit: typeof KNOWLEDGE_CANDIDATE_LIMIT;
  fusion: "weighted_rrf_v2";
  neighborWindow: typeof KNOWLEDGE_FOCUSED_NEIGHBOR_WINDOW;
  originalQuery: string;
  resultLimit: typeof KNOWLEDGE_RESULT_LIMIT;
  retrievalQuery: string;
  version: typeof KNOWLEDGE_FOCUSED_REQUEST_VERSION;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unicodePrefix(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join("");
}

/**
 * Keeps user spelling, quoted text, filenames, identifiers, numbers, and dates
 * intact while removing control characters that are unsafe in a persisted
 * provider request. No linguistic rewrite is performed.
 */
export function normalizeKnowledgeFocusedQuery(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/gu, " ").trim())
    .filter((line, index, lines) => line.length > 0 || (
      index > 0 && index < lines.length - 1 && lines[index - 1]?.length
    ))
    .join("\n")
    .trim();
}

export function createKnowledgeFocusedRequest(input: Readonly<{
  currentUserMessage: string;
  previousUserMessage?: string | null;
}>): KnowledgeFocusedRequestV1 | null {
  const current = normalizeKnowledgeFocusedQuery(input.currentUserMessage);
  if (!current) return null;
  const originalQuery = unicodePrefix(current, KNOWLEDGE_FOCUSED_QUERY_MAX_CHARACTERS);
  const previous = input.previousUserMessage
    ? normalizeKnowledgeFocusedQuery(input.previousUserMessage)
    : "";
  const separator = previous ? "\n\n" : "";
  const remaining = KNOWLEDGE_FOCUSED_QUERY_MAX_CHARACTERS -
    [...originalQuery].length - [...separator].length;
  const retainedPrevious = remaining > 0 ? unicodePrefix(previous, remaining) : "";
  const retrievalQuery = retainedPrevious
    ? `${originalQuery}${separator}${retainedPrevious}`
    : originalQuery;
  return Object.freeze({
    candidateLimit: KNOWLEDGE_CANDIDATE_LIMIT,
    fusion: "weighted_rrf_v2",
    neighborWindow: KNOWLEDGE_FOCUSED_NEIGHBOR_WINDOW,
    originalQuery,
    resultLimit: KNOWLEDGE_RESULT_LIMIT,
    retrievalQuery,
    version: KNOWLEDGE_FOCUSED_REQUEST_VERSION
  });
}

export function decodeKnowledgeFocusedRequest(
  value: unknown
): KnowledgeFocusedRequestV1 | null {
  if (!record(value) || Object.keys(value).length !== 7 ||
    value.version !== KNOWLEDGE_FOCUSED_REQUEST_VERSION ||
    value.candidateLimit !== KNOWLEDGE_CANDIDATE_LIMIT ||
    value.resultLimit !== KNOWLEDGE_RESULT_LIMIT ||
    value.neighborWindow !== KNOWLEDGE_FOCUSED_NEIGHBOR_WINDOW ||
    value.fusion !== "weighted_rrf_v2" ||
    typeof value.originalQuery !== "string" ||
    typeof value.retrievalQuery !== "string") return null;
  const originalQuery = normalizeKnowledgeFocusedQuery(value.originalQuery);
  const retrievalQuery = normalizeKnowledgeFocusedQuery(value.retrievalQuery);
  if (!originalQuery || !retrievalQuery || originalQuery !== value.originalQuery ||
    retrievalQuery !== value.retrievalQuery ||
    [...originalQuery].length > KNOWLEDGE_FOCUSED_QUERY_MAX_CHARACTERS ||
    [...retrievalQuery].length > KNOWLEDGE_FOCUSED_QUERY_MAX_CHARACTERS) return null;
  return Object.freeze({
    candidateLimit: KNOWLEDGE_CANDIDATE_LIMIT,
    fusion: "weighted_rrf_v2",
    neighborWindow: KNOWLEDGE_FOCUSED_NEIGHBOR_WINDOW,
    originalQuery,
    resultLimit: KNOWLEDGE_RESULT_LIMIT,
    retrievalQuery,
    version: KNOWLEDGE_FOCUSED_REQUEST_VERSION
  });
}

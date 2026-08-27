import { approximateKnowledgeTokenCount } from "./chunking";
import { MAX_RERANK_DOCUMENT_CHARACTERS } from "../providers/rerank";

/**
 * Versioned deterministic language-neutral candidate formatter for hosted
 * reranking. One candidate renders as newline-separated values only:
 *
 *   source title
 *   heading path
 *   atomic passage
 *
 * No English labels (no "Source:", "Location:", "Evidence layout:"), no page
 * prose, no UI-specific text. Parent or neighbor context is never included.
 * The output is bounded by an approximate model-token budget; a model-native
 * tokenizer arrives in a later slice and will bump the formatter version.
 */
export const KNOWLEDGE_RERANK_CANDIDATE_FORMATTER_VERSION = 1 as const;
export const KNOWLEDGE_RERANK_CANDIDATE_MAX_TOKENS = 768 as const;

/** Neutral, language-free separator between heading path segments. */
const HEADING_PATH_SEPARATOR = " / ";
const TITLE_MAX_TOKENS = 96;
const HEADING_MAX_TOKENS = 128;

export type KnowledgeRerankCandidateInput = Readonly<{
  headingPath: readonly string[];
  sourceName: string;
  text: string;
}>;

function singleLine(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function passageText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ")
    .trim();
}

function codePointPrefix(value: string, length: number): string {
  return [...value].slice(0, length).join("").trimEnd();
}

/** Largest code-point prefix whose approximate token count fits the budget. */
function trimToTokenBudget(value: string, maxTokens: number): string {
  if (approximateKnowledgeTokenCount(value) <= maxTokens) return value;
  const points = [...value];
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (approximateKnowledgeTokenCount(codePointPrefix(value, middle)) <= maxTokens) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return codePointPrefix(value, low);
}

function compose(parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join("\n");
}

/**
 * Deterministically formats one atomic candidate for the hosted reranker.
 * The result is non-empty, contains no NUL characters, fits the approximate
 * 768-model-token budget, and never exceeds the provider transport document
 * character bound.
 */
export function formatKnowledgeRerankCandidate(
  input: KnowledgeRerankCandidateInput
): string {
  const title = trimToTokenBudget(singleLine(input.sourceName), TITLE_MAX_TOKENS);
  const heading = trimToTokenBudget(
    input.headingPath
      .map(singleLine)
      .filter((segment) => segment.length > 0)
      .join(HEADING_PATH_SEPARATOR),
    HEADING_MAX_TOKENS
  );
  const passage = passageText(input.text);
  let formatted = compose([title, heading, passage]);
  if (approximateKnowledgeTokenCount(formatted) > KNOWLEDGE_RERANK_CANDIDATE_MAX_TOKENS) {
    const points = [...passage];
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = compose([title, heading, codePointPrefix(passage, middle)]);
      if (approximateKnowledgeTokenCount(candidate) <= KNOWLEDGE_RERANK_CANDIDATE_MAX_TOKENS) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    formatted = compose([title, heading, codePointPrefix(passage, low)]);
    if (approximateKnowledgeTokenCount(formatted) > KNOWLEDGE_RERANK_CANDIDATE_MAX_TOKENS) {
      // Hostile title/heading input alone exceeded the budget; keep trimming
      // deterministically from the composed value.
      formatted = trimToTokenBudget(formatted, KNOWLEDGE_RERANK_CANDIDATE_MAX_TOKENS);
    }
  }
  if (formatted.length > MAX_RERANK_DOCUMENT_CHARACTERS) {
    // The token budget keeps documents far below the transport character
    // bound (measured in UTF-16 units by the adapter); enforce it explicitly
    // as defense in depth without splitting a surrogate pair.
    let sliced = formatted.slice(0, MAX_RERANK_DOCUMENT_CHARACTERS);
    const last = sliced.charCodeAt(sliced.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) sliced = sliced.slice(0, -1);
    formatted = sliced.trimEnd();
  }
  return formatted.length > 0 ? formatted : "-";
}

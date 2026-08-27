import { MAX_RERANK_DOCUMENT_CHARACTERS } from "../providers/rerank";
import {
  conservativeQwen2TokenUpperBound,
  qwen2BpeTokenCounter
} from "./tokenizer/qwen2BpeTokenizer";

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
 *
 * Version 2 (FR-13) counts the token budget with the model-native Qwen2
 * byte-level BPE tokenizer of the built-in Qwen3 reranker family. If the
 * pinned tokenizer asset cannot be verified at query time, the formatter
 * falls back to the UTF-8 byte upper bound of byte-level BPE, so the limit
 * remains conservative even if the asset is unavailable — retrieval never
 * hard-fails on a formatting-side tokenizer problem (indexing has its own
 * fail-closed path). The provider transport character bound remains an
 * independent defensive guard.
 */
export const KNOWLEDGE_RERANK_CANDIDATE_FORMATTER_VERSION = 2 as const;
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

type TokenCount = (text: string) => number;

function budgetTokenCount(): TokenCount {
  try {
    const counter = qwen2BpeTokenCounter();
    return (text) => counter.countTokens(text);
  } catch {
    return conservativeQwen2TokenUpperBound;
  }
}

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

/** Largest code-point prefix whose token count fits the budget. */
function trimToTokenBudget(count: TokenCount, value: string, maxTokens: number): string {
  if (count(value) <= maxTokens) return value;
  const points = [...value];
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (count(codePointPrefix(value, middle)) <= maxTokens) {
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
 * The result is non-empty, contains no NUL characters, fits the
 * 768-model-token budget, and never exceeds the provider transport document
 * character bound.
 */
export function formatKnowledgeRerankCandidate(
  input: KnowledgeRerankCandidateInput
): string {
  const count = budgetTokenCount();
  const title = trimToTokenBudget(count, singleLine(input.sourceName), TITLE_MAX_TOKENS);
  const heading = trimToTokenBudget(
    count,
    input.headingPath
      .map(singleLine)
      .filter((segment) => segment.length > 0)
      .join(HEADING_PATH_SEPARATOR),
    HEADING_MAX_TOKENS
  );
  const passage = passageText(input.text);
  let formatted = compose([title, heading, passage]);
  if (count(formatted) > KNOWLEDGE_RERANK_CANDIDATE_MAX_TOKENS) {
    const points = [...passage];
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = compose([title, heading, codePointPrefix(passage, middle)]);
      if (count(candidate) <= KNOWLEDGE_RERANK_CANDIDATE_MAX_TOKENS) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    formatted = compose([title, heading, codePointPrefix(passage, low)]);
    if (count(formatted) > KNOWLEDGE_RERANK_CANDIDATE_MAX_TOKENS) {
      // Hostile title/heading input alone exceeded the budget; keep trimming
      // deterministically from the composed value.
      formatted = trimToTokenBudget(count, formatted, KNOWLEDGE_RERANK_CANDIDATE_MAX_TOKENS);
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
  if (count(formatted) > KNOWLEDGE_RERANK_CANDIDATE_MAX_TOKENS) {
    // A character-prefix cut can alter the last BPE merge. Re-assert the
    // model-token bound after the independent transport cut.
    formatted = trimToTokenBudget(
      count,
      formatted,
      KNOWLEDGE_RERANK_CANDIDATE_MAX_TOKENS
    );
  }
  return formatted.length > 0 ? formatted : "-";
}

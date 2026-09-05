import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { KNOWLEDGE_SEARCH_MAPPING_VERSION, KNOWLEDGE_SEARCH_PHYSICAL_INDEX_VERSION } from "../search/opensearch/contract";

const messages = {
  knowledge_search_projection_incomplete: "Knowledge search is not ready. Wait for indexing to finish, then retry; contact an administrator if it remains unavailable.",
  knowledge_retrieval_scope_changed: "Knowledge search readiness changed during this request. Retry after indexing finishes.",
  knowledge_search_candidate_revalidation_failed: "Knowledge search could not verify its index. Contact an administrator.",
  opensearch_timeout: "Knowledge search timed out. Try again later.",
  opensearch_connection_failed: "Knowledge search could not connect to its service. Try again later or contact an administrator.",
  opensearch_rate_limited: "Knowledge search is busy. Try again later.",
  opensearch_unavailable: "Knowledge search is temporarily unavailable. Try again later.",
  opensearch_authentication_failed: "Knowledge search access is misconfigured. Contact an administrator.",
  opensearch_configuration_invalid: "Knowledge search configuration is invalid. Contact an administrator.",
  opensearch_index_incompatible: "Knowledge search requires a compatible index. Contact an administrator.",
  opensearch_index_missing: "Knowledge search requires its index to be restored. Contact an administrator.",
  opensearch_response_invalid: "Knowledge search returned an invalid response. Contact an administrator.",
  opensearch_response_too_large: "Knowledge search exceeded its response limit. Contact an administrator.",
  opensearch_scope_too_large: "The selected Knowledge scope exceeds the search service limit. Select a smaller scope.",
  knowledge_retrieval_failed: "Knowledge retrieval failed. Try again later or contact an administrator."
} as const;

export type KnowledgeSearchFailureCode = keyof typeof messages;
export function isKnowledgeSearchFailureCode(value: unknown): value is KnowledgeSearchFailureCode {
  return typeof value === "string" && Object.hasOwn(messages, value);
}
export function knowledgeSearchFailureMessage(code: KnowledgeSearchFailureCode): string { return messages[code]; }

/** Content-free failure identity. The run/tool call already owns correlation;
 * only a hash of the accepted private scope may accompany the safe reason. */
export class KnowledgeSearchFailure extends Error {
  readonly scopeFingerprint: string | null;
  constructor(readonly code: KnowledgeSearchFailureCode, scopeFingerprint: string | null = null) {
    super(code);
    this.name = "KnowledgeSearchFailure";
    this.scopeFingerprint = scopeFingerprint && /^[0-9a-f]{64}$/u.test(scopeFingerprint) ? scopeFingerprint : null;
  }
}
export function knowledgeSearchFailureCode(error: unknown): KnowledgeSearchFailureCode | null {
  if (error instanceof Error) {
    const code = "code" in error ? error.code : error.message;
    if (isKnowledgeSearchFailureCode(code)) return code;
    if (error.name === "TimeoutError" || error.name === "AbortError" || error.message === "knowledge_retrieval_aborted") return "opensearch_timeout";
  }
  return null;
}
export function knowledgeSearchFailureToolResult(call: ModelToolCall, error: unknown): ToolExecutionResult {
  const code = knowledgeSearchFailureCode(error) ?? "knowledge_retrieval_failed";
  return { callId: call.id, name: call.name, status: "error",
    content: [{ text: knowledgeSearchFailureMessage(code), type: "text" }],
    rawPreview: { knowledgeFailure: {
      code, mappingVersion: KNOWLEDGE_SEARCH_MAPPING_VERSION,
      physicalIndexVersion: KNOWLEDGE_SEARCH_PHYSICAL_INDEX_VERSION,
      scopeFingerprint: error instanceof KnowledgeSearchFailure ? error.scopeFingerprint : null,
      stage: code.includes("projection") || code.includes("scope_changed") ? "readiness"
        : code.includes("revalidation") ? "revalidation" : "search",
      version: 1
    } }, usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 } };
}
export function knowledgeSearchFailureFromToolResult(result: ToolExecutionResult): KnowledgeSearchFailureCode | null {
  if (result.status !== "error") return null;
  const preview = result.rawPreview as { knowledgeFailure?: { code?: unknown; version?: unknown } } | undefined;
  return preview?.knowledgeFailure?.version === 1 && isKnowledgeSearchFailureCode(preview.knowledgeFailure.code)
    ? preview.knowledgeFailure.code : "knowledge_retrieval_failed";
}

export type KnowledgeCoverageLimitationsV1 = Readonly<{
  excludedResources: number;
  retrievalFailures: readonly KnowledgeSearchFailureCode[];
  version: 1;
}>;
export const EMPTY_KNOWLEDGE_COVERAGE_LIMITATIONS_V1: KnowledgeCoverageLimitationsV1 = Object.freeze({
  excludedResources: 0, retrievalFailures: Object.freeze([]), version: 1
});
export function decodeKnowledgeCoverageLimitationsV1(value: unknown): KnowledgeCoverageLimitationsV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 3 || fields.version !== 1 ||
    !Number.isSafeInteger(fields.excludedResources) || (fields.excludedResources as number) < 0 ||
    !Array.isArray(fields.retrievalFailures) || fields.retrievalFailures.length > Object.keys(messages).length ||
    fields.retrievalFailures.some((code, index, codes) => !isKnowledgeSearchFailureCode(code) || index > 0 && codes[index - 1] >= code)) return null;
  return Object.freeze({ excludedResources: fields.excludedResources as number,
    retrievalFailures: Object.freeze([...fields.retrievalFailures]) as readonly KnowledgeSearchFailureCode[], version: 1 });
}
export function knowledgeCoverageLimitationNotes(value: KnowledgeCoverageLimitationsV1): readonly string[] {
  return [
    ...(value.excludedResources > 0 ? [`${value.excludedResources} selected Knowledge resource(s) were excluded. The answer covers only the admitted sources; it cannot establish absence across the full requested scope.`] : []),
    ...value.retrievalFailures.map((code) => `${knowledgeSearchFailureMessage(code)} The retrieved evidence may be incomplete.`)
  ];
}

export function knowledgeScopeLimitedMessage(message: string, exclusions: readonly Readonly<{ count: number }>[] = []): string {
  const limitations = decodeKnowledgeCoverageLimitationsV1({ excludedResources: exclusions.reduce((sum, item) => sum + item.count, 0),
    retrievalFailures: [], version: 1 });
  if (!limitations) throw new Error("knowledge_coverage_limitations_invalid");
  const notes = knowledgeCoverageLimitationNotes(limitations);
  return notes.length ? `${message}\n\n${notes.join("\n")}` : message;
}

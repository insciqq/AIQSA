import type { ToolExecutionResult } from "../tools/types";
import { normalizeSearchSources } from "./evidence";
import { SEARCH_TOOL_RESULT_VERSION, searchToolResultContent, type SearchExecutionEvidence } from "./toolResult";

const usage = { cachedInputTokens: null, cacheWriteInputTokens: null, completeness: "complete" as const, inputTokens: 3, outputTokens: 4,
  reasoningTokens: 0, totalTokens: 7 };

/** A completed engine of a search result, with `count` numbered sources on its own host. */
export function searchEngine(input: Readonly<{ citations?: boolean; count: number; displayName: string; findings: string; host: string;
  optionId: string; protocol?: string; provider?: string }>): SearchExecutionEvidence {
  const sources = normalizeSearchSources(Array.from({ length: input.count }, (_, index) => ({
    ...(input.citations === false ? {} : { citation: index + 1 }), title: `${input.displayName} source ${index + 1}`,
    url: `https://${input.host}/page-${index + 1}`
  })));
  return { displayName: input.displayName, findings: input.findings, invocationId: `call-1:${input.optionId}`, modelId: "model",
    optionId: input.optionId, provider: input.provider ?? "openrouter", ...(input.protocol ? { protocol: input.protocol } : {}),
    revisionId: `revision-${input.optionId}`, sources, status: "complete", usage };
}

/** A failed engine: it adds only a warning. */
export function failedSearchEngine(displayName: string, optionId: string): SearchExecutionEvidence {
  return { displayName, failure: { code: "provider_rate_limited" }, invocationId: `call-1:${optionId}`, modelId: "model", optionId,
    provider: "openrouter", revisionId: `revision-${optionId}`, sources: [], status: "error", usage };
}

/** DeepSeek Search API findings (`lib/server/providers/deepSeekSearchApi.ts`): `[n] title — label` and a summary, per source. */
export function deepSeekFindings(count: number, summaryChars: number): string {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const summary = `Entry ${n} says model M-${n} costs ${1_000 + n} EUR. `.padEnd(summaryChars, `detail ${n} `).trimEnd();
    return `[${n}] DeepSeek source ${n} — shop-${n}.example\n${summary}`;
  }).join("\n\n");
}

/** Prose findings citing `[n]` in each paragraph, `chars` long. */
export function proseFindings(prefix: string, chars: number, sources: number): string {
  const paragraphs: string[] = [];
  let length = 0;
  for (let index = 0; length < chars; index += 1) {
    const paragraph = `${prefix} paragraph ${index + 1} reports finding ${index + 1} with care [${(index % sources) + 1}]. ` +
      "It goes on about the matter at some length so the paragraph has a realistic size for a search engine's answer.";
    paragraphs.push(paragraph);
    length += paragraph.length + 2;
  }
  return paragraphs.join("\n\n").slice(0, chars).trim();
}

/** The tool result the Search executor builds (`searchToolExecutionResult`, `lib/server/search/toolExecutor.ts`). */
export function searchResult(executions: readonly SearchExecutionEvidence[]): ToolExecutionResult {
  return { callId: "c1", content: searchToolResultContent(executions), name: "search_selected_engines",
    rawPreview: { searchExecutions: executions, searchResultVersion: SEARCH_TOOL_RESULT_VERSION },
    status: executions.some((execution) => execution.status === "complete") ? "complete" : "error", usage };
}

/** Acceptance run 2026-11-02's shape: OpenAI, Perplexity, then a DeepSeek block of about 60,000 characters. */
export function threeEngineResult(): ToolExecutionResult {
  return searchResult([
    searchEngine({ count: 8, displayName: "OpenAI", findings: proseFindings("OpenAI", 3_600, 8), host: "openai.example", optionId: "openai" }),
    searchEngine({ count: 6, displayName: "Perplexity", findings: proseFindings("Perplexity", 3_000, 6), host: "pplx.example",
      optionId: "perplexity" }),
    searchEngine({ count: 50, displayName: "DeepSeek", findings: deepSeekFindings(50, 1_150), host: "deepseek.example",
      optionId: "deepseek", protocol: "deepseek_search_api", provider: "deepseek" })
  ]);
}

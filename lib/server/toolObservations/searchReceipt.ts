import { decodeTokenUsage } from "../../domain/usage";
import { normalizeSearchSources, type SearchSource } from "../search/evidence";
import { searchExecutionsFromToolResult, searchExecutionPreviewCount, type SearchExecutionEvidence } from "../search/toolResult";
import type { ToolExecutionResult } from "../tools/types";
import { ObservationStoreError } from "./contract";

export type SearchObservationReceipt = Readonly<{ version: 1; executions: readonly SearchExecutionEvidence[] }>;
const RECEIPT_BYTES = 32 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);
const withoutSnippet = ({ snippet: _snippet, ...source }: SearchSource): SearchSource => source;
const sourceFields = (source: Readonly<Record<string, unknown>>) =>
  JSON.stringify([source.date ?? null, source.rank, source.snippet ?? null, source.title, source.url]);

/** The sole owner of reported usage and of each engine's thread sources. It is
 * recorded before the original is stored and survives its loss. Findings stay
 * only in the model-facing original; snippets, then trailing sources, are
 * dropped deterministically before the bounded receipt could lose usage. */
export function searchObservationReceipt(result: ToolExecutionResult): SearchObservationReceipt {
  const executions = searchExecutionsFromToolResult(result);
  if (!executions.length || executions.length !== searchExecutionPreviewCount(result)) throw new ObservationStoreError("tool_observation_unavailable");
  const build = (sources: (execution: SearchExecutionEvidence) => readonly SearchSource[]) =>
    decodeSearchObservationReceipt({ version: 1, executions: executions.map(execution => ({
      displayName: execution.displayName, invocationId: execution.invocationId, modelId: execution.modelId,
      optionId: execution.optionId, provider: execution.provider, revisionId: execution.revisionId,
      sources: sources(execution), status: execution.status, usage: execution.usage
    })) });
  const candidates = [
    () => build(execution => execution.sources),
    ...Array.from({ length: 21 }, (_, index) => () => build(execution => execution.sources.slice(0, 20 - index).map(withoutSnippet)))
  ];
  for (const candidate of candidates) {
    const receipt = candidate();
    if (receipt && Buffer.byteLength(JSON.stringify(receipt)) <= RECEIPT_BYTES) return receipt;
  }
  throw new ObservationStoreError("tool_observation_unavailable");
}

export function decodeSearchObservationReceipt(value: unknown): SearchObservationReceipt | null {
  if (!record(value) || Object.keys(value).sort().join(",") !== "executions,version" || value.version !== 1 ||
    !Array.isArray(value.executions) || value.executions.length < 1 || value.executions.length > 3) return null;
  const executions: SearchExecutionEvidence[] = [];
  for (const entry of value.executions) {
    if (!record(entry) || Object.keys(entry).sort().join(",") !==
      "displayName,invocationId,modelId,optionId,provider,revisionId,sources,status,usage" ||
      !identity(entry.displayName) || !identity(entry.invocationId) || !identity(entry.optionId) ||
      !identity(entry.provider) || !identity(entry.revisionId) || entry.modelId !== null && !identity(entry.modelId) ||
      !Array.isArray(entry.sources) || entry.sources.length > 20 ||
      entry.status !== "complete" && entry.status !== "error" || !record(entry.usage)) return null;
    // Accept only already normalized, re-ranked thread sources. PostgreSQL
    // JSON reorders keys, so compare fields rather than serialized text.
    const sources = normalizeSearchSources(entry.sources, 20);
    if (sources.length !== entry.sources.length || entry.sources.some((source, index) => !record(source) ||
      Object.keys(source).some(key => !["date", "rank", "snippet", "title", "url"].includes(key)) ||
      sourceFields(source) !== sourceFields(sources[index]!))) return null;
    const usage = decodeTokenUsage(entry.usage);
    const cost = entry.usage.estimatedCostMicros;
    if (!usage || cost !== undefined && cost !== null && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) return null;
    executions.push({ displayName: entry.displayName, invocationId: entry.invocationId, modelId: entry.modelId,
      optionId: entry.optionId, provider: entry.provider, revisionId: entry.revisionId, sources, status: entry.status,
      usage: { ...usage, ...(cost !== undefined ? { estimatedCostMicros: cost as number | null } : {}) } });
  }
  return { version: 1, executions };
}

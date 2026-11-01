import { decodeTokenUsage } from "../../domain/usage";
import { normalizeSearchSources, type SearchSource } from "../search/evidence";
import { searchExecutionsFromToolResult, searchExecutionPreviewCount, type SearchExecutionEvidence } from "../search/toolResult";
import type { ToolExecutionResult } from "../tools/types";
import { ObservationStoreError } from "./contract";

export type SearchObservationReceipt = Readonly<{ version: 1; executions: readonly SearchExecutionEvidence[] }>;
/** Compact JSON budget; PostgreSQL's 64 KiB jsonb text constraint is checked
 * separately because separator overhead grows with the source count. */
export const SEARCH_OBSERVATION_RECEIPT_BYTES = 60 * 1024;
const RECEIPT_JSONB_BYTES = 64 * 1024;
/** Snippet lengths (code points) tried before snippets are dropped. */
const SNIPPET_STEPS = [300, 150] as const;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);
const withoutSnippet = ({ snippet: _snippet, ...source }: SearchSource): SearchSource => source;
/** A shortened snippet stays normalized: trimmed, never a split code point. */
function shortenedSnippet(source: SearchSource, maximum: number): SearchSource {
  const points = source.snippet === undefined ? [] : Array.from(source.snippet);
  return points.length <= maximum ? source : { ...source, snippet: `${points.slice(0, maximum - 1).join("").trimEnd()}…` };
}
const sourceFields = (source: Readonly<Record<string, unknown>>) => JSON.stringify([source.citation ?? null,
  source.date ?? null, source.rank, source.snippet ?? null, source.title, source.url]);

function fitsReceipt(value: unknown): boolean {
  let separatorSpaces = 0;
  try {
    const serialized = JSON.stringify(value, (_key, item: unknown) => {
      if (Array.isArray(item)) separatorSpaces += Math.max(0, item.length - 1);
      else if (record(item)) {
        const fields = Object.values(item).filter(field => field !== undefined).length;
        separatorSpaces += fields + Math.max(0, fields - 1);
      }
      return item;
    });
    if (serialized === undefined) return false;
    const bytes = Buffer.byteLength(serialized);
    return bytes <= SEARCH_OBSERVATION_RECEIPT_BYTES && bytes + separatorSpaces <= RECEIPT_JSONB_BYTES;
  } catch {
    return false;
  }
}

/** The sole owner of reported usage and of each engine's thread sources. It is
 * recorded before the original is stored and survives its loss. Findings stay
 * only in the model-facing original. Ordinary results keep every source as
 * Off persists it; a larger one first shortens snippets, then drops them,
 * then trailing sources, deterministically and never usage. */
export function searchObservationReceipt(result: ToolExecutionResult): SearchObservationReceipt {
  const executions = searchExecutionsFromToolResult(result);
  if (!executions.length || executions.length !== searchExecutionPreviewCount(result)) throw new ObservationStoreError("tool_observation_unavailable");
  const build = (sources: (execution: SearchExecutionEvidence) => readonly SearchSource[]): SearchObservationReceipt =>
    ({ version: 1, executions: executions.map(execution => ({
      ...(execution.costUsd !== undefined ? { costUsd: execution.costUsd } : {}),
      displayName: execution.displayName, invocationId: execution.invocationId, modelId: execution.modelId,
      optionId: execution.optionId, provider: execution.provider, revisionId: execution.revisionId,
      sources: sources(execution), status: execution.status, usage: execution.usage
    })) });
  const candidates = [
    () => build(execution => execution.sources),
    ...SNIPPET_STEPS.map(maximum => () => build(execution => execution.sources.map(source => shortenedSnippet(source, maximum)))),
    () => build(execution => execution.sources.map(withoutSnippet))
  ];
  for (const candidate of candidates) {
    const receipt = decodeSearchObservationReceipt(candidate());
    if (receipt) return receipt;
  }

  // Prefixes shrink monotonically. Find the largest shared per-engine prefix
  // in O(log N) candidates instead of rebuilding N successively shorter lists.
  const stripped = build(execution => execution.sources.map(withoutSnippet));
  const prefix = (count: number): SearchObservationReceipt => ({ version: 1,
    executions: stripped.executions.map(execution => ({ ...execution, sources: execution.sources.slice(0, count) })) });
  let low = 0;
  let high = stripped.executions.reduce((maximum, execution) => Math.max(maximum, execution.sources.length), 0);
  if (!fitsReceipt(prefix(0))) throw new ObservationStoreError("tool_observation_unavailable");
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fitsReceipt(prefix(middle))) low = middle;
    else high = middle - 1;
  }
  const receipt = decodeSearchObservationReceipt(prefix(low));
  if (!receipt) throw new ObservationStoreError("tool_observation_unavailable");
  return receipt;
}

export function decodeSearchObservationReceipt(value: unknown): SearchObservationReceipt | null {
  if (!record(value) || Object.keys(value).sort().join(",") !== "executions,version" || value.version !== 1 ||
    !Array.isArray(value.executions) || value.executions.length < 1 || value.executions.length > 3 || !fitsReceipt(value)) return null;
  const executions: SearchExecutionEvidence[] = [];
  for (const entry of value.executions) {
    // A reported engine cost is optional; receipts written before it lack the key.
    if (!record(entry) || Object.keys(entry).filter(key => key !== "costUsd").sort().join(",") !==
      "displayName,invocationId,modelId,optionId,provider,revisionId,sources,status,usage" ||
      entry.costUsd !== undefined && (typeof entry.costUsd !== "number" || !Number.isFinite(entry.costUsd) || entry.costUsd < 0) ||
      !identity(entry.displayName) || !identity(entry.invocationId) || !identity(entry.optionId) ||
      !identity(entry.provider) || !identity(entry.revisionId) || entry.modelId !== null && !identity(entry.modelId) ||
      !Array.isArray(entry.sources) ||
      entry.status !== "complete" && entry.status !== "error" || !record(entry.usage)) return null;
    // Accept only already normalized, re-ranked thread sources. PostgreSQL
    // JSON reorders keys, so compare fields rather than serialized text. The
    // citation number lets a restore render each engine's numbered sources.
    const sources = normalizeSearchSources(entry.sources);
    if (sources.length !== entry.sources.length || entry.sources.some((source, index) => !record(source) ||
      Object.keys(source).some(key => !["citation", "date", "rank", "snippet", "title", "url"].includes(key)) ||
      sourceFields(source) !== sourceFields(sources[index]!))) return null;
    const usage = decodeTokenUsage(entry.usage);
    const cost = entry.usage.estimatedCostMicros;
    if (!usage || cost !== undefined && cost !== null && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) return null;
    executions.push({ ...(entry.costUsd !== undefined ? { costUsd: entry.costUsd as number } : {}),
      displayName: entry.displayName, invocationId: entry.invocationId, modelId: entry.modelId,
      optionId: entry.optionId, provider: entry.provider, revisionId: entry.revisionId, sources, status: entry.status,
      usage: { ...usage, ...(cost !== undefined ? { estimatedCostMicros: cost as number | null } : {}) } });
  }
  const receipt = { version: 1 as const, executions };
  return fitsReceipt(receipt) ? receipt : null;
}

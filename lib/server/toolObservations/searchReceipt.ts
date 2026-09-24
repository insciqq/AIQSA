import { decodeTokenUsage } from "../../domain/usage";
import { searchExecutionsFromToolResult, searchExecutionPreviewCount, type SearchExecutionEvidence } from "../search/toolResult";
import type { ToolExecutionResult } from "../tools/types";
import { ObservationStoreError } from "./contract";

export type SearchObservationReceipt = Readonly<{ version: 1; executions: readonly SearchExecutionEvidence[] }>;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);

/** Small accounting facts survive loss of the original object. No findings,
 * snippets or raw provider body are duplicated in this independent receipt. */
export function searchObservationReceipt(result: ToolExecutionResult): SearchObservationReceipt {
  const executions = searchExecutionsFromToolResult(result);
  if (!executions.length || executions.length !== searchExecutionPreviewCount(result)) throw new ObservationStoreError("tool_observation_unavailable");
  const receipt = decodeSearchObservationReceipt({ version: 1, executions: executions.map(execution => ({
    displayName: execution.displayName, invocationId: execution.invocationId, modelId: execution.modelId,
    optionId: execution.optionId, provider: execution.provider, revisionId: execution.revisionId,
    sources: [], status: execution.status, usage: execution.usage
  })) });
  if (!receipt || Buffer.byteLength(JSON.stringify(receipt)) > 32 * 1024) throw new ObservationStoreError("tool_observation_unavailable");
  return receipt;
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
      !Array.isArray(entry.sources) || entry.sources.length !== 0 ||
      entry.status !== "complete" && entry.status !== "error" || !record(entry.usage)) return null;
    const usage = decodeTokenUsage(entry.usage);
    const cost = entry.usage.estimatedCostMicros;
    if (!usage || cost !== undefined && cost !== null && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) return null;
    executions.push({ displayName: entry.displayName, invocationId: entry.invocationId, modelId: entry.modelId,
      optionId: entry.optionId, provider: entry.provider, revisionId: entry.revisionId, sources: [], status: entry.status,
      usage: { ...usage, ...(cost !== undefined ? { estimatedCostMicros: cost as number | null } : {}) } });
  }
  return { version: 1, executions };
}

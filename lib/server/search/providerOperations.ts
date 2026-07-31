import {
  decodeThreadSearchExecution,
  type ThreadSearchExecution,
  type ThreadSearchProviderOperation
} from "../../contracts/toolActivity";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";

const operationLimit = 32;
const operationTraceByteLimit = 16 * 1_024;
const engineQueryLimit = 2_000;
const queryLimit = 512;
const queryListLimit = 8;
const urlLimit = 2_048;

export type ProviderSearchOperationTrace = Readonly<{
  operations: ThreadSearchProviderOperation[];
  truncated: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= maxLength
    ? value.trim()
    : null;
}

function operationKind(value: unknown): ThreadSearchProviderOperation["kind"] {
  if (value === "search" || value === "open_page" || value === "find_in_page") return value;
  return "unknown";
}

function operationStatus(value: unknown): ThreadSearchProviderOperation["status"] {
  if (value === "completed" || value === "complete" || value === "succeeded") return "complete";
  if (value === "failed" || value === "error" || value === "incomplete") return "error";
  if (value === "in_progress" || value === "searching" || value === "running") return "running";
  return "unknown";
}

function operationQueries(action: Record<string, unknown> | null): string[] {
  if (!action) return [];
  const candidates = [
    ...(typeof action.query === "string" ? [action.query] : []),
    ...(Array.isArray(action.queries) ? action.queries : [])
  ];
  const queries: string[] = [];
  for (const candidate of candidates) {
    const query = boundedString(candidate, queryLimit);
    if (query && !queries.includes(query)) queries.push(query);
    if (queries.length >= queryListLimit) break;
  }
  return queries;
}

function mergeOperation(
  current: ThreadSearchProviderOperation,
  next: ThreadSearchProviderOperation
): ThreadSearchProviderOperation {
  const queries = [...current.queries];
  for (const query of next.queries) {
    if (!queries.includes(query) && queries.length < queryListLimit) queries.push(query);
  }
  return {
    ...current,
    id: next.id ?? current.id,
    kind: next.kind === "unknown" ? current.kind : next.kind,
    pattern: next.pattern ?? current.pattern,
    queries,
    status: next.status === "unknown" ? current.status : next.status,
    url: next.url ?? current.url
  };
}

/**
 * Reduces provider-native Responses activity to the private, bounded facts the
 * Run receipt needs. Raw provider payloads, source bodies, headers, and
 * reasoning never cross this boundary.
 */
export function providerSearchOperationsFromArtifacts(
  artifacts: readonly ModelRunSseEvent[]
): ProviderSearchOperationTrace {
  const operations = new Map<string, ThreadSearchProviderOperation>();
  let nextOrdinal = 0;
  let truncated = false;

  for (const event of artifacts) {
    if (event.type !== "artifact" || event.data.artifactType !== "search" ||
      !isRecord(event.data.payload) || event.data.payload.type !== "web_search_call") {
      continue;
    }
    const payload = event.data.payload;
    const action = isRecord(payload.action) ? payload.action : null;
    const id = boundedString(payload.id, 256);
    const outputIndex = typeof payload.outputIndex === "number" && Number.isSafeInteger(payload.outputIndex)
      && payload.outputIndex >= 0
      ? payload.outputIndex
      : null;
    const key = id ?? (outputIndex === null ? `ordinal:${nextOrdinal}` : `output:${outputIndex}`);
    const existing = operations.get(key);
    const operation: ThreadSearchProviderOperation = {
      id,
      kind: operationKind(action?.type),
      ordinal: existing?.ordinal ?? nextOrdinal,
      pattern: boundedString(action?.pattern, queryLimit),
      queries: operationQueries(action),
      status: operationStatus(payload.status),
      url: boundedString(action?.url, urlLimit)
    };
    if (existing) {
      operations.set(key, mergeOperation(existing, operation));
      continue;
    }
    if (operations.size >= operationLimit) {
      truncated = true;
      continue;
    }
    operations.set(key, operation);
    nextOrdinal += 1;
  }

  const bounded: ThreadSearchProviderOperation[] = [];
  for (const operation of operations.values()) {
    const candidate = [...bounded, operation];
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > operationTraceByteLimit) {
      truncated = true;
      break;
    }
    bounded.push(operation);
  }
  return { operations: bounded, truncated };
}

/**
 * Projects the durable tool-result snapshot. `null` means this was not a
 * Search-plan result; an empty array is a reported Search result with no
 * executions.
 */
export function threadSearchExecutionsFromToolPreview(
  rawPreview: unknown
): ThreadSearchExecution[] | null {
  if (!isRecord(rawPreview) || !isRecord(rawPreview.finalProviderResponsePreview)) return null;
  const preview = rawPreview.finalProviderResponsePreview;
  if (!Array.isArray(preview.searchExecutions) || preview.searchExecutions.length > 3) return null;

  const executions = preview.searchExecutions.flatMap((value) => {
    if (!isRecord(value) || !Array.isArray(value.sources)) return [];
    const optionId = boundedString(value.optionId, 512);
    const displayName = boundedString(value.displayName, 256) ?? optionId;
    const projected = decodeThreadSearchExecution({
      displayName,
      durationMs: value.durationMs ?? null,
      modelId: value.modelId ?? null,
      optionId,
      provider: value.provider,
      providerOperations: value.providerOperations ?? null,
      providerOperationsTruncated: value.providerOperationsTruncated === true,
      query: boundedString(value.query, engineQueryLimit),
      sourceCount: value.sources.length,
      status: value.status,
      warning: boundedString(value.warning, 512)
    });
    return projected ? [projected] : [];
  });

  return executions.length === preview.searchExecutions.length ? executions : null;
}

import type {
  ThreadSearchActivity,
  ThreadSearchActivityStatus,
  ThreadSearchOperation
} from "../contracts/chats";
import {
  decodeThreadSearchProviderOperation,
  threadSearchProviderOperationTraceWithinLimit,
  type ThreadSearchExecution,
  type ThreadSearchSource,
  type ThreadToolActivity
} from "../contracts/toolActivity";
import { safeExternalHref } from "./links";

const activityLimit = 12;
const operationLimit = 32;
const operationTraceByteLimit = 16 * 1_024;
const queryLimit = 512;
const queryListLimit = 8;
const sourceLimit = 20;
const sourceTraversalLimit = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= maximum
    ? value.trim()
    : null;
}

function httpHref(value: unknown): string | null {
  const href = safeExternalHref(value);
  if (!href) return null;
  try {
    const url = new URL(href);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? href
      : null;
  } catch {
    return null;
  }
}

/** Projects only normalized, link-safe source facts from provider-owned values. */
export function projectThreadSearchSources(value: unknown): ThreadSearchSource[] {
  const sources: ThreadSearchSource[] = [];
  const seenUrls = new Set<string>();
  const pending: unknown[] = [value];
  let visited = 0;

  while (pending.length > 0 && sources.length < sourceLimit && visited < sourceTraversalLimit) {
    const candidate = pending.shift();
    visited += 1;
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }
    if (Array.isArray(candidate)) {
      const remaining = Math.max(0, sourceTraversalLimit - visited - pending.length);
      pending.push(...candidate.slice(0, remaining));
      continue;
    }

    const record = candidate as Record<string, unknown>;
    const url = httpHref(record.url) ?? httpHref(record.href);
    if (url && !seenUrls.has(url)) {
      const date = boundedString(record.date, 80) ?? boundedString(record.publishedAt, 80);
      const snippet = boundedString(record.snippet, 2_000) ?? boundedString(record.description, 2_000);
      seenUrls.add(url);
      sources.push({
        ...(date ? { date } : {}),
        rank: sources.length + 1,
        ...(snippet ? { snippet } : {}),
        title: boundedString(record.title, 500) ?? url,
        url
      });
    }
  }

  return sources;
}

function operationKind(value: unknown): ThreadSearchOperation["kind"] {
  if (value === "search" || value === "open_page" || value === "find_in_page") return value;
  return "unknown";
}

function operationStatus(value: unknown): ThreadSearchOperation["status"] {
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
  current: ThreadSearchOperation,
  next: ThreadSearchOperation
): ThreadSearchOperation {
  const queries = [...current.queries];
  for (const query of next.queries) {
    if (!queries.includes(query) && queries.length < queryListLimit) queries.push(query);
  }
  return {
    ...current,
    kind: next.kind === "unknown" ? current.kind : next.kind,
    pattern: next.pattern ?? current.pattern,
    queries,
    status: next.status === "unknown" ? current.status : next.status,
    url: next.url ?? current.url
  };
}

function projectProviderOperations(payloads: readonly unknown[]): {
  operations: ThreadSearchOperation[];
  truncated: boolean;
} {
  const operations = new Map<string, ThreadSearchOperation>();
  let nextOrdinal = 0;
  let truncated = false;

  for (const value of payloads) {
    if (!isRecord(value) || value.type !== "web_search_call") continue;
    const action = isRecord(value.action) ? value.action : null;
    const id = boundedString(value.id, 256);
    const outputIndex = typeof value.outputIndex === "number" && Number.isSafeInteger(value.outputIndex) && value.outputIndex >= 0
      ? value.outputIndex
      : null;
    const key = id ?? (outputIndex === null ? `ordinal:${nextOrdinal}` : `output:${outputIndex}`);
    const existing = operations.get(key);
    const operation: ThreadSearchOperation = {
      kind: operationKind(action?.type),
      ordinal: existing?.ordinal ?? nextOrdinal,
      pattern: boundedString(action?.pattern, queryLimit),
      queries: operationQueries(action),
      status: operationStatus(value.status),
      url: httpHref(action?.url)
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

  const bounded: ThreadSearchOperation[] = [];
  for (const operation of operations.values()) {
    const candidate = [...bounded, operation];
    if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > operationTraceByteLimit) {
      truncated = true;
      break;
    }
    bounded.push(operation);
  }
  return { operations: bounded, truncated };
}

function activityStatusFromOperations(
  operations: readonly ThreadSearchOperation[],
  fallbackStatus?: string
): ThreadSearchActivityStatus {
  const statuses = new Set(operations.map((operation) => operation.status));
  const terminalFallback = fallbackStatus === "cancelled" ||
    fallbackStatus === "error" ||
    fallbackStatus === "complete"
    ? fallbackStatus
    : null;
  if (terminalFallback) {
    const effectiveStatuses = new Set<ThreadSearchActivityStatus>(
      operations.map((operation) =>
        operation.status === "running" || operation.status === "unknown"
          ? terminalFallback
          : operation.status
      )
    );
    if (effectiveStatuses.size === 0) effectiveStatuses.add(terminalFallback);
    if (effectiveStatuses.size > 1) return "partial";
    return [...effectiveStatuses][0] ?? terminalFallback;
  }
  if (statuses.has("running")) return "running";
  if (statuses.has("complete") && statuses.has("error")) return "partial";
  if (statuses.has("complete")) return "complete";
  if (statuses.has("error")) return "error";
  if (fallbackStatus === "in_progress" || fallbackStatus === "streaming") return "running";
  return "unknown";
}

function toolStatus(status: ThreadToolActivity["status"]): ThreadSearchActivityStatus {
  return status;
}

function executionActivity(execution: ThreadSearchExecution): ThreadSearchActivity {
  return {
    displayName: execution.displayName,
    providerOperations: execution.providerOperations?.map(({ id: _id, ...operation }) => operation) ?? null,
    providerOperationsTruncated: execution.providerOperationsTruncated,
    query: execution.query,
    sourceCount: execution.sourceCount,
    sources: execution.sources ?? [],
    status: execution.status
  };
}

export function projectToolSearchActivity(
  calls: readonly ThreadToolActivity[],
  fallbackDisplayName = "Search source"
): ThreadSearchActivity[] {
  return calls
    .filter((call) => call.capability === "web_search")
    .flatMap((call) => {
      if (call.searchExecutions && call.searchExecutions.length > 0) {
        return call.searchExecutions.map(executionActivity);
      }
      const query = isRecord(call.argumentsPreview)
        ? boundedString(call.argumentsPreview.query, 2_000)
        : null;
      return [{
        displayName: boundedString(fallbackDisplayName, 256) ?? "Search source",
        providerOperations: null,
        providerOperationsTruncated: false,
        query,
        sourceCount: null,
        sources: [],
        status: toolStatus(call.status)
      }];
    })
    .slice(0, activityLimit);
}

export function projectHostedSearchActivity(input: Readonly<{
  displayName: string | null | undefined;
  payloads: readonly unknown[];
  runStatus?: string;
}>): ThreadSearchActivity | null {
  const payloads = input.payloads.filter(
    (payload): payload is Record<string, unknown> => isRecord(payload) && payload.type === "web_search_call"
  );
  if (payloads.length === 0) return null;
  const trace = projectProviderOperations(payloads);
  const sourceValues = payloads.flatMap((payload) => {
    const action = isRecord(payload.action) ? payload.action : null;
    return action && Array.isArray(action.sources) ? [action.sources] : [];
  });
  const sources = projectThreadSearchSources(sourceValues);
  return {
    displayName: boundedString(input.displayName, 256) ?? "Search source",
    providerOperations: trace.operations,
    providerOperationsTruncated: trace.truncated,
    query: trace.operations.flatMap((operation) => operation.queries).at(0) ?? null,
    sourceCount: sourceValues.length > 0 ? sources.length : null,
    sources,
    status: activityStatusFromOperations(trace.operations, input.runStatus)
  };
}

function decodedOperations(value: unknown): ThreadSearchOperation[] | null {
  if (!Array.isArray(value) || value.length > operationLimit) return null;
  const operations = value.flatMap((operation) => {
    const decoded = decodeThreadSearchProviderOperation(operation);
    if (!decoded) return [];
    const { id: _id, ...safeOperation } = decoded;
    return [safeOperation];
  });
  return operations.length === value.length &&
    threadSearchProviderOperationTraceWithinLimit(operations)
    ? operations
    : null;
}

function queryFromSearchRun(value: Record<string, unknown>, artifacts: Record<string, unknown> | null): string | null {
  const direct = boundedString(value.query, 2_000);
  if (direct) return direct;
  const toolCall = artifacts && isRecord(artifacts.toolCall) ? artifacts.toolCall : null;
  const argumentsValue = toolCall && isRecord(toolCall.arguments) ? toolCall.arguments : null;
  return boundedString(argumentsValue?.query, 2_000);
}

function recognizedSearchRunSources(artifacts: Record<string, unknown> | null): unknown[] | null {
  if (!artifacts) return null;
  if (Array.isArray(artifacts.sources)) return artifacts.sources;
  const preview = isRecord(artifacts.finalProviderResponsePreview)
    ? artifacts.finalProviderResponsePreview
    : null;
  if (!preview) return null;
  if (Array.isArray(preview.sources)) return preview.sources;
  if (!Array.isArray(preview.searchExecutions)) return null;
  let observedSources = false;
  const executionSources = preview.searchExecutions.flatMap((execution) => {
    if (!isRecord(execution) || !Array.isArray(execution.sources)) return [];
    observedSources = true;
    return execution.sources;
  });
  return observedSources ? executionSources : null;
}

export function projectSearchRunActivity(
  value: unknown,
  fallbackDisplayName?: string | null
): ThreadSearchActivity | null {
  if (!isRecord(value)) return null;
  const artifacts = isRecord(value.artifacts) ? value.artifacts : null;
  const displayName = boundedString(artifacts?.displayName, 256) ??
    boundedString(fallbackDisplayName, 256) ??
    "Search source";
  const status = value.status === "complete" || value.status === "error"
    ? value.status
    : value.status === "cancelled"
      ? "cancelled"
      : value.status === "running" || value.status === "in_progress"
        ? "running"
        : "unknown";
  const sourceValue = recognizedSearchRunSources(artifacts);
  const sources = projectThreadSearchSources(sourceValue ?? []);
  let providerOperations = decodedOperations(artifacts?.providerOperations);
  let providerOperationsTruncated = artifacts?.providerOperationsTruncated === true;
  if (providerOperations === null && Array.isArray(artifacts?.events)) {
    const payloads = artifacts.events.flatMap((event) =>
      isRecord(event) && "payload" in event ? [event.payload] : []
    );
    const trace = projectProviderOperations(payloads);
    providerOperations = trace.operations.length > 0 ? trace.operations : null;
    providerOperationsTruncated ||= trace.truncated;
  }
  return {
    displayName,
    providerOperations,
    providerOperationsTruncated,
    query: queryFromSearchRun(value, artifacts),
    sourceCount: sourceValue === null ? null : sources.length,
    sources,
    status
  };
}

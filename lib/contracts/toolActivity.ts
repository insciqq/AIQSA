export type ThreadToolActivityStatus = "cancelled" | "complete" | "error" | "running";

export type ThreadSearchProviderOperation = {
  id: string | null;
  kind: "find_in_page" | "open_page" | "search" | "unknown";
  ordinal: number;
  pattern: string | null;
  queries: string[];
  status: "complete" | "error" | "running" | "unknown";
  url: string | null;
};

export type ThreadSearchExecution = {
  displayName: string;
  durationMs: number | null;
  modelId: string | null;
  optionId: string;
  provider: string;
  providerOperations: ThreadSearchProviderOperation[] | null;
  providerOperationsTruncated: boolean;
  query: string | null;
  sourceCount: number;
  status: "complete" | "error";
  warning: string | null;
};

export type ThreadToolActivity = {
  argumentsPreview: unknown;
  callId: string;
  capability: "mcp" | "web_search";
  credentialSources: ("oauth" | "personal" | "shared")[];
  durationMs: number | null;
  errorMessage: string | null;
  externalAccountLabel: string | null;
  ordinal: number;
  resultPreview: unknown;
  round: number;
  searchExecutions?: ThreadSearchExecution[];
  serverName: string | null;
  status: ThreadToolActivityStatus;
  toolName: string;
};

const previewCharacterLimit = 8_192;
const identityLengthLimit = 512;
const operationLimit = 32;
const operationQueryLimit = 512;
const operationQueriesLimit = 8;
const operationTraceByteLimit = 16 * 1_024;
const operationUrlLimit = 2_048;
const searchExecutionQueryLimit = 2_000;
const searchExecutionLimit = 3;
const searchSourceLimit = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength = identityLengthLimit): string | null {
  return typeof value === "string" && value.trim() && value.length <= maxLength
    ? value.trim()
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function boundedPreview(value: unknown): unknown | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && serialized.length <= previewCharacterLimit
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function credentialSources(value: unknown): ThreadToolActivity["credentialSources"] | null {
  if (!Array.isArray(value) || value.length > 3) {
    return null;
  }

  const sources = value.filter(
    (source): source is ThreadToolActivity["credentialSources"][number] =>
      source === "oauth" || source === "personal" || source === "shared"
  );
  return sources.length === value.length ? sources : null;
}

function activityStatus(value: unknown): ThreadToolActivityStatus | null {
  return value === "cancelled" || value === "complete" || value === "error" || value === "running"
    ? value
    : null;
}

function providerOperationStatus(value: unknown): ThreadSearchProviderOperation["status"] | null {
  return value === "complete" || value === "error" || value === "running" || value === "unknown"
    ? value
    : null;
}

function providerOperationKind(value: unknown): ThreadSearchProviderOperation["kind"] | null {
  return value === "find_in_page" || value === "open_page" || value === "search" || value === "unknown"
    ? value
    : null;
}

function nullableBoundedString(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null;
  return boundedString(value, maxLength) ?? undefined;
}

export function decodeThreadSearchProviderOperation(
  value: unknown
): ThreadSearchProviderOperation | null {
  if (!isRecord(value)) return null;
  const id = nullableBoundedString(value.id, 256);
  const kind = providerOperationKind(value.kind);
  const ordinal = nonNegativeInteger(value.ordinal);
  const pattern = nullableBoundedString(value.pattern, operationQueryLimit);
  const status = providerOperationStatus(value.status);
  const url = nullableBoundedString(value.url, operationUrlLimit);
  if (
    id === undefined ||
    !kind ||
    ordinal === null ||
    pattern === undefined ||
    !status ||
    url === undefined ||
    !Array.isArray(value.queries) ||
    value.queries.length > operationQueriesLimit
  ) {
    return null;
  }
  const queries = value.queries.map((query) => boundedString(query, operationQueryLimit));
  if (queries.some((query) => query === null)) return null;
  return {
    id,
    kind,
    ordinal,
    pattern,
    queries: queries as string[],
    status,
    url
  };
}

export function decodeThreadSearchExecution(value: unknown): ThreadSearchExecution | null {
  if (!isRecord(value)) return null;
  const displayName = boundedString(value.displayName, 256);
  const durationMs = value.durationMs === null ? null : nonNegativeInteger(value.durationMs);
  const modelId = nullableBoundedString(value.modelId, 512);
  const optionId = boundedString(value.optionId, 512);
  const provider = boundedString(value.provider, 256);
  const query = nullableBoundedString(value.query, searchExecutionQueryLimit);
  const sourceCount = nonNegativeInteger(value.sourceCount);
  const warning = nullableBoundedString(value.warning, 512);
  const status = value.status === "complete" || value.status === "error" ? value.status : null;
  if (
    !displayName ||
    durationMs === null && value.durationMs !== null ||
    modelId === undefined ||
    !optionId ||
    !provider ||
    query === undefined ||
    sourceCount === null ||
    sourceCount > searchSourceLimit ||
    warning === undefined ||
    !status
  ) {
    return null;
  }
  let providerOperations: ThreadSearchProviderOperation[] | null;
  if (value.providerOperations === null) {
    providerOperations = null;
  } else if (Array.isArray(value.providerOperations) && value.providerOperations.length <= operationLimit) {
    providerOperations = value.providerOperations.map(decodeThreadSearchProviderOperation)
      .filter((operation): operation is ThreadSearchProviderOperation => operation !== null);
    if (providerOperations.length !== value.providerOperations.length) return null;
  } else {
    return null;
  }
  let serializedOperations: string;
  try {
    serializedOperations = JSON.stringify(providerOperations);
  } catch {
    return null;
  }
  const providerOperationsTruncated = value.providerOperationsTruncated === undefined
    ? false
    : value.providerOperationsTruncated;
  if (
    typeof providerOperationsTruncated !== "boolean" ||
    new TextEncoder().encode(serializedOperations).byteLength > operationTraceByteLimit
  ) {
    return null;
  }
  return {
    displayName,
    durationMs,
    modelId,
    optionId,
    provider,
    providerOperations,
    providerOperationsTruncated,
    query,
    sourceCount,
    status,
    warning
  };
}

function searchExecutions(value: unknown): ThreadSearchExecution[] | null {
  if (!Array.isArray(value) || value.length > searchExecutionLimit) return null;
  const executions = value.map(decodeThreadSearchExecution)
    .filter((execution): execution is ThreadSearchExecution => execution !== null);
  return executions.length === value.length ? executions : null;
}

export function decodeThreadToolActivity(value: unknown): ThreadToolActivity | null {
  if (!isRecord(value)) {
    return null;
  }

  const callId = boundedString(value.callId, 256);
  const capability = value.capability === "mcp" || value.capability === "web_search"
    ? value.capability
    : null;
  const sources = credentialSources(value.credentialSources);
  const durationMs = value.durationMs === null ? null : nonNegativeInteger(value.durationMs);
  const errorMessage = value.errorMessage === null
    ? null
    : boundedString(value.errorMessage, 512);
  const externalAccountLabel = value.externalAccountLabel === null
    ? null
    : boundedString(value.externalAccountLabel, 256);
  const ordinal = nonNegativeInteger(value.ordinal);
  const round = nonNegativeInteger(value.round);
  const serverName = value.serverName === null ? null : boundedString(value.serverName, 256);
  const status = activityStatus(value.status);
  const toolName = boundedString(value.toolName, 256);
  const argumentsPreview = boundedPreview(value.argumentsPreview);
  const resultPreview = boundedPreview(value.resultPreview);
  const executions = value.searchExecutions === undefined
    ? undefined
    : searchExecutions(value.searchExecutions);

  if (
    !callId ||
    !capability ||
    !sources ||
    durationMs === null && value.durationMs !== null ||
    errorMessage === null && value.errorMessage !== null ||
    externalAccountLabel === null && value.externalAccountLabel !== null ||
    ordinal === null ||
    round === null ||
    serverName === null && value.serverName !== null ||
    !status ||
    !toolName ||
    argumentsPreview === undefined ||
    resultPreview === undefined ||
    executions === null ||
    (capability === "mcp" && !serverName)
  ) {
    return null;
  }

  return {
    argumentsPreview,
    callId,
    capability,
    credentialSources: [...sources],
    durationMs,
    errorMessage,
    externalAccountLabel,
    ordinal,
    resultPreview,
    round,
    ...(executions !== undefined ? { searchExecutions: [...executions] } : {}),
    serverName,
    status,
    toolName
  };
}

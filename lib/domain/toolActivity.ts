import type {
  ThreadToolActivity,
  ThreadToolActivityStatus
} from "../contracts/toolActivity";

export {
  decodeThreadToolActivity,
  type ThreadToolActivity,
  type ThreadToolActivityStatus
} from "../contracts/toolActivity";

const previewCharacterLimit = 8_192;
const identityLengthLimit = 512;

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

function artifact(value: unknown, expectedType: "tool_call" | "tool_result"): Record<string, unknown> | null {
  if (!isRecord(value) || value.artifactType !== expectedType || !isRecord(value.payload)) {
    return null;
  }
  return value.payload;
}

function callActivity(value: unknown): ThreadToolActivity | null {
  const payload = artifact(value, "tool_call");
  if (!payload || payload.status !== "requested" || !isRecord(payload.snapshot)) {
    return null;
  }

  const snapshot = payload.snapshot;
  const capability = snapshot.capability === "mcp" || snapshot.capability === "web_search"
    ? snapshot.capability
    : null;
  const sources = credentialSources(snapshot.credentialSources ?? []);
  const callId = boundedString(payload.callId, 256);
  const round = nonNegativeInteger(payload.round);
  const ordinal = nonNegativeInteger(payload.ordinal);
  const toolName = boundedString(snapshot.toolName, 256);
  const serverName = snapshot.serverName === undefined
    ? null
    : boundedString(snapshot.serverName, 256);
  const externalAccountLabel = snapshot.externalAccountLabel === undefined || snapshot.externalAccountLabel === null
    ? null
    : boundedString(snapshot.externalAccountLabel, 256);
  const argumentsPreview = boundedPreview(payload.argumentsPreview);

  if (
    !capability ||
    !sources ||
    !callId ||
    round === null ||
    ordinal === null ||
    !toolName ||
    (capability === "mcp" && !serverName) ||
    (snapshot.externalAccountLabel !== undefined && snapshot.externalAccountLabel !== null && !externalAccountLabel) ||
    argumentsPreview === undefined
  ) {
    return null;
  }

  return {
    argumentsPreview,
    callId,
    capability,
    credentialSources: [...sources],
    durationMs: null,
    errorMessage: null,
    externalAccountLabel,
    ordinal,
    resultPreview: null,
    round,
    serverName,
    status: "running",
    toolName
  };
}

function terminalFallback(
  status: ThreadToolActivityStatus,
  runStatus: string | undefined
): ThreadToolActivityStatus {
  if (status !== "running") {
    return status;
  }
  if (runStatus === "cancelled") {
    return "cancelled";
  }
  if (runStatus === "error" || runStatus === "complete") {
    return "error";
  }
  return status;
}

export function projectThreadToolActivity(
  artifacts: readonly unknown[],
  runStatus?: string
): ThreadToolActivity[] {
  const calls = new Map<string, ThreadToolActivity>();

  for (const value of artifacts) {
    const call = callActivity(value);
    if (call && !calls.has(call.callId)) {
      calls.set(call.callId, call);
      continue;
    }

    const payload = artifact(value, "tool_result");
    if (!payload) {
      continue;
    }
    const callId = boundedString(payload.callId, 256);
    const current = callId ? calls.get(callId) : null;
    const round = nonNegativeInteger(payload.round);
    const ordinal = nonNegativeInteger(payload.ordinal);
    if (!current || round !== current.round || ordinal !== current.ordinal) {
      continue;
    }

    const durationMs = payload.durationMs === undefined
      ? null
      : nonNegativeInteger(payload.durationMs);
    const resultPreview = payload.resultPreview === undefined
      ? null
      : boundedPreview(payload.resultPreview);
    const errorMessage = payload.message === undefined
      ? null
      : boundedString(payload.message, 512);
    const status = payload.status === "complete"
      ? "complete"
      : payload.status === "error"
        ? errorMessage?.toLowerCase().includes("cancel")
          ? "cancelled"
          : "error"
        : null;
    if (
      (payload.durationMs !== undefined && durationMs === null) ||
      resultPreview === undefined ||
      (payload.message !== undefined && !errorMessage) ||
      !status
    ) {
      continue;
    }

    calls.set(callId!, {
      ...current,
      durationMs,
      errorMessage,
      resultPreview,
      status
    });
  }

  return [...calls.values()]
    .map((call) => ({
      ...call,
      status: terminalFallback(call.status, runStatus)
    }))
    .sort((left, right) => left.round - right.round || left.ordinal - right.ordinal);
}

/**
 * Combines two observations of the same call without letting a stale running
 * snapshot replace terminal evidence. The right-hand observation otherwise
 * wins, while nullable result metadata is retained from either source.
 */
export function mergeThreadToolActivity(
  left: ThreadToolActivity,
  right: ThreadToolActivity
): ThreadToolActivity {
  const leftTerminal = left.status !== "running";
  const rightTerminal = right.status !== "running";
  const preferred = leftTerminal && !rightTerminal ? left : right;
  const fallback = preferred === left ? right : left;

  return {
    ...fallback,
    ...preferred,
    durationMs: preferred.durationMs ?? fallback.durationMs,
    errorMessage: preferred.errorMessage ?? fallback.errorMessage,
    resultPreview: preferred.resultPreview ?? fallback.resultPreview
  };
}

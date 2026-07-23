export type ThreadToolActivityStatus = "cancelled" | "complete" | "error" | "running";

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
  serverName: string | null;
  status: ThreadToolActivityStatus;
  toolName: string;
};

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

function activityStatus(value: unknown): ThreadToolActivityStatus | null {
  return value === "cancelled" || value === "complete" || value === "error" || value === "running"
    ? value
    : null;
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
    serverName,
    status,
    toolName
  };
}

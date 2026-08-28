import type { Prisma } from "@prisma/client";
import { memorySha256, normalizeMemorySearchText } from "../persistence/lexical";
import { projectMemoryHistorySafeText } from "./safety";

export const MEMORY_TOOL_EVENT_PROJECTION_VERSION = "memory-tool-event-v1";
export const MEMORY_TOOL_EVENT_MAX_SOURCE_CALLS = 4_096;
export const MEMORY_TOOL_EVENT_MAX_SAFE_TEXT_LENGTH = 2_000;
const MEMORY_TOOL_EVENT_MAX_SEARCH_TEXT_LENGTH = 4_000;

export type MemoryToolEventOutcome = "FAILURE" | "PARTIAL" | "SUCCESS";

export type MemoryToolEventSource = Readonly<{
  assistantMessageId: string;
  branchGeneration: number;
  chatId: string;
  completedAt: Date;
  modelRunId: string;
  modelRunToolCallId: string;
  result: Prisma.JsonValue | null;
  sourceAssistantId: string | null;
  sourceCallUpdatedAt: Date;
  sourceFolderId: string | null;
  sourceRevision: number;
  state: "complete" | "error";
  toolName: string;
  userId: string;
}>;

export type MemoryToolEventProjection = Readonly<{
  assistantMessageId: string;
  branchGeneration: number;
  chatId: string;
  contentHash: string;
  evidenceRootHash: string;
  id: string;
  languageCode: "und";
  modelRunId: string;
  modelRunToolCallId: string;
  normalizedSafeSearchText: string;
  occurredAt: string;
  operation: string;
  outcome: MemoryToolEventOutcome;
  projectionVersion: typeof MEMORY_TOOL_EVENT_PROJECTION_VERSION;
  redactionReasonCodes: readonly string[];
  redactionState: "NOT_NEEDED" | "REDACTED";
  safeProjectedText: string;
  safetyClass: "NORMAL" | "SENSITIVE";
  sourceAssistantId: string | null;
  sourceCallUpdatedAt: string;
  sourceFolderId: string | null;
  sourcePayloadHash: string;
  sourceRevision: number;
  structuredIdentifiers: Readonly<Record<string, string>>;
  toolName: string;
  userId: string;
}>;

const excludedTools = new Set([
  "edit_memory",
  "find_tools",
  "forget_memory",
  "mark_memory_correct",
  "mark_memory_incorrect",
  "save_memory",
  "search_my_history"
]);

const allowedScalarKeys = new Map<string, string>([
  ["calendar_name", "calendar"],
  ["code", "code"],
  ["completed_at", "completed_at"],
  ["count", "count"],
  ["created_at", "created_at"],
  ["endpoint", "endpoint"],
  ["end_time", "end_time"],
  ["error", "error"],
  ["error_code", "error_code"],
  ["event_title", "event"],
  ["file_name", "filename"],
  ["filename", "filename"],
  ["http_status", "status_code"],
  ["name", "name"],
  ["operation", "operation"],
  ["resource_name", "resource"],
  ["result_count", "result_count"],
  ["start_time", "start_time"],
  ["status", "status"],
  ["status_code", "status_code"],
  ["title", "title"]
]);

const safeToolNamePattern = /^[\p{L}\p{N}_.:/-]{1,128}$/u;
const safeLabelPattern = /^[a-z][a-z0-9_]{0,31}$/u;

function scalarText(value: unknown): string | null {
  if (typeof value === "string") {
    const compact = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
    return compact && compact.length <= 256 ? compact : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

function boundedNormalizedSearchText(value: string): string {
  const normalized = normalizeMemorySearchText(value);
  const sliced = normalized.slice(0, MEMORY_TOOL_EVENT_MAX_SEARCH_TEXT_LENGTH);
  const last = sliced.charCodeAt(sliced.length - 1);
  return (last >= 0xD800 && last <= 0xDBFF ? sliced.slice(0, -1) : sliced).trim();
}

function lexicalAlias(value: string): string | null {
  const alias = value.normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return alias && normalizeMemorySearchText(alias) !== normalizeMemorySearchText(value)
    ? alias
    : null;
}

function sanitizeEndpoint(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0, 256);
  } catch {
    return value.startsWith("/") && value.length <= 256 ? value : null;
  }
}

type ExtractedScalar = Readonly<{ label: string; value: string }>;

function extractAllowedScalars(value: Prisma.JsonValue | null): Readonly<{
  redactionReasonCodes: readonly string[];
  sawMeaningfulSafeScalar: boolean;
  sawRecognizedSecret: boolean;
  values: readonly ExtractedScalar[];
}> {
  const pending: Array<Readonly<{ depth: number; value: Prisma.JsonValue }>> =
    value === null ? [] : [{ depth: 0, value }];
  const values: ExtractedScalar[] = [];
  const seen = new Set<string>();
  let visited = 0;
  let sawMeaningfulSafeScalar = false;
  let sawRecognizedSecret = false;
  const redactionReasonCodes = new Set<string>();

  while (pending.length > 0 && visited < 128 && values.length < 12) {
    const current = pending.shift()!;
    visited += 1;
    if (current.depth > 3 || current.value === null ||
      typeof current.value !== "object") continue;
    if (Array.isArray(current.value)) {
      for (const child of current.value.slice(0, 8)) {
        pending.push({ depth: current.depth + 1, value: child });
      }
      continue;
    }
    for (const [key, child] of Object.entries(current.value).slice(0, 64)) {
      const observableScalar = scalarText(child);
      if (observableScalar) {
        const observed = projectMemoryHistorySafeText(observableScalar);
        if (!observed.eligible) {
          if (observed.redactionReasonCodes.includes("SECRET_ONLY")) {
            sawRecognizedSecret = true;
            redactionReasonCodes.add("SECRET_FIELD_DROPPED");
          }
        } else {
          sawMeaningfulSafeScalar = true;
          for (const reason of observed.redactionReasonCodes) {
            redactionReasonCodes.add(reason);
          }
          if (observed.redactionReasonCodes.length > 0) sawRecognizedSecret = true;
        }
      }
      const normalizedKey = key.toLowerCase().replace(/[-\s]+/gu, "_");
      const label = allowedScalarKeys.get(normalizedKey);
      if (label && safeLabelPattern.test(label)) {
        let text = scalarText(child);
        if (text && label === "endpoint") text = sanitizeEndpoint(text);
        if (text) {
          const projected = projectMemoryHistorySafeText(text);
          if (!projected.eligible) {
            if (projected.redactionReasonCodes.includes("SECRET_ONLY")) {
              sawRecognizedSecret = true;
              redactionReasonCodes.add("SECRET_FIELD_DROPPED");
            }
          } else {
            for (const reason of projected.redactionReasonCodes) {
              redactionReasonCodes.add(reason);
            }
            if (projected.redactionReasonCodes.length > 0) sawRecognizedSecret = true;
            const identity = `${label}:${projected.safeText}`;
            if (!seen.has(identity)) {
              seen.add(identity);
              values.push({ label, value: projected.safeText });
            }
          }
        }
      }
      if (child !== null && typeof child === "object" && current.depth < 3) {
        pending.push({ depth: current.depth + 1, value: child });
      }
    }
  }
  return {
    redactionReasonCodes: Object.freeze([...redactionReasonCodes].sort()),
    sawMeaningfulSafeScalar,
    sawRecognizedSecret,
    values: Object.freeze(values)
  };
}

function toolOutcome(
  state: MemoryToolEventSource["state"],
  identifiers: readonly ExtractedScalar[]
): MemoryToolEventOutcome {
  if (state === "error") return "FAILURE";
  const status = identifiers.find(({ label }) => label === "status")?.value
    .toLocaleLowerCase("und");
  if (status && new Set([
    "degraded", "incomplete", "partial", "partially_completed", "warning"
  ]).has(status)) return "PARTIAL";
  if (status && new Set([
    "cancelled", "canceled", "error", "failed", "failure", "rejected",
    "timed_out", "timeout", "unavailable"
  ]).has(status)) return "FAILURE";
  const statusCode = Number(identifiers.find(({ label }) =>
    label === "status_code")?.value);
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) {
    return "FAILURE";
  }
  if (identifiers.some(({ label, value }) =>
    label === "error_code" || label === "error" &&
      !new Set(["0", "false", "no", "none", "null"]).has(
        value.toLocaleLowerCase("und")
      ))) return "FAILURE";
  return "SUCCESS";
}

export function projectMemoryToolEvent(
  source: MemoryToolEventSource
): MemoryToolEventProjection | null {
  if (
    !safeToolNamePattern.test(source.toolName) ||
    excludedTools.has(source.toolName.toLocaleLowerCase("und")) ||
    !source.assistantMessageId || !source.chatId || !source.modelRunId ||
    !source.modelRunToolCallId || !source.userId ||
    !Number.isSafeInteger(source.branchGeneration) || source.branchGeneration < 0 ||
    !Number.isSafeInteger(source.sourceRevision) || source.sourceRevision < 0 ||
    !Number.isFinite(source.completedAt.getTime()) ||
    !Number.isFinite(source.sourceCallUpdatedAt.getTime()) ||
    source.sourceCallUpdatedAt < source.completedAt
  ) return null;

  const extracted = extractAllowedScalars(source.result);
  if (extracted.values.length === 0 && extracted.sawRecognizedSecret &&
    !extracted.sawMeaningfulSafeScalar) return null;
  const operation = extracted.values.find(({ label }) => label === "operation")?.value ??
    source.toolName;
  const outcome = toolOutcome(source.state, extracted.values);
  const occurredAt = source.completedAt.toISOString();
  const detail = extracted.values
    .filter(({ label }) => label !== "operation")
    .map(({ label, value }) => `${label}: ${value}`)
    .join("; ");
  const candidateText = [
    `Tool observation — tool: ${source.toolName}; operation: ${operation}; outcome: ${outcome}; occurred_at: ${occurredAt}`,
    detail
  ].filter(Boolean).join("; ");
  const projected = projectMemoryHistorySafeText(
    candidateText.slice(0, MEMORY_TOOL_EVENT_MAX_SAFE_TEXT_LENGTH)
  );
  if (!projected.eligible) return null;
  const redactionReasonCodes = Object.freeze([...new Set([
    ...projected.redactionReasonCodes,
    ...extracted.redactionReasonCodes
  ])].sort());

  const structuredIdentifiers = Object.freeze(Object.fromEntries(
    extracted.values
      .filter(({ label }) => label !== "operation")
      .map(({ label, value }) => [label, value])
  ));
  const lexicalAliases = extracted.values.flatMap(({ value }) => {
    const alias = lexicalAlias(value);
    return alias ? [alias] : [];
  });
  const sourcePayloadHash = memorySha256(source.result);
  const contentHash = memorySha256({
    occurredAt,
    operation,
    outcome,
    projectionVersion: MEMORY_TOOL_EVENT_PROJECTION_VERSION,
    safeProjectedText: projected.safeText,
    sourcePayloadHash,
    structuredIdentifiers,
    toolName: source.toolName
  });
  const id = memorySha256({
    contentHash,
    domain: "aiqsa.memory.tool-event",
    modelRunToolCallId: source.modelRunToolCallId,
    projectionVersion: MEMORY_TOOL_EVENT_PROJECTION_VERSION,
    userId: source.userId
  });
  return Object.freeze({
    assistantMessageId: source.assistantMessageId,
    branchGeneration: source.branchGeneration,
    chatId: source.chatId,
    contentHash,
    evidenceRootHash: memorySha256({
      domain: "aiqsa.memory.tool-event-evidence-root",
      modelRunId: source.modelRunId,
      modelRunToolCallId: source.modelRunToolCallId,
      sourcePayloadHash,
      userId: source.userId
    }),
    id,
    languageCode: "und",
    modelRunId: source.modelRunId,
    modelRunToolCallId: source.modelRunToolCallId,
    normalizedSafeSearchText: boundedNormalizedSearchText([
      ...lexicalAliases,
      projected.safeText
    ].join(" ")),
    occurredAt,
    operation,
    outcome,
    projectionVersion: MEMORY_TOOL_EVENT_PROJECTION_VERSION,
    redactionReasonCodes,
    redactionState: redactionReasonCodes.length > 0 ? "REDACTED" : "NOT_NEEDED",
    safeProjectedText: projected.safeText,
    safetyClass: projected.safetyClass,
    sourceAssistantId: source.sourceAssistantId,
    sourceCallUpdatedAt: source.sourceCallUpdatedAt.toISOString(),
    sourceFolderId: source.sourceFolderId,
    sourcePayloadHash,
    sourceRevision: source.sourceRevision,
    structuredIdentifiers,
    toolName: source.toolName,
    userId: source.userId
  });
}

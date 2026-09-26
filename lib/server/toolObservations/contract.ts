import { createHash } from "node:crypto";
import { OBSERVATION_ENCODING } from "./codec";
import { OBSERVATION_READ_LIMITS, ObservationReadError, type ObservationByteSelector } from "./byteReader";
import { getMcpResponseWireLimits, type McpResponseWireLimits } from "../mcp/responseLimits";

export const TOOL_OBSERVATION_POLICY_VERSION = 1 as const;
export const TOOL_OBSERVATION_SOURCES = ["mcp", "workspace", "search", "skill", "knowledge"] as const;
export type ToolObservationSource = typeof TOOL_OBSERVATION_SOURCES[number];

/** Private accepted authority, separate from the model-visible descriptor.
 * Source owners validate these references against their existing run bindings. */
export type ToolObservationSourceBinding = Readonly<{ version: 1 }> & (
  | Readonly<{ source: "mcp"; serverId: string; originalName: string; revisionId: string; fingerprint: string }>
  | Readonly<{ source: "search"; sources: readonly Readonly<{ optionId: string; revisionId: string }>[] }>
  | Readonly<{ source: "skill"; skillId: string; revisionId: string }>
);

export class ObservationStoreError extends Error {
  /** The operation is known to have executed (an unavailable result only). */
  readonly executed: boolean;
  constructor(readonly code: "tool_observation_unavailable" | "tool_observation_limit_exceeded" |
    "tool_observation_conflict" | "tool_observation_storage_unavailable" | "tool_observation_busy" |
    "tool_observation_not_started", options: Readonly<{ executed?: boolean }> = {}) {
    super(code);
    this.name = "ObservationStoreError";
    this.executed = code === "tool_observation_unavailable" && options.executed === true;
  }
}

export function observationFailure(error: unknown): Readonly<{ code: string; message: string }> | null {
  if (!(error instanceof ObservationStoreError)) return null;
  return { code: error.code, message: error.code === "tool_observation_storage_unavailable"
    ? "Saved tool results require streaming storage, which is unavailable. This new operation was not dispatched."
    : error.code === "tool_observation_limit_exceeded"
      ? "The budget for retained tool results is exhausted. This new operation was not dispatched; existing results remain readable."
      : error.code === "tool_observation_busy"
        ? "Saved tool results are temporarily busy. This new operation was not dispatched; it may be retried later."
        : error.code === "tool_observation_not_started"
          ? "This operation was not started: the run can no longer accept tool results. Nothing was executed."
          : error.executed
            ? "The operation executed, but its saved result is unavailable. Do not execute it again to recover the result."
            : "The original operation may have completed, but its saved result is unavailable. Do not execute it again to recover the result." };
}

/** Storage location, actor/run IDs, credentials and source bindings stay in
 * the repository. A handle is a lookup key, never an authorization token. */
export type ToolObservationDescriptor = Readonly<{
  version: 1;
  handle: string;
  source: ToolObservationSource;
  encoding: typeof OBSERVATION_ENCODING;
  byteSize: number;
  checksum: string;
  sourceTruncated: boolean;
  maskable: boolean;
}>;

export const TOOL_OBSERVATION_LIMITS = Object.freeze({
  inlineBytes: 8 * 1024,
  previewBytes: 2048,
  projectionBytes: 8 * 1024,
  readerEstimatedTokens: 4096,
  readerBytes: 16 * 1024,
  /** Externalized originals (exact size) plus in-flight reservation ceilings
   * of one run and of its branch. Inline rows are bounded database values,
   * like a persisted Off result, and count toward neither budget: every
   * counted original exceeds `inlineBytes`, so the bytes also bound objects. */
  runBytes: 64 * 1024 * 1024,
  branchBytes: 256 * 1024 * 1024,
  /** The tool loop's accepted parallel calls (`maxConcurrency`). */
  concurrentCalls: 4,
  /** Process-wide bytes of originals being encoded, uploaded or read in full.
   * This bounds storage streams and transient buffers, never business calls. */
  inFlightBytes: 32 * 1024 * 1024,
  /** Waiting storage phases before new dispatches and model reads are refused
   * as transient; an already executed result always waits for its turn. */
  queuedOperations: 64,
  storageTimeoutMs: 60_000,
  storageLeaseMs: 120_000
});

/** The MCP adapter's reservation ceiling: the configured wire cap plus the
 * original's small versioned envelope. */
export function mcpObservationMaximumBytes(limits: McpResponseWireLimits = getMcpResponseWireLimits()): number {
  return limits.callToolResponseMaxBytes + 64 * 1024;
}

/** Store usage of the reserving run and its branch: retained externalized
 * bytes plus in-flight ceilings of reservations not yet published. */
export type ToolObservationBudgetUsage = Readonly<{ runBytes: bigint; branchBytes: bigint }>;

/** The per-run ceiling never refuses a full parallel batch at the configured
 * wire cap when nothing is retained. Search (8 MiB) and Workspace (6 MiB and
 * an envelope) ceilings stay below `runBytes / concurrentCalls`. */
export function toolObservationRunBytes(limits: McpResponseWireLimits = getMcpResponseWireLimits()): number {
  return Math.max(TOOL_OBSERVATION_LIMITS.runBytes, TOOL_OBSERVATION_LIMITS.concurrentCalls * mcpObservationMaximumBytes(limits));
}

export function admitsToolObservationReservation(usage: ToolObservationBudgetUsage, maximumBytes: number,
  limits: McpResponseWireLimits = getMcpResponseWireLimits()): boolean {
  return usage.runBytes + BigInt(maximumBytes) <= BigInt(toolObservationRunBytes(limits)) &&
    usage.branchBytes + BigInt(maximumBytes) <= BigInt(TOOL_OBSERVATION_LIMITS.branchBytes);
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function decodeToolObservationSourceBinding(value: unknown, source: string): ToolObservationSourceBinding | null {
  if (!record(value) || value.version !== 1 || value.source !== source) return null;
  const id = (field: unknown) => typeof field === "string" && field.length > 0 && field.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(field);
  const keys = Object.keys(value).sort().join(",");
  if (source === "mcp" && keys === "fingerprint,originalName,revisionId,serverId,source,version" &&
    id(value.originalName) && id(value.revisionId) && id(value.serverId) &&
    typeof value.fingerprint === "string" && /^[a-f0-9]{64}$/u.test(value.fingerprint)) return value as ToolObservationSourceBinding;
  if (source === "skill" && keys === "revisionId,skillId,source,version" && id(value.revisionId) && id(value.skillId)) {
    return value as ToolObservationSourceBinding;
  }
  if (source === "search" && keys === "source,sources,version" && Array.isArray(value.sources) &&
    value.sources.length > 0 && value.sources.length <= 3 && value.sources.every(item => record(item) &&
      Object.keys(item).sort().join(",") === "optionId,revisionId" && id(item.optionId) && id(item.revisionId))) {
    return value as ToolObservationSourceBinding;
  }
  return null;
}

export function isToolObservationHandle(value: unknown): value is string {
  return typeof value === "string" && /^tor1_[a-f0-9]{32}$/u.test(value);
}

/** Strict version decoding deliberately leaves historical inline results
 * alone; an unknown descriptor must not become a promise of exact recall. */
export function decodeToolObservationDescriptor(value: unknown): ToolObservationDescriptor | null {
  if (!record(value) || Object.keys(value).sort().join(",") !==
    "byteSize,checksum,encoding,handle,maskable,source,sourceTruncated,version" ||
    value.version !== TOOL_OBSERVATION_POLICY_VERSION || !isToolObservationHandle(value.handle) ||
    value.encoding !== OBSERVATION_ENCODING || !TOOL_OBSERVATION_SOURCES.some(source => source === value.source) ||
    !Number.isSafeInteger(value.byteSize) || Number(value.byteSize) < 1 || Number(value.byteSize) > OBSERVATION_READ_LIMITS.documentBytes ||
    typeof value.checksum !== "string" || !/^[a-f0-9]{64}$/u.test(value.checksum) ||
    typeof value.sourceTruncated !== "boolean" || typeof value.maskable !== "boolean" ||
    value.source === "skill" && value.maskable) return null;
  return value as ToolObservationDescriptor;
}

export type ToolObservationReadInput = Readonly<{
  handle: string;
  selector: ObservationByteSelector;
  /** Present only when continuing a previously returned immutable identity. */
  expectedChecksum?: string;
}>;

const invalid = () => new ObservationReadError("tool_observation_selector_invalid");
const queryHash = (query: string | undefined) => createHash("sha256").update(query ?? "").digest("hex");

export function decodeToolObservationReadInput(value: unknown): ToolObservationReadInput {
  if (!record(value) || Object.keys(value).some(key => !["handle", "offset", "maxBytes", "query", "cursor"].includes(key)) ||
    !isToolObservationHandle(value.handle) || value.query !== undefined && typeof value.query !== "string") throw invalid();
  let offset: unknown = value.offset ?? 0;
  let expectedChecksum: string | undefined;
  if (value.cursor !== undefined) {
    if (value.offset !== undefined || typeof value.cursor !== "string" || value.cursor.length > 512 ||
      !/^[A-Za-z0-9_-]+$/u.test(value.cursor)) throw invalid();
    let cursor: unknown;
    try { cursor = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value.cursor, "base64url"))); }
    catch { throw invalid(); }
    if (!record(cursor) || Object.keys(cursor).sort().join(",") !== "checksum,handle,offset,query,version" ||
      cursor.version !== 1 || cursor.handle !== value.handle || cursor.query !== queryHash(value.query) ||
      typeof cursor.checksum !== "string" || !/^[a-f0-9]{64}$/u.test(cursor.checksum)) throw invalid();
    offset = cursor.offset;
    expectedChecksum = cursor.checksum;
  }
  const maxBytes = value.maxBytes ?? OBSERVATION_READ_LIMITS.fragmentBytes;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > OBSERVATION_READ_LIMITS.documentBytes ||
    !Number.isSafeInteger(maxBytes) || Number(maxBytes) < 4 || Number(maxBytes) > OBSERVATION_READ_LIMITS.fragmentBytes ||
    value.query !== undefined && (!value.query.length || /[\ud800-\udfff]/u.test(value.query) ||
      Buffer.byteLength(value.query) > Math.min(OBSERVATION_READ_LIMITS.queryBytes, Number(maxBytes)))) throw invalid();
  return { handle: value.handle, selector: { offset: Number(offset), maxBytes: Number(maxBytes),
    ...(value.query !== undefined ? { query: value.query } : {}) }, ...(expectedChecksum ? { expectedChecksum } : {}) };
}

export function toolObservationCursor(descriptor: ToolObservationDescriptor, offset: number, query?: string): string {
  if (!decodeToolObservationDescriptor(descriptor) || !Number.isSafeInteger(offset) || offset < 0 || offset > descriptor.byteSize) throw invalid();
  return Buffer.from(JSON.stringify({ version: 1, handle: descriptor.handle, checksum: descriptor.checksum,
    query: queryHash(query), offset })).toString("base64url");
}

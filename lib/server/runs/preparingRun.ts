import { createHash } from "node:crypto";
import type { MemoryReceiptOutcome } from "@prisma/client";
import {
  MEMORY_RETRIEVAL_PIPELINE_VERSION,
  MEMORY_RETRIEVAL_PLANNER_VERSION,
  type MemoryRetrievalItemType,
  type MemorySafeProjectionKind
} from "../../domain/memory/retrieval";
import { memoryExplicitStatementContainsSecret } from "../memory/explicit/safety";
import type { NormalizedRunRequest } from "../providers/types";

export const MEMORY_PREPARING_ATTEMPT_TTL_MS = 10 * 60_000;
export const MEMORY_PREPARING_BASE_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
export const MEMORY_PREPARING_CONTEXT_MAX_TOKENS = 1_800;
export const MEMORY_PREPARING_ITEM_LIMIT = 13;
export const MEMORY_PREPARING_QUERY_PLANNER_VERSION =
  MEMORY_RETRIEVAL_PLANNER_VERSION;
export const MEMORY_PREPARING_RETRIEVAL_PIPELINE_VERSION =
  MEMORY_RETRIEVAL_PIPELINE_VERSION;

const safeCode = /^[a-z][a-z0-9_]{0,63}$/u;
const safeSelectionReason = /^[a-z][a-z0-9_.:+-]{0,127}$/u;
const MEMORY_PREPARING_CONTEXT_MAX_BYTES = 64 * 1024;
const MEMORY_PREPARING_EVIDENCE_JSON_MAX_BYTES = 64 * 1024;
const MEMORY_PREPARING_SAFE_QUERY_MAX_LENGTH = 2_000;

export type MemoryPreparingSettingsSnapshot = Readonly<{
  acceptedUtilityEgressFingerprint: string | null;
  acceptedUtilityPolicyVersion: string | null;
  activeIndexGenerationId: string | null;
  decayEnabled: boolean;
  decayPolicyVersion: string | null;
  learnAutomatically: boolean;
  memoryConsentRevision: number;
  referenceChatHistory: boolean;
  schemaVersion: 2;
  settingsRevision: number;
  useMemoryFacts: boolean;
}>;

export type MemoryPreparingBaseSnapshot = Readonly<{
  normalizedRequest: NormalizedRunRequest;
  providerRequestPreview: Readonly<Record<string, unknown>>;
  schemaVersion: 1;
}>;

type MemoryPreparingItemInputBase = Readonly<{
  exactSafeText: string;
  featureSnapshot?: Readonly<Record<string, unknown>>;
  finalScore: number;
  laneRanks?: Readonly<Record<string, unknown>>;
  projectionKind?: MemorySafeProjectionKind;
  selectionReason: string;
  supportingItemId?: string | null;
}>;

export type MemoryPreparingItemInput = MemoryPreparingItemInputBase & (
  | Readonly<{
      exactItemId?: string;
      factVersionId: string;
      itemType?: "FACT_VERSION";
    }>
  | Readonly<{
      exactItemId: string;
      itemType: "RECALL_CHUNK";
      recallChunkId: string;
    }>
);

export type MemoryPreparingItemTarget = Readonly<{
  exactItemId: string;
  factVersionId: string | null;
  itemType: MemoryRetrievalItemType;
  recallChunkId: string | null;
}>;

export function memoryPreparingItemTarget(
  item: MemoryPreparingItemInput
): MemoryPreparingItemTarget | null {
  if ((item.itemType === undefined || item.itemType === "FACT_VERSION") &&
    "factVersionId" in item && item.factVersionId) {
    const exactItemId = item.exactItemId ?? item.factVersionId;
    return exactItemId === item.factVersionId
      ? {
          exactItemId,
          factVersionId: item.factVersionId,
          itemType: "FACT_VERSION",
          recallChunkId: null
        }
      : null;
  }
  if (item.itemType === "RECALL_CHUNK" && "recallChunkId" in item &&
    item.recallChunkId && item.exactItemId === item.recallChunkId) {
    return {
      exactItemId: item.exactItemId,
      factVersionId: null,
      itemType: "RECALL_CHUNK",
      recallChunkId: item.recallChunkId
    };
  }
  return null;
}

export type MemoryPreparingAttemptResult = Readonly<{
  budgetSnapshot: Readonly<Record<string, unknown>>;
  degradationCode?: string | null;
  items?: readonly MemoryPreparingItemInput[];
  outcome: MemoryReceiptOutcome;
  preparedContext?: Readonly<{
    approxTokens: number;
    text: string;
  }> | null;
  /** Optional when the safe query itself is withheld after secret screening. */
  queryHash?: string;
  querySnapshot?: string | null;
}>;

export class MemoryPreparingRunConflictError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean
  ) {
    super(safeCode.test(code) ? code : "memory_preparing_run_conflict");
    this.name = "MemoryPreparingRunConflictError";
    this.code = this.message;
  }
}

function jsonSnapshot(value: unknown, maximumBytes: number): unknown {
  const serialized = JSON.stringify(value);
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > maximumBytes
  ) {
    throw new MemoryPreparingRunConflictError("memory_base_request_too_large", false);
  }
  return JSON.parse(serialized) as unknown;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new MemoryPreparingRunConflictError("memory_snapshot_invalid", false);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new MemoryPreparingRunConflictError("memory_snapshot_invalid", false);
}

export function memoryPreparingHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function memoryPreparingTextHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createMemoryPreparingBaseSnapshot(input: Readonly<{
  normalizedRequest: NormalizedRunRequest;
  providerRequestPreview: Readonly<Record<string, unknown>>;
}>): MemoryPreparingBaseSnapshot {
  return jsonSnapshot({
    normalizedRequest: input.normalizedRequest,
    providerRequestPreview: input.providerRequestPreview,
    schemaVersion: 1
  }, MEMORY_PREPARING_BASE_SNAPSHOT_MAX_BYTES) as MemoryPreparingBaseSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedJson(value: unknown, maximumBytes: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && Buffer.byteLength(serialized, "utf8") <= maximumBytes;
  } catch {
    return false;
  }
}

export function decodeMemoryPreparingBaseSnapshot(
  value: unknown
): MemoryPreparingBaseSnapshot | null {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
    !isRecord(value.normalizedRequest) || !isRecord(value.providerRequestPreview)) {
    return null;
  }
  try {
    const snapshot = jsonSnapshot(value, MEMORY_PREPARING_BASE_SNAPSHOT_MAX_BYTES);
    return snapshot as MemoryPreparingBaseSnapshot;
  } catch {
    return null;
  }
}

export function memoryPreparingSettingsSnapshot(value: Readonly<{
  acceptedUtilityEgressFingerprint: string | null;
  acceptedUtilityPolicyVersion: string | null;
  activeIndexGenerationId: string | null;
  decayEnabled: boolean;
  decayPolicyVersion: string | null;
  learnAutomatically: boolean;
  memoryConsentRevision: number;
  referenceChatHistory: boolean;
  settingsRevision: number;
  useMemoryFacts: boolean;
}>): MemoryPreparingSettingsSnapshot {
  return Object.freeze({
    acceptedUtilityEgressFingerprint: value.acceptedUtilityEgressFingerprint,
    acceptedUtilityPolicyVersion: value.acceptedUtilityPolicyVersion,
    activeIndexGenerationId: value.activeIndexGenerationId,
    decayEnabled: value.decayEnabled,
    decayPolicyVersion: value.decayPolicyVersion,
    learnAutomatically: value.learnAutomatically,
    memoryConsentRevision: value.memoryConsentRevision,
    referenceChatHistory: value.referenceChatHistory,
    schemaVersion: 2 as const,
    settingsRevision: value.settingsRevision,
    useMemoryFacts: value.useMemoryFacts
  });
}

export function decodeMemoryPreparingSettingsSnapshot(
  value: unknown
): MemoryPreparingSettingsSnapshot | null {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) return null;
  const nullableString = (entry: unknown) => entry === null || typeof entry === "string";
  if (
    typeof value.useMemoryFacts !== "boolean" ||
    typeof value.referenceChatHistory !== "boolean" ||
    typeof value.learnAutomatically !== "boolean" ||
    typeof value.memoryConsentRevision !== "number" ||
    !Number.isSafeInteger(value.memoryConsentRevision) ||
    value.memoryConsentRevision < 0 ||
    typeof value.settingsRevision !== "number" ||
    !Number.isSafeInteger(value.settingsRevision) ||
    value.settingsRevision < 0 ||
    !nullableString(value.activeIndexGenerationId) ||
    !nullableString(value.acceptedUtilityEgressFingerprint) ||
    !nullableString(value.acceptedUtilityPolicyVersion) ||
    (value.schemaVersion === 2 && (
      typeof value.decayEnabled !== "boolean" ||
      !nullableString(value.decayPolicyVersion)
    ))
  ) {
    return null;
  }
  if (value.schemaVersion === 1) {
    return Object.freeze({
      ...value,
      decayEnabled: false,
      decayPolicyVersion: null,
      schemaVersion: 2 as const
    }) as MemoryPreparingSettingsSnapshot;
  }
  return value as MemoryPreparingSettingsSnapshot;
}

export function sameMemoryPreparingSettings(
  left: MemoryPreparingSettingsSnapshot,
  right: MemoryPreparingSettingsSnapshot,
  options: Readonly<{ requireUtilityEgressMatch?: boolean }> = {}
): boolean {
  return left.activeIndexGenerationId === right.activeIndexGenerationId &&
    left.decayEnabled === right.decayEnabled &&
    left.decayPolicyVersion === right.decayPolicyVersion &&
    left.learnAutomatically === right.learnAutomatically &&
    left.referenceChatHistory === right.referenceChatHistory &&
    left.useMemoryFacts === right.useMemoryFacts &&
    (options.requireUtilityEgressMatch !== false
      ? left.acceptedUtilityEgressFingerprint === right.acceptedUtilityEgressFingerprint &&
        left.acceptedUtilityPolicyVersion === right.acceptedUtilityPolicyVersion &&
        left.memoryConsentRevision === right.memoryConsentRevision
      : true);
}

export function validateMemoryPreparingAttemptResult(
  input: MemoryPreparingAttemptResult
): void {
  const items = input.items ?? [];
  const context = input.preparedContext ?? null;
  if (
    !isRecord(input.budgetSnapshot) ||
    !boundedJson(input.budgetSnapshot, MEMORY_PREPARING_EVIDENCE_JSON_MAX_BYTES) ||
    items.length > MEMORY_PREPARING_ITEM_LIMIT
  ) {
    throw new MemoryPreparingRunConflictError("memory_attempt_result_invalid", false);
  }
  if (input.degradationCode !== undefined && input.degradationCode !== null &&
    !safeCode.test(input.degradationCode)) {
    throw new MemoryPreparingRunConflictError("memory_attempt_result_invalid", false);
  }
  if (input.querySnapshot !== undefined && input.querySnapshot !== null && (
    input.querySnapshot.length === 0 ||
    input.querySnapshot.length > MEMORY_PREPARING_SAFE_QUERY_MAX_LENGTH ||
    input.querySnapshot.includes("\u0000") ||
    memoryExplicitStatementContainsSecret(input.querySnapshot)
  )) {
    throw new MemoryPreparingRunConflictError("memory_attempt_result_invalid", false);
  }
  if (input.queryHash !== undefined && !/^[a-f0-9]{64}$/u.test(input.queryHash)) {
    throw new MemoryPreparingRunConflictError("memory_attempt_result_invalid", false);
  }
  if (input.queryHash !== undefined && input.querySnapshot != null &&
    input.queryHash !== memoryPreparingTextHash(input.querySnapshot)) {
    throw new MemoryPreparingRunConflictError("memory_attempt_result_invalid", false);
  }
  if (context && (
    context.text.length === 0 ||
    Buffer.byteLength(context.text, "utf8") > MEMORY_PREPARING_CONTEXT_MAX_BYTES ||
    !Number.isSafeInteger(context.approxTokens) ||
    context.approxTokens < 0 ||
    context.approxTokens > MEMORY_PREPARING_CONTEXT_MAX_TOKENS
  )) {
    throw new MemoryPreparingRunConflictError("memory_attempt_result_invalid", false);
  }
  const visibleOutcome = input.outcome === "USED" || input.outcome === "DEGRADED";
  if (visibleOutcome && (!context || items.length === 0)) {
    throw new MemoryPreparingRunConflictError("memory_attempt_result_invalid", false);
  }
  if (!visibleOutcome && (context || items.length > 0)) {
    throw new MemoryPreparingRunConflictError("memory_attempt_result_invalid", false);
  }
  if ((input.outcome === "DEGRADED") !== Boolean(input.degradationCode)) {
    throw new MemoryPreparingRunConflictError("memory_attempt_result_invalid", false);
  }
  const seenItems = new Set<string>();
  for (const item of items) {
    const target = memoryPreparingItemTarget(item);
    const identity = target ? `${target.itemType}:${target.exactItemId}` : "";
    if (
      !target ||
      item.exactSafeText.length === 0 ||
      item.exactSafeText.length > 4_000 ||
      !safeSelectionReason.test(item.selectionReason) ||
      !Number.isFinite(item.finalScore) ||
      item.finalScore < 0 ||
      item.finalScore > 1 ||
      seenItems.has(identity) ||
      (item.projectionKind !== undefined &&
        item.projectionKind !== "CHAT_DIGEST_SAFE_TEXT" &&
        item.projectionKind !== "FACT_DISPLAY_TEXT" &&
        item.projectionKind !== "RECALL_CHUNK_SAFE_PROJECTED_TEXT") ||
      (item.supportingItemId !== undefined && item.supportingItemId !== null &&
        (item.supportingItemId.length === 0 || item.supportingItemId.length > 256)) ||
      (item.laneRanks !== undefined && (
        !isRecord(item.laneRanks) ||
        !boundedJson(item.laneRanks, MEMORY_PREPARING_EVIDENCE_JSON_MAX_BYTES)
      )) ||
      (item.featureSnapshot !== undefined && (
        !isRecord(item.featureSnapshot) ||
        !boundedJson(item.featureSnapshot, MEMORY_PREPARING_EVIDENCE_JSON_MAX_BYTES)
      ))
    ) {
      throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
    }
    seenItems.add(identity);
  }
}

export function dormantMemoryAttemptResult(
  settings: MemoryPreparingSettingsSnapshot
): MemoryPreparingAttemptResult {
  const disabled = !settings.useMemoryFacts && !settings.referenceChatHistory;
  return Object.freeze({
    budgetSnapshot: Object.freeze({
      hardCapTokens: MEMORY_PREPARING_CONTEXT_MAX_TOKENS,
      itemCount: 0,
      schemaVersion: 1
    }),
    items: Object.freeze([]),
    outcome: disabled ? "DISABLED" : "EMPTY",
    preparedContext: null
  });
}

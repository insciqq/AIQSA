import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import { normalizeProviderExecutionSnapshot } from "../providers/runtimeFactory";
import {
  createKnowledgeBudgetReservation,
  decideKnowledgeBudgetReservation,
  decodeKnowledgeBudgetActual,
  decodeKnowledgeBudgetEstimate,
  dispatchKnowledgeBudgetReservation,
  KNOWLEDGE_BUDGET_RESERVATION_POLICY_VERSION,
  KNOWLEDGE_BUDGET_RESERVATION_VERSION,
  markKnowledgeBudgetReservationAmbiguous,
  releaseKnowledgeBudgetReservation,
  settleKnowledgeBudgetReservation,
  type KnowledgeBudgetActual,
  type KnowledgeBudgetCharge,
  type KnowledgeBudgetEstimate,
  type KnowledgeBudgetReservation,
  type KnowledgeBudgetReservationPolicy,
  type KnowledgeBudgetReservationStopReason,
  type KnowledgeBudgetReservationTransitionResult
} from "./knowledgeBudgetReservation";
import {
  decodeKnowledgeBudgetPolicy,
  type KnowledgeOperationKind
} from "./knowledgeBudget";
import {
  canonicalKnowledgeOperationRequestV2,
  createKnowledgeOperationRequestV2,
  decodeKnowledgeOperationRequestV2,
  hashKnowledgeOperationRequestV2,
  knowledgeOperationTargetSourceIds,
  KNOWLEDGE_OPERATION_REQUEST_VERSION,
  type KnowledgeOperationRequestV2
} from "./knowledgeOperationRequest";
import {
  KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME,
  KNOWLEDGE_EXACT_TOOL_NAME,
  KNOWLEDGE_FOCUSED_OPERATION_NAME,
  KNOWLEDGE_READ_SOURCE_TOOL_NAME,
} from "./retrievalTypes";

const MIN_LEASE_MS = 1_000;
const MAX_ACCEPTED_OPERATION_LATENCY_MS = 3_600_000;
const LEASE_SAFETY_MARGIN_MS = 30_000;
const MAX_LEASE_MS = MAX_ACCEPTED_OPERATION_LATENCY_MS + LEASE_SAFETY_MARGIN_MS;
const SHA256 = /^[0-9a-f]{64}$/u;
const LEASE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/u;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function embeddingCompatibilityKey(value: Readonly<{
  embeddingExecutionSnapshot: unknown;
  vectorSpaceFingerprint: string;
}>): string {
  return `${value.vectorSpaceFingerprint.trim()}\u0000${canonicalJson(
    normalizeProviderExecutionSnapshot(value.embeddingExecutionSnapshot)
  )}`;
}

const operationToolNames: Readonly<Record<KnowledgeOperationKind, string>> = Object.freeze({
  automatic_search: KNOWLEDGE_FOCUSED_OPERATION_NAME,
  discover_sources: KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME,
  find_exact: KNOWLEDGE_EXACT_TOOL_NAME,
  read_source: KNOWLEDGE_READ_SOURCE_TOOL_NAME
});

const reservationSelect = {
  actualCandidates: true,
  actualCostMicros: true,
  actualEmbeddingCalls: true,
  actualLatencyMs: true,
  actualRetrievedTokens: true,
  ambiguousAt: true,
  createdAt: true,
  dispatchAttemptKey: true,
  dispatchedAt: true,
  estimatedCandidates: true,
  estimatedCostMicros: true,
  estimatedEmbeddingCalls: true,
  estimatedLatencyMs: true,
  estimatedRetrievedTokens: true,
  expiredAt: true,
  failureCode: true,
  id: true,
  idempotencyKey: true,
  leaseExpiresAt: true,
  leaseToken: true,
  modelRunId: true,
  modelRunToolCallId: true,
  operation: true,
  operationOrdinal: true,
  operationRequest: true,
  operationRequestHash: true,
  phaseOrdinal: true,
  policyVersion: true,
  purgedAt: true,
  receiptHash: true,
  releasedAt: true,
  settledAt: true,
  state: true,
  subqueryOrdinal: true
} satisfies Prisma.KnowledgeBudgetReservationSelect;

export type KnowledgeBudgetReservationPersistenceRow =
  Prisma.KnowledgeBudgetReservationGetPayload<{ select: typeof reservationSelect }>;

type ActiveStoredKnowledgeBudgetReservation = Readonly<{
  leaseToken: string | null;
  modelRunId: string;
  modelRunToolCallId: string;
  operationRequest: KnowledgeOperationRequestV2;
  purgedAt: null;
  reservation: KnowledgeBudgetReservation;
}>;

type PurgedStoredKnowledgeBudgetReservation = Readonly<{
  leaseToken: null;
  modelRunId: string;
  modelRunToolCallId: string;
  operationRequest: null;
  purgedAt: string;
  reservation: KnowledgeBudgetReservation;
}>;

export type StoredKnowledgeBudgetReservation =
  | ActiveStoredKnowledgeBudgetReservation
  | PurgedStoredKnowledgeBudgetReservation;

const resourceEstimateKeys = [
  "candidateCount",
  "costMicros",
  "latencyMs",
  "queryEmbeddingCalls",
  "retrievedTokens"
] as const;

type KnowledgeBudgetResourceKey = typeof resourceEstimateKeys[number];

export type KnowledgeBudgetResourceEstimate = Readonly<
  Pick<KnowledgeBudgetEstimate, KnowledgeBudgetResourceKey>
>;

export type KnowledgeBudgetResourceActual = Readonly<
  Pick<KnowledgeBudgetActual, KnowledgeBudgetResourceKey>
>;

type KnowledgeOperationRequestInputWithoutEnvelope<T> = T extends KnowledgeOperationRequestV2
  ? Omit<
      T,
      | "idempotencyKey"
      | "originalQuery"
      | "phaseOrdinal"
      | "profileRevisionNumber"
      | "reservationId"
      | "subqueryOrdinal"
      | "version"
    >
  : never;

export type KnowledgeBudgetOperationRequestInput = Readonly<
  KnowledgeOperationRequestInputWithoutEnvelope<KnowledgeOperationRequestV2>
>;

export type ReserveKnowledgeBudgetInput = Readonly<{
  estimate: KnowledgeBudgetResourceEstimate;
  idempotencyKey: string;
  modelRunToolCallId: string;
  operationRequest: KnowledgeBudgetOperationRequestInput;
  originalQuerySha256: string;
  runId: string;
  userId: string;
}>;

export type ReserveKnowledgeBudgetResult =
  | Readonly<{
      chargeAfter: KnowledgeBudgetCharge;
      chargeBefore: KnowledgeBudgetCharge;
      kind: "admitted";
      record: StoredKnowledgeBudgetReservation;
      roundIndex: number;
    }>
  | Readonly<{
      chargeAfter: KnowledgeBudgetCharge;
      kind: "idempotent";
      record: StoredKnowledgeBudgetReservation;
      roundIndex: number;
    }>
  | Readonly<{
      chargeAfter: KnowledgeBudgetCharge;
      chargeBefore: KnowledgeBudgetCharge;
      kind: "rejected";
      reason: KnowledgeBudgetReservationStopReason;
    }>
  | Readonly<{
      kind: "conflict";
      reason:
        | "idempotency_conflict"
        | "invalid_payload"
        | "operation_sequence_exhausted"
        | "reservation_id_conflict"
        | "scope_mismatch"
        | "tool_call_mismatch"
        | "tool_call_state";
    }>
  | Readonly<{ kind: "not_found" }>;

type DomainTransitionConflictReason = Extract<
  KnowledgeBudgetReservationTransitionResult,
  { kind: "conflict" }
>["reason"];

export type KnowledgeBudgetReservationMutationResult =
  | Readonly<{
      kind: "transitioned" | "idempotent";
      record: StoredKnowledgeBudgetReservation;
    }>
  | Readonly<{
      kind: "conflict";
      reason: DomainTransitionConflictReason | "lease_fenced";
      record: StoredKnowledgeBudgetReservation;
    }>
  | Readonly<{ kind: "not_found" }>;

export type KnowledgeBudgetReservationRepository = Readonly<{
  claimDispatch(input: Readonly<{
    dispatchAttemptKey: string;
    leaseToken: string;
    reservationId: string;
    runId: string;
    userId: string;
  }>): Promise<KnowledgeBudgetReservationMutationResult>;
  markAmbiguous(input: Readonly<{
    leaseToken: string;
    reason: string;
    reservationId: string;
    runId: string;
    userId: string;
  }>): Promise<KnowledgeBudgetReservationMutationResult>;
  release(input: Readonly<{
    leaseToken: string;
    reason: string;
    reservationId: string;
    runId: string;
    userId: string;
  }>): Promise<KnowledgeBudgetReservationMutationResult>;
  reserve(input: ReserveKnowledgeBudgetInput): Promise<ReserveKnowledgeBudgetResult>;
  settle(input: Readonly<{
    actual: KnowledgeBudgetResourceActual;
    leaseToken: string;
    receiptHash: string;
    reservationId: string;
    runId: string;
    userId: string;
  }>): Promise<KnowledgeBudgetReservationMutationResult>;
}>;

export type SettleKnowledgeBudgetReservationReceiptInput = Readonly<{
  actual: KnowledgeBudgetResourceActual;
  leaseToken: string;
  modelRunToolCallId: string;
  operation: KnowledgeOperationKind;
  operationOrdinal: number;
  receiptHash: string;
  reservationId: string;
  runId: string;
  settledAt?: Date;
}>;

type LockedReserveContext = Readonly<{
  budgetPolicy: Prisma.JsonValue;
  roundIndex: number;
  toolCallOrdinal: number;
  toolCallState: string;
  toolName: string;
  userMessageId: string;
}>;

type AvailableSource = Readonly<{
  baseProvenance: Prisma.JsonValue | null;
  sourceAlias: string;
  sourceId: string | null;
}>;

function invalidStorage(): never {
  throw new Error("knowledge_budget_reservation_invalid_in_storage");
}

function iso(value: Date | null): string | null {
  if (!value || Number.isNaN(value.valueOf())) return null;
  return value.toISOString();
}

function allNull(values: readonly unknown[]): boolean {
  return values.every((value) => value === null);
}

function strictLeaseToken(value: unknown): string | null {
  return typeof value === "string" && LEASE_TOKEN.test(value) ? value : null;
}

const storedOperationKinds = new Set<string>([
  ...Object.keys(operationToolNames),
  "search_knowledge",
  "structured_analysis",
  "visual_analysis"
]);

function structuralAmount(): Readonly<{
  operationSlots: 1;
}> {
  return Object.freeze({ operationSlots: 1 });
}

function persistedEstimate(
  row: KnowledgeBudgetReservationPersistenceRow
): KnowledgeBudgetEstimate {
  const estimate = decodeKnowledgeBudgetEstimate({
    candidateCount: row.estimatedCandidates,
    costMicros: row.estimatedCostMicros,
    latencyMs: row.estimatedLatencyMs,
    queryEmbeddingCalls: row.estimatedEmbeddingCalls,
    retrievedTokens: row.estimatedRetrievedTokens,
    ...structuralAmount()
  });
  return estimate ?? invalidStorage();
}

function persistedActual(
  row: KnowledgeBudgetReservationPersistenceRow
): KnowledgeBudgetActual {
  const actual = decodeKnowledgeBudgetActual({
    candidateCount: row.actualCandidates,
    costMicros: row.actualCostMicros,
    latencyMs: row.actualLatencyMs,
    queryEmbeddingCalls: row.actualEmbeddingCalls,
    retrievedTokens: row.actualRetrievedTokens,
    ...structuralAmount()
  });
  return actual ?? invalidStorage();
}

function timestampAfter(reference: string, candidate: string): string {
  return new Date(Math.max(
    new Date(candidate).valueOf(),
    new Date(reference).valueOf() + 1
  )).toISOString();
}

function decodePurgedKnowledgeBudgetReservation(
  row: KnowledgeBudgetReservationPersistenceRow,
  purgedAt: string,
  createdAt: string
): PurgedStoredKnowledgeBudgetReservation {
  if (!storedOperationKinds.has(row.operation) ||
    row.policyVersion !== KNOWLEDGE_BUDGET_RESERVATION_POLICY_VERSION ||
    purgedAt < createdAt || !allNull([
      row.dispatchAttemptKey,
      row.failureCode,
      row.idempotencyKey,
      row.leaseExpiresAt,
      row.leaseToken,
      row.operationRequest,
      row.operationRequestHash,
      row.receiptHash
    ])) invalidStorage();
  const common = {
    createdAt,
    estimate: persistedEstimate(row),
    id: row.id,
    idempotencyKey: `purged:${row.id}`,
    operationOrdinal: row.operationOrdinal,
    phaseOrdinal: row.phaseOrdinal,
    requestHash: "0".repeat(64),
    subqueryOrdinal: row.subqueryOrdinal,
    version: KNOWLEDGE_BUDGET_RESERVATION_VERSION
  } as const;
  const actualColumns = [
    row.actualCandidates,
    row.actualCostMicros,
    row.actualEmbeddingCalls,
    row.actualLatencyMs,
    row.actualRetrievedTokens
  ];
  let reservation: KnowledgeBudgetReservation;
  if (row.state === "reserved") {
    if (!allNull([
      ...actualColumns,
      row.ambiguousAt,
      row.dispatchedAt,
      row.expiredAt,
      row.releasedAt,
      row.settledAt
    ])) invalidStorage();
    reservation = {
      ...common,
      leaseExpiresAt: timestampAfter(createdAt, purgedAt),
      state: "reserved"
    };
  } else if (row.state === "dispatched") {
    const dispatchedAt = iso(row.dispatchedAt);
    if (!dispatchedAt || !allNull([
      ...actualColumns,
      row.ambiguousAt,
      row.expiredAt,
      row.releasedAt,
      row.settledAt
    ])) invalidStorage();
    reservation = {
      ...common,
      dispatchKey: `purged:${row.id}`,
      dispatchedAt,
      leaseExpiresAt: timestampAfter(dispatchedAt, purgedAt),
      state: "dispatched"
    };
  } else if (row.state === "settled") {
    const dispatchedAt = iso(row.dispatchedAt);
    const settledAt = iso(row.settledAt);
    if (!dispatchedAt || !settledAt || !allNull([
      row.ambiguousAt,
      row.expiredAt,
      row.releasedAt
    ])) invalidStorage();
    reservation = {
      ...common,
      actual: persistedActual(row),
      dispatchKey: `purged:${row.id}`,
      dispatchedAt,
      settledAt,
      settlementKey: `purged:${row.id}`,
      state: "settled"
    };
  } else if (row.state === "released") {
    const releasedAt = iso(row.releasedAt);
    if (!releasedAt || !allNull([
      ...actualColumns,
      row.ambiguousAt,
      row.dispatchedAt,
      row.expiredAt,
      row.settledAt
    ])) invalidStorage();
    reservation = { ...common, reason: "purged", releasedAt, state: "released" };
  } else if (row.state === "ambiguous") {
    const ambiguousAt = iso(row.ambiguousAt);
    const dispatchedAt = iso(row.dispatchedAt);
    if (!ambiguousAt || !dispatchedAt || !allNull([
      ...actualColumns,
      row.expiredAt,
      row.releasedAt,
      row.settledAt
    ])) invalidStorage();
    reservation = {
      ...common,
      ambiguousAt,
      dispatchKey: `purged:${row.id}`,
      dispatchedAt,
      reason: "purged",
      state: "ambiguous"
    };
  } else if (row.state === "expired") {
    const expiredAt = iso(row.expiredAt);
    if (!expiredAt || !allNull([
      ...actualColumns,
      row.ambiguousAt,
      row.dispatchedAt,
      row.releasedAt,
      row.settledAt
    ])) invalidStorage();
    reservation = { ...common, expiredAt, reason: "purged", state: "expired" };
  } else {
    invalidStorage();
  }
  return Object.freeze({
    leaseToken: null,
    modelRunId: row.modelRunId,
    modelRunToolCallId: row.modelRunToolCallId,
    operationRequest: null,
    purgedAt,
    reservation: createKnowledgeBudgetReservation(reservation)
  });
}

/**
 * Maps the nullable persistence row to the strict state union and rejects
 * impossible mixed states before they can participate in accounting.
 */
export function decodeKnowledgeBudgetReservationPersistenceRow(
  row: KnowledgeBudgetReservationPersistenceRow
): StoredKnowledgeBudgetReservation {
  const createdAt = iso(row.createdAt);
  if (!createdAt) invalidStorage();
  if (row.purgedAt !== null) {
    const purgedAt = iso(row.purgedAt);
    return decodePurgedKnowledgeBudgetReservation(
      row,
      purgedAt ?? invalidStorage(),
      createdAt
    );
  }
  const operationRequest = decodeKnowledgeOperationRequestV2(row.operationRequest);
  const requestHash = row.operationRequestHash?.trim();
  if (!operationRequest || row.policyVersion !== KNOWLEDGE_BUDGET_RESERVATION_POLICY_VERSION ||
    row.id !== operationRequest.reservationId ||
    row.idempotencyKey !== operationRequest.idempotencyKey ||
    row.operation !== operationRequest.operation ||
    row.phaseOrdinal !== operationRequest.phaseOrdinal ||
    row.subqueryOrdinal !== operationRequest.subqueryOrdinal ||
    !requestHash || !SHA256.test(requestHash) ||
    hashKnowledgeOperationRequestV2(operationRequest) !== requestHash) invalidStorage();

  const estimate = persistedEstimate(row);
  const common = {
    createdAt,
    estimate,
    id: row.id,
    idempotencyKey: operationRequest.idempotencyKey,
    operationOrdinal: row.operationOrdinal,
    phaseOrdinal: row.phaseOrdinal,
    requestHash,
    subqueryOrdinal: row.subqueryOrdinal,
    version: KNOWLEDGE_BUDGET_RESERVATION_VERSION
  } as const;
  const actualColumns = [
    row.actualCandidates,
    row.actualCostMicros,
    row.actualEmbeddingCalls,
    row.actualLatencyMs,
    row.actualRetrievedTokens
  ];
  let reservation: KnowledgeBudgetReservation;

  if (row.state === "reserved") {
    const leaseToken = strictLeaseToken(row.leaseToken);
    const leaseExpiresAt = iso(row.leaseExpiresAt);
    if (!leaseToken || !leaseExpiresAt || !allNull([
      ...actualColumns,
      row.ambiguousAt,
      row.dispatchAttemptKey,
      row.dispatchedAt,
      row.expiredAt,
      row.failureCode,
      row.receiptHash,
      row.releasedAt,
      row.settledAt
    ])) invalidStorage();
    reservation = {
      ...common,
      leaseExpiresAt,
      state: "reserved"
    };
  } else if (row.state === "dispatched") {
    const leaseToken = strictLeaseToken(row.leaseToken);
    const leaseExpiresAt = iso(row.leaseExpiresAt);
    const dispatchedAt = iso(row.dispatchedAt);
    if (!leaseToken || !leaseExpiresAt || !dispatchedAt || !row.dispatchAttemptKey ||
      !allNull([
        ...actualColumns,
        row.ambiguousAt,
        row.expiredAt,
        row.failureCode,
        row.receiptHash,
        row.releasedAt,
        row.settledAt
      ])) invalidStorage();
    reservation = {
      ...common,
      dispatchKey: row.dispatchAttemptKey,
      dispatchedAt,
      leaseExpiresAt,
      state: "dispatched"
    };
  } else if (row.state === "settled") {
    const dispatchedAt = iso(row.dispatchedAt);
    const settledAt = iso(row.settledAt);
    if (!dispatchedAt || !settledAt || !row.dispatchAttemptKey || !row.receiptHash ||
      !allNull([
        row.ambiguousAt,
        row.expiredAt,
        row.failureCode,
        row.leaseExpiresAt,
        row.leaseToken,
        row.releasedAt
      ])) invalidStorage();
    reservation = {
      ...common,
      actual: persistedActual(row),
      dispatchKey: row.dispatchAttemptKey,
      dispatchedAt,
      settledAt,
      settlementKey: row.receiptHash,
      state: "settled"
    };
  } else if (row.state === "released") {
    const releasedAt = iso(row.releasedAt);
    if (!releasedAt || !row.failureCode || !allNull([
      ...actualColumns,
      row.ambiguousAt,
      row.dispatchAttemptKey,
      row.dispatchedAt,
      row.expiredAt,
      row.leaseExpiresAt,
      row.leaseToken,
      row.receiptHash,
      row.settledAt
    ])) invalidStorage();
    reservation = {
      ...common,
      reason: row.failureCode,
      releasedAt,
      state: "released"
    };
  } else if (row.state === "ambiguous") {
    const ambiguousAt = iso(row.ambiguousAt);
    const dispatchedAt = iso(row.dispatchedAt);
    if (!ambiguousAt || !dispatchedAt || !row.dispatchAttemptKey || !row.failureCode ||
      !allNull([
        ...actualColumns,
        row.expiredAt,
        row.leaseExpiresAt,
        row.leaseToken,
        row.receiptHash,
        row.releasedAt,
        row.settledAt
      ])) invalidStorage();
    reservation = {
      ...common,
      ambiguousAt,
      dispatchKey: row.dispatchAttemptKey,
      dispatchedAt,
      reason: row.failureCode,
      state: "ambiguous"
    };
  } else if (row.state === "expired") {
    const expiredAt = iso(row.expiredAt);
    if (!expiredAt || !row.failureCode || !allNull([
      ...actualColumns,
      row.ambiguousAt,
      row.dispatchAttemptKey,
      row.dispatchedAt,
      row.leaseExpiresAt,
      row.leaseToken,
      row.receiptHash,
      row.releasedAt,
      row.settledAt
    ])) invalidStorage();
    reservation = {
      ...common,
      expiredAt,
      reason: row.failureCode,
      state: "expired"
    };
  } else {
    invalidStorage();
  }

  return Object.freeze({
    leaseToken: row.leaseToken,
    modelRunId: row.modelRunId,
    modelRunToolCallId: row.modelRunToolCallId,
    operationRequest,
    purgedAt: null,
    reservation: createKnowledgeBudgetReservation(reservation)
  });
}

/** Maps the fixed focused policy into the durable reservation envelope. */
export function knowledgeBudgetReservationPolicyFromRunScope(
  value: unknown
): KnowledgeBudgetReservationPolicy | null {
  const policy = decodeKnowledgeBudgetPolicy(value);
  if (!policy) return null;
  return Object.freeze({
    maxCumulativeCandidates: policy.maxCumulativeCandidates,
    maxEstimatedCostMicros: policy.maxEstimatedCostMicros,
    maxLatencyMs: policy.maxLatencyMs,
    maxOperations: policy.maxOperations,
    maxQueryEmbeddingCalls: policy.maxQueryEmbeddingCalls,
    maxRetrievedTokens: policy.maxRetrievedTokens,
    version: KNOWLEDGE_BUDGET_RESERVATION_POLICY_VERSION
  });
}

function validLeaseDuration(value: number): number | null {
  const duration = value;
  return Number.isSafeInteger(duration) && duration >= MIN_LEASE_MS && duration <= MAX_LEASE_MS
    ? duration
    : null;
}

/**
 * Keeps reservation ownership alive for the complete accepted operation
 * latency budget plus bounded receipt-persistence overhead. The one-hour
 * operation-latency ceiling remains one hour; the lease alone may extend by
 * the fixed persistence margin so a valid one-hour operation can still commit.
 */
export function knowledgeBudgetLeaseDurationMs(maxLatencyMs: number): number | null {
  if (!Number.isSafeInteger(maxLatencyMs) || maxLatencyMs < 100 ||
    maxLatencyMs > MAX_ACCEPTED_OPERATION_LATENCY_MS) return null;
  return validLeaseDuration(maxLatencyMs + LEASE_SAFETY_MARGIN_MS);
}

function validNow(value: Date): Date {
  if (Number.isNaN(value.valueOf())) throw new Error("knowledge_budget_clock_invalid");
  return new Date(value);
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function resourceEstimate(
  request: KnowledgeOperationRequestV2,
  value: KnowledgeBudgetResourceEstimate
): KnowledgeBudgetEstimate | null {
  return decodeKnowledgeBudgetEstimate({
    ...value,
    ...structuralAmount()
  });
}

function resourceActual(
  request: KnowledgeOperationRequestV2,
  value: KnowledgeBudgetResourceActual
): KnowledgeBudgetActual | null {
  return decodeKnowledgeBudgetActual({
    ...value,
    ...structuralAmount()
  });
}

function baseIds(value: Prisma.JsonValue | null): readonly string[] | null {
  if (value === null) return [];
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry) ||
      Object.keys(entry).length !== 2 ||
      typeof entry.knowledgeBaseId !== "string" || !entry.knowledgeBaseId ||
      typeof entry.indexGenerationId !== "string" || !entry.indexGenerationId) return null;
    ids.push(entry.knowledgeBaseId);
  }
  return new Set(ids).size === ids.length ? Object.freeze(ids) : null;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sourceScopeMatches(
  request: KnowledgeBudgetOperationRequestInput,
  sources: readonly AvailableSource[],
  bases: readonly Readonly<{ knowledgeBaseId: string; ordinal: number }>[]
): boolean {
  const available = new Map<string, AvailableSource>();
  const sourceAliases = new Map<string, string>();
  const sourcesByBase = new Map<string, Set<string>>();
  for (const source of sources) {
    if (!source.sourceId || sourceAliases.has(source.sourceAlias)) return false;
    const provenance = baseIds(source.baseProvenance);
    if (!provenance) return false;
    if (!available.has(source.sourceId)) available.set(source.sourceId, source);
    sourceAliases.set(source.sourceAlias, source.sourceId);
    for (const baseId of provenance) {
      const selected = sourcesByBase.get(baseId) ?? new Set<string>();
      selected.add(source.sourceId);
      sourcesByBase.set(baseId, selected);
    }
  }
  const baseAliases = new Map(bases.map((base) => [`B${base.ordinal + 1}`, base.knowledgeBaseId]));
  const expected = new Set<string>();
  if (request.sourceAliases.length === 0) {
    for (const sourceId of available.keys()) expected.add(sourceId);
  } else {
    for (const alias of request.sourceAliases) {
      if (alias.startsWith("S")) {
        const sourceId = sourceAliases.get(alias);
        if (!sourceId) return false;
        expected.add(sourceId);
        continue;
      }
      const baseId = baseAliases.get(alias);
      const matchingSources = baseId ? sourcesByBase.get(baseId) : undefined;
      if (!matchingSources || matchingSources.size === 0) return false;
      for (const sourceId of matchingSources) expected.add(sourceId);
    }
  }
  const expectedIds = [...expected].sort();
  const suppliedIds = [...request.resolvedSourceIds].sort();
  return sameStrings(expectedIds, suppliedIds) &&
    knowledgeOperationTargetSourceIds(request)
      .every((sourceId) => expected.has(sourceId));
}

async function recoverStaleReservations(
  tx: Prisma.TransactionClient,
  runId: string,
  now: Date
): Promise<void> {
  await tx.knowledgeBudgetReservation.updateMany({
    data: {
      expiredAt: now,
      failureCode: "lease_expired",
      leaseExpiresAt: null,
      leaseToken: null,
      state: "expired"
    },
    where: {
      leaseExpiresAt: { lte: now },
      modelRunId: runId,
      purgedAt: null,
      state: "reserved"
    }
  });
  await tx.knowledgeBudgetReservation.updateMany({
    data: {
      ambiguousAt: now,
      failureCode: "lease_expired_after_dispatch",
      leaseExpiresAt: null,
      leaseToken: null,
      state: "ambiguous"
    },
    where: {
      leaseExpiresAt: { lte: now },
      modelRunId: runId,
      purgedAt: null,
      state: "dispatched"
    }
  });
}

async function lockReserveContext(
  tx: Prisma.TransactionClient,
  input: Pick<ReserveKnowledgeBudgetInput, "modelRunToolCallId" | "runId" | "userId">
): Promise<LockedReserveContext | null> {
  const rows = await tx.$queryRaw<LockedReserveContext[]>(Prisma.sql`
    SELECT
      scope."budgetPolicy",
      call."roundIndex",
      call."ordinal" AS "toolCallOrdinal",
      call."state"::text AS "toolCallState",
      call."toolName",
      run."userMessageId"
    FROM "KnowledgeRunScope" AS scope
    INNER JOIN "ModelRun" AS run
      ON run."id" = scope."modelRunId"
    INNER JOIN "ModelRunToolCall" AS call
      ON call."modelRunId" = run."id"
     AND call."id" = ${input.modelRunToolCallId}
    WHERE run."id" = ${input.runId}
      AND run."userId" = ${input.userId}
    FOR UPDATE OF scope
  `);
  return rows[0] ?? null;
}

async function lockRunScope(
  tx: Prisma.TransactionClient,
  input: Readonly<{ runId: string; userId: string }>
): Promise<KnowledgeBudgetReservationPolicy | null> {
  const rows = await tx.$queryRaw<Array<{
    budgetPolicy: Prisma.JsonValue;
    modelRunId: string;
  }>>(Prisma.sql`
    SELECT scope."budgetPolicy", scope."modelRunId"
    FROM "KnowledgeRunScope" AS scope
    INNER JOIN "ModelRun" AS run
      ON run."id" = scope."modelRunId"
    WHERE run."id" = ${input.runId}
      AND run."userId" = ${input.userId}
    FOR UPDATE OF scope
  `);
  if (rows.length !== 1) return null;
  const policy = knowledgeBudgetReservationPolicyFromRunScope(rows[0]!.budgetPolicy);
  return policy ?? invalidStorage();
}

async function loadReservation(
  tx: Prisma.TransactionClient,
  runId: string,
  reservationId: string
): Promise<StoredKnowledgeBudgetReservation | null> {
  const row = await tx.knowledgeBudgetReservation.findFirst({
    select: reservationSelect,
    where: { id: reservationId, modelRunId: runId }
  });
  return row ? decodeKnowledgeBudgetReservationPersistenceRow(row) : null;
}

function mutationConflict(
  record: StoredKnowledgeBudgetReservation,
  reason: DomainTransitionConflictReason | "lease_fenced"
): KnowledgeBudgetReservationMutationResult {
  return Object.freeze({ kind: "conflict", reason, record });
}

function domainMutationResult(
  record: StoredKnowledgeBudgetReservation,
  result: KnowledgeBudgetReservationTransitionResult
): KnowledgeBudgetReservationMutationResult | null {
  if (result.kind === "conflict") return mutationConflict(record, result.reason);
  if (result.kind === "idempotent") {
    return Object.freeze({ kind: "idempotent", record });
  }
  return null;
}

/**
 * Settles the resource reservation inside the caller's receipt transaction.
 * The KnowledgeRun insert and the actual-vs-estimate accounting therefore
 * share one commit boundary; callers must already hold the owning ModelRun
 * lock before invoking this helper.
 */
export async function settleKnowledgeBudgetReservationReceipt(
  tx: Prisma.TransactionClient,
  input: SettleKnowledgeBudgetReservationReceiptInput
): Promise<StoredKnowledgeBudgetReservation> {
  if (!SHA256.test(input.receiptHash) || !strictLeaseToken(input.leaseToken) ||
    !Number.isSafeInteger(input.operationOrdinal) || input.operationOrdinal < 1 ||
    input.operationOrdinal > 256) invalidStorage();
  const row = await tx.knowledgeBudgetReservation.findFirst({
    select: reservationSelect,
    where: {
      id: input.reservationId,
      modelRunId: input.runId,
      modelRunToolCallId: input.modelRunToolCallId
    }
  });
  if (!row) throw new Error("knowledge_budget_reservation_unavailable");
  const record = decodeKnowledgeBudgetReservationPersistenceRow(row);
  if (record.purgedAt !== null || record.operationRequest.operation !== input.operation ||
    record.reservation.operationOrdinal !== input.operationOrdinal) {
    throw new Error("knowledge_budget_reservation_mismatch");
  }
  if (record.reservation.state === "settled") {
    const expectedActual = resourceActual(record.operationRequest, input.actual);
    if (record.reservation.settlementKey !== input.receiptHash ||
      JSON.stringify(record.reservation.actual) !== JSON.stringify(expectedActual)) {
      throw new Error("knowledge_budget_reservation_settlement_conflict");
    }
    return record;
  }
  if (record.reservation.state !== "dispatched" || record.leaseToken !== input.leaseToken) {
    throw new Error("knowledge_budget_reservation_not_dispatched");
  }
  const settledAt = validNow(input.settledAt ?? new Date());
  const actual = resourceActual(record.operationRequest, input.actual);
  const transition = settleKnowledgeBudgetReservation(record.reservation, {
    actual,
    settledAt: settledAt.toISOString(),
    settlementKey: input.receiptHash
  });
  if (transition.kind !== "transitioned" || transition.reservation.state !== "settled") {
    throw new Error("knowledge_budget_reservation_settlement_conflict");
  }
  const acceptedActual = transition.reservation.actual;
  const updated = await tx.knowledgeBudgetReservation.updateMany({
    data: {
      actualCandidates: acceptedActual.candidateCount,
      actualCostMicros: acceptedActual.costMicros,
      actualEmbeddingCalls: acceptedActual.queryEmbeddingCalls,
      actualLatencyMs: acceptedActual.latencyMs,
      actualRetrievedTokens: acceptedActual.retrievedTokens,
      leaseExpiresAt: null,
      leaseToken: null,
      receiptHash: input.receiptHash,
      settledAt,
      state: "settled"
    },
    where: {
      id: input.reservationId,
      leaseExpiresAt: { gt: settledAt },
      leaseToken: input.leaseToken,
      modelRunId: input.runId,
      modelRunToolCallId: input.modelRunToolCallId,
      state: "dispatched"
    }
  });
  if (updated.count !== 1) throw new Error("knowledge_budget_reservation_settlement_conflict");
  const accepted = await tx.knowledgeBudgetReservation.findFirst({
    select: reservationSelect,
    where: { id: input.reservationId, modelRunId: input.runId }
  });
  return accepted
    ? decodeKnowledgeBudgetReservationPersistenceRow(accepted)
    : invalidStorage();
}

export function createPrismaKnowledgeBudgetReservationRepository(
  client: Pick<PrismaClient, "$transaction"> = prisma,
  options: Readonly<{
    now?: () => Date;
    uuid?: () => string;
  }> = {}
): KnowledgeBudgetReservationRepository {
  const currentTime = options.now ?? (() => new Date());
  const uuid = options.uuid ?? randomUUID;

  const withLockedReservation = async (
    input: Readonly<{
      reservationId: string;
      runId: string;
      userId: string;
    }>,
    consume: (
      tx: Prisma.TransactionClient,
      record: ActiveStoredKnowledgeBudgetReservation,
      now: Date,
      policy: KnowledgeBudgetReservationPolicy
    ) => Promise<KnowledgeBudgetReservationMutationResult>
  ): Promise<KnowledgeBudgetReservationMutationResult> => client.$transaction(async (tx) => {
    const policy = await lockRunScope(tx, input);
    if (!policy) return { kind: "not_found" } as const;
    const now = validNow(currentTime());
    await recoverStaleReservations(tx, input.runId, now);
    const record = await loadReservation(tx, input.runId, input.reservationId);
    if (!record) return { kind: "not_found" } as const;
    return record.purgedAt === null
      ? consume(tx, record, now, policy)
      : mutationConflict(record, "invalid_state");
  });

  return Object.freeze({
    claimDispatch: async (input) => {
      return withLockedReservation(input, async (tx, record, now, policy) => {
        const leaseDurationMs = knowledgeBudgetLeaseDurationMs(policy.maxLatencyMs);
        if (!leaseDurationMs) return mutationConflict(record, "invalid_payload");
        if (record.reservation.state === "reserved" ||
          record.reservation.state === "dispatched") {
          if (record.leaseToken !== input.leaseToken || !strictLeaseToken(input.leaseToken)) {
            return mutationConflict(record, "lease_fenced");
          }
        }
        const result = dispatchKnowledgeBudgetReservation(record.reservation, {
          dispatchKey: input.dispatchAttemptKey,
          dispatchedAt: now.toISOString(),
          leaseExpiresAt: new Date(now.valueOf() + leaseDurationMs).toISOString()
        });
        const terminal = domainMutationResult(record, result);
        if (terminal) return terminal;
        const updated = await tx.knowledgeBudgetReservation.updateMany({
          data: {
            dispatchAttemptKey: input.dispatchAttemptKey,
            dispatchedAt: now,
            leaseExpiresAt: new Date(now.valueOf() + leaseDurationMs),
            state: "dispatched"
          },
          where: {
            id: input.reservationId,
            leaseExpiresAt: { gt: now },
            leaseToken: input.leaseToken,
            modelRunId: input.runId,
            state: "reserved"
          }
        });
        if (updated.count !== 1) return mutationConflict(record, "lease_fenced");
        const accepted = await loadReservation(tx, input.runId, input.reservationId);
        if (!accepted) invalidStorage();
        return Object.freeze({ kind: "transitioned", record: accepted });
      });
    },

    markAmbiguous: (input) => withLockedReservation(input, async (tx, record, now) => {
      if (record.reservation.state === "dispatched" &&
        (record.leaseToken !== input.leaseToken || !strictLeaseToken(input.leaseToken))) {
        return mutationConflict(record, "lease_fenced");
      }
      const result = markKnowledgeBudgetReservationAmbiguous(record.reservation, {
        ambiguousAt: now.toISOString(),
        reason: input.reason
      });
      const terminal = domainMutationResult(record, result);
      if (terminal) return terminal;
      const updated = await tx.knowledgeBudgetReservation.updateMany({
        data: {
          ambiguousAt: now,
          failureCode: input.reason,
          leaseExpiresAt: null,
          leaseToken: null,
          state: "ambiguous"
        },
        where: {
          id: input.reservationId,
          leaseExpiresAt: { gt: now },
          leaseToken: input.leaseToken,
          modelRunId: input.runId,
          state: "dispatched"
        }
      });
      if (updated.count !== 1) return mutationConflict(record, "lease_fenced");
      const accepted = await loadReservation(tx, input.runId, input.reservationId);
      if (!accepted) invalidStorage();
      return Object.freeze({ kind: "transitioned", record: accepted });
    }),

    release: (input) => withLockedReservation(input, async (tx, record, now) => {
      if (record.reservation.state === "reserved" &&
        (record.leaseToken !== input.leaseToken || !strictLeaseToken(input.leaseToken))) {
        return mutationConflict(record, "lease_fenced");
      }
      const result = releaseKnowledgeBudgetReservation(record.reservation, {
        reason: input.reason,
        releasedAt: now.toISOString()
      });
      const terminal = domainMutationResult(record, result);
      if (terminal) return terminal;
      const updated = await tx.knowledgeBudgetReservation.updateMany({
        data: {
          failureCode: input.reason,
          leaseExpiresAt: null,
          leaseToken: null,
          releasedAt: now,
          state: "released"
        },
        where: {
          id: input.reservationId,
          leaseExpiresAt: { gt: now },
          leaseToken: input.leaseToken,
          modelRunId: input.runId,
          state: "reserved"
        }
      });
      if (updated.count !== 1) return mutationConflict(record, "lease_fenced");
      const accepted = await loadReservation(tx, input.runId, input.reservationId);
      if (!accepted) invalidStorage();
      return Object.freeze({ kind: "transitioned", record: accepted });
    }),

    reserve: async (input) => {
      if (!SHA256.test(input.originalQuerySha256)) {
        return { kind: "conflict", reason: "invalid_payload" };
      }
      return client.$transaction(async (tx) => {
        const context = await lockReserveContext(tx, input);
        if (!context) return { kind: "not_found" } as const;
        const operation = input.operationRequest.operation;
        if (!Number.isSafeInteger(context.roundIndex) || context.roundIndex < 0 ||
          context.roundIndex > 63 || !Number.isSafeInteger(context.toolCallOrdinal) ||
          context.toolCallOrdinal < 0 || context.toolCallOrdinal > 127 ||
          operationToolNames[operation] !== context.toolName) {
          return { kind: "conflict", reason: "tool_call_mismatch" } as const;
        }
        const now = validNow(currentTime());
        await recoverStaleReservations(tx, input.runId, now);
        const rows = await tx.knowledgeBudgetReservation.findMany({
          orderBy: { operationOrdinal: "asc" },
          select: reservationSelect,
          where: { modelRunId: input.runId }
        });
        const records = rows.map(decodeKnowledgeBudgetReservationPersistenceRow);
        const existingForCall = records.find((record) =>
          record.modelRunToolCallId === input.modelRunToolCallId);
        if (!existingForCall && context.toolCallState !== "pending" &&
          context.toolCallState !== "running") {
          return { kind: "conflict", reason: "tool_call_state" } as const;
        }
        const operationOrdinal = existingForCall?.reservation.operationOrdinal ??
          records.reduce((maximum, record) =>
            Math.max(maximum, record.reservation.operationOrdinal), 0) + 1;
        if (operationOrdinal > 256) {
          return { kind: "conflict", reason: "operation_sequence_exhausted" } as const;
        }
        const profiles = await tx.knowledgeRunProfileBinding.findMany({
          select: {
            embeddingExecutionSnapshot: true,
            id: true,
            profileRevision: { select: { revisionNumber: true } },
            profileRevisionId: true,
            vectorSpaceFingerprint: true
          },
          where: { modelRunId: input.runId }
        });
        const profile = profiles.find(({ profileRevisionId }) =>
          profileRevisionId === input.operationRequest.profileRevisionId);
        if (!profile) return { kind: "conflict", reason: "scope_mismatch" } as const;
        let compatibleProfileBindingIds: string[];
        try {
          const compatibilityKey = embeddingCompatibilityKey(profile);
          compatibleProfileBindingIds = profiles.filter((candidate) =>
            embeddingCompatibilityKey(candidate) === compatibilityKey).map(({ id }) => id);
        } catch {
          return { kind: "conflict", reason: "scope_mismatch" } as const;
        }
        const reservationId = existingForCall?.reservation.id ?? uuid();
        let request: KnowledgeOperationRequestV2;
        try {
          request = createKnowledgeOperationRequestV2({
            ...input.operationRequest,
            idempotencyKey: input.idempotencyKey,
            originalQuery: {
              reference: context.userMessageId,
              sha256: input.originalQuerySha256
            },
            phaseOrdinal: context.roundIndex,
            profileRevisionNumber: profile.profileRevision.revisionNumber,
            reservationId,
            subqueryOrdinal: context.toolCallOrdinal,
            version: KNOWLEDGE_OPERATION_REQUEST_VERSION
          });
        } catch {
          return { kind: "conflict", reason: "invalid_payload" } as const;
        }
        const [sources, bases] = await Promise.all([
          tx.knowledgeRunSourceBinding.findMany({
            orderBy: { ordinal: "asc" },
            select: { baseProvenance: true, sourceAlias: true, sourceId: true },
            where: {
              modelRunId: input.runId,
              profileBindingId: { in: compatibleProfileBindingIds },
              readinessState: "ready",
              tombstonedAt: null
            }
          }),
          tx.knowledgeRunBinding.findMany({
            orderBy: { ordinal: "asc" },
            select: { knowledgeBaseId: true, ordinal: true },
            where: { modelRunId: input.runId }
          })
        ]);
        if (!sourceScopeMatches(request, sources, bases)) {
          return { kind: "conflict", reason: "scope_mismatch" } as const;
        }
        const estimate = resourceEstimate(request, input.estimate);
        if (!estimate) return { kind: "conflict", reason: "invalid_payload" } as const;
        const policy = knowledgeBudgetReservationPolicyFromRunScope(context.budgetPolicy);
        if (!policy) throw new Error("knowledge_budget_policy_invalid_in_storage");
        const leaseDurationMs = knowledgeBudgetLeaseDurationMs(policy.maxLatencyMs);
        if (!leaseDurationMs) throw new Error("knowledge_budget_policy_invalid_in_storage");
        const createdAt = existingForCall?.reservation.createdAt ?? now.toISOString();
        const proposalLease = new Date(now.valueOf() + leaseDurationMs).toISOString();
        const proposal = {
          createdAt,
          estimate,
          id: reservationId,
          idempotencyKey: request.idempotencyKey,
          leaseExpiresAt: proposalLease,
          operationOrdinal,
          phaseOrdinal: request.phaseOrdinal,
          requestHash: hashKnowledgeOperationRequestV2(request),
          state: "reserved" as const,
          subqueryOrdinal: request.subqueryOrdinal,
          version: KNOWLEDGE_BUDGET_RESERVATION_VERSION
        };
        const decision = decideKnowledgeBudgetReservation(
          policy,
          records.map((record) => record.reservation),
          proposal
        );
        if (decision.kind === "conflict") return decision;
        if (decision.kind === "rejected") return decision;
        if (decision.kind === "idempotent") {
          const record = records.find((candidate) =>
            candidate.reservation.id === decision.reservation.id);
          if (!record || record.purgedAt !== null ||
            record.modelRunToolCallId !== input.modelRunToolCallId ||
            canonicalKnowledgeOperationRequestV2(record.operationRequest) !==
              canonicalKnowledgeOperationRequestV2(request)) {
            return { kind: "conflict", reason: "idempotency_conflict" } as const;
          }
          return Object.freeze({
            chargeAfter: decision.chargeAfter,
            kind: "idempotent",
            record,
            roundIndex: context.roundIndex
          });
        }
        const leaseToken = uuid();
        if (!strictLeaseToken(leaseToken)) {
          return { kind: "conflict", reason: "invalid_payload" } as const;
        }
        const created = await tx.knowledgeBudgetReservation.create({
          data: {
            createdAt: now,
            estimatedCandidates: estimate.candidateCount,
            estimatedCostMicros: estimate.costMicros,
            estimatedEmbeddingCalls: estimate.queryEmbeddingCalls,
            estimatedLatencyMs: estimate.latencyMs,
            estimatedRetrievedTokens: estimate.retrievedTokens,
            id: reservationId,
            idempotencyKey: request.idempotencyKey,
            leaseExpiresAt: new Date(proposalLease),
            leaseToken,
            modelRunId: input.runId,
            modelRunToolCallId: input.modelRunToolCallId,
            operation: request.operation,
            operationOrdinal,
            operationRequest: json(request),
            operationRequestHash: proposal.requestHash,
            phaseOrdinal: request.phaseOrdinal,
            policyVersion: policy.version,
            state: "reserved",
            subqueryOrdinal: request.subqueryOrdinal
          },
          select: reservationSelect
        });
        return Object.freeze({
          chargeAfter: decision.chargeAfter,
          chargeBefore: decision.chargeBefore,
          kind: "admitted",
          record: decodeKnowledgeBudgetReservationPersistenceRow(created),
          roundIndex: context.roundIndex
        });
      });
    },

    settle: (input) => withLockedReservation(input, async (tx, record, now) => {
      if (!SHA256.test(input.receiptHash)) {
        return mutationConflict(record, "invalid_payload");
      }
      if (record.reservation.state === "dispatched" &&
        (record.leaseToken !== input.leaseToken || !strictLeaseToken(input.leaseToken))) {
        return mutationConflict(record, "lease_fenced");
      }
      const actual = resourceActual(record.operationRequest, input.actual);
      const result = settleKnowledgeBudgetReservation(record.reservation, {
        actual,
        settledAt: now.toISOString(),
        settlementKey: input.receiptHash
      });
      const terminal = domainMutationResult(record, result);
      if (terminal) return terminal;
      const acceptedActual = result.reservation.state === "settled"
        ? result.reservation.actual
        : invalidStorage();
      const updated = await tx.knowledgeBudgetReservation.updateMany({
        data: {
          actualCandidates: acceptedActual.candidateCount,
          actualCostMicros: acceptedActual.costMicros,
          actualEmbeddingCalls: acceptedActual.queryEmbeddingCalls,
          actualLatencyMs: acceptedActual.latencyMs,
          actualRetrievedTokens: acceptedActual.retrievedTokens,
          leaseExpiresAt: null,
          leaseToken: null,
          receiptHash: input.receiptHash,
          settledAt: now,
          state: "settled"
        },
        where: {
          id: input.reservationId,
          leaseExpiresAt: { gt: now },
          leaseToken: input.leaseToken,
          modelRunId: input.runId,
          state: "dispatched"
        }
      });
      if (updated.count !== 1) return mutationConflict(record, "lease_fenced");
      const accepted = await loadReservation(tx, input.runId, input.reservationId);
      if (!accepted) invalidStorage();
      return Object.freeze({ kind: "transitioned", record: accepted });
    })
  });
}

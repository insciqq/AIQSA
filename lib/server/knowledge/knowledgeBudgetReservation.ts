export const KNOWLEDGE_BUDGET_RESERVATION_VERSION = 1 as const;
export const KNOWLEDGE_BUDGET_RESERVATION_POLICY_VERSION = 1 as const;

export const knowledgeBudgetReservationStates = [
  "reserved",
  "dispatched",
  "settled",
  "released",
  "ambiguous",
  "expired"
] as const;

export type KnowledgeBudgetReservationState = typeof knowledgeBudgetReservationStates[number];

const STRUCTURAL_OPERATION_MAX = 256;
const STRUCTURAL_PHASE_MAX = 64;
const STRUCTURAL_SUBQUERY_MAX = 128;
const MAX_ACCOUNTING_VALUE = 2_147_483_647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/u;
const REASON = /^[a-z][a-z0-9_]{0,63}$/u;

const amountKeys = [
  "candidateCount",
  "costMicros",
  "latencyMs",
  "operationSlots",
  "queryEmbeddingCalls",
  "retrievedTokens"
] as const;

export type KnowledgeBudgetAmountKey = typeof amountKeys[number];

export type KnowledgeBudgetEstimate = Readonly<Record<KnowledgeBudgetAmountKey, number>>;
export type KnowledgeBudgetActual = Readonly<Record<KnowledgeBudgetAmountKey, number | null>>;
export type KnowledgeBudgetCharge = KnowledgeBudgetEstimate;

export type KnowledgeBudgetReservationPolicy = Readonly<{
  maxCumulativeCandidates: number;
  maxEstimatedCostMicros: number;
  maxLatencyMs: number;
  maxOperations: number;
  maxQueryEmbeddingCalls: number;
  maxRetrievedTokens: number;
  version: typeof KNOWLEDGE_BUDGET_RESERVATION_POLICY_VERSION;
}>;

type KnowledgeBudgetReservationCommon = Readonly<{
  createdAt: string;
  estimate: KnowledgeBudgetEstimate;
  id: string;
  idempotencyKey: string;
  operationOrdinal: number;
  phaseOrdinal: number;
  requestHash: string;
  subqueryOrdinal: number;
  version: typeof KNOWLEDGE_BUDGET_RESERVATION_VERSION;
}>;

export type KnowledgeBudgetReservedReservation = KnowledgeBudgetReservationCommon & Readonly<{
  leaseExpiresAt: string;
  state: "reserved";
}>;

export type KnowledgeBudgetDispatchedReservation = KnowledgeBudgetReservationCommon & Readonly<{
  dispatchKey: string;
  dispatchedAt: string;
  leaseExpiresAt: string;
  state: "dispatched";
}>;

export type KnowledgeBudgetSettledReservation = KnowledgeBudgetReservationCommon & Readonly<{
  actual: KnowledgeBudgetActual;
  dispatchKey: string;
  dispatchedAt: string;
  settledAt: string;
  settlementKey: string;
  state: "settled";
}>;

export type KnowledgeBudgetReleasedReservation = KnowledgeBudgetReservationCommon & Readonly<{
  reason: string;
  releasedAt: string;
  state: "released";
}>;

export type KnowledgeBudgetAmbiguousReservation = KnowledgeBudgetReservationCommon & Readonly<{
  ambiguousAt: string;
  dispatchKey: string;
  dispatchedAt: string;
  reason: string;
  state: "ambiguous";
}>;

export type KnowledgeBudgetExpiredReservation = KnowledgeBudgetReservationCommon & Readonly<{
  expiredAt: string;
  reason: string;
  state: "expired";
}>;

export type KnowledgeBudgetReservation =
  | KnowledgeBudgetAmbiguousReservation
  | KnowledgeBudgetDispatchedReservation
  | KnowledgeBudgetExpiredReservation
  | KnowledgeBudgetReleasedReservation
  | KnowledgeBudgetReservedReservation
  | KnowledgeBudgetSettledReservation;

export type KnowledgeBudgetReservationStopReason =
  | "candidate_budget"
  | "cost_budget"
  | "embedding_budget"
  | "latency_budget"
  | "operation_budget"
  | "retrieved_token_budget";

export type KnowledgeBudgetReservationDecision =
  | Readonly<{
      chargeAfter: KnowledgeBudgetCharge;
      chargeBefore: KnowledgeBudgetCharge;
      kind: "admitted";
    }>
  | Readonly<{
      chargeAfter: KnowledgeBudgetCharge;
      chargeBefore: KnowledgeBudgetCharge;
      kind: "rejected";
      reason: KnowledgeBudgetReservationStopReason;
    }>
  | Readonly<{
      chargeAfter: KnowledgeBudgetCharge;
      kind: "idempotent";
      reservation: KnowledgeBudgetReservation;
    }>
  | Readonly<{
      kind: "conflict";
      reason: "idempotency_conflict" | "reservation_id_conflict";
    }>;

export type KnowledgeBudgetReservationTransitionResult =
  | Readonly<{
      kind: "transitioned";
      reservation: KnowledgeBudgetReservation;
    }>
  | Readonly<{
      kind: "idempotent";
      reservation: KnowledgeBudgetReservation;
    }>
  | Readonly<{
      kind: "conflict";
      reason:
        | "idempotency_conflict"
        | "invalid_payload"
        | "invalid_state"
        | "lease_active"
        | "lease_expired";
      reservation: KnowledgeBudgetReservation;
    }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function integer(value: unknown, minimum = 0, maximum = MAX_ACCOUNTING_VALUE): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 20 || value.length > 32) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value ? null : value;
}

function safeIdentity(value: unknown): string | null {
  return typeof value === "string" && IDEMPOTENCY_KEY.test(value) ? value : null;
}

function safeReason(value: unknown): string | null {
  return typeof value === "string" && REASON.test(value) ? value : null;
}

function decodeAmount(
  value: unknown,
  nullable: false
): KnowledgeBudgetEstimate | null;
function decodeAmount(
  value: unknown,
  nullable: true
): KnowledgeBudgetActual | null;
function decodeAmount(
  value: unknown,
  nullable: boolean
): KnowledgeBudgetActual | KnowledgeBudgetEstimate | null {
  if (!record(value) || !exactKeys(value, amountKeys) || amountKeys.some((key) => {
    const entry = value[key];
    return entry === null ? !nullable : !integer(entry);
  })) return null;
  const decoded = Object.fromEntries(amountKeys.map((key) => [key, value[key]])) as
    Record<KnowledgeBudgetAmountKey, number | null>;
  if (decoded.operationSlots !== null && decoded.operationSlots > STRUCTURAL_OPERATION_MAX) {
    return null;
  }
  return Object.freeze(decoded) as KnowledgeBudgetActual | KnowledgeBudgetEstimate;
}

export function decodeKnowledgeBudgetEstimate(value: unknown): KnowledgeBudgetEstimate | null {
  return decodeAmount(value, false);
}

export function decodeKnowledgeBudgetActual(value: unknown): KnowledgeBudgetActual | null {
  return decodeAmount(value, true);
}

export function decodeKnowledgeBudgetReservationPolicy(
  value: unknown
): KnowledgeBudgetReservationPolicy | null {
  const keys = [
    "maxCumulativeCandidates",
    "maxEstimatedCostMicros",
    "maxLatencyMs",
    "maxOperations",
    "maxQueryEmbeddingCalls",
    "maxRetrievedTokens",
    "version"
  ] as const;
  if (!record(value) || !exactKeys(value, keys) ||
    value.version !== KNOWLEDGE_BUDGET_RESERVATION_POLICY_VERSION ||
    !integer(value.maxCumulativeCandidates, 1, 1_000_000) ||
    !integer(value.maxEstimatedCostMicros, 0, 1_000_000_000) ||
    !integer(value.maxLatencyMs, 100, 3_600_000) ||
    !integer(value.maxOperations, 1, STRUCTURAL_OPERATION_MAX) ||
    !integer(value.maxQueryEmbeddingCalls, 0, STRUCTURAL_OPERATION_MAX) ||
    !integer(value.maxRetrievedTokens, 1, 10_000_000)) return null;
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]]))) as
    KnowledgeBudgetReservationPolicy;
}

const commonKeys = [
  "createdAt",
  "estimate",
  "id",
  "idempotencyKey",
  "operationOrdinal",
  "phaseOrdinal",
  "requestHash",
  "subqueryOrdinal",
  "version"
] as const;

function decodeCommon(value: Record<string, unknown>): KnowledgeBudgetReservationCommon | null {
  const createdAt = canonicalTimestamp(value.createdAt);
  const estimate = decodeKnowledgeBudgetEstimate(value.estimate);
  if (!createdAt || !estimate || estimate.operationSlots !== 1 ||
    typeof value.id !== "string" || !UUID.test(value.id) ||
    typeof value.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
    typeof value.requestHash !== "string" || !SHA256.test(value.requestHash) ||
    !integer(value.operationOrdinal, 1, STRUCTURAL_OPERATION_MAX) ||
    !integer(value.phaseOrdinal, 0, STRUCTURAL_PHASE_MAX - 1) ||
    !integer(value.subqueryOrdinal, 0, STRUCTURAL_SUBQUERY_MAX - 1) ||
    value.version !== KNOWLEDGE_BUDGET_RESERVATION_VERSION) return null;
  return Object.freeze({
    createdAt,
    estimate,
    id: value.id,
    idempotencyKey: value.idempotencyKey,
    operationOrdinal: Number(value.operationOrdinal),
    phaseOrdinal: Number(value.phaseOrdinal),
    requestHash: value.requestHash,
    subqueryOrdinal: Number(value.subqueryOrdinal),
    version: KNOWLEDGE_BUDGET_RESERVATION_VERSION
  });
}

function commonFields(reservation: KnowledgeBudgetReservation): KnowledgeBudgetReservationCommon {
  return {
    createdAt: reservation.createdAt,
    estimate: reservation.estimate,
    id: reservation.id,
    idempotencyKey: reservation.idempotencyKey,
    operationOrdinal: reservation.operationOrdinal,
    phaseOrdinal: reservation.phaseOrdinal,
    requestHash: reservation.requestHash,
    subqueryOrdinal: reservation.subqueryOrdinal,
    version: KNOWLEDGE_BUDGET_RESERVATION_VERSION
  };
}

/** Strictly decodes every state as a separate persisted shape. */
export function decodeKnowledgeBudgetReservation(
  value: unknown
): KnowledgeBudgetReservation | null {
  if (!record(value) || typeof value.state !== "string") return null;
  const common = decodeCommon(value);
  if (!common) return null;
  if (value.state === "reserved") {
    if (!exactKeys(value, [...commonKeys, "leaseExpiresAt", "state"])) return null;
    const leaseExpiresAt = canonicalTimestamp(value.leaseExpiresAt);
    return leaseExpiresAt && leaseExpiresAt > common.createdAt
      ? Object.freeze({ ...common, leaseExpiresAt, state: "reserved" })
      : null;
  }
  if (value.state === "dispatched") {
    if (!exactKeys(value, [
      ...commonKeys,
      "dispatchKey",
      "dispatchedAt",
      "leaseExpiresAt",
      "state"
    ])) return null;
    const dispatchKey = safeIdentity(value.dispatchKey);
    const dispatchedAt = canonicalTimestamp(value.dispatchedAt);
    const leaseExpiresAt = canonicalTimestamp(value.leaseExpiresAt);
    return dispatchKey && dispatchedAt && dispatchedAt >= common.createdAt &&
      leaseExpiresAt && leaseExpiresAt > dispatchedAt
      ? Object.freeze({ ...common, dispatchKey, dispatchedAt, leaseExpiresAt, state: "dispatched" })
      : null;
  }
  if (value.state === "settled") {
    if (!exactKeys(value, [
      ...commonKeys,
      "actual",
      "dispatchKey",
      "dispatchedAt",
      "settledAt",
      "settlementKey",
      "state"
    ])) return null;
    const actual = decodeKnowledgeBudgetActual(value.actual);
    const dispatchKey = safeIdentity(value.dispatchKey);
    const settlementKey = safeIdentity(value.settlementKey);
    const dispatchedAt = canonicalTimestamp(value.dispatchedAt);
    const settledAt = canonicalTimestamp(value.settledAt);
    return actual && dispatchKey && settlementKey && dispatchedAt && settledAt &&
      dispatchedAt >= common.createdAt && settledAt >= dispatchedAt
      ? Object.freeze({
          ...common,
          actual,
          dispatchKey,
          dispatchedAt,
          settledAt,
          settlementKey,
          state: "settled"
        })
      : null;
  }
  if (value.state === "released") {
    if (!exactKeys(value, [...commonKeys, "reason", "releasedAt", "state"])) return null;
    const reason = safeReason(value.reason);
    const releasedAt = canonicalTimestamp(value.releasedAt);
    return reason && releasedAt && releasedAt >= common.createdAt
      ? Object.freeze({ ...common, reason, releasedAt, state: "released" })
      : null;
  }
  if (value.state === "ambiguous") {
    if (!exactKeys(value, [
      ...commonKeys,
      "ambiguousAt",
      "dispatchKey",
      "dispatchedAt",
      "reason",
      "state"
    ])) return null;
    const ambiguousAt = canonicalTimestamp(value.ambiguousAt);
    const dispatchKey = safeIdentity(value.dispatchKey);
    const dispatchedAt = canonicalTimestamp(value.dispatchedAt);
    const reason = safeReason(value.reason);
    return ambiguousAt && dispatchKey && dispatchedAt && reason &&
      dispatchedAt >= common.createdAt && ambiguousAt >= dispatchedAt
      ? Object.freeze({
          ...common,
          ambiguousAt,
          dispatchKey,
          dispatchedAt,
          reason,
          state: "ambiguous"
        })
      : null;
  }
  if (value.state === "expired") {
    if (!exactKeys(value, [...commonKeys, "expiredAt", "reason", "state"])) return null;
    const expiredAt = canonicalTimestamp(value.expiredAt);
    const reason = safeReason(value.reason);
    return expiredAt && reason && expiredAt >= common.createdAt
      ? Object.freeze({ ...common, expiredAt, reason, state: "expired" })
      : null;
  }
  return null;
}

export function createKnowledgeBudgetReservation(value: unknown): KnowledgeBudgetReservation {
  const decoded = decodeKnowledgeBudgetReservation(value);
  if (!decoded) throw new Error("knowledge_budget_reservation_invalid");
  return decoded;
}

const ZERO_CHARGE: KnowledgeBudgetCharge = Object.freeze(Object.fromEntries(
  amountKeys.map((key) => [key, 0])
)) as KnowledgeBudgetCharge;

function settledCharge(
  estimate: KnowledgeBudgetEstimate,
  actual: KnowledgeBudgetActual
): KnowledgeBudgetCharge {
  return Object.freeze(Object.fromEntries(amountKeys.map((key) => [
    key,
    actual[key] ?? estimate[key]
  ]))) as KnowledgeBudgetCharge;
}

/** Conservative accounting: in-flight/ambiguous uses estimates; terminal unused capacity is zero. */
export function knowledgeBudgetReservationCharge(
  reservation: KnowledgeBudgetReservation
): KnowledgeBudgetCharge {
  if (reservation.state === "released" || reservation.state === "expired") return ZERO_CHARGE;
  if (reservation.state === "settled") {
    return settledCharge(reservation.estimate, reservation.actual);
  }
  return reservation.estimate;
}

function addAmount(
  left: KnowledgeBudgetCharge,
  right: KnowledgeBudgetCharge
): KnowledgeBudgetCharge {
  const entries = amountKeys.map((key) => {
    const value = left[key] + right[key];
    if (!Number.isSafeInteger(value) || value > MAX_ACCOUNTING_VALUE) {
      throw new Error("knowledge_budget_aggregate_overflow");
    }
    return [key, value] as const;
  });
  return Object.freeze(Object.fromEntries(entries)) as KnowledgeBudgetCharge;
}

export function aggregateKnowledgeBudgetReservations(
  reservations: readonly KnowledgeBudgetReservation[]
): KnowledgeBudgetCharge {
  const ids = new Set<string>();
  const idempotencyKeys = new Set<string>();
  let aggregate = ZERO_CHARGE;
  for (const reservation of reservations) {
    if (ids.has(reservation.id) || idempotencyKeys.has(reservation.idempotencyKey)) {
      throw new Error("knowledge_budget_reservation_duplicate");
    }
    ids.add(reservation.id);
    idempotencyKeys.add(reservation.idempotencyKey);
    aggregate = addAmount(aggregate, knowledgeBudgetReservationCharge(reservation));
  }
  return aggregate;
}

function sameAmount(left: KnowledgeBudgetActual, right: KnowledgeBudgetActual): boolean;
function sameAmount(left: KnowledgeBudgetEstimate, right: KnowledgeBudgetEstimate): boolean;
function sameAmount(
  left: KnowledgeBudgetActual | KnowledgeBudgetEstimate,
  right: KnowledgeBudgetActual | KnowledgeBudgetEstimate
): boolean {
  return amountKeys.every((key) => left[key] === right[key]);
}

function sameReservationAttempt(
  existing: KnowledgeBudgetReservation,
  proposal: KnowledgeBudgetReservedReservation
): boolean {
  return existing.requestHash === proposal.requestHash &&
    existing.operationOrdinal === proposal.operationOrdinal &&
    existing.phaseOrdinal === proposal.phaseOrdinal &&
    existing.subqueryOrdinal === proposal.subqueryOrdinal &&
    sameAmount(existing.estimate, proposal.estimate);
}

function stopReason(
  policy: KnowledgeBudgetReservationPolicy,
  charge: KnowledgeBudgetCharge
): KnowledgeBudgetReservationStopReason | null {
  if (charge.operationSlots > policy.maxOperations) return "operation_budget";
  if (charge.candidateCount > policy.maxCumulativeCandidates) return "candidate_budget";
  if (charge.queryEmbeddingCalls > policy.maxQueryEmbeddingCalls) return "embedding_budget";
  if (charge.retrievedTokens > policy.maxRetrievedTokens) return "retrieved_token_budget";
  if (charge.latencyMs > policy.maxLatencyMs) return "latency_budget";
  if (charge.costMicros > policy.maxEstimatedCostMicros) return "cost_budget";
  return null;
}

/**
 * Pure decision intended to run while the durable run-scope accounting row is
 * locked. The caller persists an admitted proposal in that same transaction.
 */
export function decideKnowledgeBudgetReservation(
  policy: KnowledgeBudgetReservationPolicy,
  reservations: readonly KnowledgeBudgetReservation[],
  proposal: KnowledgeBudgetReservedReservation
): KnowledgeBudgetReservationDecision {
  const sameKey = reservations.find((reservation) =>
    reservation.idempotencyKey === proposal.idempotencyKey);
  if (sameKey) {
    return sameReservationAttempt(sameKey, proposal)
      ? Object.freeze({
          chargeAfter: aggregateKnowledgeBudgetReservations(reservations),
          kind: "idempotent" as const,
          reservation: sameKey
        })
      : Object.freeze({ kind: "conflict" as const, reason: "idempotency_conflict" as const });
  }
  if (reservations.some((reservation) => reservation.id === proposal.id)) {
    return Object.freeze({ kind: "conflict" as const, reason: "reservation_id_conflict" as const });
  }
  const chargeBefore = aggregateKnowledgeBudgetReservations(reservations);
  const chargeAfter = addAmount(chargeBefore, proposal.estimate);
  const reason = stopReason(policy, chargeAfter);
  return reason
    ? Object.freeze({ chargeAfter, chargeBefore, kind: "rejected" as const, reason })
    : Object.freeze({ chargeAfter, chargeBefore, kind: "admitted" as const });
}

function transitioned(
  reservation: KnowledgeBudgetReservation
): KnowledgeBudgetReservationTransitionResult {
  return Object.freeze({ kind: "transitioned", reservation });
}

function idempotent(
  reservation: KnowledgeBudgetReservation
): KnowledgeBudgetReservationTransitionResult {
  return Object.freeze({ kind: "idempotent", reservation });
}

function conflict(
  reservation: KnowledgeBudgetReservation,
  reason: Extract<KnowledgeBudgetReservationTransitionResult, { kind: "conflict" }>["reason"]
): KnowledgeBudgetReservationTransitionResult {
  return Object.freeze({ kind: "conflict", reason, reservation });
}

export function dispatchKnowledgeBudgetReservation(
  reservation: KnowledgeBudgetReservation,
  input: Readonly<{ dispatchKey: string; dispatchedAt: string; leaseExpiresAt: string }>
): KnowledgeBudgetReservationTransitionResult {
  const dispatchKey = safeIdentity(input.dispatchKey);
  const dispatchedAt = canonicalTimestamp(input.dispatchedAt);
  const leaseExpiresAt = canonicalTimestamp(input.leaseExpiresAt);
  if (!dispatchKey || !dispatchedAt || !leaseExpiresAt ||
    dispatchedAt < reservation.createdAt || leaseExpiresAt <= dispatchedAt) {
    return conflict(reservation, "invalid_payload");
  }
  if (reservation.state === "dispatched") {
    return reservation.dispatchKey === dispatchKey
      ? idempotent(reservation)
      : conflict(reservation, "idempotency_conflict");
  }
  if (reservation.state !== "reserved") return conflict(reservation, "invalid_state");
  if (dispatchedAt >= reservation.leaseExpiresAt) {
    return conflict(reservation, "lease_expired");
  }
  return transitioned(Object.freeze({
    ...commonFields(reservation),
    dispatchKey,
    dispatchedAt,
    leaseExpiresAt,
    state: "dispatched"
  }));
}

export function settleKnowledgeBudgetReservation(
  reservation: KnowledgeBudgetReservation,
  input: Readonly<{ actual: unknown; settledAt: string; settlementKey: string }>
): KnowledgeBudgetReservationTransitionResult {
  const actual = decodeKnowledgeBudgetActual(input.actual);
  const settledAt = canonicalTimestamp(input.settledAt);
  const settlementKey = safeIdentity(input.settlementKey);
  if (!actual || !settledAt || !settlementKey) return conflict(reservation, "invalid_payload");
  if (reservation.state === "settled") {
    return reservation.settlementKey === settlementKey && sameAmount(reservation.actual, actual)
      ? idempotent(reservation)
      : conflict(reservation, "idempotency_conflict");
  }
  if (reservation.state !== "dispatched") return conflict(reservation, "invalid_state");
  if (settledAt < reservation.dispatchedAt) return conflict(reservation, "invalid_payload");
  return transitioned(Object.freeze({
    ...commonFields(reservation),
    actual,
    dispatchKey: reservation.dispatchKey,
    dispatchedAt: reservation.dispatchedAt,
    settledAt,
    settlementKey,
    state: "settled"
  }));
}

export function releaseKnowledgeBudgetReservation(
  reservation: KnowledgeBudgetReservation,
  input: Readonly<{ reason: string; releasedAt: string }>
): KnowledgeBudgetReservationTransitionResult {
  const reason = safeReason(input.reason);
  const releasedAt = canonicalTimestamp(input.releasedAt);
  if (!reason || !releasedAt || releasedAt < reservation.createdAt) {
    return conflict(reservation, "invalid_payload");
  }
  if (reservation.state === "released") {
    return reservation.reason === reason
      ? idempotent(reservation)
      : conflict(reservation, "idempotency_conflict");
  }
  if (reservation.state !== "reserved") return conflict(reservation, "invalid_state");
  return transitioned(Object.freeze({
    ...commonFields(reservation),
    reason,
    releasedAt,
    state: "released"
  }));
}

export function markKnowledgeBudgetReservationAmbiguous(
  reservation: KnowledgeBudgetReservation,
  input: Readonly<{ ambiguousAt: string; reason: string }>
): KnowledgeBudgetReservationTransitionResult {
  const ambiguousAt = canonicalTimestamp(input.ambiguousAt);
  const reason = safeReason(input.reason);
  if (!ambiguousAt || !reason) return conflict(reservation, "invalid_payload");
  if (reservation.state === "ambiguous") {
    return reservation.reason === reason
      ? idempotent(reservation)
      : conflict(reservation, "idempotency_conflict");
  }
  if (reservation.state !== "dispatched") return conflict(reservation, "invalid_state");
  if (ambiguousAt < reservation.dispatchedAt) return conflict(reservation, "invalid_payload");
  return transitioned(Object.freeze({
    ...commonFields(reservation),
    ambiguousAt,
    dispatchKey: reservation.dispatchKey,
    dispatchedAt: reservation.dispatchedAt,
    reason,
    state: "ambiguous"
  }));
}

export function expireKnowledgeBudgetReservation(
  reservation: KnowledgeBudgetReservation,
  input: Readonly<{ expiredAt: string; reason: string }>
): KnowledgeBudgetReservationTransitionResult {
  const expiredAt = canonicalTimestamp(input.expiredAt);
  const reason = safeReason(input.reason);
  if (!expiredAt || !reason || expiredAt < reservation.createdAt) {
    return conflict(reservation, "invalid_payload");
  }
  if (reservation.state === "expired") {
    return reservation.reason === reason
      ? idempotent(reservation)
      : conflict(reservation, "idempotency_conflict");
  }
  if (reservation.state !== "reserved") return conflict(reservation, "invalid_state");
  if (expiredAt < reservation.leaseExpiresAt) return conflict(reservation, "lease_active");
  return transitioned(Object.freeze({
    ...commonFields(reservation),
    expiredAt,
    reason,
    state: "expired"
  }));
}

/** Expired reserved capacity is freed; expired dispatched work becomes ambiguity, never replay. */
export function recoverExpiredKnowledgeBudgetReservation(
  reservation: KnowledgeBudgetReservation,
  at: string
): KnowledgeBudgetReservationTransitionResult {
  const recoveredAt = canonicalTimestamp(at);
  if (!recoveredAt) return conflict(reservation, "invalid_payload");
  if (reservation.state !== "reserved" && reservation.state !== "dispatched") {
    return conflict(reservation, "invalid_state");
  }
  if (recoveredAt < reservation.leaseExpiresAt) return conflict(reservation, "lease_active");
  return reservation.state === "reserved"
    ? expireKnowledgeBudgetReservation(reservation, {
        expiredAt: recoveredAt,
        reason: "lease_expired"
      })
    : markKnowledgeBudgetReservationAmbiguous(reservation, {
        ambiguousAt: recoveredAt,
        reason: "lease_expired_after_dispatch"
      });
}

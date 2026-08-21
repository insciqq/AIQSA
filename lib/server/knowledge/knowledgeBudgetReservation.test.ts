import { describe, expect, it } from "vitest";
import {
  aggregateKnowledgeBudgetReservations,
  createKnowledgeBudgetReservation,
  decideKnowledgeBudgetReservation,
  decodeKnowledgeBudgetActual,
  decodeKnowledgeBudgetEstimate,
  decodeKnowledgeBudgetReservation,
  decodeKnowledgeBudgetReservationPolicy,
  dispatchKnowledgeBudgetReservation,
  expireKnowledgeBudgetReservation,
  knowledgeBudgetReservationCharge,
  KNOWLEDGE_BUDGET_RESERVATION_POLICY_VERSION,
  KNOWLEDGE_BUDGET_RESERVATION_VERSION,
  markKnowledgeBudgetReservationAmbiguous,
  recoverExpiredKnowledgeBudgetReservation,
  releaseKnowledgeBudgetReservation,
  settleKnowledgeBudgetReservation,
  type KnowledgeBudgetActual,
  type KnowledgeBudgetAmountKey,
  type KnowledgeBudgetEstimate,
  type KnowledgeBudgetReservation,
  type KnowledgeBudgetReservationPolicy,
  type KnowledgeBudgetReservedReservation
} from "./knowledgeBudgetReservation";

const CREATED = "2026-08-19T10:00:00.000Z";
const DISPATCHED = "2026-08-19T10:01:00.000Z";
const SETTLED = "2026-08-19T10:02:00.000Z";
const LEASE = "2026-08-19T10:05:00.000Z";
const DISPATCH_LEASE = "2026-08-19T10:06:00.000Z";

function estimate(overrides: Partial<KnowledgeBudgetEstimate> = {}): KnowledgeBudgetEstimate {
  return {
    candidateCount: 100,
    costMicros: 50,
    latencyMs: 500,
    operationSlots: 1,
    queryEmbeddingCalls: 1,
    retrievedTokens: 1_000,
    ...overrides
  };
}

function actual(
  overrides: Partial<Record<KnowledgeBudgetAmountKey, number | null>> = {}
): KnowledgeBudgetActual {
  return {
    candidateCount: 40,
    costMicros: 20,
    latencyMs: 300,
    operationSlots: 1,
    queryEmbeddingCalls: 1,
    retrievedTokens: 600,
    ...overrides
  };
}

function reserved(
  overrides: Record<string, unknown> = {}
): KnowledgeBudgetReservedReservation {
  return createKnowledgeBudgetReservation({
    createdAt: CREATED,
    estimate: estimate(),
    id: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "run:1:operation:1",
    leaseExpiresAt: LEASE,
    operationOrdinal: 1,
    phaseOrdinal: 0,
    requestHash: "a".repeat(64),
    state: "reserved",
    subqueryOrdinal: 0,
    version: KNOWLEDGE_BUDGET_RESERVATION_VERSION,
    ...overrides
  }) as KnowledgeBudgetReservedReservation;
}

function dispatch(
  reservation: KnowledgeBudgetReservation = reserved(),
  dispatchKey = "provider:request:one"
): KnowledgeBudgetReservation {
  const result = dispatchKnowledgeBudgetReservation(reservation, {
    dispatchKey,
    dispatchedAt: DISPATCHED,
    leaseExpiresAt: DISPATCH_LEASE
  });
  if (result.kind !== "transitioned") throw new Error("dispatch_fixture_invalid");
  return result.reservation;
}

const policy: KnowledgeBudgetReservationPolicy = {
  maxCumulativeCandidates: 1_400,
  maxEstimatedCostMicros: 10_000,
  maxLatencyMs: 30_000,
  maxOperations: 14,
  maxQueryEmbeddingCalls: 14,
  maxRetrievedTokens: 32_000,
  version: KNOWLEDGE_BUDGET_RESERVATION_POLICY_VERSION
};

describe("Knowledge budget reservation contract", () => {
  it("strictly decodes estimates, actual usage, policy, and reserved state", () => {
    expect(decodeKnowledgeBudgetEstimate(estimate())).toEqual(estimate());
    expect(decodeKnowledgeBudgetActual(actual({ retrievedTokens: null })))
      .toEqual(actual({ retrievedTokens: null }));
    expect(decodeKnowledgeBudgetReservationPolicy(policy)).toEqual(policy);
    expect(decodeKnowledgeBudgetReservation(reserved())).toEqual(reserved());
    expect(Object.isFrozen(reserved())).toBe(true);
    expect(Object.isFrozen(reserved().estimate)).toBe(true);

    expect(decodeKnowledgeBudgetEstimate({ ...estimate(), unknown: 1 })).toBeNull();
    expect(decodeKnowledgeBudgetEstimate({ ...estimate(), candidateCount: 0.5 })).toBeNull();
    expect(decodeKnowledgeBudgetActual({ ...actual(), costMicros: undefined })).toBeNull();
    expect(decodeKnowledgeBudgetReservationPolicy({ ...policy, unknown: true })).toBeNull();
    expect(decodeKnowledgeBudgetReservation({ ...reserved(), unknown: true })).toBeNull();
    expect(decodeKnowledgeBudgetReservation({ ...reserved(), leaseExpiresAt: CREATED })).toBeNull();
    expect(decodeKnowledgeBudgetEstimate({
      ...estimate(),
      rerankerCalls: 1
    })).toBeNull();
    expect(() => createKnowledgeBudgetReservation({})).toThrow(
      "knowledge_budget_reservation_invalid"
    );
  });

  it("dispatches once and treats only the same dispatch identity as idempotent", () => {
    const reservation = reserved();
    const first = dispatchKnowledgeBudgetReservation(reservation, {
      dispatchKey: "provider:request:one",
      dispatchedAt: DISPATCHED,
      leaseExpiresAt: DISPATCH_LEASE
    });
    expect(first.kind).toBe("transitioned");
    if (first.kind !== "transitioned") return;
    expect(first.reservation.state).toBe("dispatched");

    expect(dispatchKnowledgeBudgetReservation(first.reservation, {
      dispatchKey: "provider:request:one",
      dispatchedAt: SETTLED,
      leaseExpiresAt: "2026-08-19T10:07:00.000Z"
    }).kind).toBe("idempotent");
    expect(dispatchKnowledgeBudgetReservation(first.reservation, {
      dispatchKey: "provider:request:two",
      dispatchedAt: SETTLED,
      leaseExpiresAt: "2026-08-19T10:07:00.000Z"
    })).toMatchObject({ kind: "conflict", reason: "idempotency_conflict" });
    expect(dispatchKnowledgeBudgetReservation(reservation, {
      dispatchKey: "provider:request:late",
      dispatchedAt: LEASE,
      leaseExpiresAt: "2026-08-19T10:07:00.000Z"
    })).toMatchObject({ kind: "conflict", reason: "lease_expired" });
  });

  it("settles dispatched work exactly once and rejects conflicting replays", () => {
    const dispatched = dispatch();
    const usage = actual({ retrievedTokens: null });
    const first = settleKnowledgeBudgetReservation(dispatched, {
      actual: usage,
      settledAt: SETTLED,
      settlementKey: "provider:settlement:one"
    });
    expect(first.kind).toBe("transitioned");
    if (first.kind !== "transitioned") return;
    expect(first.reservation).toMatchObject({ actual: usage, state: "settled" });

    expect(settleKnowledgeBudgetReservation(first.reservation, {
      actual: usage,
      settledAt: "2026-08-19T10:03:00.000Z",
      settlementKey: "provider:settlement:one"
    }).kind).toBe("idempotent");
    expect(settleKnowledgeBudgetReservation(first.reservation, {
      actual: actual({ candidateCount: 41, retrievedTokens: null }),
      settledAt: "2026-08-19T10:03:00.000Z",
      settlementKey: "provider:settlement:one"
    })).toMatchObject({ kind: "conflict", reason: "idempotency_conflict" });
    expect(settleKnowledgeBudgetReservation(first.reservation, {
      actual: usage,
      settledAt: "2026-08-19T10:03:00.000Z",
      settlementKey: "provider:settlement:two"
    })).toMatchObject({ kind: "conflict", reason: "idempotency_conflict" });
    expect(settleKnowledgeBudgetReservation(reserved(), {
      actual: usage,
      settledAt: SETTLED,
      settlementKey: "provider:settlement:one"
    })).toMatchObject({ kind: "conflict", reason: "invalid_state" });
  });

  it("releases capacity only before dispatch and keeps release retries idempotent", () => {
    const first = releaseKnowledgeBudgetReservation(reserved(), {
      reason: "cancelled",
      releasedAt: DISPATCHED
    });
    expect(first.kind).toBe("transitioned");
    if (first.kind !== "transitioned") return;
    expect(first.reservation.state).toBe("released");
    expect(knowledgeBudgetReservationCharge(first.reservation)).toEqual(
      Object.fromEntries(Object.keys(estimate()).map((key) => [key, 0]))
    );
    expect(releaseKnowledgeBudgetReservation(first.reservation, {
      reason: "cancelled",
      releasedAt: SETTLED
    }).kind).toBe("idempotent");
    expect(releaseKnowledgeBudgetReservation(dispatch(), {
      reason: "cancelled",
      releasedAt: SETTLED
    })).toMatchObject({ kind: "conflict", reason: "invalid_state" });
  });

  it("turns an expired reserved lease into expiry and a dispatched lease into ambiguity", () => {
    expect(recoverExpiredKnowledgeBudgetReservation(reserved(), DISPATCHED))
      .toMatchObject({ kind: "conflict", reason: "lease_active" });

    const expired = recoverExpiredKnowledgeBudgetReservation(reserved(), LEASE);
    expect(expired.kind).toBe("transitioned");
    if (expired.kind === "transitioned") {
      expect(expired.reservation).toMatchObject({ reason: "lease_expired", state: "expired" });
      expect(knowledgeBudgetReservationCharge(expired.reservation).operationSlots).toBe(0);
    }

    const ambiguous = recoverExpiredKnowledgeBudgetReservation(dispatch(), DISPATCH_LEASE);
    expect(ambiguous.kind).toBe("transitioned");
    if (ambiguous.kind === "transitioned") {
      expect(ambiguous.reservation).toMatchObject({
        reason: "lease_expired_after_dispatch",
        state: "ambiguous"
      });
      expect(knowledgeBudgetReservationCharge(ambiguous.reservation)).toEqual(estimate());
      expect(settleKnowledgeBudgetReservation(ambiguous.reservation, {
        actual: actual(),
        settledAt: "2026-08-19T10:07:00.000Z",
        settlementKey: "provider:settlement:one"
      })).toMatchObject({ kind: "conflict", reason: "invalid_state" });
    }
  });

  it("permits ambiguity only after dispatch and expiry only before dispatch", () => {
    expect(markKnowledgeBudgetReservationAmbiguous(reserved(), {
      ambiguousAt: SETTLED,
      reason: "response_unknown"
    })).toMatchObject({ kind: "conflict", reason: "invalid_state" });
    expect(expireKnowledgeBudgetReservation(dispatch(), {
      expiredAt: SETTLED,
      reason: "lease_expired"
    })).toMatchObject({ kind: "conflict", reason: "invalid_state" });
    expect(expireKnowledgeBudgetReservation(reserved(), {
      expiredAt: SETTLED,
      reason: "lease_expired"
    })).toMatchObject({ kind: "conflict", reason: "lease_active" });

    const ambiguous = markKnowledgeBudgetReservationAmbiguous(dispatch(), {
      ambiguousAt: SETTLED,
      reason: "response_unknown"
    });
    expect(ambiguous.kind).toBe("transitioned");
    if (ambiguous.kind === "transitioned") {
      expect(markKnowledgeBudgetReservationAmbiguous(ambiguous.reservation, {
        ambiguousAt: "2026-08-19T10:03:00.000Z",
        reason: "response_unknown"
      }).kind).toBe("idempotent");
    }
  });

  it("charges settled actuals separately with conservative estimate fallback", () => {
    const dispatched = dispatch();
    const settled = settleKnowledgeBudgetReservation(dispatched, {
      actual: actual({ queryEmbeddingCalls: null, retrievedTokens: null }),
      settledAt: SETTLED,
      settlementKey: "provider:settlement:one"
    });
    if (settled.kind !== "transitioned") throw new Error("settlement_fixture_invalid");

    expect(knowledgeBudgetReservationCharge(settled.reservation)).toEqual({
      ...actual({ queryEmbeddingCalls: null, retrievedTokens: null }),
      queryEmbeddingCalls: estimate().queryEmbeddingCalls,
      retrievedTokens: estimate().retrievedTokens
    });
  });

  it("aggregates chargeable states, excludes released capacity, and rejects duplicates", () => {
    const second = reserved({
      id: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "run:1:operation:2",
      operationOrdinal: 2,
      requestHash: "b".repeat(64),
      subqueryOrdinal: 1
    });
    const released = releaseKnowledgeBudgetReservation(second, {
      reason: "cancelled",
      releasedAt: DISPATCHED
    });
    if (released.kind !== "transitioned") throw new Error("release_fixture_invalid");
    expect(aggregateKnowledgeBudgetReservations([reserved(), released.reservation]))
      .toEqual(estimate());
    expect(() => aggregateKnowledgeBudgetReservations([reserved(), reserved()]))
      .toThrow("knowledge_budget_reservation_duplicate");

    const huge = reserved({ estimate: estimate({ candidateCount: 2_000_000_000 }) });
    const anotherHuge = reserved({
      estimate: estimate({ candidateCount: 2_000_000_000 }),
      id: "33333333-3333-4333-8333-333333333333",
      idempotencyKey: "run:1:operation:3",
      operationOrdinal: 3,
      requestHash: "c".repeat(64)
    });
    expect(() => aggregateKnowledgeBudgetReservations([huge, anotherHuge]))
      .toThrow("knowledge_budget_aggregate_overflow");
  });

  it("makes an ordered policy decision and handles reservation retries by idempotency identity", () => {
    const existing = reserved();
    const proposal = reserved({
      id: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "run:1:operation:2",
      operationOrdinal: 2,
      requestHash: "b".repeat(64),
      subqueryOrdinal: 1
    });
    expect(decideKnowledgeBudgetReservation(policy, [existing], proposal))
      .toMatchObject({ kind: "admitted" });

    const candidateLimited = { ...policy, maxCumulativeCandidates: 150 };
    expect(decideKnowledgeBudgetReservation(candidateLimited, [existing], proposal))
      .toMatchObject({ kind: "rejected", reason: "candidate_budget" });
    expect(decideKnowledgeBudgetReservation({
      ...candidateLimited,
      maxOperations: 1
    }, [existing], proposal)).toMatchObject({
      kind: "rejected",
      reason: "operation_budget"
    });

    const retry = reserved({
      id: "33333333-3333-4333-8333-333333333333"
    });
    expect(decideKnowledgeBudgetReservation(policy, [existing], retry))
      .toMatchObject({ kind: "idempotent", reservation: existing });
    const conflictingRetry = reserved({
      estimate: estimate({ candidateCount: 101 }),
      id: "33333333-3333-4333-8333-333333333333"
    });
    expect(decideKnowledgeBudgetReservation(policy, [existing], conflictingRetry))
      .toMatchObject({ kind: "conflict", reason: "idempotency_conflict" });
  });

});

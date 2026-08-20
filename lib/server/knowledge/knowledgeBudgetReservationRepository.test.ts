import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";
import {
  createPrismaKnowledgeBudgetReservationRepository,
  decodeKnowledgeBudgetReservationPersistenceRow,
  knowledgeBudgetLeaseDurationMs,
  knowledgeBudgetReservationPolicyFromRunScope,
  type KnowledgeBudgetOperationRequestInput,
  type KnowledgeBudgetReservationPersistenceRow,
  type KnowledgeBudgetResourceEstimate
} from "./knowledgeBudgetReservationRepository";
import {
  createKnowledgeOperationRequestV2,
  hashKnowledgeOperationRequestV2
} from "./knowledgeOperationRequest";
import { KNOWLEDGE_TOOL_NAME } from "./retrievalTypes";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const CALL_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const PROFILE_ID = "44444444-4444-4444-8444-444444444444";
const RESERVATION_ID = "55555555-5555-4555-8555-555555555555";
const LEASE_TOKEN = "66666666-6666-4666-8666-666666666666";
const SOURCE_ID = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const LEASE = new Date("2026-08-19T12:05:00.000Z");

function operationRequest(overrides: Record<string, unknown> = {}) {
  return createKnowledgeOperationRequestV2({
    discovery: {
      cursor: null,
      fields: ["filename", "heading", "source_name", "tag", "title"],
      limit: 40,
      query: "Find policy sources"
    },
    idempotencyKey: "run:one:operation:one",
    operation: "discover_sources",
    originalQuery: { reference: MESSAGE_ID, sha256: "a".repeat(64) },
    phaseOrdinal: 2,
    plan: {
      allowedLanes: ["metadata"],
      coverage: { expectedPassageCount: null, mode: "partial" },
      exactTerms: [],
      rewrittenQuery: "Find policy sources",
      strategy: "focused",
      targetNames: [],
      targetSourceIds: []
    },
    plannerVersion: 1,
    profileRevisionId: PROFILE_ID,
    profileRevisionNumber: 3,
    purpose: "source_discovery",
    reservationId: RESERVATION_ID,
    resolvedSourceIds: [],
    sourceAliases: [],
    subqueryOrdinal: 3,
    version: 2,
    ...overrides
  });
}

function persistenceRow(
  overrides: Partial<KnowledgeBudgetReservationPersistenceRow> = {}
): KnowledgeBudgetReservationPersistenceRow {
  const request = operationRequest();
  return {
    actualCandidates: null,
    actualCostMicros: null,
    actualEmbeddingCalls: null,
    actualLatencyMs: null,
    actualRepairSlots: null,
    actualRerankerCalls: null,
    actualRetrievedTokens: null,
    actualValidationSlots: null,
    ambiguousAt: null,
    createdAt: NOW,
    dispatchAttemptKey: null,
    dispatchedAt: null,
    estimatedCandidates: 8,
    estimatedCostMicros: 12,
    estimatedEmbeddingCalls: 0,
    estimatedLatencyMs: 100,
    estimatedRepairSlots: 0,
    estimatedRerankerCalls: 0,
    estimatedRetrievedTokens: 200,
    estimatedValidationSlots: 0,
    expiredAt: null,
    failureCode: null,
    id: request.reservationId,
    idempotencyKey: request.idempotencyKey,
    leaseExpiresAt: LEASE,
    leaseToken: LEASE_TOKEN,
    modelRunId: RUN_ID,
    modelRunToolCallId: CALL_ID,
    operation: request.operation,
    operationOrdinal: 1,
    operationRequest: request as unknown as Prisma.JsonValue,
    operationRequestHash: hashKnowledgeOperationRequestV2(request),
    phaseOrdinal: request.phaseOrdinal,
    policyVersion: 1,
    purgedAt: null,
    receiptHash: null,
    releasedAt: null,
    settledAt: null,
    state: "reserved",
    subqueryOrdinal: request.subqueryOrdinal,
    ...overrides
  };
}

const requestInput: KnowledgeBudgetOperationRequestInput = {
  discovery: {
    cursor: null,
    fields: ["filename", "heading", "source_name", "tag", "title"],
    limit: 40,
    query: "Find policy sources"
  },
  operation: "discover_sources",
  plan: {
    allowedLanes: ["metadata"],
    coverage: { expectedPassageCount: null, mode: "partial" },
    exactTerms: [],
    rewrittenQuery: "Find policy sources",
    strategy: "focused",
    targetNames: [],
    targetSourceIds: []
  },
  plannerVersion: 1,
  profileRevisionId: PROFILE_ID,
  purpose: "source_discovery",
  resolvedSourceIds: [],
  sourceAliases: []
};

const estimate: KnowledgeBudgetResourceEstimate = Object.freeze({
  candidateCount: 8,
  costMicros: 12,
  latencyMs: 100,
  queryEmbeddingCalls: 0,
  repairCalls: 0,
  rerankerCalls: 0,
  retrievedTokens: 200,
  validationCalls: 0
});

function sqlText(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const sql = value as { sql?: string; text?: string };
  return sql.sql ?? sql.text ?? "";
}

function repositoryHarness(options: Readonly<{
  budgetPolicy?: typeof DEFAULT_KNOWLEDGE_BUDGET_POLICY;
  now?: () => Date;
  sources?: readonly Readonly<{
    baseProvenance: Prisma.JsonValue | null;
    sourceAlias: string;
    sourceId: string | null;
  }>[];
  toolName?: string;
}> = {}) {
  const rows: KnowledgeBudgetReservationPersistenceRow[] = [];
  const lockQueries: unknown[] = [];
  const uuidValues = [RESERVATION_ID, LEASE_TOKEN];
  const create = vi.fn(async (args: unknown) => {
    const data = (args as { data: Record<string, unknown> }).data;
    const row = persistenceRow({
      createdAt: data.createdAt as Date,
      estimatedCandidates: data.estimatedCandidates as number,
      estimatedCostMicros: data.estimatedCostMicros as number,
      estimatedEmbeddingCalls: data.estimatedEmbeddingCalls as number,
      estimatedLatencyMs: data.estimatedLatencyMs as number,
      estimatedRepairSlots: data.estimatedRepairSlots as number,
      estimatedRerankerCalls: data.estimatedRerankerCalls as number,
      estimatedRetrievedTokens: data.estimatedRetrievedTokens as number,
      estimatedValidationSlots: data.estimatedValidationSlots as number,
      id: data.id as string,
      idempotencyKey: data.idempotencyKey as string,
      leaseExpiresAt: data.leaseExpiresAt as Date,
      leaseToken: data.leaseToken as string,
      modelRunId: data.modelRunId as string,
      modelRunToolCallId: data.modelRunToolCallId as string,
      operation: data.operation as string,
      operationOrdinal: data.operationOrdinal as number,
      operationRequest: data.operationRequest as Prisma.JsonValue,
      operationRequestHash: data.operationRequestHash as string,
      phaseOrdinal: data.phaseOrdinal as number,
      policyVersion: data.policyVersion as number,
      state: data.state as KnowledgeBudgetReservationPersistenceRow["state"],
      subqueryOrdinal: data.subqueryOrdinal as number
    });
    rows.push(row);
    return row;
  });
  const updateMany = vi.fn(async (args: unknown) => {
    const input = args as {
      data: Partial<KnowledgeBudgetReservationPersistenceRow>;
      where: {
        id?: string;
        leaseExpiresAt?: { gt?: Date; lte?: Date };
        leaseToken?: string;
        modelRunId?: string;
        purgedAt?: null;
        state?: KnowledgeBudgetReservationPersistenceRow["state"];
      };
    };
    let count = 0;
    for (const row of rows) {
      if (input.where.id !== undefined && row.id !== input.where.id ||
        input.where.modelRunId !== undefined && row.modelRunId !== input.where.modelRunId ||
        input.where.state !== undefined && row.state !== input.where.state ||
        input.where.purgedAt === null && row.purgedAt !== null ||
        input.where.leaseToken !== undefined && row.leaseToken !== input.where.leaseToken ||
        input.where.leaseExpiresAt?.gt &&
          (!row.leaseExpiresAt || row.leaseExpiresAt <= input.where.leaseExpiresAt.gt) ||
        input.where.leaseExpiresAt?.lte &&
          (!row.leaseExpiresAt || row.leaseExpiresAt > input.where.leaseExpiresAt.lte)) continue;
      Object.assign(row, input.data);
      count += 1;
    }
    return { count };
  });
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      lockQueries.push(query);
      return sqlText(query).includes('call."roundIndex"')
        ? [{
            budgetPolicy: options.budgetPolicy ?? DEFAULT_KNOWLEDGE_BUDGET_POLICY,
            roundIndex: 2,
            toolCallOrdinal: 3,
            toolCallState: "running",
            toolName: options.toolName ?? "discover_sources",
            userMessageId: MESSAGE_ID
          }]
        : [{
            budgetPolicy: options.budgetPolicy ?? DEFAULT_KNOWLEDGE_BUDGET_POLICY,
            modelRunId: RUN_ID
          }];
    }),
    knowledgeBudgetReservation: {
      create,
      findFirst: vi.fn(async (args: unknown) => {
        const where = (args as { where: { id: string; modelRunId: string } }).where;
        return rows.find((row) => row.id === where.id && row.modelRunId === where.modelRunId) ?? null;
      }),
      findMany: vi.fn(async () => [...rows]),
      updateMany
    },
    knowledgeRunBinding: { findMany: vi.fn(async () => []) },
    knowledgeRunProfileBinding: {
      findFirst: vi.fn(async () => ({
        id: "77777777-7777-4777-8777-777777777777",
        profileRevision: { revisionNumber: 3 }
      }))
    },
    knowledgeRunSourceBinding: { findMany: vi.fn(async () => options.sources ?? []) }
  } as unknown as Prisma.TransactionClient;
  const client = {
    $transaction: vi.fn(async (consume: (value: Prisma.TransactionClient) => Promise<unknown>) =>
      consume(tx))
  } as unknown as PrismaClient;
  const repository = createPrismaKnowledgeBudgetReservationRepository(client, {
    now: options.now ?? (() => new Date(NOW)),
    uuid: () => uuidValues.shift() ?? "88888888-8888-4888-8888-888888888888"
  });
  return { create, lockQueries, repository, rows };
}

describe("Knowledge budget reservation Prisma repository", () => {
  it("maps each nullable persistence state into the strict domain state", () => {
    expect(decodeKnowledgeBudgetReservationPersistenceRow(persistenceRow()).reservation)
      .toMatchObject({ state: "reserved", followUp: true, phaseOrdinal: 2, subqueryOrdinal: 3 });

    const dispatched = persistenceRow({
      dispatchAttemptKey: "provider:attempt:one",
      dispatchedAt: new Date("2026-08-19T12:01:00.000Z"),
      leaseExpiresAt: new Date("2026-08-19T12:06:00.000Z"),
      state: "dispatched"
    });
    expect(decodeKnowledgeBudgetReservationPersistenceRow(dispatched).reservation)
      .toMatchObject({ dispatchKey: "provider:attempt:one", state: "dispatched" });

    const settled = persistenceRow({
      actualCandidates: 5,
      actualCostMicros: 9,
      actualEmbeddingCalls: 0,
      actualLatencyMs: 80,
      actualRepairSlots: 0,
      actualRerankerCalls: 0,
      actualRetrievedTokens: null,
      actualValidationSlots: 0,
      dispatchAttemptKey: "provider:attempt:one",
      dispatchedAt: new Date("2026-08-19T12:01:00.000Z"),
      leaseExpiresAt: null,
      leaseToken: null,
      receiptHash: "b".repeat(64),
      settledAt: new Date("2026-08-19T12:02:00.000Z"),
      state: "settled"
    });
    expect(decodeKnowledgeBudgetReservationPersistenceRow(settled).reservation)
      .toMatchObject({ actual: { retrievedTokens: null }, state: "settled" });

    expect(decodeKnowledgeBudgetReservationPersistenceRow(persistenceRow({
      failureCode: "cancelled",
      leaseExpiresAt: null,
      leaseToken: null,
      releasedAt: new Date("2026-08-19T12:02:00.000Z"),
      state: "released"
    })).reservation.state).toBe("released");
    expect(decodeKnowledgeBudgetReservationPersistenceRow(persistenceRow({
      dispatchAttemptKey: "provider:attempt:one",
      dispatchedAt: new Date("2026-08-19T12:01:00.000Z"),
      failureCode: "response_unknown",
      ambiguousAt: new Date("2026-08-19T12:02:00.000Z"),
      leaseExpiresAt: null,
      leaseToken: null,
      state: "ambiguous"
    })).reservation.state).toBe("ambiguous");
    expect(decodeKnowledgeBudgetReservationPersistenceRow(persistenceRow({
      expiredAt: new Date("2026-08-19T12:05:00.000Z"),
      failureCode: "lease_expired",
      leaseExpiresAt: null,
      leaseToken: null,
      state: "expired"
    })).reservation.state).toBe("expired");

    expect(() => decodeKnowledgeBudgetReservationPersistenceRow(persistenceRow({
      operationRequestHash: "f".repeat(64)
    }))).toThrow("knowledge_budget_reservation_invalid_in_storage");
    expect(() => decodeKnowledgeBudgetReservationPersistenceRow(persistenceRow({
      failureCode: "cancelled",
      releasedAt: new Date("2026-08-19T12:02:00.000Z"),
      state: "released"
    }))).toThrow("knowledge_budget_reservation_invalid_in_storage");
  });

  it("decodes purged accounting without reconstructing private request fingerprints", () => {
    const purged = persistenceRow({
      actualCandidates: 5,
      actualCostMicros: 9,
      actualEmbeddingCalls: 0,
      actualLatencyMs: 80,
      actualRepairSlots: 0,
      actualRerankerCalls: 0,
      actualRetrievedTokens: 90,
      actualValidationSlots: 0,
      dispatchAttemptKey: null,
      dispatchedAt: new Date("2026-08-19T12:01:00.000Z"),
      idempotencyKey: null,
      leaseExpiresAt: null,
      leaseToken: null,
      operationRequest: null,
      operationRequestHash: null,
      purgedAt: new Date("2026-08-19T12:03:00.000Z"),
      receiptHash: null,
      settledAt: new Date("2026-08-19T12:02:00.000Z"),
      state: "settled"
    });

    expect(decodeKnowledgeBudgetReservationPersistenceRow(purged)).toMatchObject({
      leaseToken: null,
      operationRequest: null,
      purgedAt: "2026-08-19T12:03:00.000Z",
      reservation: {
        actual: { candidateCount: 5, retrievedTokens: 90 },
        state: "settled"
      }
    });
    expect(() => decodeKnowledgeBudgetReservationPersistenceRow({
      ...purged,
      operationRequest: operationRequest() as unknown as Prisma.JsonValue
    })).toThrow("knowledge_budget_reservation_invalid_in_storage");
  });

  it("counts purged settled usage but fences every further mutation", async () => {
    const harness = repositoryHarness();
    harness.rows.push(persistenceRow({
      actualCandidates: 5,
      actualCostMicros: 9,
      actualEmbeddingCalls: 0,
      actualLatencyMs: 80,
      actualRepairSlots: 0,
      actualRerankerCalls: 0,
      actualRetrievedTokens: 90,
      actualValidationSlots: 0,
      dispatchAttemptKey: null,
      dispatchedAt: new Date("2026-08-19T12:01:00.000Z"),
      id: "99999999-9999-4999-8999-999999999999",
      idempotencyKey: null,
      leaseExpiresAt: null,
      leaseToken: null,
      modelRunToolCallId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      operationRequest: null,
      operationRequestHash: null,
      purgedAt: new Date("2026-08-19T12:03:00.000Z"),
      receiptHash: null,
      settledAt: new Date("2026-08-19T12:02:00.000Z"),
      state: "settled"
    }));
    const admitted = await harness.repository.reserve({
      estimate,
      idempotencyKey: "run:one:operation:one",
      modelRunToolCallId: CALL_ID,
      operationRequest: requestInput,
      originalQuerySha256: "a".repeat(64),
      runId: RUN_ID,
      userId: "owner-one"
    });
    expect(admitted).toMatchObject({
      chargeBefore: { candidateCount: 5, retrievedTokens: 90 },
      kind: "admitted"
    });
    await expect(harness.repository.settle({
      actual: estimate,
      leaseToken: LEASE_TOKEN,
      receiptHash: "c".repeat(64),
      reservationId: "99999999-9999-4999-8999-999999999999",
      runId: RUN_ID,
      userId: "owner-one"
    })).resolves.toMatchObject({ kind: "conflict", reason: "invalid_state" });
  });

  it("extends the accepted run policy with bounded validation and one repair slot", () => {
    expect(knowledgeBudgetReservationPolicyFromRunScope(DEFAULT_KNOWLEDGE_BUDGET_POLICY))
      .toMatchObject({
        maxOperations: DEFAULT_KNOWLEDGE_BUDGET_POLICY.maxOperations,
        maxRepairCalls: 1,
        maxValidationCalls: DEFAULT_KNOWLEDGE_BUDGET_POLICY.maxOperations,
        version: 1
      });
    expect(knowledgeBudgetReservationPolicyFromRunScope({ maxOperations: 14 })).toBeNull();
    expect(knowledgeBudgetLeaseDurationMs(30_000)).toBe(60_000);
    expect(knowledgeBudgetLeaseDurationMs(3_600_000)).toBe(3_630_000);
    expect(knowledgeBudgetLeaseDurationMs(3_600_001)).toBeNull();
  });

  it("locks the run scope, derives durable ordinals, and reuses the same tool call idempotently", async () => {
    const harness = repositoryHarness();
    const input = {
      estimate,
      idempotencyKey: "run:one:operation:one",
      modelRunToolCallId: CALL_ID,
      operationRequest: requestInput,
      originalQuerySha256: "a".repeat(64),
      runId: RUN_ID,
      userId: "owner-one"
    } as const;

    const admitted = await harness.repository.reserve(input);
    const replay = await harness.repository.reserve(input);

    expect(admitted.kind).toBe("admitted");
    expect(replay.kind).toBe("idempotent");
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(harness.rows).toHaveLength(1);
    expect(harness.rows[0]).toMatchObject({
      operationOrdinal: 1,
      phaseOrdinal: 2,
      subqueryOrdinal: 3
    });
    if (admitted.kind === "admitted") {
      expect(admitted.record.operationRequest).toMatchObject({
        originalQuery: { reference: MESSAGE_ID, sha256: "a".repeat(64) },
        phaseOrdinal: 2,
        profileRevisionNumber: 3,
        reservationId: RESERVATION_ID,
        subqueryOrdinal: 3
      });
      expect(admitted.record.leaseToken).toBe(LEASE_TOKEN);
    }
    expect(harness.lockQueries.some((query) =>
      sqlText(query).includes("FOR UPDATE OF scope"))).toBe(true);

    await expect(harness.repository.reserve({
      ...input,
      operationRequest: {
        ...requestInput,
        discovery: { ...requestInput.discovery, query: "Different query" },
        plan: { ...requestInput.plan, rewrittenQuery: "Different query" }
      }
    })).resolves.toMatchObject({ kind: "conflict", reason: "idempotency_conflict" });
  });

  it.each([
    {
      name: "structured analysis",
      operation: "structured_analysis",
      operationRequest: {
        operation: "structured_analysis",
        plan: {
          allowedLanes: [],
          coverage: { expectedPassageCount: null, mode: "partial" },
          exactTerms: [],
          rewrittenQuery: "Sum Revenue",
          strategy: "structured_data",
          targetNames: ["Sales workbook"],
          targetSourceIds: [SOURCE_ID]
        },
        plannerVersion: 2,
        profileRevisionId: PROFILE_ID,
        purpose: "answer",
        resolvedSourceIds: [SOURCE_ID],
        sourceAliases: ["S1"],
        structured: {
          query: "Sum Revenue",
          selector: {
            columns: ["Revenue"],
            includeHidden: false,
            operation: "aggregate",
            range: null,
            sheet: null
          },
          targetSourceIds: [SOURCE_ID]
        }
      } satisfies KnowledgeBudgetOperationRequestInput
    },
    {
      name: "visual analysis",
      operation: "visual_analysis",
      operationRequest: {
        operation: "visual_analysis",
        plan: {
          allowedLanes: [],
          coverage: { expectedPassageCount: null, mode: "partial" },
          exactTerms: [],
          rewrittenQuery: "Inspect the chart",
          strategy: "focused",
          targetNames: ["Quarterly report"],
          targetSourceIds: [SOURCE_ID]
        },
        plannerVersion: 2,
        profileRevisionId: PROFILE_ID,
        purpose: "answer",
        resolvedSourceIds: [SOURCE_ID],
        sourceAliases: ["S1"],
        visual: {
          query: "Inspect the chart",
          selector: null,
          targetSourceIds: [SOURCE_ID]
        }
      } satisfies KnowledgeBudgetOperationRequestInput
    }
  ])("maps $name to the internal Knowledge tool and automatic accounting", async ({
    operation,
    operationRequest
  }) => {
    const harness = repositoryHarness({
      sources: [{ baseProvenance: [], sourceAlias: "S1", sourceId: SOURCE_ID }],
      toolName: KNOWLEDGE_TOOL_NAME
    });

    await expect(harness.repository.reserve({
      estimate,
      idempotencyKey: "run:one:operation:one",
      modelRunToolCallId: CALL_ID,
      operationRequest,
      originalQuerySha256: "a".repeat(64),
      runId: RUN_ID,
      userId: "owner-one"
    })).resolves.toMatchObject({
      kind: "admitted",
      record: {
        operationRequest: { operation },
        reservation: { followUp: false }
      }
    });
  });

  it("expires stale pre-dispatch work and makes stale dispatched work ambiguous", async () => {
    const input = {
      estimate,
      idempotencyKey: "run:one:operation:one",
      modelRunToolCallId: CALL_ID,
      operationRequest: requestInput,
      originalQuerySha256: "a".repeat(64),
      runId: RUN_ID,
      userId: "owner-one"
    } as const;
    const reservedHarness = repositoryHarness();
    reservedHarness.rows.push(persistenceRow({ leaseExpiresAt: new Date(NOW) }));
    await expect(reservedHarness.repository.reserve(input)).resolves.toMatchObject({
      kind: "idempotent",
      record: { reservation: { reason: "lease_expired", state: "expired" } }
    });

    const dispatchedHarness = repositoryHarness();
    dispatchedHarness.rows.push(persistenceRow({
      createdAt: new Date("2026-08-19T11:00:00.000Z"),
      dispatchAttemptKey: "provider:attempt:one",
      dispatchedAt: new Date("2026-08-19T11:30:00.000Z"),
      leaseExpiresAt: new Date("2026-08-19T11:59:00.000Z"),
      state: "dispatched"
    }));
    await expect(dispatchedHarness.repository.reserve(input)).resolves.toMatchObject({
      kind: "idempotent",
      record: {
        reservation: { reason: "lease_expired_after_dispatch", state: "ambiguous" }
      }
    });
  });

  it("fences dispatch ownership and settles actual usage exactly once", async () => {
    const harness = repositoryHarness();
    const admitted = await harness.repository.reserve({
      estimate,
      idempotencyKey: "run:one:operation:one",
      modelRunToolCallId: CALL_ID,
      operationRequest: requestInput,
      originalQuerySha256: "a".repeat(64),
      runId: RUN_ID,
      userId: "owner-one"
    });
    if (admitted.kind !== "admitted") throw new Error("reservation_fixture_invalid");

    await expect(harness.repository.claimDispatch({
      dispatchAttemptKey: "provider:attempt:one",
      leaseToken: "99999999-9999-4999-8999-999999999999",
      reservationId: RESERVATION_ID,
      runId: RUN_ID,
      userId: "owner-one"
    })).resolves.toMatchObject({ kind: "conflict", reason: "lease_fenced" });

    await expect(harness.repository.claimDispatch({
      dispatchAttemptKey: "provider:attempt:one",
      leaseToken: LEASE_TOKEN,
      reservationId: RESERVATION_ID,
      runId: RUN_ID,
      userId: "owner-one"
    })).resolves.toMatchObject({ kind: "transitioned" });

    const settlement = {
      actual: {
        candidateCount: 3,
        costMicros: 7,
        latencyMs: 40,
        queryEmbeddingCalls: 0,
        repairCalls: 0,
        rerankerCalls: 0,
        retrievedTokens: 90,
        validationCalls: 0
      },
      leaseToken: LEASE_TOKEN,
      receiptHash: "c".repeat(64),
      reservationId: RESERVATION_ID,
      runId: RUN_ID,
      userId: "owner-one"
    } as const;
    await expect(harness.repository.settle(settlement))
      .resolves.toMatchObject({ kind: "transitioned", record: { reservation: { state: "settled" } } });
    await expect(harness.repository.settle(settlement))
      .resolves.toMatchObject({ kind: "idempotent", record: { reservation: { state: "settled" } } });
    expect(harness.rows[0]).toMatchObject({
      actualCandidates: 3,
      actualRetrievedTokens: 90,
      leaseToken: null,
      receiptHash: "c".repeat(64),
      state: "settled"
    });
  });

  it("keeps a valid operation lease beyond 30 seconds and expires it at the accepted boundary", async () => {
    let clock = new Date(NOW);
    const budgetPolicy = Object.freeze({
      ...DEFAULT_KNOWLEDGE_BUDGET_POLICY,
      maxLatencyMs: 60_000
    });
    const harness = repositoryHarness({
      budgetPolicy,
      now: () => new Date(clock)
    });
    const admitted = await harness.repository.reserve({
      estimate,
      idempotencyKey: "run:one:operation:one",
      modelRunToolCallId: CALL_ID,
      operationRequest: requestInput,
      originalQuerySha256: "a".repeat(64),
      runId: RUN_ID,
      userId: "owner-one"
    });
    if (admitted.kind !== "admitted") throw new Error("reservation_fixture_invalid");
    expect(admitted.record.reservation).toMatchObject({
      leaseExpiresAt: "2026-08-19T12:01:30.000Z",
      state: "reserved"
    });

    await expect(harness.repository.claimDispatch({
      dispatchAttemptKey: "provider:attempt:one",
      leaseToken: LEASE_TOKEN,
      reservationId: RESERVATION_ID,
      runId: RUN_ID,
      userId: "owner-one"
    })).resolves.toMatchObject({
      kind: "transitioned",
      record: {
        reservation: {
          leaseExpiresAt: "2026-08-19T12:01:30.000Z",
          state: "dispatched"
        }
      }
    });

    clock = new Date("2026-08-19T12:00:45.000Z");
    await expect(harness.repository.settle({
      actual: { ...estimate, latencyMs: 45_000 },
      leaseToken: LEASE_TOKEN,
      receiptHash: "d".repeat(64),
      reservationId: RESERVATION_ID,
      runId: RUN_ID,
      userId: "owner-one"
    })).resolves.toMatchObject({
      kind: "transitioned",
      record: { reservation: { actual: { latencyMs: 45_000 }, state: "settled" } }
    });

    let expiryClock = new Date(NOW);
    const expiredHarness = repositoryHarness({
      budgetPolicy,
      now: () => new Date(expiryClock)
    });
    const expiring = await expiredHarness.repository.reserve({
      estimate,
      idempotencyKey: "run:one:operation:one",
      modelRunToolCallId: CALL_ID,
      operationRequest: requestInput,
      originalQuerySha256: "a".repeat(64),
      runId: RUN_ID,
      userId: "owner-one"
    });
    if (expiring.kind !== "admitted") throw new Error("reservation_fixture_invalid");
    await expiredHarness.repository.claimDispatch({
      dispatchAttemptKey: "provider:attempt:one",
      leaseToken: LEASE_TOKEN,
      reservationId: RESERVATION_ID,
      runId: RUN_ID,
      userId: "owner-one"
    });
    expiryClock = new Date("2026-08-19T12:01:30.001Z");
    await expect(expiredHarness.repository.settle({
      actual: { ...estimate, latencyMs: 60_000 },
      leaseToken: LEASE_TOKEN,
      receiptHash: "e".repeat(64),
      reservationId: RESERVATION_ID,
      runId: RUN_ID,
      userId: "owner-one"
    })).resolves.toMatchObject({
      kind: "conflict",
      record: {
        reservation: { reason: "lease_expired_after_dispatch", state: "ambiguous" }
      }
    });
  });

  it("releases only reserved capacity and records explicit post-dispatch ambiguity", async () => {
    const reserve = async (harness: ReturnType<typeof repositoryHarness>) => {
      const result = await harness.repository.reserve({
        estimate,
        idempotencyKey: "run:one:operation:one",
        modelRunToolCallId: CALL_ID,
        operationRequest: requestInput,
        originalQuerySha256: "a".repeat(64),
        runId: RUN_ID,
        userId: "owner-one"
      });
      if (result.kind !== "admitted") throw new Error("reservation_fixture_invalid");
      return result;
    };
    const releasedHarness = repositoryHarness();
    await reserve(releasedHarness);
    const releaseInput = {
      leaseToken: LEASE_TOKEN,
      reason: "cancelled",
      reservationId: RESERVATION_ID,
      runId: RUN_ID,
      userId: "owner-one"
    } as const;
    await expect(releasedHarness.repository.release(releaseInput))
      .resolves.toMatchObject({ kind: "transitioned", record: { reservation: { state: "released" } } });
    await expect(releasedHarness.repository.release(releaseInput))
      .resolves.toMatchObject({ kind: "idempotent" });

    const ambiguousHarness = repositoryHarness();
    await reserve(ambiguousHarness);
    await ambiguousHarness.repository.claimDispatch({
      dispatchAttemptKey: "provider:attempt:one",
      leaseToken: LEASE_TOKEN,
      reservationId: RESERVATION_ID,
      runId: RUN_ID,
      userId: "owner-one"
    });
    await expect(ambiguousHarness.repository.markAmbiguous({
      leaseToken: LEASE_TOKEN,
      reason: "response_unknown",
      reservationId: RESERVATION_ID,
      runId: RUN_ID,
      userId: "owner-one"
    })).resolves.toMatchObject({
      kind: "transitioned",
      record: { reservation: { reason: "response_unknown", state: "ambiguous" } }
    });
  });
});

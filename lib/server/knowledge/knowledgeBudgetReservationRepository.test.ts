import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";
import { createKnowledgeFocusedRequest } from "./focusedRequest";
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

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const CALL_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const PROFILE_ID = "44444444-4444-4444-8444-444444444444";
const RESERVATION_ID = "55555555-5555-4555-8555-555555555555";
const LEASE_TOKEN = "66666666-6666-4666-8666-666666666666";
const SOURCE_ID = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const LEASE = new Date("2026-08-19T12:05:00.000Z");
const focused = createKnowledgeFocusedRequest({ currentUserMessage: "Find policy sources" })!;
const embeddingExecutionSnapshot = {
  connection: {
    allowPrivateNetwork: false,
    apiRoot: "https://embedding.example.test/v1",
    authenticationMode: "bearer" as const,
    responseTimeoutMs: 30_000
  },
  connectionDisplayName: "Embedding",
  connectionId: "embedding-connection-1",
  credentialId: "embedding-credential-1",
  credentialVersionId: "embedding-credential-version-1",
  model: {
    adapterKind: "openai_embeddings_compatible" as const,
    answerSelectable: false,
    capabilities: {
      contextWindow: 8_192,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      toolCalling: false,
      vision: false
    },
    defaultParams: {},
    embedding: {
      nativeDimension: 1_024,
      providerFamily: "openai_compatible" as const,
      queryInstructionTemplate: null,
      supportsMrl: false,
      targetDimension: 1_024
    },
    modelClass: "embedding" as const,
    upstreamModelId: "embedding-upstream"
  },
  modelDisplayName: "Embedding model",
  providerFamily: "openai_compatible" as const,
  providerModelId: "embedding-model-1",
  version: 1 as const
};

function operationRequest(overrides: Record<string, unknown> = {}) {
  return createKnowledgeOperationRequestV2({
    focused,
    idempotencyKey: "run:one:operation:one",
    operation: "automatic_search",
    originalQuery: { reference: MESSAGE_ID, sha256: "a".repeat(64) },
    phaseOrdinal: 0,
    profileRevisionId: PROFILE_ID,
    profileRevisionNumber: 3,
    reservationId: RESERVATION_ID,
    resolvedSourceIds: [SOURCE_ID],
    sourceAliases: [],
    subqueryOrdinal: 0,
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
    actualRetrievedTokens: null,
    ambiguousAt: null,
    createdAt: NOW,
    dispatchAttemptKey: null,
    dispatchedAt: null,
    estimatedCandidates: 8,
    estimatedCostMicros: 12,
    estimatedEmbeddingCalls: 1,
    estimatedLatencyMs: 100,
    estimatedRetrievedTokens: 200,
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
  focused,
  operation: "automatic_search",
  profileRevisionId: PROFILE_ID,
  resolvedSourceIds: [SOURCE_ID],
  sourceAliases: []
};

const estimate: KnowledgeBudgetResourceEstimate = Object.freeze({
  candidateCount: 8,
  costMicros: 12,
  latencyMs: 100,
  queryEmbeddingCalls: 1,
  retrievedTokens: 200
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
      estimatedRetrievedTokens: data.estimatedRetrievedTokens as number,
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
  const profileFindMany = vi.fn(async () => [{
    embeddingExecutionSnapshot,
    id: "77777777-7777-4777-8777-777777777777",
    profileRevision: { revisionNumber: 3 },
    profileRevisionId: PROFILE_ID,
    vectorSpaceFingerprint: "f".repeat(64)
  }, {
    embeddingExecutionSnapshot,
    id: "88888888-8888-4888-8888-888888888889",
    profileRevision: { revisionNumber: 4 },
    profileRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
    vectorSpaceFingerprint: "f".repeat(64)
  }]);
  const sourceFindMany = vi.fn(async () => options.sources ?? [
    {
      baseProvenance: null,
      sourceAlias: "S1",
      sourceId: SOURCE_ID
    },
    {
      baseProvenance: null,
      sourceAlias: "S2",
      sourceId: SOURCE_ID
    }
  ]);
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      lockQueries.push(query);
      return sqlText(query).includes('call."roundIndex"')
        ? [{
            budgetPolicy: options.budgetPolicy ?? DEFAULT_KNOWLEDGE_BUDGET_POLICY,
            roundIndex: 0,
            toolCallOrdinal: 0,
            toolCallState: "running",
            toolName: options.toolName ?? "knowledge_focused_v1",
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
      findMany: profileFindMany
    },
    knowledgeRunSourceBinding: {
      findMany: sourceFindMany
    }
  } as unknown as Prisma.TransactionClient;
  const client = {
    $transaction: vi.fn(async (consume: (value: Prisma.TransactionClient) => Promise<unknown>) =>
      consume(tx))
  } as unknown as PrismaClient;
  const repository = createPrismaKnowledgeBudgetReservationRepository(client, {
    now: options.now ?? (() => new Date(NOW)),
    uuid: () => uuidValues.shift() ?? "88888888-8888-4888-8888-888888888888"
  });
  return { create, lockQueries, profileFindMany, repository, rows, sourceFindMany };
}

describe("Knowledge budget reservation Prisma repository", () => {
  it("maps each nullable persistence state into the strict domain state", () => {
    expect(decodeKnowledgeBudgetReservationPersistenceRow(persistenceRow()).reservation)
      .toMatchObject({ state: "reserved", phaseOrdinal: 0, subqueryOrdinal: 0 });

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
      actualRetrievedTokens: null,
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
      actualRetrievedTokens: 90,
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
    expect(decodeKnowledgeBudgetReservationPersistenceRow({
      ...purged,
      operation: "structured_analysis"
    }).reservation.state).toBe("settled");
  });

  it("counts purged settled usage but fences every further mutation", async () => {
    const harness = repositoryHarness();
    harness.rows.push(persistenceRow({
      actualCandidates: 5,
      actualCostMicros: 9,
      actualEmbeddingCalls: 0,
      actualLatencyMs: 80,
      actualRetrievedTokens: 90,
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
    const rejected = await harness.repository.reserve({
      estimate,
      idempotencyKey: "run:one:operation:one",
      modelRunToolCallId: CALL_ID,
      operationRequest: requestInput,
      originalQuerySha256: "a".repeat(64),
      runId: RUN_ID,
      userId: "owner-one"
    });
    expect(rejected).toMatchObject({
      chargeBefore: { candidateCount: 5, retrievedTokens: 90 },
      kind: "rejected",
      reason: "operation_budget"
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

  it("maps only the focused reservation limits", () => {
    expect(knowledgeBudgetReservationPolicyFromRunScope(DEFAULT_KNOWLEDGE_BUDGET_POLICY))
      .toMatchObject({
        maxOperations: DEFAULT_KNOWLEDGE_BUDGET_POLICY.maxOperations,
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
      phaseOrdinal: 0,
      subqueryOrdinal: 0
    });
    if (admitted.kind === "admitted") {
      expect(admitted.record.operationRequest).toMatchObject({
        originalQuery: { reference: MESSAGE_ID, sha256: "a".repeat(64) },
        phaseOrdinal: 0,
        profileRevisionNumber: 3,
        reservationId: RESERVATION_ID,
        subqueryOrdinal: 0
      });
      expect(admitted.record.leaseToken).toBe(LEASE_TOKEN);
    }
    expect(harness.lockQueries.some((query) =>
      sqlText(query).includes("FOR UPDATE OF scope"))).toBe(true);
    expect(harness.sourceFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        profileBindingId: {
          in: [
            "77777777-7777-4777-8777-777777777777",
            "88888888-8888-4888-8888-888888888889"
          ]
        }
      })
    }));

    await expect(harness.repository.reserve({
      ...input,
      operationRequest: {
        ...requestInput,
        focused: createKnowledgeFocusedRequest({ currentUserMessage: "Different query" })!
      }
    })).resolves.toMatchObject({ kind: "conflict", reason: "idempotency_conflict" });
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
        retrievedTokens: 90
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

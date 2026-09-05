import type { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { NOOP_MEMORY_SOURCE_MUTATION_HOOKS } from "../memory/sourceState";
import type { NormalizedRunRequest } from "../providers/types";
import { PERSONAL_CONTEXT_HEADING } from "../providers/personalContext";
import { createKnowledgeFocusedRequest } from "../knowledge/focusedRequest";
import { appendRunOutputEvents, createPrismaRunToolLoopOperations } from "./prismaRepositoryToolLoop";
import type { RunOutputArtifactEvent } from "./runOutputEvents";

describe("Workspace activity publication", () => {
  it("deduplicates grounded output and Workspace replays within one ordered output stream", async () => {
    const rows: { eventType: string; payload: RunOutputArtifactEvent["data"]; sequence: number }[] = [];
    const tx = {
      modelRunEvent: {
        aggregate: async () => ({ _max: { sequence: rows.at(-1)?.sequence ?? null } }),
        createMany: async ({ data }: { data: typeof rows }) => { rows.push(...data); },
        findFirst: async ({ where }: { where: { eventType: string; payload?: { equals: string } } }) =>
          where.eventType === "grounding_display"
            ? [...rows].reverse().find((row) => row.eventType === "grounding_display") ?? null
            : rows.find((row) => "artifactType" in row.payload &&
              row.payload.artifactType === "workspace_activity" &&
              row.payload.payload.updateId === where.payload?.equals) ?? null
      }
    } as unknown as Prisma.TransactionClient;
    const display: RunOutputArtifactEvent = { type: "grounding_display", data: {
      provider: "gemini", suggestionsHtml: '<a href="https://www.google.com/search?q=weather">Weather</a>',
      citations: [{ startIndex: 0, endIndex: 8, title: "Source", url: "https://example.test/source" }]
    } };
    const activity: RunOutputArtifactEvent = { type: "artifact", data: {
      artifactType: "workspace_activity",
      payload: { id: "command", updateId: "started", kind: "command", phase: "running", command: { preview: "command" } }
    } };
    const first = await appendRunOutputEvents(tx, "run", [display, activity, display]);
    const replay = await appendRunOutputEvents(tx, "run", [activity, display]);
    expect(rows.map(({ eventType, sequence }) => ({ eventType, sequence }))).toEqual([
      { eventType: "grounding_display", sequence: 0 }, { eventType: "artifact", sequence: 1 }
    ]);
    expect(first).toMatchObject([display, { data: { payload: { sequence: 1 } } }, display]);
    expect(replay).toEqual([first[1], display]);
  });

  it.each(["complete", "error", "cancelled"] as const)("keeps provider output fenced after %s while allowing Workspace settlement", async (status) => {
    const createMany = vi.fn();
    const tx = {
      $queryRaw: async () => [{ id: "run", status, errorPayload: { recoveryTerminal: true } }],
      modelRun: { update: vi.fn() },
      modelRunEvent: { aggregate: async () => ({ _max: { sequence: 3 } }), createMany }
    };
    const operations = createPrismaRunToolLoopOperations({
      $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)
    } as unknown as PrismaClient, NOOP_MEMORY_SOURCE_MUTATION_HOOKS);
    await operations.appendRunOutputEvent("run", {
      type: "artifact", data: { artifactType: "reasoning", payload: { text: "Late provider output" } }
    });
    expect(createMany).not.toHaveBeenCalled();
    const published = await operations.appendRunOutputEvent("run", {
      type: "artifact", data: { artifactType: "workspace_activity", payload: {
        id: "stopped", kind: "workspace_stopped", phase: "succeeded"
      } }
    });
    expect(published).toMatchObject({ data: { payload: { sequence: 4 } } });
    expect(createMany).toHaveBeenCalledOnce();
  });

  it("reuses the first durable sequence and payload when a settled tool artifact is replayed", async () => {
    const rows: { payload: RunOutputArtifactEvent["data"]; sequence: number }[] = [];
    const tx = {
      modelRunEvent: {
        aggregate: async () => ({ _max: { sequence: rows.at(-1)?.sequence ?? null } }),
        createMany: async ({ data }: { data: typeof rows }) => { rows.push(...data); },
        findFirst: async ({ where }: { where: { payload: { equals: string; path: string[] } } }) =>
          rows.find((row) => "artifactType" in row.payload && row.payload.artifactType === "workspace_activity" && row.payload.payload.updateId === where.payload.equals) ?? null
      }
    } as unknown as Prisma.TransactionClient;
    const event = (updateId: string, phase: "running" | "succeeded"): RunOutputArtifactEvent => ({
      data: { artifactType: "workspace_activity", payload: { command: { preview: "command" }, id: "command", kind: "command", phase, updateId } },
      type: "artifact"
    });
    const first = await appendRunOutputEvents(tx, "run", [event("start", "running")]);
    const last = await appendRunOutputEvents(tx, "run", [event("poll", "succeeded"), event("poll", "succeeded")]);
    const replay = await appendRunOutputEvents(tx, "run", [event("start", "running")]);
    expect(first).toMatchObject([{ data: { payload: { sequence: 0 } } }]);
    expect(last).toMatchObject([{ data: { payload: { sequence: 1 } } }, { data: { payload: { sequence: 1 } } }]);
    expect(replay).toEqual(first);
    expect(rows).toHaveLength(2);
  });
});

type ToolCallRow = {
  completedAt: Date | null;
  id: string;
  state: "cancelled" | "pending";
};

type ReservationRow = {
  ambiguousAt: Date | null;
  dispatchAttemptKey: string | null;
  failureCode: string | null;
  leaseExpiresAt: Date | null;
  leaseToken: string | null;
  modelRunId: string;
  modelRunToolCallId: string;
  purgedAt: Date | null;
  releasedAt: Date | null;
  state: "ambiguous" | "dispatched" | "expired" | "released" | "reserved" | "settled";
};

type BudgetUpdate = {
  data: Partial<ReservationRow>;
  where: {
    modelRunId: string;
    modelRunToolCallId: { in: string[] };
    purgedAt: null | { not: null };
    state: ReservationRow["state"];
  };
};

type ToolCallUpdate = {
  data: Partial<ToolCallRow>;
  where: {
    id: { in: string[] };
    modelRunId: string;
    state: ToolCallRow["state"];
  };
};

const focusedEmbeddingSnapshot = {
  connection: {
    allowPrivateNetwork: true,
    apiRoot: "http://127.0.0.1",
    authenticationMode: "none",
    responseTimeoutMs: 300_000
  },
  connectionDisplayName: "Fake",
  connectionId: "embedding-connection",
  credentialId: null,
  credentialVersionId: null,
  model: {
    adapterKind: "fake",
    capabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      vision: false
    },
    defaultParams: {},
    upstreamModelId: "embedding-model"
  },
  modelDisplayName: "Embedding model",
  providerFamily: "fake",
  providerModelId: "embedding-model",
  version: 1
} as const;

function cancellationHarness(options: Readonly<{
  failToolCallUpdate?: boolean;
  ownerFound?: boolean;
}> = {}) {
  const runId = "run-one";
  const pendingIds = [
    "reserved-call",
    "dispatched-call",
    "purged-reserved-call",
    "purged-dispatched-call",
    "settled-call",
    "released-call",
    "ambiguous-call",
    "expired-call"
  ];
  const calls: ToolCallRow[] = [
    ...pendingIds.map((id) => ({ completedAt: null, id, state: "pending" as const })),
    { completedAt: new Date("2026-08-19T11:59:00.000Z"), id: "old-call", state: "cancelled" }
  ];
  const leaseExpiresAt = new Date("2026-08-19T12:10:00.000Z");
  const reservations: ReservationRow[] = [
    {
      ambiguousAt: null,
      dispatchAttemptKey: null,
      failureCode: null,
      leaseExpiresAt,
      leaseToken: "lease:reserved:one",
      modelRunId: runId,
      modelRunToolCallId: "reserved-call",
      purgedAt: null,
      releasedAt: null,
      state: "reserved"
    },
    {
      ambiguousAt: null,
      dispatchAttemptKey: "dispatch:attempt:one",
      failureCode: null,
      leaseExpiresAt,
      leaseToken: "lease:dispatched:one",
      modelRunId: runId,
      modelRunToolCallId: "dispatched-call",
      purgedAt: null,
      releasedAt: null,
      state: "dispatched"
    },
    ...(["reserved", "dispatched"] as const).map((state) => ({
      ambiguousAt: null,
      dispatchAttemptKey: null,
      failureCode: null,
      leaseExpiresAt: null,
      leaseToken: null,
      modelRunId: runId,
      modelRunToolCallId: `purged-${state}-call`,
      purgedAt: new Date("2026-08-19T11:56:00.000Z"),
      releasedAt: null,
      state
    })),
    ...(["settled", "released", "ambiguous", "expired"] as const).map((state) => ({
      ambiguousAt: state === "ambiguous" ? new Date("2026-08-19T11:58:00.000Z") : null,
      dispatchAttemptKey: state === "settled" || state === "ambiguous"
        ? `dispatch:${state}:one`
        : null,
      failureCode: state === "settled" ? null : `${state}_reason`,
      leaseExpiresAt: null,
      leaseToken: null,
      modelRunId: runId,
      modelRunToolCallId: `${state}-call`,
      purgedAt: null,
      releasedAt: state === "released" ? new Date("2026-08-19T11:57:00.000Z") : null,
      state
    })),
    {
      ambiguousAt: null,
      dispatchAttemptKey: null,
      failureCode: null,
      leaseExpiresAt,
      leaseToken: "lease:old:one",
      modelRunId: runId,
      modelRunToolCallId: "old-call",
      purgedAt: null,
      releasedAt: null,
      state: "reserved"
    }
  ];
  let queryOrdinal = 0;
  const transaction = vi.fn(async (consume: (tx: unknown) => Promise<number>) => {
    const callSnapshot = calls.map((row) => ({ ...row }));
    const reservationSnapshot = reservations.map((row) => ({ ...row }));
    try {
      return await consume(tx);
    } catch (error) {
      calls.splice(0, calls.length, ...callSnapshot);
      reservations.splice(0, reservations.length, ...reservationSnapshot);
      throw error;
    }
  });
  const tx = {
    $queryRaw: vi.fn(async () => {
      queryOrdinal += 1;
      if (queryOrdinal % 2 === 1) {
        return options.ownerFound === false
          ? []
          : [{
              assistantMessageId: null,
              errorPayload: null,
              providerResponseId: null,
              status: "in_progress",
              toolLoopState: null
            }];
      }
      return calls.filter((call) => call.state === "pending").map(({ id }) => ({ id }));
    }),
    knowledgeBudgetReservation: {
      updateMany: vi.fn(async (input: BudgetUpdate) => {
        const ids = new Set(input.where.modelRunToolCallId.in);
        const matching = reservations.filter((row) =>
          row.modelRunId === input.where.modelRunId &&
          ids.has(row.modelRunToolCallId) &&
          (input.where.purgedAt === null ? row.purgedAt === null : row.purgedAt !== null) &&
          row.state === input.where.state);
        matching.forEach((row) => Object.assign(row, input.data));
        return { count: matching.length };
      })
    },
    modelRunToolCall: {
      updateMany: vi.fn(async (input: ToolCallUpdate) => {
        if (options.failToolCallUpdate) throw new Error("tool_call_write_failed");
        const ids = new Set(input.where.id.in);
        const matching = calls.filter((row) => ids.has(row.id) && row.state === input.where.state);
        matching.forEach((row) => Object.assign(row, input.data));
        return { count: matching.length };
      })
    }
  };
  const client = { $transaction: transaction } as unknown as PrismaClient;
  return {
    calls,
    operations: createPrismaRunToolLoopOperations(
      client,
      NOOP_MEMORY_SOURCE_MUTATION_HOOKS
    ),
    reservations,
    runId,
    transaction,
    tx
  };
}

describe("Prisma run tool-loop cancellation", () => {
  it("releases reserved Knowledge capacity and fences dispatched work as ambiguous", async () => {
    const harness = cancellationHarness();
    const terminalBefore = harness.reservations.slice(4, 8).map((row) => ({ ...row }));

    await expect(harness.operations.cancelPendingToolLoopCalls({
      runId: harness.runId,
      userId: "owner-one"
    })).resolves.toBe(8);

    expect(harness.reservations[0]).toMatchObject({
      failureCode: "operation_cancelled",
      leaseExpiresAt: null,
      leaseToken: null,
      releasedAt: expect.any(Date),
      state: "released"
    });
    expect(harness.reservations[1]).toMatchObject({
      ambiguousAt: expect.any(Date),
      dispatchAttemptKey: "dispatch:attempt:one",
      failureCode: "operation_cancelled_after_dispatch",
      leaseExpiresAt: null,
      leaseToken: null,
      state: "ambiguous"
    });
    expect(harness.reservations[2]).toMatchObject({
      failureCode: null,
      purgedAt: expect.any(Date),
      releasedAt: expect.any(Date),
      state: "released"
    });
    expect(harness.reservations[3]).toMatchObject({
      ambiguousAt: expect.any(Date),
      failureCode: null,
      purgedAt: expect.any(Date),
      state: "ambiguous"
    });
    expect(harness.reservations.slice(4, 8)).toEqual(terminalBefore);
    expect(harness.reservations[8]).toMatchObject({
      leaseToken: "lease:old:one",
      state: "reserved"
    });
    expect(harness.calls.slice(0, 8)).toEqual(pendingCallsWithOneTimestamp(harness.calls, 8));
    expect(harness.calls[8]).toMatchObject({ state: "cancelled" });

    const budgetWrites = harness.tx.knowledgeBudgetReservation.updateMany.mock.calls.length;
    const callWrites = harness.tx.modelRunToolCall.updateMany.mock.calls.length;
    await expect(harness.operations.cancelPendingToolLoopCalls({
      runId: harness.runId,
      userId: "owner-one"
    })).resolves.toBe(0);
    expect(harness.tx.knowledgeBudgetReservation.updateMany).toHaveBeenCalledTimes(budgetWrites);
    expect(harness.tx.modelRunToolCall.updateMany).toHaveBeenCalledTimes(callWrites);
  });

  it("rolls budget transitions back when call cancellation cannot commit", async () => {
    const harness = cancellationHarness({ failToolCallUpdate: true });
    const reservationsBefore = harness.reservations.map((row) => ({ ...row }));

    await expect(harness.operations.cancelPendingToolLoopCalls({
      runId: harness.runId,
      userId: "owner-one"
    })).rejects.toThrow("tool_call_write_failed");

    expect(harness.reservations).toEqual(reservationsBefore);
    expect(harness.calls.slice(0, 8).every((call) => call.state === "pending")).toBe(true);
    expect(harness.transaction).toHaveBeenCalledTimes(1);
  });

  it("does not mutate calls when the owning run is unavailable", async () => {
    const harness = cancellationHarness({ ownerFound: false });

    await expect(harness.operations.cancelPendingToolLoopCalls({
      runId: harness.runId,
      userId: "different-owner"
    })).resolves.toBe(0);

    expect(harness.tx.knowledgeBudgetReservation.updateMany).not.toHaveBeenCalled();
    expect(harness.tx.modelRunToolCall.updateMany).not.toHaveBeenCalled();
  });
});

describe("provider dispatch recovery request loading", () => {
  const normalizedRequest = {
    attachmentIds: [],
    chatId: "chat-one",
    content: { blocks: [{ text: "private question", type: "text" }] },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      vision: false
    },
    modelId: "model-one",
    params: {},
    prompt: { developer: null, system: null },
    provider: "provider-one",
    searchPlan: { mode: "all_selected", options: [] },
    toolMode: "none"
  } satisfies NormalizedRunRequest;

  it("selects only the accepted request and ownership fields", async () => {
    const findUnique = vi.fn(async () => ({
      chat: { projectId: null, userId: "owner-one" },
      chatId: "chat-one",
      modelId: "model-one",
      normalizedRequest,
      provider: "provider-one"
    }));
    const operations = createPrismaRunToolLoopOperations({
      modelRun: { findUnique }
    } as unknown as PrismaClient, NOOP_MEMORY_SOURCE_MUTATION_HOOKS);

    await expect(operations.loadProviderDispatchRecoveryRequest!({
      runId: "run-one",
      userId: "owner-one"
    })).resolves.toEqual(normalizedRequest);
    expect(findUnique).toHaveBeenCalledWith({
      select: {
        chat: { select: { projectId: true, userId: true } },
        chatId: true,
        modelId: true,
        normalizedRequest: true,
        provider: true
      },
      where: { id: "run-one" }
    });
  });

  it("recovers historical chronological and current rank-interleaved evidence policies", async () => {
    for (const [packingVersion, accepted] of [
      [undefined, true],
      [2, true],
      [1, false],
      [3, false]
    ] as const) {
      const request = {
        ...normalizedRequest,
        ...(packingVersion === undefined ? {} : {
          knowledgeEvidencePackingVersion: packingVersion
        })
      };
      const operations = createPrismaRunToolLoopOperations({
        modelRun: {
          findUnique: vi.fn(async () => ({
            chat: { projectId: null, userId: "owner-one" },
            chatId: "chat-one",
            modelId: "model-one",
            normalizedRequest: request,
            provider: "provider-one"
          }))
        }
      } as unknown as PrismaClient, NOOP_MEMORY_SOURCE_MUTATION_HOOKS);
      const loaded = operations.loadProviderDispatchRecoveryRequest!({
        runId: "run-one",
        userId: "owner-one"
      });

      if (accepted) await expect(loaded).resolves.toEqual(request);
      else await expect(loaded).rejects.toThrow(
        "provider_dispatch_recovery_request_invalid_in_storage"
      );
    }
  });

  it("round-trips a frozen full-context request with its exact evidence envelope", async () => {
    const evidenceBlock = JSON.stringify({
      citation: "[K1]",
      exactExcerpt: "The exact admitted Source passage.",
      handle: "K1",
      schemaVersion: 1,
      type: "source_evidence"
    });
    const fullContextRequest: NormalizedRunRequest = {
      ...normalizedRequest,
      context: {
        messages: [{
          content: {
            blocks: [{
              text: [
                '<private_knowledge_evidence version="4" coverage="full_admitted_corpus">\nFrozen private evidence contract.',
                "The full admitted corpus is included with no passage omitted.",
                evidenceBlock,
                "</private_knowledge_evidence>"
              ].join("\n\n"),
              type: "text"
            }]
          },
          id: "knowledge-evidence:v2",
          purpose: "knowledge_evidence",
          role: "user"
        }],
        mode: "branch_path"
      },
      knowledgeAnswering: {
        answerPolicy: {
          fullContextThresholdBasisPoints: 7_000,
          maximumKnowledgeSearches: 12,
          revision: 1,
          version: 1
        },
        approximateDocumentTokens: 16,
        evidenceCount: 1,
        exactDocumentTokens: 8,
        route: "full_context_v1",
        version: 1
      },
      knowledgePlan: {
        baseIds: ["base-one"],
        mode: "explicit",
        sourceIds: [],
        version: 1
      },
      prompt: { ...normalizedRequest.prompt, knowledgeAnswerContract: 1 }
    };
    const operations = createPrismaRunToolLoopOperations({
      modelRun: {
        findUnique: vi.fn(async () => ({
          chat: { projectId: null, userId: "owner-one" },
          chatId: "chat-one",
          modelId: "model-one",
          normalizedRequest: fullContextRequest,
          provider: "provider-one"
        }))
      }
    } as unknown as PrismaClient, NOOP_MEMORY_SOURCE_MUTATION_HOOKS);

    await expect(operations.loadProviderDispatchRecoveryRequest!({
      runId: "run-one",
      userId: "owner-one"
    })).resolves.toEqual(fullContextRequest);
  });

  it("round-trips the exact frozen structured Personal Memory pack", async () => {
    const memoryText = [
      PERSONAL_CONTEXT_HEADING,
      '<aiqsa_memory_evidence version="2">',
      '{"aggregation_requested":false,"budget_profile":"past_chat"}',
      "EVIDENCE_ITEMS_JSONL",
      '{"document_time":"2026-08-27T00:00:00.000Z","evidence_handle":"M1","raw_safe_evidence":"frozen evidence","source_session_handle":"S1","status":"current"}',
      "</aiqsa_memory_evidence>"
    ].join("\n");
    const frozenRequest: NormalizedRunRequest = {
      ...normalizedRequest,
      personalContext: {
        approxTokens: 64,
        itemCount: 1,
        memoryGeneration: 7,
        memoryRevision: 11,
        mode: "prefetched",
        text: memoryText
      }
    };
    const operations = createPrismaRunToolLoopOperations({
      modelRun: {
        findUnique: vi.fn(async () => ({
          chat: { projectId: null, userId: "owner-one" },
          chatId: "chat-one",
          modelId: "model-one",
          normalizedRequest: frozenRequest,
          provider: "provider-one"
        }))
      }
    } as unknown as PrismaClient, NOOP_MEMORY_SOURCE_MUTATION_HOOKS);

    const loaded = await operations.loadProviderDispatchRecoveryRequest!({
      runId: "run-one",
      userId: "owner-one"
    });

    expect(loaded).toEqual(frozenRequest);
    expect(loaded?.personalContext?.text).toBe(memoryText);
  });

  it("rejects a full-context recovery request without its exact evidence envelope", async () => {
    const operations = createPrismaRunToolLoopOperations({
      modelRun: {
        findUnique: vi.fn(async () => ({
          chat: { projectId: null, userId: "owner-one" },
          chatId: "chat-one",
          modelId: "model-one",
          normalizedRequest: {
            ...normalizedRequest,
            knowledgeAnswering: {
              answerPolicy: {
                fullContextThresholdBasisPoints: 7_000,
                maximumKnowledgeSearches: 12,
                revision: 1,
                version: 1
              },
              approximateDocumentTokens: 16,
              evidenceCount: 1,
              exactDocumentTokens: 8,
              route: "full_context_v1",
              version: 1
            },
            prompt: { ...normalizedRequest.prompt, knowledgeAnswerContract: 1 }
          },
          provider: "provider-one"
        }))
      }
    } as unknown as PrismaClient, NOOP_MEMORY_SOURCE_MUTATION_HOOKS);

    await expect(operations.loadProviderDispatchRecoveryRequest!({
      runId: "run-one",
      userId: "owner-one"
    })).rejects.toThrow("provider_dispatch_recovery_request_invalid_in_storage");
  });

  it("round-trips only the server-minted focused Knowledge contract version", async () => {
    const focusedRequest = createKnowledgeFocusedRequest({ currentUserMessage: "Question" })!;
    for (const [contract, accepted] of [[1, true], [2, false]] as const) {
      const request = {
        ...normalizedRequest,
        knowledgeFocusedRequest: focusedRequest,
        knowledgePlan: {
          baseIds: ["base-one"],
          mode: "explicit" as const,
          sourceIds: [],
          version: 1 as const
        },
        prompt: { ...normalizedRequest.prompt, knowledgeAnswerContract: contract }
      };
      const operations = createPrismaRunToolLoopOperations({
        modelRun: {
          findUnique: vi.fn(async () => ({
            chat: { projectId: null, userId: "owner-one" },
            chatId: "chat-one",
            modelId: "model-one",
            normalizedRequest: request,
            provider: "provider-one"
          }))
        }
      } as unknown as PrismaClient, NOOP_MEMORY_SOURCE_MUTATION_HOOKS);
      const loaded = operations.loadProviderDispatchRecoveryRequest!({
        runId: "run-one",
        userId: "owner-one"
      });

      if (accepted) await expect(loaded).resolves.toEqual(request);
      else await expect(loaded).rejects.toThrow(
        "provider_dispatch_recovery_request_invalid_in_storage"
      );
    }
  });

  it("loads immutable focused exclusions from the accepted run scope", async () => {
    const exclusions = [{
      count: 2,
      reason: "not_ready",
      resourceType: "source"
    }] as const;
    const findFirst = vi.fn(async () => ({ knowledgeRunScope: { exclusions } }));
    const operations = createPrismaRunToolLoopOperations({
      modelRun: { findFirst }
    } as unknown as PrismaClient, NOOP_MEMORY_SOURCE_MUTATION_HOOKS);

    await expect(operations.loadFocusedKnowledgeScopeExclusions!({
      runId: "run-one",
      userId: "owner-one"
    })).resolves.toEqual(exclusions);
    expect(findFirst).toHaveBeenCalledWith({
      select: {
        knowledgeRunScope: { select: { exclusions: true } }
      },
      where: { id: "run-one", userId: "owner-one" }
    });
  });

  it("loads the exact immutable focused Source authorization snapshot", async () => {
    const findFirst = vi.fn(async () => ({
      knowledgeRunBindings: [{
        includeWholeBase: true,
        indexGenerationId: "generation-one",
        knowledgeBaseId: "base-one",
        ordinal: 0,
        selectedSourceIds: [],
        vectorSpaceFingerprint: "a".repeat(64)
      }],
      knowledgeRunProfileBindings: [{
        embeddingCredentialSource: "default",
        embeddingExecutionSnapshot: focusedEmbeddingSnapshot,
        embeddingProviderModelId: "embedding-model",
        ordinal: 0,
        profileRevisionId: "profile-revision-one",
        targetDimension: 1_024,
        vectorSpaceFingerprint: "a".repeat(64)
      }],
      knowledgeRunScope: {
        exclusions: [{ count: 1, reason: "not_ready", resourceType: "source" }],
        resolvedBaseCount: 1,
        resolvedSourceCount: 1,
        sourceBindingStrategy: "eager_v1",
        selection: { baseIds: ["base-one"], mode: "explicit", sourceIds: [], version: 1 }
      },
      knowledgeRunSourceBindings: [{
        accessProvenance: {
          authority: { knowledgeBaseIds: ["base-one"], owner: false, projectId: null },
          selectionProvenance: ["base"]
        },
        baseProvenance: [{
          indexGenerationId: "generation-one",
          knowledgeBaseId: "base-one"
        }],
        directSelected: false,
        ordinal: 0,
        profileBinding: { profileRevisionId: "profile-revision-one" },
        readinessState: "ready",
        sourceAlias: "S1",
        sourceArtifactId: "artifact-one",
        sourceId: "source-one",
        sourceVersionId: "source-version-one",
        tombstonedAt: null
      }]
    }));
    const operations = createPrismaRunToolLoopOperations({
      modelRun: { findFirst }
    } as unknown as PrismaClient, NOOP_MEMORY_SOURCE_MUTATION_HOOKS);

    await expect(operations.loadFocusedKnowledgeRecoveryScope!({
      runId: "run-one",
      userId: "owner-one"
    })).resolves.toMatchObject({
      bindings: [{
        indexGenerationId: "generation-one",
        knowledgeBaseId: "base-one"
      }],
      exclusions: [{ count: 1, reason: "not_ready", resourceType: "source" }],
      knowledgePlan: { baseIds: ["base-one"], mode: "explicit", sourceIds: [], version: 1 },
      profiles: [{ profileRevisionId: "profile-revision-one" }],
      sources: [{
        authority: { knowledgeBaseIds: ["base-one"], owner: false, projectId: null },
        baseProvenance: [{
          indexGenerationId: "generation-one",
          knowledgeBaseId: "base-one"
        }],
        sourceArtifactId: "artifact-one",
        sourceId: "source-one",
        sourceVersionId: "source-version-one"
      }]
    });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "run-one", userId: "owner-one" }
    }));
  });

  it("loads a large Base recovery scope before any Source alias is disclosed", async () => {
    const findFirst = vi.fn(async () => ({
      knowledgeRunBindings: [{
        includeWholeBase: true,
        indexGenerationId: "generation-one",
        knowledgeBaseId: "base-one",
        ordinal: 0,
        selectedSourceIds: [],
        vectorSpaceFingerprint: "a".repeat(64)
      }],
      knowledgeRunProfileBindings: [{
        embeddingCredentialSource: "default",
        embeddingExecutionSnapshot: focusedEmbeddingSnapshot,
        embeddingProviderModelId: "embedding-model",
        ordinal: 0,
        profileRevisionId: "profile-revision-one",
        targetDimension: 1_024,
        vectorSpaceFingerprint: "a".repeat(64)
      }],
      knowledgeRunScope: {
        exclusions: [],
        resolvedBaseCount: 1,
        resolvedSourceCount: 5_183,
        selection: { baseIds: ["base-one"], mode: "explicit", sourceIds: [], version: 1 },
        sourceBindingStrategy: "disclosed_v1"
      },
      knowledgeRunSourceBindings: []
    }));
    const operations = createPrismaRunToolLoopOperations({
      modelRun: { findFirst }
    } as unknown as PrismaClient, NOOP_MEMORY_SOURCE_MUTATION_HOOKS);

    await expect(operations.loadFocusedKnowledgeRecoveryScope!({
      runId: "run-one",
      userId: "owner-one"
    })).resolves.toMatchObject({
      resolvedSourceCount: 5_183,
      sourceBindingStrategy: "disclosed_v1",
      sources: []
    });
  });

  it("rejects a focused Source snapshot whose Base provenance is not in the accepted scope", async () => {
    const findFirst = vi.fn(async () => ({
      knowledgeRunBindings: [{
        includeWholeBase: true,
        indexGenerationId: "generation-one",
        knowledgeBaseId: "base-one",
        ordinal: 0,
        selectedSourceIds: [],
        vectorSpaceFingerprint: "a".repeat(64)
      }],
      knowledgeRunProfileBindings: [{
        embeddingCredentialSource: "default",
        embeddingExecutionSnapshot: focusedEmbeddingSnapshot,
        embeddingProviderModelId: "embedding-model",
        ordinal: 0,
        profileRevisionId: "profile-revision-one",
        targetDimension: 1_024,
        vectorSpaceFingerprint: "a".repeat(64)
      }],
      knowledgeRunScope: {
        exclusions: [],
        resolvedBaseCount: 1,
        resolvedSourceCount: 1,
        sourceBindingStrategy: "eager_v1",
        selection: { baseIds: ["base-one"], mode: "explicit", sourceIds: [], version: 1 }
      },
      knowledgeRunSourceBindings: [{
        accessProvenance: {
          authority: { knowledgeBaseIds: ["base-two"], owner: false, projectId: null },
          selectionProvenance: ["base"]
        },
        baseProvenance: [{
          indexGenerationId: "generation-two",
          knowledgeBaseId: "base-two"
        }],
        directSelected: false,
        ordinal: 0,
        profileBinding: { profileRevisionId: "profile-revision-one" },
        readinessState: "ready",
        sourceAlias: "S1",
        sourceArtifactId: "artifact-one",
        sourceId: "source-one",
        sourceVersionId: "source-version-one",
        tombstonedAt: null
      }]
    }));
    const operations = createPrismaRunToolLoopOperations({
      modelRun: { findFirst }
    } as unknown as PrismaClient, NOOP_MEMORY_SOURCE_MUTATION_HOOKS);

    await expect(operations.loadFocusedKnowledgeRecoveryScope!({
      runId: "run-one",
      userId: "owner-one"
    })).rejects.toThrow("knowledge_run_scope_invalid_in_storage");
  });

  it("accepts a persisted MCP server-only snapshot", async () => {
    const acceptedRequest: NormalizedRunRequest = {
      ...normalizedRequest,
      mcp: {
        servers: [{
          fingerprint: "a".repeat(64),
          revisionId: "revision-one",
          serverId: "server-one",
          serverName: "Server one"
        }],
        tools: [],
        version: 1
      }
    };
    const operations = createPrismaRunToolLoopOperations({
      modelRun: {
        findUnique: vi.fn(async () => ({
          chat: { projectId: null, userId: "owner-one" },
          chatId: "chat-one",
          modelId: "model-one",
          normalizedRequest: acceptedRequest,
          provider: "provider-one"
        }))
      }
    } as unknown as PrismaClient, NOOP_MEMORY_SOURCE_MUTATION_HOOKS);

    await expect(operations.loadProviderDispatchRecoveryRequest!({
      runId: "run-one",
      userId: "owner-one"
    })).resolves.toEqual(acceptedRequest);
  });

  it("rejects focused recovery requests that can expose any model tool route", async () => {
    const focusedRequest = createKnowledgeFocusedRequest({ currentUserMessage: "Question" })!;
    for (const unsafe of [
      { toolMode: "auto" as const },
      { mcp: { servers: [], tools: [], version: 1 as const } },
      { mcpDiscovery: { catalog: { servers: [] }, epochs: [], version: 2 as const } },
      { memoryActionTools: { version: "model-driven-v2" as const } },
      { memoryHistoryTool: { maxCalls: 2 as const, pageSize: 20 as const } },
      { searchPlan: {
          mode: "all_selected" as const,
          options: [{ unsafe: true }]
        } }
    ]) {
      const operations = createPrismaRunToolLoopOperations({
        modelRun: {
          findUnique: vi.fn(async () => ({
            chat: { projectId: null, userId: "owner-one" },
            chatId: "chat-one",
            modelId: "model-one",
            normalizedRequest: {
              ...normalizedRequest,
              knowledgeFocusedRequest: focusedRequest,
              knowledgePlan: {
                baseIds: ["base-one"],
                mode: "explicit",
                sourceIds: [],
                version: 1
              },
              ...unsafe
            },
            provider: "provider-one"
          }))
        }
      } as unknown as PrismaClient, NOOP_MEMORY_SOURCE_MUTATION_HOOKS);

      await expect(operations.loadProviderDispatchRecoveryRequest!({
        runId: "run-one",
        userId: "owner-one"
      })).rejects.toThrow("provider_dispatch_recovery_request_invalid_in_storage");
    }
  });

  it("rejects a stored request with an unrecognized private projection", async () => {
    const operations = createPrismaRunToolLoopOperations({
      modelRun: {
        findUnique: vi.fn(async () => ({
          chat: { projectId: null, userId: "owner-one" },
          chatId: "chat-one",
          modelId: "model-one",
          normalizedRequest: { ...normalizedRequest, unexpectedPrivateField: "must not pass" },
          provider: "provider-one"
        }))
      }
    } as unknown as PrismaClient, NOOP_MEMORY_SOURCE_MUTATION_HOOKS);

    await expect(operations.loadProviderDispatchRecoveryRequest!({
      runId: "run-one",
      userId: "owner-one"
    })).rejects.toThrow("provider_dispatch_recovery_request_invalid_in_storage");
  });

  it("rejects unrecognized fields inside a persisted MCP snapshot", async () => {
    const operations = createPrismaRunToolLoopOperations({
      modelRun: {
        findUnique: vi.fn(async () => ({
          chat: { projectId: null, userId: "owner-one" },
          chatId: "chat-one",
          modelId: "model-one",
          normalizedRequest: {
            ...normalizedRequest,
            mcp: {
              privateRuntimeProjection: "must not pass",
              servers: [],
              tools: [],
              version: 1
            }
          },
          provider: "provider-one"
        }))
      }
    } as unknown as PrismaClient, NOOP_MEMORY_SOURCE_MUTATION_HOOKS);

    await expect(operations.loadProviderDispatchRecoveryRequest!({
      runId: "run-one",
      userId: "owner-one"
    })).rejects.toThrow("provider_dispatch_recovery_request_invalid_in_storage");
  });
});

function pendingCallsWithOneTimestamp(calls: ToolCallRow[], count: number): ToolCallRow[] {
  const completedAt = calls[0]?.completedAt;
  expect(completedAt).toBeInstanceOf(Date);
  return calls.slice(0, count).map((call) => ({
    completedAt: completedAt ?? null,
    id: call.id,
    state: "cancelled"
  }));
}

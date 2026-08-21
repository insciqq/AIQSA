import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createMemoryClientRefService } from "../actions/clientRef";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../history/chunking";
import { MEMORY_HISTORY_INDEX_PIPELINE_VERSION } from "../history/contract";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "../history/sourceProjection";
import { createMemorySourceActionService } from "./actionService";

const now = new Date("2026-08-21T05:00:00.000Z");

function setup() {
  const key = randomBytes(32);
  const refs = createMemoryClientRefService({ encryptionKey: () => key });
  const feedback = {
    create: vi.fn(async () => ({})),
    findUnique: vi.fn(async () => null)
  };
  const event = { create: vi.fn(async () => ({})) };
  const client = {
    $queryRaw: vi.fn(async () => [{ id: "version-1" }]),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $queryRaw: vi.fn(async () => [{ id: "chat-1" }]),
        memoryEvent: event,
        memoryFeedback: feedback
      })),
    chat: { findFirst: vi.fn() },
    chatMemoryCheckpoint: { findUnique: vi.fn() },
    memoryFact: { findFirst: vi.fn(async () => ({
      currentVersionId: "version-1",
      scopeId: "scope-1",
      state: "ACTIVE"
    })) },
    memoryFactVersion: { findFirst: vi.fn(async () => ({
      contentPurgedAt: null,
      id: "version-1",
      safetyClassificationState: "CLASSIFIED",
      sensitivityClass: "NORMAL",
      sourceMode: "EXPLICIT",
      state: "ACTIVE"
    })) },
    memoryScope: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => ({ id: "scope-1" }))
    },
    memoryRecallChunk: { findFirst: vi.fn() },
    memoryRecallChunkMessage: { findMany: vi.fn(async () => []) },
    memoryRetrievalAttempt: { findFirst: vi.fn() },
    memorySuppression: {
      findMany: vi.fn(async (): Promise<Array<{
        id: string;
        sourceMessageId: string | null;
      }>> => [])
    },
    message: { findMany: vi.fn(async () => []) },
    modelRun: { findMany: vi.fn(async () => [{ id: "run-1" }]) },
    modelRunMemoryBinding: { findFirst: vi.fn(async () => ({ id: "binding-1" })) },
    modelRunMemoryItem: { findFirst: vi.fn(async () => ({
      factVersionId: "version-1",
      id: "item-1",
      itemType: "FACT_VERSION",
      recallChunkId: null,
      sourceBranchGenerationSnapshot: null,
      sourceChatIdSnapshot: null,
      sourceContentHashSnapshot: null,
      sourceMessageIdsSnapshot: [],
      sourceRevisionSnapshot: null
    })) }
  };
  const service = createMemorySourceActionService({
    authorizationRepository: { mint: vi.fn() },
    client: client as never,
    clientRefs: refs,
    explicitService: {} as never,
    lifecycleService: {} as never
  });
  const ref = refs.mint("user-1", {
    allowedOperations: ["EDIT", "FORGET", "NOT_RELEVANT"],
    originatingRunId: "run-1",
    target: {
      exactItemId: "version-1",
      factId: "fact-1",
      factVersionId: "version-1",
      itemType: "FACT_VERSION",
      recallChunkId: null,
      sourceChatId: null,
      sourceMessageIds: []
    }
  }, now);
  return { client, event, feedback, ref, refs, service };
}

describe("Memory source actions", () => {
  it("records owner- and run-bound Not relevant feedback without returning identifiers", async () => {
    const { event, feedback, ref, service } = setup();
    await expect(service.execute("user-1", {
      action: "NOT_RELEVANT",
      memoryRef: ref,
      requestNonce: "request-1"
    }, now)).resolves.toEqual({ status: "COMMITTED" });
    expect(event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: "USER",
        actorUserId: "user-1",
        factId: "fact-1",
        factVersionId: "version-1",
        metadata: expect.objectContaining({
          feedbackId: expect.any(String),
          feedbackType: "NOT_USEFUL",
          schemaVersion: "memory-feedback-event-v1"
        }),
        operation: "USER_FEEDBACK",
        userId: "user-1"
      })
    });
    expect(feedback.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        feedbackType: "NOT_USEFUL",
        memoryFactId: "fact-1",
        memoryFactVersionId: "version-1",
        memoryEventId: expect.any(String),
        modelRunId: "run-1",
        modelRunMemoryItemId: "item-1",
        targetKind: "FACT_VERSION",
        userId: "user-1"
      })
    });
  });

  it("rejects every stale ref whose originating run now belongs to a Project", async () => {
    const { client, ref, service } = setup();
    client.modelRun.findMany.mockResolvedValueOnce([]);

    await expect(service.execute("user-1", {
      action: "NOT_RELEVANT",
      memoryRef: ref,
      requestNonce: "request-project"
    }, now)).rejects.toMatchObject({ code: "memory_not_found" });
    expect(client.modelRunMemoryBinding.findFirst).not.toHaveBeenCalled();
  });

  it("opens the exact learned source only while its Personal evidence is current", async () => {
    const { client, refs, service } = setup();
    const learnedRef = refs.mint("user-1", {
      allowedOperations: ["EDIT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
      originatingRunId: "run-1",
      target: {
        exactItemId: "version-1",
        factId: "fact-1",
        factVersionId: "version-1",
        itemType: "FACT_VERSION",
        recallChunkId: null,
        sourceChatId: "source-chat-1",
        sourceMessageIds: ["source-message-1"]
      }
    }, now);
    client.memoryFactVersion.findFirst.mockResolvedValue({
      contentPurgedAt: null,
      id: "version-1",
      safetyClassificationState: "CLASSIFIED",
      sensitivityClass: "NORMAL",
      sourceMode: "AUTOMATIC",
      state: "ACTIVE"
    } as never);
    client.modelRunMemoryItem.findFirst.mockResolvedValue({
      factVersionId: "version-1",
      id: "item-1",
      itemType: "FACT_VERSION",
      recallChunkId: null,
      sourceBranchGenerationSnapshot: 4,
      sourceChatIdSnapshot: "source-chat-1",
      sourceContentHashSnapshot: null,
      sourceMessageIdsSnapshot: ["source-message-1"],
      sourceRevisionSnapshot: null
    } as never);
    client.$queryRaw.mockReset()
      .mockResolvedValueOnce([{ id: "version-1" }])
      .mockResolvedValueOnce([{
        branchGeneration: 4,
        chatId: "source-chat-1",
        factVersionId: "version-1",
        messageId: "source-message-1"
      }] as never);
    client.chat.findFirst.mockResolvedValue({
      id: "source-chat-1",
      memoryBranchGeneration: 4
    } as never);
    client.message.findMany.mockResolvedValue([{ id: "source-message-1" }] as never);

    await expect(service.execute("user-1", {
      action: "OPEN_SOURCE",
      memoryRef: learnedRef,
      requestNonce: "request-open"
    }, now)).resolves.toEqual({
      href: expect.stringContaining("/api/me/memory/source-actions/open?memoryRef="),
      status: "READY"
    });

    client.$queryRaw.mockReset().mockResolvedValueOnce([]);
    await expect(service.execute("user-1", {
      action: "OPEN_SOURCE",
      memoryRef: learnedRef,
      requestNonce: "request-stale"
    }, now)).rejects.toMatchObject({ code: "memory_version_stale" });
  });

  it("accepts an unbound action-result ref only from the latest consumed run result", async () => {
    const key = randomBytes(32);
    const refs = createMemoryClientRefService({ encryptionKey: () => key });
    const ref = refs.mint("user-1", {
      allowedOperations: ["EDIT", "FORGET"],
      originatingRunId: "run-1",
      target: {
        exactItemId: "version-1",
        factId: "fact-1",
        factVersionId: "version-1",
        itemType: "FACT_VERSION",
        recallChunkId: null,
        sourceChatId: null,
        sourceMessageIds: []
      }
    }, now);
    const otherRef = refs.mint("user-1", {
      allowedOperations: ["EDIT", "FORGET"],
      originatingRunId: "run-1",
      target: {
        exactItemId: "version-2",
        factId: "fact-2",
        factVersionId: "version-2",
        itemType: "FACT_VERSION",
        recallChunkId: null,
        sourceChatId: null,
        sourceMessageIds: []
      }
    }, now);
    const update = vi.fn(async () => ({}));
    const mint = vi.fn(async () => ({ id: "authorization-1" }));
    const attempt = {
      budgetSnapshot: {
        memoryActionResult: {
          candidates: [ref, otherRef].map((memoryRef, index) => ({
            category: "other",
            createdAt: `2026-08-21T05:00:0${index}.000Z`,
            memoryRef,
            provenance: "SAVED",
            sensitivity: "NORMAL",
            statement: `Candidate ${index + 1}`
          })),
          operation: "UPDATE",
          statement: "Use the frozen replacement.",
          status: "AMBIGUOUS"
        }
      }
    };
    const findLatestActionResult = vi.fn(async (): Promise<unknown> => attempt);
    const client = {
      $queryRaw: vi.fn(async () => [{ id: "version-1" }]),
      chat: { findFirst: vi.fn() },
      chatMemoryCheckpoint: { findUnique: vi.fn() },
      memoryFact: { findFirst: vi.fn(async () => ({
        currentVersionId: "version-1",
        scopeId: "scope-1",
        state: "ACTIVE"
      })) },
      memoryFactVersion: { findFirst: vi.fn(async () => ({
        contentPurgedAt: null,
        id: "version-1",
        safetyClassificationState: "CLASSIFIED",
        sensitivityClass: "NORMAL",
        sourceMode: "EXPLICIT",
        state: "ACTIVE"
      })) },
      memoryScope: { findFirst: vi.fn(async () => ({ id: "scope-1" })) },
      memoryRecallChunk: { findFirst: vi.fn() },
      memoryRecallChunkMessage: { findMany: vi.fn() },
      memoryRetrievalAttempt: { findFirst: findLatestActionResult },
      memorySuppression: {
        findMany: vi.fn(async (): Promise<Array<{
          id: string;
          sourceMessageId: string | null;
        }>> => [])
      },
      message: { findMany: vi.fn() },
      modelRun: { findMany: vi.fn(async () => [{ id: "run-1" }]) },
      modelRunMemoryBinding: { findFirst: vi.fn(async () => ({ id: "binding-1" })) },
      modelRunMemoryItem: { findFirst: vi.fn(async () => null) }
    };
    const service = createMemorySourceActionService({
      authorizationRepository: { mint: mint as never },
      client: client as never,
      clientRefs: refs,
      explicitService: { update } as never,
      lifecycleService: {} as never
    });

    await expect(service.execute("user-1", {
      action: "CORRECT",
      memoryRef: ref,
      requestNonce: "request-1",
      statement: "Use the frozen replacement."
    }, now)).resolves.toEqual({ status: "COMMITTED" });
    expect(findLatestActionResult).toHaveBeenCalledWith({
      orderBy: { attemptOrdinal: "desc" },
      select: { budgetSnapshot: true },
      where: { modelRunId: "run-1", state: "CONSUMED", userId: "user-1" }
    });
    expect(update).toHaveBeenCalledWith("user-1", "fact-1", expect.objectContaining({
      expectedVersionId: "version-1",
      statement: "Use the frozen replacement."
    }));

    await expect(service.execute("user-1", {
      action: "CORRECT",
      memoryRef: ref,
      requestNonce: "request-2",
      statement: "A browser-supplied substitute."
    }, now)).rejects.toMatchObject({ code: "memory_contract_invalid" });

    findLatestActionResult.mockResolvedValueOnce({
      budgetSnapshot: {
        memoryActionResult: {
          items: [attempt.budgetSnapshot.memoryActionResult.candidates[1]],
          operation: "LIST",
          status: "COMPLETE"
        }
      }
    });
    await expect(service.execute("user-1", {
      action: "FORGET",
      memoryRef: ref,
      requestNonce: "request-3"
    }, now)).rejects.toMatchObject({ code: "memory_not_found" });
  });

  it("does not promote action-result refs into source feedback or navigation authority", async () => {
    const key = randomBytes(32);
    const refs = createMemoryClientRefService({ encryptionKey: () => key });
    const ref = refs.mint("user-1", {
      allowedOperations: ["EDIT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
      originatingRunId: "run-1",
      target: {
        exactItemId: "version-1",
        factId: "fact-1",
        factVersionId: "version-1",
        itemType: "FACT_VERSION",
        recallChunkId: null,
        sourceChatId: null,
        sourceMessageIds: []
      }
    }, now);
    const client = {
      ...setup().client,
      memoryRetrievalAttempt: { findFirst: vi.fn(async () => ({
        budgetSnapshot: {
          memoryActionResult: {
            memoryRef: ref,
            operation: "SAVE",
            statement: "Saved statement.",
            status: "COMMITTED"
          }
        }
      })) },
      modelRunMemoryItem: { findFirst: vi.fn(async () => null) }
    };
    const service = createMemorySourceActionService({
      authorizationRepository: { mint: vi.fn() },
      client: client as never,
      clientRefs: refs,
      explicitService: {} as never,
      lifecycleService: {} as never
    });

    await expect(service.execute("user-1", {
      action: "NOT_RELEVANT",
      memoryRef: ref,
      requestNonce: "request-1"
    }, now)).rejects.toMatchObject({ code: "memory_not_found" });
    await expect(service.execute("user-1", {
      action: "OPEN_SOURCE",
      memoryRef: ref,
      requestNonce: "request-2"
    }, now)).rejects.toMatchObject({ code: "memory_not_found" });
    expect(client.memoryRetrievalAttempt.findFirst).not.toHaveBeenCalled();
  });

  it("rejects another tenant before any repository lookup", async () => {
    const { client, ref, service } = setup();
    await expect(service.execute("user-2", {
      action: "NOT_RELEVANT",
      memoryRef: ref,
      requestNonce: "request-1"
    }, now)).rejects.toMatchObject({ code: "memory_not_found" });
    expect(client.modelRunMemoryBinding.findFirst).not.toHaveBeenCalled();
  });

  it("rejects feedback, edit, and forget for a dormant legacy-scoped fact", async () => {
    const { client, feedback, ref, service } = setup();
    client.memoryScope.findFirst.mockResolvedValue(null);

    for (const action of [
      { action: "NOT_RELEVANT" as const, requestNonce: "request-feedback" },
      {
        action: "CORRECT" as const,
        requestNonce: "request-edit",
        statement: "Use concise answers."
      },
      { action: "FORGET" as const, requestNonce: "request-forget" }
    ]) {
      await expect(service.execute("user-1", {
        ...action,
        memoryRef: ref
      }, now)).rejects.toMatchObject({ code: "memory_not_found" });
    }
    expect(feedback.create).not.toHaveBeenCalled();
    expect(client.memoryScope.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        assistantId: null,
        chatId: null,
        folderId: null,
        id: "scope-1",
        scopeType: "GLOBAL_USER",
        state: "ACTIVE",
        targetDisplaySnapshot: null,
        targetIdSnapshot: null,
        userId: "user-1"
      }
    });
  });

  it("returns only an opaque same-origin navigation URL and rejoins the current source", async () => {
    const { client } = setup();
    const key = randomBytes(32);
    const refs = createMemoryClientRefService({ encryptionKey: () => key });
    const historyClient = {
      ...client,
      chat: { findFirst: vi.fn(async () => ({
        id: "source-chat-1",
        memoryBranchGeneration: 4,
        memoryMode: "NORMAL",
        memorySourceRevision: 8
      })) },
      chatMemoryCheckpoint: { findUnique: vi.fn(async () => ({
        pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION
      })) },
      memoryRecallChunk: { findFirst: vi.fn(async () => ({
        branchGeneration: 4,
        chatId: "source-chat-1",
        chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
        contentHash: "c".repeat(64),
        sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
        sourceRevisionAtCreation: 8,
        state: "ACTIVE"
      })) },
      memoryRecallChunkMessage: { findMany: vi.fn(async () => [{
        chatId: "source-chat-1",
        messageId: "source-message-1"
      }]) },
      message: { findMany: vi.fn(async () => [{ id: "source-message-1" }]) },
      modelRunMemoryItem: { findFirst: vi.fn(async () => ({
        factVersionId: null,
        id: "item-history-1",
        itemType: "RECALL_CHUNK",
        recallChunkId: "chunk-1",
        sourceBranchGenerationSnapshot: 4,
        sourceChatIdSnapshot: "source-chat-1",
        sourceContentHashSnapshot: "c".repeat(64),
        sourceMessageIdsSnapshot: ["source-message-1"],
        sourceRevisionSnapshot: 8
      })) }
    };
    const create = vi.fn(async () => ({}));
    const mintAuthorization = vi.fn(async () => ({
      expiresAt: "2026-08-21T05:10:00.000Z",
      mutationAuthorizationId: "authorization-1"
    }));
    const suppress = vi.fn(async () => undefined);
    const historyService = createMemorySourceActionService({
      authorizationRepository: { mint: vi.fn() },
      client: historyClient as never,
      clientRefs: refs,
      explicitService: { create, mintAuthorization } as never,
      lifecycleService: {} as never,
      recallMutationRepository: { suppress }
    });
    const ref = refs.mint("user-1", {
      allowedOperations: ["EDIT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
      originatingRunId: "run-1",
      target: {
        exactItemId: "chunk-1",
        factId: null,
        factVersionId: null,
        itemType: "RECALL_CHUNK",
        recallChunkId: "chunk-1",
        sourceChatId: "source-chat-1",
        sourceMessageIds: ["source-message-1"]
      }
    }, now);

    const response = await historyService.execute("user-1", {
      action: "OPEN_SOURCE",
      memoryRef: ref,
      requestNonce: "request-1"
    }, now);

    expect(response).toMatchObject({ status: "READY" });
    if (response.status !== "READY") throw new Error("expected navigation response");
    expect(response.href.startsWith("/api/me/memory/source-actions/open?memoryRef=")).toBe(true);
    expect(response.href).not.toContain("source-chat-1");
    expect(response.href).not.toContain("source-message-1");
    await expect(historyService.resolveOpenSource("user-1", ref, now)).resolves.toEqual({
      chatId: "source-chat-1",
      messageId: "source-message-1"
    });

    await expect(historyService.execute("user-1", {
      action: "CORRECT",
      memoryRef: ref,
      requestNonce: "request-correct",
      statement: "Use the cedar deployment for this environment."
    }, now)).resolves.toEqual({ status: "COMMITTED" });
    expect(mintAuthorization).toHaveBeenCalledWith("user-1", expect.objectContaining({
      action: "SAVE",
      confirmationCopyVersion: "memory-confirmation-v1",
      exactStatementHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      requestNonce: expect.stringMatching(/^[a-f0-9]{64}$/u)
    }));
    expect(create).toHaveBeenCalledWith("user-1", {
      mutationAuthorizationId: "authorization-1",
      scope: { type: "GLOBAL_USER" },
      statement: "Use the cedar deployment for this environment."
    });

    await expect(historyService.execute("user-1", {
      action: "FORGET",
      memoryRef: ref,
      requestNonce: "request-forget"
    }, now)).resolves.toEqual({ status: "COMMITTED" });
    expect(suppress).toHaveBeenCalledWith("user-1", {
      branchGeneration: 4,
      chatId: "source-chat-1",
      chunkId: "chunk-1",
      contentHash: "c".repeat(64),
      messageIds: ["source-message-1"],
      requestNonce: "request-forget",
      sourceRevision: 8
    });

    historyClient.memorySuppression.findMany.mockResolvedValueOnce([{
      id: "suppression-1",
      sourceMessageId: "source-message-1"
    }]);
    await expect(historyService.resolveOpenSource("user-1", ref, now)).rejects.toMatchObject({
      code: "memory_not_found"
    });

    historyClient.chatMemoryCheckpoint.findUnique.mockResolvedValueOnce({
      pipelineVersion: "memory-history-index-stale"
    });
    await expect(historyService.resolveOpenSource("user-1", ref, now)).rejects.toMatchObject({
      code: "memory_not_found"
    });

    historyClient.chat.findFirst.mockResolvedValueOnce({
      id: "source-chat-1",
      memoryBranchGeneration: 4,
      memoryMode: "EXCLUDED",
      memorySourceRevision: 9
    });
    await expect(historyService.resolveOpenSource("user-1", ref, now)).rejects.toMatchObject({
      code: "memory_not_found"
    });
  });
});

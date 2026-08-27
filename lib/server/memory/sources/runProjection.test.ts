import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createMemoryClientRefService } from "../actions/clientRef";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../history/chunking";
import {
  MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION
} from "../history/contract";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "../history/sourceProjection";
import { loadMemoryRunSources } from "./runProjection";

function client() {
  return {
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([{ id: "private-version-1" }])
      .mockResolvedValueOnce([]),
    chat: { findMany: vi.fn(async () => []) },
    chatMemoryCheckpoint: { findMany: vi.fn(async () => []) },
    chatMemoryCheckpointMessage: { findMany: vi.fn(async () => []) },
    chatMemoryDigest: { findMany: vi.fn(async () => []) },
    chatMemoryDigestMessage: { findMany: vi.fn(async () => []) },
    memoryFact: { findMany: vi.fn(async () => [{
      currentVersionId: "private-version-1",
      id: "private-fact-1",
      scopeId: "global-scope-1",
      state: "ACTIVE"
    }]) },
    memoryFactVersion: { findMany: vi.fn(async () => [{
      contentPurgedAt: null,
      factId: "private-fact-1",
      id: "private-version-1",
      safetyClassificationState: "CLASSIFIED",
      sensitivityClass: "NORMAL",
      sourceMode: "EXPLICIT",
      state: "ACTIVE",
      systemFrom: new Date("2026-08-21T04:00:00.000Z")
    }]) },
    memoryScope: { findMany: vi.fn(async () => [{ id: "global-scope-1" }]) },
    memoryRecallChunk: { findMany: vi.fn(async () => []) },
    memoryRecallChunkMessage: { findMany: vi.fn(async () => []) },
    memorySuppression: { findMany: vi.fn(async (): Promise<Array<{
      sourceBranchGeneration: number | null;
      sourceChatId: string | null;
      sourceMessageId: string | null;
    }>> => []) },
    message: { findMany: vi.fn(async () => []) },
    modelRun: { findMany: vi.fn(async () => [{ id: "run-1" }]) },
    modelRunMemoryBinding: { findMany: vi.fn(async () => [{ id: "binding-1", modelRunId: "run-1" }]) },
    modelRunMemoryItem: { findMany: vi.fn(async () => [{
      bindingId: "binding-1",
      factVersionId: "private-version-1",
      featureSnapshot: {
        documentTime: "internal-document-time-sentinel",
        evidenceHandle: "internal-evidence-handle-sentinel",
        sourceAuthority: "user_saved",
        sourceSessionHandle: "internal-session-handle-sentinel"
      },
      includedText: "I prefer exact, concise answers.",
      itemType: "FACT_VERSION",
      recallChunkId: null,
      sourceChatIdSnapshot: null,
      sourceMessageIdsSnapshot: [],
      sourceRevisionSnapshot: null
    }]) }
  };
}

function historyClient(overrides: Readonly<{
  branchGeneration?: number;
  chunkingVersion?: string;
  pipelineVersion?: string;
  sourceProjectionVersion?: string;
}> = {}) {
  return {
    $queryRaw: vi.fn(async () => []),
    chat: { findMany: vi.fn(async () => [{
      activeLeafMessageId: "source-message-1",
      id: "source-chat-1",
      memoryBranchGeneration: 4,
      memoryMode: "NORMAL",
      memorySourceRevision: 3,
      permanentDeletionAt: null,
      projectId: null,
      title: "Archived source"
    }]) },
    chatMemoryCheckpoint: { findMany: vi.fn(async () => [{
      activeLeafMessageId: "source-message-1",
      branchGeneration: 4,
      chatId: "source-chat-1",
      lastIndexedMessageId: "source-message-1",
      pipelineVersion: overrides.pipelineVersion ?? MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
      sourceContentHash: "s".repeat(64),
      sourceRevision: 3,
      status: "READY"
    }]) },
    chatMemoryCheckpointMessage: { findMany: vi.fn(async () => [{
      chatId: "source-chat-1",
      messageId: "source-message-1",
      sourceMessageUpdatedAt: new Date("2026-08-21T04:00:00.000Z")
    }]) },
    chatMemoryDigest: { findMany: vi.fn(async () => []) },
    chatMemoryDigestMessage: { findMany: vi.fn(async () => []) },
    memoryFact: { findMany: vi.fn(async () => []) },
    memoryFactVersion: { findMany: vi.fn(async () => []) },
    memoryScope: { findMany: vi.fn(async () => []) },
    memoryRecallChunk: { findMany: vi.fn(async () => [{
      branchGeneration: overrides.branchGeneration ?? 4,
      chatId: "source-chat-1",
      chunkingVersion: overrides.chunkingVersion ?? MEMORY_HISTORY_CHUNKING_VERSION,
      id: "private-chunk-1",
      contentHash: "c".repeat(64),
      occurredTo: new Date("2026-08-21T04:00:00.000Z"),
      redactionState: "NOT_NEEDED",
      safetyClass: "NORMAL",
      sourceProjectionVersion: overrides.sourceProjectionVersion ??
        MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
      sourceRevisionAtCreation: 3,
      state: "ACTIVE"
    }]) },
    memoryRecallChunkMessage: { findMany: vi.fn(async () => [{
      chatId: "source-chat-1",
      chunkId: "private-chunk-1",
      messageId: "source-message-1",
      sourceMessageUpdatedAt: new Date("2026-08-21T04:00:00.000Z")
    }]) },
    memorySuppression: { findMany: vi.fn(async (): Promise<Array<{
      sourceBranchGeneration: number | null;
      sourceChatId: string | null;
      sourceMessageId: string | null;
    }>> => []) },
    message: { findMany: vi.fn(async () => [{
      chatId: "source-chat-1",
      id: "source-message-1",
      updatedAt: new Date("2026-08-21T04:00:00.000Z")
    }]) },
    modelRun: { findMany: vi.fn(async () => [{ id: "run-1" }]) },
    modelRunMemoryBinding: {
      findMany: vi.fn(async () => [{ id: "binding-1", modelRunId: "run-1" }])
    },
    modelRunMemoryItem: { findMany: vi.fn(async () => [{
      bindingId: "binding-1",
      factVersionId: null,
      featureSnapshot: { projectionKind: "RECALL_CHUNK_SAFE_PROJECTED_TEXT" },
      includedText: "The previous chat chose cedar deployment.",
      itemType: "RECALL_CHUNK",
      recallChunkId: "private-chunk-1",
      sourceBranchGenerationSnapshot: 4,
      sourceChatIdSnapshot: "source-chat-1",
      sourceContentHashSnapshot: "c".repeat(64),
      sourceMessageIdsSnapshot: ["source-message-1"],
      sourceRevisionSnapshot: 3
    }]) }
  };
}

describe("answer Memory source projection", () => {
  it("uses exact committed run items and emits no repository identifiers", async () => {
    const sources = await loadMemoryRunSources(client() as never, {
      clientRefs: createMemoryClientRefService({ encryptionKey: () => randomBytes(32) }),
      runIds: ["run-1"],
      userId: "user-1"
    });
    expect(sources.get("run-1")).toEqual([expect.objectContaining({
      actions: ["CORRECT", "FORGET", "NOT_RELEVANT"],
      sourceType: "SAVED_MEMORY",
      text: "I prefer exact, concise answers."
    })]);
    const serialized = JSON.stringify(sources.get("run-1"));
    expect(serialized).not.toContain("private-fact-1");
    expect(serialized).not.toContain("private-version-1");
    expect(serialized).not.toContain("internal-document-time-sentinel");
    expect(serialized).not.toContain("internal-evidence-handle-sentinel");
    expect(serialized).not.toContain("internal-session-handle-sentinel");
  });

  it("projects history only when both persisted projection versions are current", async () => {
    const clientRefs = createMemoryClientRefService({ encryptionKey: () => randomBytes(32) });
    const current = await loadMemoryRunSources(historyClient() as never, {
      clientRefs,
      runIds: ["run-1"],
      userId: "user-1"
    });
    expect(current.get("run-1")).toEqual([expect.objectContaining({
      actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
      origin: "Archived source",
      sourceType: "PAST_CHAT",
      text: "The previous chat chose cedar deployment."
    })]);

    for (const stale of [
      { branchGeneration: 5 },
      { chunkingVersion: "memory-history-chunking-stale" },
      { pipelineVersion: "memory-history-index-stale" },
      { sourceProjectionVersion: "memory-history-source-projection-stale" }
    ]) {
      const sources = await loadMemoryRunSources(historyClient(stale) as never, {
        clientRefs,
        runIds: ["run-1"],
        userId: "user-1"
      });
      expect(sources.get("run-1")).toBeUndefined();
    }
  });

  it("does not project forgotten past-chat text or mint a usable ref", async () => {
    const database = historyClient();
    database.memorySuppression.findMany.mockResolvedValueOnce([{
      sourceBranchGeneration: 4,
      sourceChatId: "source-chat-1",
      sourceMessageId: "source-message-1"
    }]);
    const sealedRefs = createMemoryClientRefService({ encryptionKey: () => randomBytes(32) });
    const mint = vi.fn(sealedRefs.mint.bind(sealedRefs));

    const sources = await loadMemoryRunSources(database as never, {
      clientRefs: { mint, resolve: sealedRefs.resolve.bind(sealedRefs) },
      runIds: ["run-1"],
      userId: "user-1"
    });

    expect(sources.get("run-1")).toBeUndefined();
    expect(mint).not.toHaveBeenCalled();
  });

  it("projects an overview digest through its exact current anchor source", async () => {
    const database = historyClient();
    const updatedAt = new Date("2026-08-21T04:00:00.000Z");
    database.modelRunMemoryItem.findMany.mockResolvedValueOnce([{
      bindingId: "binding-1",
      factVersionId: null,
      featureSnapshot: {
        projectionKind: "CHAT_DIGEST_SAFE_TEXT",
        supportingItemId: "digest-1"
      },
      includedText: "Summary: The chat selected cedar deployment.",
      itemType: "RECALL_CHUNK",
      recallChunkId: "private-chunk-1",
      sourceBranchGenerationSnapshot: 4,
      sourceChatIdSnapshot: "source-chat-1",
      sourceContentHashSnapshot: "c".repeat(64),
      sourceMessageIdsSnapshot: ["source-message-0", "source-message-1"],
      sourceRevisionSnapshot: 3
    }] as never);
    database.message.findMany.mockResolvedValueOnce([
      { chatId: "source-chat-1", id: "source-message-0", updatedAt },
      { chatId: "source-chat-1", id: "source-message-1", updatedAt }
    ] as never);
    database.chatMemoryCheckpointMessage.findMany.mockResolvedValueOnce([
      { chatId: "source-chat-1", messageId: "source-message-0", sourceMessageUpdatedAt: updatedAt },
      { chatId: "source-chat-1", messageId: "source-message-1", sourceMessageUpdatedAt: updatedAt }
    ] as never);
    database.chatMemoryDigest.findMany.mockResolvedValueOnce([{
      activeLeafMessageId: "source-message-1",
      anchorChunkId: "private-chunk-1",
      branchGeneration: 4,
      chatId: "source-chat-1",
      contentHash: "d".repeat(64),
      id: "digest-1",
      occurredTo: new Date("2026-08-21T04:05:00.000Z"),
      pipelineVersion: MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
      redactionState: "NOT_NEEDED",
      safetyClass: "NORMAL",
      sourceContentHash: "s".repeat(64),
      sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
      sourceRevisionAtCreation: 3,
      state: "ACTIVE"
    }] as never);
    database.chatMemoryDigestMessage.findMany.mockResolvedValueOnce([
      {
        chatId: "source-chat-1",
        digestId: "digest-1",
        messageId: "source-message-0",
        sourceMessageUpdatedAt: updatedAt
      },
      {
        chatId: "source-chat-1",
        digestId: "digest-1",
        messageId: "source-message-1",
        sourceMessageUpdatedAt: updatedAt
      }
    ] as never);
    const key = randomBytes(32);
    const refs = createMemoryClientRefService({ encryptionKey: () => key });

    const sources = await loadMemoryRunSources(database as never, {
      clientRefs: refs,
      runIds: ["run-1"],
      userId: "user-1"
    });
    const projected = sources.get("run-1")?.[0];
    expect(projected).toMatchObject({
      date: "2026-08-21T04:05:00.000Z",
      sourceType: "PAST_CHAT",
      text: "Summary: The chat selected cedar deployment."
    });
    if (!projected?.memoryRef) throw new Error("missing digest source fixture");
    expect(refs.resolve("user-1", projected.memoryRef, "OPEN_SOURCE", new Date()))
      .toMatchObject({
        target: {
          exactItemId: "private-chunk-1",
          sourceChatId: "source-chat-1",
          sourceMessageIds: ["source-message-1"]
        }
      });
  });

  it("never returns receipt text after the exact fact version is no longer current", async () => {
    const stale = client();
    stale.memoryFact.findMany.mockResolvedValueOnce([{
      currentVersionId: "different-version",
      id: "private-fact-1",
      scopeId: "global-scope-1",
      state: "FORGOTTEN"
    }]);
    stale.memoryFactVersion.findMany.mockResolvedValueOnce([{
      contentPurgedAt: null,
      factId: "private-fact-1",
      id: "private-version-1",
      safetyClassificationState: "CLASSIFIED",
      sensitivityClass: "NORMAL",
      sourceMode: "EXPLICIT",
      state: "FORGOTTEN",
      systemFrom: new Date("2026-08-21T04:00:00.000Z")
    }]);

    const sources = await loadMemoryRunSources(stale as never, {
      clientRefs: createMemoryClientRefService({ encryptionKey: () => randomBytes(32) }),
      runIds: ["run-1"],
      userId: "user-1"
    });

    expect(sources.get("run-1")).toBeUndefined();
  });

  it("does not project or mint a ref for a dormant legacy-scoped fact", async () => {
    const legacy = client();
    legacy.memoryScope.findMany.mockResolvedValueOnce([]);
    const sealedRefs = createMemoryClientRefService({ encryptionKey: () => randomBytes(32) });
    const mint = vi.fn(sealedRefs.mint.bind(sealedRefs));
    const refs = { mint, resolve: sealedRefs.resolve.bind(sealedRefs) };

    const sources = await loadMemoryRunSources(legacy as never, {
      clientRefs: refs,
      runIds: ["run-1"],
      userId: "user-1"
    });

    expect(sources.get("run-1")).toBeUndefined();
    expect(mint).not.toHaveBeenCalled();
    expect(legacy.memoryScope.findMany).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        assistantId: null,
        chatId: null,
        folderId: null,
        id: { in: ["global-scope-1"] },
        scopeType: "GLOBAL_USER",
        state: "ACTIVE",
        targetDisplaySnapshot: null,
        targetIdSnapshot: null,
        userId: "user-1"
      }
    });
  });

  it("never hydrates Personal Memory sources into a Project run", async () => {
    const database = client();
    database.modelRun.findMany.mockResolvedValueOnce([]);

    const sources = await loadMemoryRunSources(database as never, {
      clientRefs: createMemoryClientRefService({ encryptionKey: () => randomBytes(32) }),
      runIds: ["run-1"],
      userId: "user-1"
    });

    expect(sources.size).toBe(0);
    expect(database.modelRunMemoryBinding.findMany).not.toHaveBeenCalled();
  });

  it("offers Open source only while exact learned evidence remains Personal and current", async () => {
    const database = client();
    database.$queryRaw.mockReset()
      .mockResolvedValueOnce([{ id: "private-version-1" }])
      .mockResolvedValueOnce([{
        branchGeneration: 4,
        chatId: "source-chat-1",
        factVersionId: "private-version-1",
        messageId: "source-message-1"
      }]);
    database.memoryFactVersion.findMany.mockResolvedValueOnce([{
      contentPurgedAt: null,
      factId: "private-fact-1",
      id: "private-version-1",
      safetyClassificationState: "CLASSIFIED",
      sensitivityClass: "NORMAL",
      sourceMode: "AUTOMATIC",
      state: "ACTIVE",
      systemFrom: new Date("2026-08-21T04:00:00.000Z")
    }] as never);
    database.modelRunMemoryItem.findMany.mockResolvedValueOnce([{
      bindingId: "binding-1",
      factVersionId: "private-version-1",
      includedText: "I prefer exact, concise answers.",
      itemType: "FACT_VERSION",
      recallChunkId: null,
      sourceBranchGenerationSnapshot: 4,
      sourceChatIdSnapshot: "source-chat-1",
      sourceContentHashSnapshot: null,
      sourceMessageIdsSnapshot: ["source-message-1"],
      sourceRevisionSnapshot: null
    }] as never);
    database.chat.findMany.mockResolvedValueOnce([{
      activeLeafMessageId: "source-message-1",
      id: "source-chat-1",
      memoryBranchGeneration: 4,
      memoryMode: "NORMAL",
      memorySourceRevision: 1,
      permanentDeletionAt: null,
      projectId: null,
      title: "Source chat"
    }] as never);
    database.message.findMany.mockResolvedValueOnce([{
      chatId: "source-chat-1",
      id: "source-message-1",
      updatedAt: new Date("2026-08-21T04:00:00.000Z")
    }] as never);

    const sources = await loadMemoryRunSources(database as never, {
      clientRefs: createMemoryClientRefService({ encryptionKey: () => randomBytes(32) }),
      runIds: ["run-1"],
      userId: "user-1"
    });

    expect(sources.get("run-1")).toEqual([expect.objectContaining({
      actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
      sourceType: "LEARNED_MEMORY"
    })]);

    database.$queryRaw.mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const transitioned = await loadMemoryRunSources(database as never, {
      clientRefs: createMemoryClientRefService({ encryptionKey: () => randomBytes(32) }),
      runIds: ["run-1"],
      userId: "user-1"
    });
    expect(transitioned.size).toBe(0);
  });
});

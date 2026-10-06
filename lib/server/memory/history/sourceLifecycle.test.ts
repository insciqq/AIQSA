import { describe, expect, it, vi } from "vitest";
import type {
  LockedMemorySourceChat,
  MemoryRetainedSourceMutationEvent,
  MemorySourceSnapshot
} from "../sourceState";
import type { MemoryTransaction } from "../persistence/transaction";
import {
  MEMORY_HISTORY_QUIET_WINDOW_MS,
  MEMORY_HISTORY_REBUILD_REQUIRED_CHECKPOINT_VERSION
} from "./contract";
import {
  applyMemoryHistorySourceMutation,
  inheritMemoryHistoryBranchResumeCutoff
} from "./sourceLifecycle";

const untouchedTransaction = new Proxy({}, {
  get() {
    throw new Error("history_transaction_touched");
  }
}) as MemoryTransaction;

function branchEvent(
  overrides: Partial<MemorySourceSnapshot> = {},
  branchSourceChatId: string | null = "chat-source"
): MemoryRetainedSourceMutationEvent {
  const snapshot: MemorySourceSnapshot = {
    activeLeafMessageId: "assistant-branch",
    archived: false,
    folderId: null,
    id: "chat-branch",
    memoryBranchGeneration: 0,
    memoryMode: "NORMAL",
    memorySourceRevision: 1,
    messages: [],
    projectId: null,
    sourceHash: "b".repeat(64),
    temporaryRetentionDeadline: null,
    temporaryRetentionPolicyVersion: null,
    userId: "owner-1",
    ...overrides
  };
  return {
    ...(branchSourceChatId ? { branchSourceChatId } : {}),
    mutations: ["NORMAL_APPEND"],
    previous: {
      activeLeafMessageId: null,
      archived: false,
      folderId: null,
      id: snapshot.id,
      memoryBranchGeneration: 0,
      memoryMode: snapshot.memoryMode,
      memorySourceRevision: 0,
      projectId: snapshot.projectId,
      temporaryRetentionDeadline: null,
      temporaryRetentionPolicyVersion: null,
      userId: snapshot.userId
    },
    snapshot
  };
}

function checkpointTransaction(resumeCreatedAtCutoff: Date | null) {
  const findUnique = vi.fn(async () => ({ resumeCreatedAtCutoff }));
  const upsert = vi.fn(async () => ({}));
  const tx = { chatMemoryCheckpoint: { findUnique, upsert } } as unknown as MemoryTransaction;
  return { findUnique, tx, upsert };
}

function projectEvent(): MemoryRetainedSourceMutationEvent {
  const snapshot: MemorySourceSnapshot = {
    activeLeafMessageId: "assistant-1",
    archived: false,
    folderId: null,
    id: "chat-project",
    memoryBranchGeneration: 0,
    memoryMode: "NORMAL",
    memorySourceRevision: 1,
    messages: [],
    projectId: "project-1",
    sourceHash: "a".repeat(64),
    temporaryRetentionDeadline: null,
    temporaryRetentionPolicyVersion: null,
    userId: "owner-1"
  };
  const previous: LockedMemorySourceChat = {
    activeLeafMessageId: snapshot.activeLeafMessageId,
    archived: snapshot.archived,
    folderId: snapshot.folderId,
    id: snapshot.id,
    memoryBranchGeneration: snapshot.memoryBranchGeneration,
    memoryMode: snapshot.memoryMode,
    memorySourceRevision: 0,
    projectId: snapshot.projectId,
    temporaryRetentionDeadline: snapshot.temporaryRetentionDeadline,
    temporaryRetentionPolicyVersion: snapshot.temporaryRetentionPolicyVersion,
    userId: snapshot.userId
  };
  return {
    mutations: ["TERMINAL_SETTLEMENT"],
    previous,
    settlement: {
      assistantMessageId: snapshot.activeLeafMessageId,
      runId: "run-1",
      status: "complete"
    },
    snapshot
  };
}

function settledTurnEvent(): MemoryRetainedSourceMutationEvent {
  const snapshot: MemorySourceSnapshot = {
    activeLeafMessageId: "assistant-2",
    archived: false,
    folderId: null,
    id: "chat-1",
    memoryBranchGeneration: 0,
    memoryMode: "NORMAL",
    memorySourceRevision: 4,
    messages: [],
    projectId: null,
    sourceHash: "c".repeat(64),
    temporaryRetentionDeadline: null,
    temporaryRetentionPolicyVersion: null,
    userId: "owner-1"
  };
  const { messages: _messages, sourceHash: _sourceHash, ...chat } = snapshot;
  return {
    mutations: ["TERMINAL_SETTLEMENT"],
    previous: { ...chat, memorySourceRevision: 3 },
    settlement: { assistantMessageId: "assistant-2", runId: "run-2", status: "complete" },
    snapshot
  };
}

function sqlText(query: unknown): string {
  return Array.isArray(query)
    ? query.join("")
    : String((query as { sql?: unknown }).sql ?? "");
}

/** A settled turn on a chat whose indexed history stays on the active path. */
function settlementTransaction() {
  const create = vi.fn(async (_input: { data: Record<string, unknown> }) => ({
    id: "job-1",
    memoryGenerationSnapshot: 0,
    memoryRevisionSnapshot: 0,
    state: "QUEUED"
  }));
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => sqlText(query).includes("\"UserMemorySettings\"")
      ? [{
          memoryGeneration: 0,
          memoryRevision: 0,
          ownerStatus: "active",
          referenceChatHistory: true,
          useMemoryFacts: true,
          userId: "owner-1"
        }]
      : []),
    chatMemoryCheckpoint: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      upsert: vi.fn(async () => ({}))
    },
    memoryJob: { create, findUnique: vi.fn(async () => null) }
  } as unknown as MemoryTransaction;
  return { create, tx };
}

describe("memory history source lifecycle", () => {
  it("queues a settled turn's index job only after the quiet window", async () => {
    const { create, tx } = settlementTransaction();
    const before = Date.now();
    await applyMemoryHistorySourceMutation(tx, settledTurnEvent());
    const after = Date.now();

    expect(create).toHaveBeenCalledOnce();
    const data = create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      activeLeafMessageId: "assistant-2",
      chatId: "chat-1",
      kind: "INDEX_HISTORY",
      sourceRevision: 4
    });
    const notBefore = (data.nextAttemptAt as Date).getTime();
    expect(notBefore).toBeGreaterThanOrEqual(before + MEMORY_HISTORY_QUIET_WINDOW_MS);
    expect(notBefore).toBeLessThanOrEqual(after + MEMORY_HISTORY_QUIET_WINDOW_MS);
  });

  it("does not read, write, or enqueue artifacts for project chats", async () => {
    const tx = new Proxy({}, {
      get() {
        throw new Error("project_history_transaction_touched");
      }
    }) as MemoryTransaction;

    await expect(applyMemoryHistorySourceMutation(tx, projectEvent()))
      .resolves.toBeUndefined();
  });

  it("seeds a Normal branch with its source chat's Resume cutoff", async () => {
    const cutoff = new Date("2026-09-20T10:00:00.000Z");
    const { findUnique, tx, upsert } = checkpointTransaction(cutoff);

    await inheritMemoryHistoryBranchResumeCutoff(tx, branchEvent());

    expect(findUnique).toHaveBeenCalledWith({
      select: { resumeCreatedAtCutoff: true },
      where: { userId_chatId: { chatId: "chat-source", userId: "owner-1" } }
    });
    const checkpoint = {
      activeLeafMessageId: "assistant-branch",
      branchGeneration: 0,
      pipelineVersion: MEMORY_HISTORY_REBUILD_REQUIRED_CHECKPOINT_VERSION,
      resumeCreatedAtCutoff: cutoff,
      sourceContentHash: "b".repeat(64),
      sourceRevision: 1,
      status: "STALE"
    };
    expect(upsert).toHaveBeenCalledWith({
      create: { ...checkpoint, chatId: "chat-branch", userId: "owner-1" },
      update: checkpoint,
      where: { userId_chatId: { chatId: "chat-branch", userId: "owner-1" } }
    });
  });

  it("leaves a branch without a checkpoint when its source was never resumed", async () => {
    const { tx, upsert } = checkpointTransaction(null);

    await inheritMemoryHistoryBranchResumeCutoff(tx, branchEvent());

    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["an Excluded branch", branchEvent({ memoryMode: "EXCLUDED" })],
    ["a Project branch", branchEvent({ projectId: "project-1" })],
    ["an ordinary append", branchEvent({}, null)]
  ])("does not touch checkpoints for %s", async (_label, event) => {
    await expect(inheritMemoryHistoryBranchResumeCutoff(untouchedTransaction, event))
      .resolves.toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import type {
  LockedMemorySourceChat,
  MemoryRetainedSourceMutationEvent,
  MemorySourceSnapshot
} from "../sourceState";
import type { MemoryTransaction } from "../persistence/transaction";
import { MEMORY_HISTORY_REBUILD_REQUIRED_CHECKPOINT_VERSION } from "./contract";
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

describe("memory history source lifecycle", () => {
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

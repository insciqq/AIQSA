import { describe, expect, it } from "vitest";
import type {
  LockedMemorySourceChat,
  MemoryRetainedSourceMutationEvent,
  MemorySourceSnapshot
} from "../sourceState";
import type { MemoryTransaction } from "../persistence/transaction";
import { applyMemoryLearningSourceMutation } from "./sourceLifecycle";

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

describe("memory learning source lifecycle", () => {
  it("does not read, write, or enqueue automatic facts for project chats", async () => {
    const tx = new Proxy({}, {
      get() {
        throw new Error("project_learning_transaction_touched");
      }
    }) as MemoryTransaction;

    await expect(applyMemoryLearningSourceMutation(tx, projectEvent()))
      .resolves.toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { MemoryTransaction } from "../../persistence/transaction";
import type { MemoryRetainedSourceMutationEvent } from "../../sourceState";
import { normalizeMemoryFactsForSourceMutation } from "./normalization";

function folderMove(): MemoryRetainedSourceMutationEvent {
  const previous = {
    activeLeafMessageId: "message-1",
    archived: false,
    folderId: null,
    id: "chat-1",
    memoryBranchGeneration: 0,
    memoryMode: "NORMAL" as const,
    memorySourceRevision: 0,
    temporaryRetentionDeadline: null,
    temporaryRetentionPolicyVersion: null,
    userId: "user-1"
  };
  return {
    mutations: ["FOLDER_MOVE"],
    previous,
    snapshot: {
      ...previous,
      folderId: "folder-1",
      memorySourceRevision: 1,
      messages: [],
      sourceHash: "a".repeat(64)
    }
  };
}

describe("Memory evidence on folder moves", () => {
  it("preserves existing evidence when an unfiled chat enters a folder", async () => {
    const tx = new Proxy({}, {
      get() { throw new Error("unexpected_memory_evidence_mutation"); }
    }) as MemoryTransaction;

    await expect(normalizeMemoryFactsForSourceMutation(tx, folderMove()))
      .resolves.toBeNull();
  });

  it.each(["SOURCE_EXCLUDE", "SOURCE_HARD_DELETE", "BRANCH_PATH_CHANGE"] as const)(
    "still checks evidence for a simultaneous %s",
    async (mutation) => {
      const event = folderMove();
      const query = vi.fn(async () => []);
      const tx = { $queryRaw: query } as unknown as MemoryTransaction;

      await normalizeMemoryFactsForSourceMutation(tx, {
        ...event,
        mutations: [...event.mutations, mutation],
        snapshot: {
          ...event.snapshot,
          memoryBranchGeneration: mutation === "BRANCH_PATH_CHANGE" ? 1 : 0
        }
      });

      expect(query).toHaveBeenCalledOnce();
    }
  );
});

import { describe, expect, it, vi } from "vitest";
import type { MemoryTransaction } from "./persistence/transaction";
import { deleteMemorySourceJobsForMessages } from "./sourceState";

function deletionTransaction() {
  let usageAttached = true;
  const tx = {
    memoryExecutionBinding: {
      findMany: vi.fn(async () => [{ id: "execution" }])
    },
    memoryJob: {
      deleteMany: vi.fn(async () => {
        if (usageAttached) throw new Error("UsageEvent_memory_execution_fkey");
        return { count: 2 };
      }),
      findMany: vi.fn(async () => [{ id: "leaf-job" }, { id: "source-job" }])
    },
    usageEvent: {
      updateMany: vi.fn(async () => {
        usageAttached = false;
        return { count: 1 };
      })
    }
  };
  return { client: tx as unknown as MemoryTransaction, tx };
}

const input = { chatId: "chat", messageIds: ["message", "child"], userId: "owner" };

describe("Memory source job deletion", () => {
  it("detaches usage before cascading the selected jobs' execution bindings", async () => {
    const { client, tx } = deletionTransaction();

    await expect(deleteMemorySourceJobsForMessages(client, input)).resolves.toBe(2);

    expect(tx.memoryJob.findMany).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        chatId: "chat",
        OR: [
          { activeLeafMessageId: { in: ["message", "child"] } },
          { sourceMessageId: { in: ["message", "child"] } }
        ],
        userId: "owner"
      }
    });
    expect(tx.memoryExecutionBinding.findMany).toHaveBeenCalledWith({
      select: { id: true },
      where: { memoryJobId: { in: ["leaf-job", "source-job"] }, userId: "owner" }
    });
    expect(tx.usageEvent.updateMany).toHaveBeenCalledExactlyOnceWith({
      data: { memoryExecutionBindingId: null, providerModelId: null },
      where: { memoryExecutionBindingId: { in: ["execution"] }, userId: "owner" }
    });
    expect(tx.memoryJob.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: { in: ["leaf-job", "source-job"] }, userId: "owner" }
    });
  });

  it("does nothing for an empty message selection", async () => {
    const { client, tx } = deletionTransaction();
    await expect(deleteMemorySourceJobsForMessages(client, { ...input, messageIds: [] }))
      .resolves.toBe(0);
    expect(tx.memoryJob.findMany).not.toHaveBeenCalled();
    expect(tx.memoryExecutionBinding.findMany).not.toHaveBeenCalled();
    expect(tx.usageEvent.updateMany).not.toHaveBeenCalled();
    expect(tx.memoryJob.deleteMany).not.toHaveBeenCalled();
  });

  it("does nothing when no jobs match", async () => {
    const { client, tx } = deletionTransaction();
    tx.memoryJob.findMany.mockResolvedValue([]);
    await expect(deleteMemorySourceJobsForMessages(client, input)).resolves.toBe(0);
    expect(tx.memoryExecutionBinding.findMany).not.toHaveBeenCalled();
    expect(tx.usageEvent.updateMany).not.toHaveBeenCalled();
    expect(tx.memoryJob.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes jobs with no executions without touching usage", async () => {
    const { client, tx } = deletionTransaction();
    tx.memoryExecutionBinding.findMany.mockResolvedValue([]);
    tx.memoryJob.deleteMany.mockResolvedValue({ count: 2 });
    await expect(deleteMemorySourceJobsForMessages(client, input)).resolves.toBe(2);
    expect(tx.usageEvent.updateMany).not.toHaveBeenCalled();
    expect(tx.memoryJob.deleteMany).toHaveBeenCalledOnce();
  });

  it("does not delete jobs when usage detachment fails", async () => {
    const { client, tx } = deletionTransaction();
    const failure = new Error("synthetic detach failure");
    tx.usageEvent.updateMany.mockRejectedValue(failure);
    await expect(deleteMemorySourceJobsForMessages(client, input)).rejects.toBe(failure);
    expect(tx.memoryJob.deleteMany).not.toHaveBeenCalled();
  });
});

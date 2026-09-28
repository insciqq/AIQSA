import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  applyMemoryAssistantAvailabilityChange: vi.fn(async () => true),
  applyMemoryScopeTargetDeletion: vi.fn(async () => 0)
}));
vi.mock("./scopeLifecycle", () => lifecycle);

import type { MemoryTransaction } from "./persistence/transaction";
import { defaultMemorySourceMutationHooks } from "./sourceHooks";

const tx = {} as MemoryTransaction;

describe("default Memory scoped-target owner lifecycle routing", () => {
  beforeEach(() => {
    lifecycle.applyMemoryAssistantAvailabilityChange.mockClear();
    lifecycle.applyMemoryScopeTargetDeletion.mockClear();
  });

  it.each([
    ["ASSISTANT_DELETE", "ASSISTANT"],
    ["CHAT_DELETE", "CHAT"],
    ["FOLDER_DELETE", "FOLDER"]
  ] as const)("orphans the %s target scope", async (kind, scopeType) => {
    await defaultMemorySourceMutationHooks.onScopedTargetOwnerLifecycle?.(tx, {
      kind, sourceSnapshots: [], targetId: "target-1", userId: "user-1"
    });
    expect(lifecycle.applyMemoryScopeTargetDeletion).toHaveBeenCalledWith(tx, {
      scopeType, targetId: "target-1", userId: "user-1"
    });
    expect(lifecycle.applyMemoryAssistantAvailabilityChange).not.toHaveBeenCalled();
  });

  it("keeps Assistant availability changes non-destructive", async () => {
    await defaultMemorySourceMutationHooks.onScopedTargetOwnerLifecycle?.(tx, {
      kind: "ASSISTANT_ACCESS_CHANGE", sourceSnapshots: [], targetId: "assistant-1", userId: "user-1"
    });
    expect(lifecycle.applyMemoryAssistantAvailabilityChange).toHaveBeenCalledWith(tx, {
      assistantId: "assistant-1", userId: "user-1"
    });
    expect(lifecycle.applyMemoryScopeTargetDeletion).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { resolveMemoryCoordinatorPolicy } from "./policy";
import { MemoryScheduler } from "./scheduler";

function scheduler(): MemoryScheduler {
  return new MemoryScheduler({ policy: resolveMemoryCoordinatorPolicy() });
}

describe("Memory scheduler", () => {
  it("gives safety work a bounded weighted turn", () => {
    const service = scheduler();
    const kinds = ["RECONCILE_BRANCH", "INDEX_HISTORY"] as const;

    expect(service.claimWaves(kinds)[0]).toEqual(["RECONCILE_BRANCH"]);
    expect(service.claimWaves(kinds)[0]).toEqual(["RECONCILE_BRANCH"]);
    expect(service.claimWaves(kinds)[0]).toEqual(["INDEX_HISTORY"]);
    expect(service.claimWaves(kinds)[0]).toEqual(["RECONCILE_BRANCH"]);
  });

  it("serializes one owner's work while allowing another owner to proceed", async () => {
    const service = scheduler();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const otherController = new AbortController();
    const releaseFirst = await service.acquireOwner("owner-a", firstController.signal);
    const granted = vi.fn();
    const second = service.acquireOwner("owner-a", secondController.signal)
      .then((release) => {
        granted();
        return release;
      });

    await Promise.resolve();
    expect(granted).not.toHaveBeenCalled();
    const releaseOther = await service.acquireOwner("owner-b", otherController.signal);
    releaseOther();
    releaseFirst();
    const releaseSecond = await second;
    expect(granted).toHaveBeenCalledOnce();
    releaseSecond();
  });

  it("removes an aborted owner waiter without consuming a later slot", async () => {
    const service = scheduler();
    const active = new AbortController();
    const waiting = new AbortController();
    const release = await service.acquireOwner("owner-a", active.signal);
    const rejected = service.acquireOwner("owner-a", waiting.signal);

    waiting.abort(new Error("test_abort"));
    await expect(rejected).rejects.toThrow("test_abort");
    release();
    const next = await service.acquireOwner("owner-a", new AbortController().signal);
    next();
  });
});

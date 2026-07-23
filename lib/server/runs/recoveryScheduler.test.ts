import { describe, expect, it, vi } from "vitest";
import { RunRecoveryScheduler } from "./recoveryScheduler";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("run recovery scheduler", () => {
  it("coalesces concurrent kicks and drains one pending pass", async () => {
    const first = deferred();
    const reconcile = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const scheduler = new RunRecoveryScheduler({ reconcile });

    scheduler.kick();
    scheduler.kick();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    scheduler.kick();
    scheduler.kick();
    first.resolve();
    await scheduler.reconcileNow();

    expect(reconcile).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });
});

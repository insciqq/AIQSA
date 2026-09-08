import { describe, expect, it, vi } from "vitest";
import { ingestionConcurrency, IngestionWorkPool, mapIngestionWork } from "./ingestionConcurrency";


function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

describe("bounded ingestion work", () => {
  it("rejects unsafe capacity before admitting work", () => {
    for (const value of [0, -1, 1.5, 65, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => ingestionConcurrency(value, 4, 64)).toThrow("knowledge_ingestion_concurrency_invalid");
    }
  });

  it("drains started work after failure without admitting the remaining queue", async () => {
    const second = deferred<number>();
    const worker = vi.fn(async (value: number) => {
      if (value === 0) throw new Error("failed_batch");
      return second.promise;
    });
    let finished = false;
    const run = mapIngestionWork([0, 1, 2, 3], 2, worker).catch(error => {
      finished = true;
      return error;
    });
    await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(2));
    expect(finished).toBe(false);
    second.resolve(1);
    expect(await run).toMatchObject({ message: "failed_batch" });
    expect(worker).toHaveBeenCalledTimes(2);
  });

  it("removes cancelled waiters and retains capacity until actual work settles", async () => {
    const pool = new IngestionWorkPool(1);
    const first = deferred<void>();
    const operation = vi.fn(() => first.promise);
    const running = pool.run(operation);
    const controller = new AbortController();
    const cancelled = pool.run(operation, controller.signal).catch(error => error);
    const lastOperation = vi.fn(async () => "last");
    const last = pool.run(lastOperation);
    controller.abort(new Error("cancelled_waiter"));
    expect(await cancelled).toMatchObject({ message: "cancelled_waiter" });
    expect(operation).toHaveBeenCalledOnce();
    expect(lastOperation).not.toHaveBeenCalled();
    first.resolve();
    await running;
    expect(await last).toBe("last");
    expect(operation).toHaveBeenCalledOnce();
  });
});

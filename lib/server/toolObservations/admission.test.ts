import { describe, expect, it, vi } from "vitest";
import { createObservationAdmission } from "./admission";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("bounded observation dispatch admission", () => {
  it("bounds active originals and waiting work, releasing the slot after failure", async () => {
    const admit = createObservationAdmission(2, 1);
    const first = deferred();
    const second = deferred();
    const queued = vi.fn(async () => 3);
    const a = admit(() => first.promise);
    const b = admit(() => second.promise);
    const c = admit(queued);
    const overflow = vi.fn(async () => 4);
    await expect(admit(overflow)).rejects.toThrow("tool_observation_limit_exceeded");
    expect(queued).not.toHaveBeenCalled();
    expect(overflow).not.toHaveBeenCalled();
    first.resolve();
    await a;
    expect(await c).toBe(3);
    second.reject(new Error("synthetic_failure"));
    await expect(b).rejects.toThrow("synthetic_failure");
    expect(await admit(async () => 5)).toBe(5);
  });

  it("removes cancelled waiters without executing them or leaking capacity", async () => {
    const admit = createObservationAdmission(1, 1);
    const active = deferred();
    const running = admit(() => active.promise);
    const controller = new AbortController();
    const work = vi.fn(async () => 1);
    const waiting = admit(work, controller.signal);
    controller.abort(new Error("synthetic_stop"));
    await expect(waiting).rejects.toThrow("synthetic_stop");
    const replacement = admit(async () => 2);
    active.resolve();
    await running;
    expect(await replacement).toBe(2);
    expect(work).not.toHaveBeenCalled();
    await expect(admit(work, controller.signal)).rejects.toThrow("synthetic_stop");
  });
});

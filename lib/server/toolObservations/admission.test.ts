import { describe, expect, it, vi } from "vitest";
import { createObservationAdmission } from "./admission";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("bounded observation storage admission", () => {
  it("bounds bytes in flight and waiting phases, releasing capacity after failure", async () => {
    const admit = createObservationAdmission(100, 1);
    const first = deferred();
    const second = deferred();
    const queued = vi.fn(async () => 3);
    const a = admit(60, () => first.promise);
    const b = admit(40, () => second.promise);
    const c = admit(10, queued);
    expect(admit.busy()).toBe(true);
    const overflow = vi.fn(async () => 4);
    await expect(admit(1, overflow)).rejects.toMatchObject({ code: "tool_observation_busy" });
    expect(queued).not.toHaveBeenCalled();
    expect(overflow).not.toHaveBeenCalled();
    first.resolve();
    await a;
    expect(await c).toBe(3);
    second.reject(new Error("synthetic_failure"));
    await expect(b).rejects.toThrow("synthetic_failure");
    expect(await admit(100, async () => 5)).toBe(5);
  });

  it("never discards an already executed result for queueing and keeps FIFO for a large waiter", async () => {
    const admit = createObservationAdmission(100, 0);
    const active = deferred();
    const running = admit(80, () => active.promise);
    const order: string[] = [];
    const large = admit(100, async () => { order.push("large"); }, { whenBusy: "wait" });
    // A smaller phase that would fit cannot overtake the waiting large phase.
    const small = admit(10, async () => { order.push("small"); }, { whenBusy: "wait" });
    await expect(admit(10, async () => undefined)).rejects.toMatchObject({ code: "tool_observation_busy" });
    active.resolve();
    await Promise.all([running, large, small]);
    expect(order).toEqual(["large", "small"]);
  });

  it("clamps a phase larger than the budget instead of blocking forever", async () => {
    const admit = createObservationAdmission(100, 1);
    expect(await admit(10_000, async () => "whole budget")).toBe("whole budget");
    await expect(admit(Number.NaN, async () => undefined)).rejects.toThrow("tool_observation_admission_invalid");
  });

  it("removes cancelled waiters without executing them or leaking capacity", async () => {
    const admit = createObservationAdmission(100, 2);
    const active = deferred();
    const running = admit(90, () => active.promise);
    const controller = new AbortController();
    const work = vi.fn(async () => 1);
    const waiting = admit(50, work, { signal: controller.signal });
    const smaller = admit(10, async () => 2);
    controller.abort(new Error("synthetic_stop"));
    await expect(waiting).rejects.toThrow("synthetic_stop");
    // The cancelled head no longer blocks a phase that fits.
    expect(await smaller).toBe(2);
    const replacement = admit(100, async () => 3);
    active.resolve();
    await running;
    expect(await replacement).toBe(3);
    expect(work).not.toHaveBeenCalled();
    await expect(admit(1, work, { signal: controller.signal })).rejects.toThrow("synthetic_stop");
  });
});

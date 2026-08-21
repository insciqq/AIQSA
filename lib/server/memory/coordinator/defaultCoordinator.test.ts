import { describe, expect, it } from "vitest";
import {
  kickDefaultMemoryCoordinator,
  reconcileDefaultMemoryWork
} from "./defaultCoordinator";

describe("default Memory coordinator composition", () => {
  it("keeps request-side queue wakes from starting a second claimant", () => {
    const scope = globalThis as typeof globalThis & {
      __aiqsaMemoryCoordinator?: unknown;
    };
    const previous = scope.__aiqsaMemoryCoordinator;
    delete scope.__aiqsaMemoryCoordinator;
    try {
      kickDefaultMemoryCoordinator();
      expect(scope.__aiqsaMemoryCoordinator).toBeUndefined();
    } finally {
      if (previous !== undefined) scope.__aiqsaMemoryCoordinator = previous;
    }
  });

  it("runs only candidate reconciliation in the periodic pass", async () => {
    const order: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const step = (name: string) => async () => {
      order.push(`${name}:start`);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      order.push(`${name}:end`);
    };

    await reconcileDefaultMemoryWork({
      candidates: step("candidates")
    });

    expect(maximumActive).toBe(1);
    expect(order).toEqual([
      "candidates:start",
      "candidates:end"
    ]);
  });
});

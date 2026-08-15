import { describe, expect, it } from "vitest";
import { reconcileDefaultMemoryWork } from "./defaultCoordinator";

describe("default Memory coordinator composition", () => {
  it("serializes owner-locking discovery work", async () => {
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
      candidates: step("candidates"),
      history: step("history")
    });

    expect(maximumActive).toBe(1);
    expect(order).toEqual([
      "history:start",
      "history:end",
      "candidates:start",
      "candidates:end"
    ]);
  });
});

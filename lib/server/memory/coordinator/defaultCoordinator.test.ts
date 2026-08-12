import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_COORDINATOR_MANIFEST,
  ensureDefaultMemoryHandlersRegistered,
  reconcileDefaultMemoryWork
} from "./defaultCoordinator";
import { defaultMemoryCoordinatorRegistry } from "./registry";

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
      dream: step("dream"),
      history: step("history"),
      profile: step("profile")
    });

    expect(maximumActive).toBe(1);
    expect(order).toEqual([
      "history:start",
      "history:end",
      "candidates:start",
      "candidates:end",
      "dream:start",
      "dream:end",
      "profile:start",
      "profile:end"
    ]);
  });

  it("registers the exact current job and deletion manifest idempotently", () => {
    ensureDefaultMemoryHandlersRegistered();
    ensureDefaultMemoryHandlersRegistered();

    expect(new Set(defaultMemoryCoordinatorRegistry.deletionOperations())).toEqual(
      new Set(DEFAULT_MEMORY_COORDINATOR_MANIFEST.deletionOperations)
    );
    expect(new Set(defaultMemoryCoordinatorRegistry.jobKinds())).toEqual(
      new Set(DEFAULT_MEMORY_COORDINATOR_MANIFEST.jobKinds)
    );
    for (const operation of DEFAULT_MEMORY_COORDINATOR_MANIFEST
      .deletionOperations) {
      expect(defaultMemoryCoordinatorRegistry.deletionHandler(operation)?.operation)
        .toBe(operation);
    }
    for (const kind of DEFAULT_MEMORY_COORDINATOR_MANIFEST.jobKinds) {
      expect(defaultMemoryCoordinatorRegistry.jobHandler(kind)?.kind).toBe(kind);
    }
  });
});

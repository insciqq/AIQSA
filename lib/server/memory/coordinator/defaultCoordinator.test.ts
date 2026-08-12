import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_COORDINATOR_MANIFEST,
  ensureDefaultMemoryHandlersRegistered
} from "./defaultCoordinator";
import { defaultMemoryCoordinatorRegistry } from "./registry";

describe("default Memory coordinator composition", () => {
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

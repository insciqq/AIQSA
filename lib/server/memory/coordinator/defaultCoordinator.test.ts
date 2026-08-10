import { describe, expect, it } from "vitest";
import {
  ensureDefaultMemoryPhase4HandlersRegistered
} from "./defaultCoordinator";
import { defaultMemoryCoordinatorRegistry } from "./registry";

describe("default Memory coordinator composition", () => {
  it("registers purge, history, and optional vector leaves idempotently", () => {
    ensureDefaultMemoryPhase4HandlersRegistered();
    ensureDefaultMemoryPhase4HandlersRegistered();

    expect(defaultMemoryCoordinatorRegistry.deletionOperations()).toContain("FORGET_PURGE");
    expect(defaultMemoryCoordinatorRegistry.deletionOperations()).toContain("TEMPORARY_DELETE");
    expect(defaultMemoryCoordinatorRegistry.jobKinds()).toContain("EMBED_ITEMS");
    expect(defaultMemoryCoordinatorRegistry.jobKinds()).toContain("INDEX_HISTORY");
    expect(defaultMemoryCoordinatorRegistry.jobHandler("EMBED_ITEMS")?.kind).toBe("EMBED_ITEMS");
    expect(defaultMemoryCoordinatorRegistry.jobHandler("INDEX_HISTORY")?.kind)
      .toBe("INDEX_HISTORY");
  });
});

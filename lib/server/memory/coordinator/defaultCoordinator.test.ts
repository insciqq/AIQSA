import { describe, expect, it } from "vitest";
import {
  ensureDefaultMemoryPhase2HandlersRegistered
} from "./defaultCoordinator";
import { defaultMemoryCoordinatorRegistry } from "./registry";

describe("default Phase 2 Memory coordinator composition", () => {
  it("registers purge and optional vector leaves idempotently", () => {
    ensureDefaultMemoryPhase2HandlersRegistered();
    ensureDefaultMemoryPhase2HandlersRegistered();

    expect(defaultMemoryCoordinatorRegistry.deletionOperations()).toContain("FORGET_PURGE");
    expect(defaultMemoryCoordinatorRegistry.jobKinds()).toContain("EMBED_ITEMS");
    expect(defaultMemoryCoordinatorRegistry.jobHandler("EMBED_ITEMS")?.kind).toBe("EMBED_ITEMS");
  });
});

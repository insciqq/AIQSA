import { describe, expect, it } from "vitest";
import { activeRunControllerRegistry as registry, activeRunControllers, runSettlements } from "./activeRunControllerRegistry";

describe("the runs executing in this process", () => {
  it("keeps a run Stop aborted until its terminal handling is over, though Stop can no longer reach it", () => {
    activeRunControllers.set("run-stopped", new AbortController());
    runSettlements.set("run-stopped", Promise.resolve());
    expect(registry.abort("run-stopped")).toBe(true);
    expect(registry.ids()).not.toContain("run-stopped");
    expect(registry.executing()).toContain("run-stopped");
    runSettlements.delete("run-stopped");
    expect(registry.executing()).not.toContain("run-stopped");
  });

  it("keeps a leased run through its abort until the lease is released", () => {
    const lease = registry.register("run-leased")!;
    expect(registry.executing()).toContain("run-leased");
    registry.abort("run-leased");
    expect(registry.ids()).not.toContain("run-leased");
    expect(registry.executing()).toContain("run-leased");
    lease.release();
    expect(registry.executing()).not.toContain("run-leased");
  });

  it("lists a run once, however many facts say it executes", () => {
    const lease = registry.register("run-both")!;
    runSettlements.set("run-both", Promise.resolve());
    expect(registry.executing().filter((id) => id === "run-both")).toHaveLength(1);
    runSettlements.delete("run-both");
    lease.release();
  });
});

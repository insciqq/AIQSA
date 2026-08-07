import { describe, expect, it, vi } from "vitest";
import { createToolHiveRuntimeLifecycle } from "./defaultToolHive";
import { createInFlightValidationWorkloadRegistry } from "./inFlightValidationWorkloads";

describe("default ToolHive runtime lifecycle", () => {
  it("merges durable generations with in-flight validation workloads", async () => {
    const cleanupOwnedWorkloads = vi.fn(async () => [] as string[]);
    const registry = createInFlightValidationWorkloadRegistry();
    const first = registry.register("validation-one");
    const duplicate = registry.register("durable-generation");
    const lifecycle = createToolHiveRuntimeLifecycle({ cleanupOwnedWorkloads }, registry);

    await lifecycle.cleanupOrphans(["durable-generation", "activation-token"]);

    expect(cleanupOwnedWorkloads).toHaveBeenCalledWith({
      keepGenerationTokens: ["durable-generation", "activation-token", "validation-one"]
    });
    first.release();
    duplicate.release();
    await lifecycle.cleanupOrphans(["durable-generation"]);
    expect(cleanupOwnedWorkloads).toHaveBeenLastCalledWith({
      keepGenerationTokens: ["durable-generation"]
    });
  });
});

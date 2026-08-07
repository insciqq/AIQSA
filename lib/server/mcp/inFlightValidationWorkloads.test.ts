import { describe, expect, it } from "vitest";
import { createInFlightValidationWorkloadRegistry } from "./inFlightValidationWorkloads";

describe("in-flight MCP validation workload registry", () => {
  it("reference-counts duplicate tokens and scopes release to its registration", () => {
    const registry = createInFlightValidationWorkloadRegistry();
    const first = registry.register("token-b");
    const duplicate = registry.register("token-b");
    const other = registry.register("token-a");

    expect(registry.snapshot()).toEqual(["token-a", "token-b"]);
    first.release();
    first.release();
    expect(registry.snapshot()).toEqual(["token-a", "token-b"]);
    other.release();
    expect(registry.snapshot()).toEqual(["token-b"]);
    duplicate.release();
    expect(registry.snapshot()).toEqual([]);
  });
});

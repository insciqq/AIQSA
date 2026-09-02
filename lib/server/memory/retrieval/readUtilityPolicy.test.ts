import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_READ_UTILITY_POLICY,
  LEGACY_MEMORY_READ_UTILITY_POLICY,
  MEMORY_READ_UTILITY_POLICIES
} from "./readUtilityPolicy";

describe("Memory read utility policy", () => {
  it("uses deterministic reads as the sole production default", () => {
    expect(DEFAULT_MEMORY_READ_UTILITY_POLICY).toBe("DETERMINISTIC_READ_V1");
    expect(LEGACY_MEMORY_READ_UTILITY_POLICY).toBe("CONTROL_RESOLVER_V1");
    expect(MEMORY_READ_UTILITY_POLICIES).toEqual([
      "CONTROL_RESOLVER_V1",
      "DETERMINISTIC_READ_V1"
    ]);
  });
});

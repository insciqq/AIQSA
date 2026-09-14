import { describe, expect, it } from "vitest";
import { assertMemoryReadUtilityAudit, assertMemoryReadUtilityExecutions } from "./readUtilityAudit";

describe("LongMemEval read utility evidence", () => {
  it("accepts the shared intent classifier while retrieval remains deterministic", () => {
    expect(() => assertMemoryReadUtilityAudit("DETERMINISTIC_READ_V1", {
      memoryReadUtilityPolicy: "DETERMINISTIC_READ_V1", controlProviderCalls: 1,
      queryResolverProviderCalls: 0
    })).not.toThrow();
    expect(() => assertMemoryReadUtilityExecutions("DETERMINISTIC_READ_V1", [
      { role: "MEMORY_CONTROL" }, { role: "MEMORY_QUERY_EMBED" }, { role: "MEMORY_RERANK" }
    ])).not.toThrow();
  });

  it("still rejects query resolver dispatch from either persisted evidence surface", () => {
    expect(() => assertMemoryReadUtilityAudit("DETERMINISTIC_READ_V1", {
      memoryReadUtilityPolicy: "DETERMINISTIC_READ_V1", controlProviderCalls: 1,
      queryResolverProviderCalls: 1
    })).toThrow("longmemeval_memory_read_utility_call_detected");
    expect(() => assertMemoryReadUtilityExecutions("DETERMINISTIC_READ_V1", [
      { role: "MEMORY_QUERY_RESOLVE" }
    ])).toThrow("longmemeval_memory_read_utility_execution_detected");
  });

  it("preserves the accepted policy identity check", () => {
    expect(() => assertMemoryReadUtilityAudit("DETERMINISTIC_READ_V1", {
      memoryReadUtilityPolicy: "CONTROL_RESOLVER_V1", controlProviderCalls: 1,
      queryResolverProviderCalls: 0
    })).toThrow("longmemeval_memory_read_policy_mismatch");
  });

  it.each([null, -1, 0.5])("rejects unavailable or invalid classifier accounting: %s", (controlProviderCalls) => {
    expect(() => assertMemoryReadUtilityAudit("DETERMINISTIC_READ_V1", {
      memoryReadUtilityPolicy: "DETERMINISTIC_READ_V1", controlProviderCalls,
      queryResolverProviderCalls: 0
    })).toThrow("longmemeval_memory_read_utility_call_detected");
  });

  it("permits resolver evidence for the legacy resolver policy", () => {
    expect(() => assertMemoryReadUtilityAudit("CONTROL_RESOLVER_V1", {
      memoryReadUtilityPolicy: "CONTROL_RESOLVER_V1", controlProviderCalls: 1,
      queryResolverProviderCalls: 1
    })).not.toThrow();
    expect(() => assertMemoryReadUtilityExecutions("CONTROL_RESOLVER_V1", [
      { role: "MEMORY_QUERY_RESOLVE" }
    ])).not.toThrow();
  });
});

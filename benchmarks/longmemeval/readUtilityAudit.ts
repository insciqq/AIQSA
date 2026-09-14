import type { MemoryReadUtilityPolicy } from "../../lib/server/memory/retrieval/readUtilityPolicy";
import type { LongMemEvalRetrievalAudit } from "./contract";

type ReadUtilityAudit = Pick<LongMemEvalRetrievalAudit,
  "memoryReadUtilityPolicy" | "controlProviderCalls" | "queryResolverProviderCalls">;

export function assertMemoryReadUtilityAudit(
  policy: MemoryReadUtilityPolicy,
  audit: ReadUtilityAudit
): void {
  if (audit.memoryReadUtilityPolicy !== policy) {
    throw new Error("longmemeval_memory_read_policy_mismatch");
  }
  // Intent classification is shared with explicit memory actions. Deterministic
  // retrieval does not imply language-specific, provider-free intent routing.
  if (policy === "DETERMINISTIC_READ_V1" &&
    (audit.controlProviderCalls === null || !Number.isInteger(audit.controlProviderCalls) ||
      audit.controlProviderCalls < 0 || audit.queryResolverProviderCalls !== 0)) {
    throw new Error("longmemeval_memory_read_utility_call_detected");
  }
}

export function assertMemoryReadUtilityExecutions(
  policy: MemoryReadUtilityPolicy,
  aggregates: readonly Readonly<{ role: string }>[]
): void {
  if (policy === "DETERMINISTIC_READ_V1" && aggregates.some(({ role }) =>
    role === "MEMORY_QUERY_RESOLVE")) {
    throw new Error("longmemeval_memory_read_utility_execution_detected");
  }
}

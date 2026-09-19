import { describe, expect, it } from "vitest";
import { authorizeMemoryExecutionResultsForCommit } from "./lifecycle";
import type { LockedMemorySettings, MemoryTransaction } from "../persistence/transaction";

describe("Memory result commit input bounds", () => {
  it.each(["empty", "oversized", "duplicate", "binding", "output_hash", "input_hash", "owner"])(
    "rejects %s input before database access", async (scenario) => {
      const result = { bindingId: "binding-1", acceptedOutputHash: "a".repeat(64) };
      const results = scenario === "empty" ? []
        : scenario === "oversized" ? Array.from({ length: 33 }, (_, i) => ({ ...result, bindingId: `binding-${i}` }))
        : scenario === "duplicate" ? [result, result]
        : scenario === "binding" ? [{ ...result, bindingId: "" }]
        : scenario === "output_hash" ? [{ ...result, acceptedOutputHash: "invalid" }]
        : scenario === "input_hash" ? [{ ...result, inputHash: "invalid" }]
        : [result];
      await expect(authorizeMemoryExecutionResultsForCommit({}, {} as MemoryTransaction,
        { userId: scenario === "owner" ? "other-owner" : "user-1" } as LockedMemorySettings,
        "user-1", { memoryJobId: "job-1", role: "MEMORY_HISTORY_CLASSIFY" }, results))
        .rejects.toMatchObject({ code: "memory_execution_input_invalid" });
    }
  );
});

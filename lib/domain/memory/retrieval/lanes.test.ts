import { describe, expect, it } from "vitest";
import { MEMORY_RETRIEVAL_LANE_ORDER, type MemoryRetrievalLane } from "./config";
import { allocateMemoryRetrievalLaneLimits, executeMemoryRetrievalLaneTasks } from "./lanes";

describe("Memory retrieval lane scheduler", () => {
  it("executes the language-agnostic lane set in stable task order", async () => {
    const lanes = [...MEMORY_RETRIEVAL_LANE_ORDER];
    const result = await executeMemoryRetrievalLaneTasks(lanes.map((lane) => ({
      async execute() {
        await Promise.resolve();
        return { candidates: [], lane };
      },
      lane
    })));
    expect(result.map(({ lane }) => lane)).toEqual(lanes);
  });

  it("rejects duplicate tasks and excess parallelism", async () => {
    const task = {
      async execute() { return { candidates: [], lane: "FACT_EXACT" as const }; },
      lane: "FACT_EXACT" as const
    };
    await expect(executeMemoryRetrievalLaneTasks([task, task])).rejects
      .toThrow("memory_retrieval_lane_contract_invalid");
    await expect(executeMemoryRetrievalLaneTasks([task], 5)).rejects
      .toThrow("memory_retrieval_lane_contract_invalid");
  });

  it("allocates all configured lanes under the shared candidate ceiling", () => {
    const lanes: readonly MemoryRetrievalLane[] = MEMORY_RETRIEVAL_LANE_ORDER;
    const allocation = allocateMemoryRetrievalLaneLimits(lanes);
    expect(Object.keys(allocation).sort()).toEqual([...lanes].sort());
    expect(Object.values(allocation).reduce((sum, value) => sum + (value ?? 0), 0))
      .toBeLessThanOrEqual(120);
  });
});

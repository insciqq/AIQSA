import { describe, expect, it } from "vitest";
import type { MemoryRetrievalLane } from "./config";
import {
  allocateMemoryRetrievalLaneLimits,
  executeMemoryRetrievalLaneTasks
} from "./lanes";

describe("Memory retrieval lane executor", () => {
  it("runs independent lanes with bounded parallelism and stable result order", async () => {
    const lanes = [
      "FACT_EXACT",
      "FACT_CANONICAL",
      "FACT_FTS_RUSSIAN",
      "FACT_FTS_ENGLISH",
      "FACT_FTS_SIMPLE",
      "FACT_VECTOR"
    ] as const satisfies readonly MemoryRetrievalLane[];
    let active = 0;
    let maximumActive = 0;
    const results = await executeMemoryRetrievalLaneTasks(lanes.map((lane) => ({
      async execute() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return { candidates: [], lane };
      },
      lane
    })), 3);
    expect(maximumActive).toBe(3);
    expect(results.map((result) => result.lane)).toEqual(lanes);
  });

  it("rejects duplicate lanes and excess parallelism", async () => {
    const task = { async execute() { return { candidates: [], lane: "FACT_EXACT" as const }; }, lane: "FACT_EXACT" as const };
    await expect(executeMemoryRetrievalLaneTasks([task, task], 2))
      .rejects.toThrow("memory_retrieval_lane_contract_invalid");
    await expect(executeMemoryRetrievalLaneTasks([task], 5))
      .rejects.toThrow("memory_retrieval_lane_contract_invalid");
  });

  it("allocates a deterministic global pre-fusion budget across enabled lanes", () => {
    const lanes = [
      "FACT_EXACT",
      "FACT_CANONICAL",
      "FACT_FTS_RUSSIAN",
      "FACT_FTS_ENGLISH",
      "FACT_FTS_SIMPLE",
      "FACT_VECTOR",
      "FACT_TEMPORAL",
      "HISTORY_ENTITY_TIME",
      "HISTORY_EPISODE_FTS_RUSSIAN",
      "HISTORY_EPISODE_FTS_ENGLISH",
      "HISTORY_EPISODE_FTS_SIMPLE",
      "HISTORY_EPISODE_VECTOR",
      "HISTORY_RECALL_FTS_RUSSIAN",
      "HISTORY_RECALL_FTS_ENGLISH",
      "HISTORY_RECALL_FTS_SIMPLE",
      "HISTORY_RECALL_VECTOR"
    ] as const satisfies readonly MemoryRetrievalLane[];
    const allocation = allocateMemoryRetrievalLaneLimits(lanes);
    expect(Object.values(allocation).reduce((total, limit) => total + (limit ?? 0), 0)).toBe(150);
    expect(Object.values(allocation).every((limit) => Number.isSafeInteger(limit) && limit > 0))
      .toBe(true);
    expect(allocateMemoryRetrievalLaneLimits(lanes)).toEqual(allocation);
  });
});

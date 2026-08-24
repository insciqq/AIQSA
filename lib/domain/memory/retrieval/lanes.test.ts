import { describe, expect, it } from "vitest";
import {
  MEMORY_RETRIEVAL_LANE_ORDER,
  MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES,
  type MemoryRetrievalLane
} from "./config";
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
    const lanes: readonly MemoryRetrievalLane[] = MEMORY_RETRIEVAL_LANE_ORDER.filter(
      (lane) => lane !== "FACT_PROFILE"
    );
    const allocation = allocateMemoryRetrievalLaneLimits(lanes);
    for (const lane of lanes) expect(allocation[lane]).toBeGreaterThan(0);
    expect(allocation).toEqual({
      FACT_EXACT: 4,
      FACT_ENTITY: 5,
      FACT_FTS_SIMPLE: 5,
      FACT_RECENT: 2,
      FACT_VECTOR: 5,
      HISTORY_RECALL_EXACT: 2,
      HISTORY_RECALL_FTS_SIMPLE: 3,
      HISTORY_RECALL_RECENT: 1,
      HISTORY_RECALL_VECTOR: 3
    });
    expect(Object.values(allocation).reduce((sum, value) => sum + (value ?? 0), 0))
      .toBe(MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES);
  });

  it("keeps the bounded profile lane isolated from targeted lane allocation", () => {
    expect(allocateMemoryRetrievalLaneLimits(["FACT_PROFILE"]))
      .toEqual({ FACT_PROFILE: 20 });
    expect(() => allocateMemoryRetrievalLaneLimits(["FACT_PROFILE", "FACT_VECTOR"]))
      .toThrow("memory_retrieval_lane_contract_invalid");
  });
});

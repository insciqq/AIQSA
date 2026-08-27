import { describe, expect, it } from "vitest";
import {
  MEMORY_RETRIEVAL_MAX_AGGREGATION_PRE_FUSION_CANDIDATES,
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
      FACT_ENTITY: 6,
      FACT_FTS_ENGLISH: 5,
      FACT_FTS_RUSSIAN: 5,
      FACT_FTS_SIMPLE: 5,
      FACT_RECENT: 2,
      FACT_TEMPORAL_FILTERED: 5,
      FACT_TEMPORAL_UNRESTRICTED: 2,
      FACT_TRIGRAM: 4,
      FACT_VECTOR: 5,
      HISTORY_DIGEST_FTS_SIMPLE: 14,
      HISTORY_RECALL_EXACT: 5,
      HISTORY_RECALL_FTS_ENGLISH: 14,
      HISTORY_RECALL_FTS_RUSSIAN: 14,
      HISTORY_RECALL_FTS_SIMPLE: 14,
      HISTORY_RECALL_RECENT: 5,
      HISTORY_RECALL_TEMPORAL_FILTERED: 11,
      HISTORY_RECALL_TEMPORAL_UNRESTRICTED: 4,
      HISTORY_RECALL_TRIGRAM: 9,
      HISTORY_RECALL_VECTOR: 27
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

  it("gives aggregation history lanes a larger bounded ceiling", () => {
    const targetedHistory = [
      "HISTORY_RECALL_EXACT",
      "HISTORY_DIGEST_FTS_SIMPLE",
      "HISTORY_RECALL_FTS_SIMPLE",
      "HISTORY_RECALL_RECENT",
      "HISTORY_RECALL_VECTOR"
    ] as const;
    expect(allocateMemoryRetrievalLaneLimits(targetedHistory)).toEqual({
      HISTORY_RECALL_EXACT: 12,
      HISTORY_DIGEST_FTS_SIMPLE: 30,
      HISTORY_RECALL_FTS_SIMPLE: 30,
      HISTORY_RECALL_RECENT: 12,
      HISTORY_RECALL_VECTOR: 60
    });
    const aggregationHistoryLanes = [
      "HISTORY_RECALL_EXACT",
      "HISTORY_RECALL_FTS_SIMPLE",
      "HISTORY_RECALL_VECTOR"
    ] as const;
    expect(allocateMemoryRetrievalLaneLimits(aggregationHistoryLanes, true)).toEqual({
      HISTORY_RECALL_EXACT: 8,
      HISTORY_RECALL_FTS_SIMPLE: 40,
      HISTORY_RECALL_VECTOR: 120
    });
    expect(Object.values(allocateMemoryRetrievalLaneLimits(aggregationHistoryLanes, true))
      .reduce((sum, value) => sum + (value ?? 0), 0))
      .toBeLessThanOrEqual(MEMORY_RETRIEVAL_MAX_AGGREGATION_PRE_FUSION_CANDIDATES);
  });
});

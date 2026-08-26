import {
  MEMORY_RETRIEVAL_MAX_AGGREGATION_PRE_FUSION_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_PARALLEL_LANES,
  MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES,
  MEMORY_RETRIEVAL_LANE_ORDER,
  memoryRetrievalLaneLimit,
  type MemoryRetrievalLane
} from "./config";
import type { MemoryLaneResult } from "./contracts";

export type MemoryRetrievalLaneTask = Readonly<{
  execute(): Promise<MemoryLaneResult>;
  lane: MemoryRetrievalLane;
}>;

export type MemoryRetrievalLaneLimitAllocation = Readonly<
  Partial<Record<MemoryRetrievalLane, number>>
>;

export function allocateMemoryRetrievalLaneLimits(
  lanes: readonly MemoryRetrievalLane[],
  aggregationRequested = false
): MemoryRetrievalLaneLimitAllocation {
  const profileRequested = lanes.includes("FACT_PROFILE");
  if (
    lanes.length === 0 || lanes.length > MEMORY_RETRIEVAL_LANE_ORDER.length ||
    new Set(lanes).size !== lanes.length ||
    lanes.some((lane) => !MEMORY_RETRIEVAL_LANE_ORDER.includes(lane)) ||
    (profileRequested && lanes.length !== 1) ||
    typeof aggregationRequested !== "boolean"
  ) throw new Error("memory_retrieval_lane_contract_invalid");
  const configuredTotal = lanes.reduce(
    (total, lane) => total + memoryRetrievalLaneLimit(lane, aggregationRequested),
    0
  );
  const candidateCeiling = aggregationRequested
    ? MEMORY_RETRIEVAL_MAX_AGGREGATION_PRE_FUSION_CANDIDATES
    : MEMORY_RETRIEVAL_MAX_PRE_FUSION_CANDIDATES;
  if (configuredTotal <= candidateCeiling) {
    return Object.freeze(Object.fromEntries(
      lanes.map((lane) => [lane, memoryRetrievalLaneLimit(lane, aggregationRequested)])
    ));
  }
  const scale = candidateCeiling / configuredTotal;
  const allocations = lanes.map((lane) => {
    const scaled = memoryRetrievalLaneLimit(lane, aggregationRequested) * scale;
    return { fraction: scaled - Math.floor(scaled), lane, limit: Math.max(1, Math.floor(scaled)) };
  });
  let remaining = candidateCeiling - allocations.reduce(
    (total, allocation) => total + allocation.limit,
    0
  );
  const priority = new Map(MEMORY_RETRIEVAL_LANE_ORDER.map((lane, index) => [lane, index]));
  for (const allocation of [...allocations].sort((left, right) =>
    right.fraction - left.fraction ||
    (priority.get(left.lane) ?? Number.MAX_SAFE_INTEGER) -
      (priority.get(right.lane) ?? Number.MAX_SAFE_INTEGER)
  )) {
    if (remaining <= 0) break;
    allocation.limit += 1;
    remaining -= 1;
  }
  return Object.freeze(Object.fromEntries(
    allocations.map(({ lane, limit }) => [lane, limit])
  ));
}

export async function executeMemoryRetrievalLaneTasks(
  tasks: readonly MemoryRetrievalLaneTask[],
  parallelism = MEMORY_RETRIEVAL_MAX_PARALLEL_LANES
): Promise<readonly MemoryLaneResult[]> {
  if (
    !Number.isSafeInteger(parallelism) ||
    parallelism < 1 || parallelism > MEMORY_RETRIEVAL_MAX_PARALLEL_LANES ||
    tasks.length > MEMORY_RETRIEVAL_LANE_ORDER.length ||
    new Set(tasks.map((task) => task.lane)).size !== tasks.length
  ) throw new Error("memory_retrieval_lane_contract_invalid");
  const results = new Array<MemoryLaneResult>(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      const task = tasks[index];
      if (!task) continue;
      const result = await task.execute();
      if (result.lane !== task.lane) throw new Error("memory_retrieval_lane_contract_invalid");
      results[index] = result;
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(parallelism, tasks.length) },
    () => worker()
  ));
  return results;
}

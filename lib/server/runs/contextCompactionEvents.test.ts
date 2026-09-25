import { describe, expect, it } from "vitest";
import { makeContextCompactionStatus, mergeContextCompactionStatus, type ContextCompactionStatus, type ContextPlanMeasurement } from "../../contracts/contextCompaction";
import { createContextCompactionPublisher } from "./contextCompactionEvents";

const measured = (beforeTokens: number, afterTokens: number): ContextPlanMeasurement => ({
  afterTokens, beforeTokens, budgetTokens: 1_000, legacyFallback: false,
  maskedBatches: 0, maskedObservations: 0, outcome: "needs_summary", version: 1
});

describe("durable compaction status", () => {
  it("uses the actual post-compaction estimate and permits another server cycle", async () => {
    const events: ContextCompactionStatus[] = [];
    const publisher = createContextCompactionPublisher(async status => { events.push(status); });
    await publisher.begin(measured(1_500, 1_500));
    await publisher.settle("summary_applied", measured(600, 600));
    await publisher.begin(measured(1_200, 1_100));
    await publisher.settle("provider_failed");
    expect(events.map(({ cycle, state }) => [cycle, state])).toEqual([
      [1, "running"], [1, "complete"], [2, "running"], [2, "failed"]
    ]);
    expect(events[1]).toMatchObject({ beforeTokens: 1_500, afterTokens: 600, reducedTokens: 900 });
    expect(events[3]).toMatchObject({ afterTokens: null, reducedTokens: null });
    let projected: ContextCompactionStatus | null = null;
    for (const status of [...events, events[0]!, events[2]!]) projected = mergeContextCompactionStatus(projected, status);
    expect(projected).toEqual(events[3]);
  });

  it("resumes an interrupted cycle and advances after a persisted completed one", async () => {
    const events: ContextCompactionStatus[] = [];
    const pending = makeContextCompactionStatus({ beforeTokens: 1_500, cycle: 3, outcome: "pending", state: "running" });
    const publisher = createContextCompactionPublisher(async status => { events.push(status); }, pending);
    await publisher.begin(measured(1_500, 1_500));
    await publisher.settle("summary_applied", measured(600, 600));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ cycle: 3, reducedTokens: 900, state: "complete" });
    const recovered = createContextCompactionPublisher(async status => { events.push(status); }, events[0]);
    await recovered.begin(measured(1_300, 1_300));
    expect(events[1]).toMatchObject({ cycle: 4, state: "running" });
  });
});

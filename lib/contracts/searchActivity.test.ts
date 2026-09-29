import { describe, expect, it } from "vitest";
import { decodeThreadSearchEngineActivity, mergeThreadSearchEngineActivity,
  runningSearchEngineCalls } from "./searchActivity";

describe("search activity wire", () => {
  const complete = { engine: 1, name: "Perplexity", requested: 2, settled: 2, complete: 2, error: 0, skipped: 0 };

  it("merges absolute counters without counting duplicate or delayed snapshots twice", () => {
    const running = { ...complete, settled: 1, complete: 1 };
    expect(mergeThreadSearchEngineActivity([complete], [running])).toEqual([complete]);
    expect(runningSearchEngineCalls(running)).toBe(1);
  });

  it("rejects impossible counts and additional diagnostic fields", () => {
    expect(decodeThreadSearchEngineActivity(complete)).toEqual(complete);
    expect(decodeThreadSearchEngineActivity({ ...complete, complete: 3 })).toBeNull();
    expect(decodeThreadSearchEngineActivity({ ...complete, settled: 1 })).toBeNull();
    expect(decodeThreadSearchEngineActivity({ ...complete, invocationId: "private" })).toBeNull();
  });
});

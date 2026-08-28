import { describe, expect, it } from "vitest";
import {
  AIQSA_MEMORY_LIVE_RECALL_SEND_COUNT,
  AIQSA_MEMORY_LIVE_SOURCE_CHAT_COUNT,
  AIQSA_MEMORY_LIVE_SOURCE_SEND_COUNT,
  assertLiveBaseUrl,
  assertLiveDatabaseUrl,
  evaluateLiveRecall,
  liveScenario,
  resolveLiveOutputDirectory,
  validateLiveScenario
} from "../../../../benchmarks/aiqsa-memory-live-microbench/contract";

describe("AIQSA Memory live microbench contract", () => {
  it("keeps one bounded real-user scenario", () => {
    const scenario = validateLiveScenario(liveScenario);
    expect(scenario.sourceChats).toHaveLength(AIQSA_MEMORY_LIVE_SOURCE_CHAT_COUNT);
    expect(scenario.sourceChats.flatMap(({ messages }) => messages))
      .toHaveLength(AIQSA_MEMORY_LIVE_SOURCE_SEND_COUNT);
    expect(scenario.recalls).toHaveLength(AIQSA_MEMORY_LIVE_RECALL_SEND_COUNT);
    expect(scenario.sourceChats.filter(({ messages }) => messages.length === 2))
      .toHaveLength(2);
  });

  it("scores paraphrases by required semantic anchors without exact prose", () => {
    const dream = liveScenario.recalls.find(({ id }) => id === "dream-routine")!;
    expect(evaluateLiveRecall(
      dream,
      "You tend to prepare in the early morning: Riverside, Harbor, and Spring support it."
    )).toEqual({ matchedGroups: 4, passed: true, requiredGroups: 4 });
    expect(evaluateLiveRecall(dream, "You prepare early for Riverside.").passed).toBe(false);
  });

  it("confines paid traffic and artifacts to the disposable stack", () => {
    expect(assertLiveBaseUrl("http://127.0.0.1:3137/", 3137).port).toBe("3137");
    expect(() => assertLiveBaseUrl("http://127.0.0.1:3000/", 3000))
      .toThrow("aiqsa_memory_live_base_url_not_isolated");
    const database = "postgresql://aiqsa_benchmark:" +
      "aiqsa-memory-benchmark-dev-password@127.0.0.1:55437/" +
      "aiqsa_memory_benchmark?schema=public";
    expect(assertLiveDatabaseUrl(database, 55437).pathname)
      .toBe("/aiqsa_memory_benchmark");
    expect(resolveLiveOutputDirectory("/repo/benchmarks/live", "results/run-1"))
      .toBe("/repo/benchmarks/live/results/run-1");
    expect(() => resolveLiveOutputDirectory("/repo/benchmarks/live", "../outside"))
      .toThrow("aiqsa_memory_live_output_not_isolated");
  });
});

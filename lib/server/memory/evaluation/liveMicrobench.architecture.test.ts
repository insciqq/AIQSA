import { describe, expect, it } from "vitest";
import {
  AIQSA_MEMORY_LIVE_RECALL_SEND_COUNT,
  AIQSA_MEMORY_LIVE_DEFAULT_SYSTEM_MODEL_ID,
  AIQSA_MEMORY_LIVE_SOURCE_CHAT_COUNT,
  AIQSA_MEMORY_LIVE_SOURCE_SEND_COUNT,
  assertLiveBaseUrl,
  assertLiveDatabaseUrl,
  decodeLiveSystemModelId,
  evaluateLiveRecall,
  liveScenario,
  resolveLiveOutputDirectory,
  validateLiveScenario
} from "../../../../benchmarks/aiqsa-memory-live-microbench/contract";

describe("AIQSA Memory live microbench contract", () => {
  it("allows only the reviewed codex-lb qualification models", () => {
    expect(AIQSA_MEMORY_LIVE_DEFAULT_SYSTEM_MODEL_ID).toBe("gpt-5.6-sol");
    expect(decodeLiveSystemModelId("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(decodeLiveSystemModelId("gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(() => decodeLiveSystemModelId("openai/gpt-5.6-luna"))
      .toThrow("aiqsa_memory_live_system_model_invalid");
  });

  it("keeps one bounded real-user scenario", () => {
    const scenario = validateLiveScenario(liveScenario);
    expect(scenario.sourceChats).toHaveLength(AIQSA_MEMORY_LIVE_SOURCE_CHAT_COUNT);
    expect(scenario.sourceChats.flatMap(({ messages }) => messages))
      .toHaveLength(AIQSA_MEMORY_LIVE_SOURCE_SEND_COUNT);
    expect(scenario.recalls).toHaveLength(AIQSA_MEMORY_LIVE_RECALL_SEND_COUNT);
    expect(scenario.sourceChats.every(({ messages }) => messages.length === 1))
      .toBe(true);
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

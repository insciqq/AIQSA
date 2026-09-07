import { describe, expect, it } from "vitest";
import {
  BRIGHT_EMBEDDING_MAX_CONCURRENCY,
  nextBrightEmbeddingConcurrency,
  parseBrightEmbeddingCli,
  type BrightEmbeddingConcurrencyState
} from "./embedBrightStackOverflowImport";

const targetEnvironment = Object.freeze({
  AIQSA_BRIGHT_BENCHMARK_ACK: "RETAINED_BRIGHT_KB"
});

function observeClean(
  state: BrightEmbeddingConcurrencyState,
  targetConcurrency: number,
  count: number
): BrightEmbeddingConcurrencyState {
  let current = state;
  for (let index = 0; index < count; index += 1) {
    current = nextBrightEmbeddingConcurrency({
      providerRequestCount: 1,
      state: current,
      targetConcurrency
    });
  }
  return current;
}

describe("BRIGHT full embedding execution controls", () => {
  it("keeps inspection free and requires independent canary/full acknowledgements", () => {
    expect(parseBrightEmbeddingCli([
      "--confirm-target",
      "RETAINED",
      "--inspect-only"
    ], targetEnvironment)).toEqual({ concurrency: 1, mode: "inspect", resume: false });

    expect(parseBrightEmbeddingCli([
      "--confirm-target",
      "RETAINED",
      "--confirm-paid",
      "CANARY",
      "--resume"
    ], {
      ...targetEnvironment,
      AIQSA_BRIGHT_EMBEDDING_ACK: "OPENROUTER_CANARY"
    })).toEqual({ concurrency: 1, mode: "canary", resume: true });

    expect(parseBrightEmbeddingCli([
      "--confirm-target",
      "RETAINED",
      "--confirm-paid",
      "FULL_0_75_USD",
      "--concurrency",
      "16",
      "--resume"
    ], {
      ...targetEnvironment,
      AIQSA_BRIGHT_EMBEDDING_ACK: "OPENROUTER_FULL_50M_USD_0_75"
    })).toEqual({ concurrency: 16, mode: "full", resume: true });
  });

  it("rejects missing spend authority and concurrency above the reviewed ceiling", () => {
    expect(() => parseBrightEmbeddingCli([
      "--confirm-target",
      "RETAINED",
      "--confirm-paid",
      "FULL_0_75_USD"
    ], targetEnvironment)).toThrow("bright_stackoverflow_embedding_confirmation_required");

    expect(() => parseBrightEmbeddingCli([
      "--confirm-target",
      "RETAINED",
      "--confirm-paid",
      "FULL_0_75_USD",
      "--concurrency",
      String(BRIGHT_EMBEDDING_MAX_CONCURRENCY + 1)
    ], {
      ...targetEnvironment,
      AIQSA_BRIGHT_EMBEDDING_ACK: "OPENROUTER_FULL_50M_USD_0_75"
    })).toThrow("bright_stackoverflow_embedding_concurrency_invalid");
  });

  it("ramps 2 to 4 to 8 to 16 and backs off to 8 after a retry", () => {
    let state: BrightEmbeddingConcurrencyState = {
      cleanProviderBatches: 0,
      concurrency: 2
    };
    state = observeClean(state, 16, 8);
    expect(state).toEqual({ cleanProviderBatches: 0, concurrency: 4 });
    state = observeClean(state, 16, 24);
    expect(state).toEqual({ cleanProviderBatches: 0, concurrency: 8 });
    state = observeClean(state, 16, 64);
    expect(state).toEqual({ cleanProviderBatches: 0, concurrency: 16 });
    expect(nextBrightEmbeddingConcurrency({
      providerRequestCount: 2,
      state,
      targetConcurrency: 16
    })).toEqual({ cleanProviderBatches: 0, concurrency: 8 });
  });
});

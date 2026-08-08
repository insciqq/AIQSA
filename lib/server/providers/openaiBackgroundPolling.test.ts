import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENAI_BACKGROUND_POLL_TIMEOUT_MS,
  MAX_OPENAI_BACKGROUND_POLL_TIMEOUT_MS,
  effectiveOpenAIBackgroundPollTimeoutMs
} from "./openaiBackgroundPolling";

describe("OpenAI background polling configuration", () => {
  it("defaults to the previous eleven-minute lifecycle window", () => {
    expect(effectiveOpenAIBackgroundPollTimeoutMs(300_000, {})).toBe(660_000);
  });

  it("honors a window above the connection response-timeout ceiling", () => {
    expect(effectiveOpenAIBackgroundPollTimeoutMs(900_000, {
      AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS: "1200000"
    })).toBe(1_200_000);
  });

  it("never lets the complete lifecycle undercut one response exchange", () => {
    expect(effectiveOpenAIBackgroundPollTimeoutMs(900_000, {
      AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS: "5000"
    })).toBe(900_000);
  });

  it.each([
    ["missing", undefined],
    ["blank", ""],
    ["zero", "0"],
    ["fractional", "660000.5"],
    ["too large", String(MAX_OPENAI_BACKGROUND_POLL_TIMEOUT_MS + 1)]
  ])("falls back safely for a %s control", (_label, value) => {
    expect(effectiveOpenAIBackgroundPollTimeoutMs(300_000, {
      AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS: value
    })).toBe(DEFAULT_OPENAI_BACKGROUND_POLL_TIMEOUT_MS);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { STRUCTURED_OUTPUT_LIMITS, structuredOutputPromptFits } from "./structuredOutputLimits";

afterEach(() => vi.unstubAllEnvs());

describe("structured request resource bounds", () => {
  it("accepts a prompt beyond the former byte cap and counts UTF-8 and schema in the same envelope", () => {
    expect(structuredOutputPromptFits({ systemPrompt: "System", userPrompt: "я".repeat(150_000) })).toBe(true);
    vi.stubEnv("AIQSA_STRUCTURED_INPUT_MAX_BYTES", "1000");
    expect(structuredOutputPromptFits({ systemPrompt: "", userPrompt: "я".repeat(500) })).toBe(true);
    expect(structuredOutputPromptFits({ systemPrompt: "x", userPrompt: "я".repeat(500) })).toBe(false);
    expect(structuredOutputPromptFits({ systemPrompt: "", userPrompt: "x".repeat(999), schema: {} })).toBe(false);
  });

  it.each(["0", "-1", "1.5", "NaN", "9007199254740992"])("rejects malformed resource configuration %s", value => {
    vi.stubEnv("AIQSA_STRUCTURED_INPUT_MAX_BYTES", value);
    expect(() => structuredOutputPromptFits({ systemPrompt: "System", userPrompt: "Input" }))
      .toThrow("structured_output_limit_config_invalid:AIQSA_STRUCTURED_INPUT_MAX_BYTES");
    try { structuredOutputPromptFits({ systemPrompt: "System", userPrompt: "Input" }); }
    catch (error) { expect(error).toMatchObject({ code: "structured_output_limit_config_invalid" }); }
  });

  it("keeps schema and result guards independently configurable", () => {
    vi.stubEnv("AIQSA_STRUCTURED_SCHEMA_MAX_BYTES", "2000000");
    vi.stubEnv("AIQSA_STRUCTURED_OUTPUT_MAX_CHARS", "3000000");
    expect(STRUCTURED_OUTPUT_LIMITS.maxSchemaBytes).toBe(2_000_000);
    expect(STRUCTURED_OUTPUT_LIMITS.maxOutputCharacters).toBe(3_000_000);
  });
});

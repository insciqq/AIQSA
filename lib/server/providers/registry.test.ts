import { describe, expect, it } from "vitest";
import { createProviderAdaptersFromEnv, createSearchProviderAdaptersFromEnv } from "./registry";

describe("provider registry", () => {
  it("keeps real providers unavailable until their API keys are configured", () => {
    expect(Object.keys(createProviderAdaptersFromEnv({})).sort()).toEqual([]);
    expect(Object.keys(createSearchProviderAdaptersFromEnv({}))).toEqual([]);
  });

  it("registers real adapters when explicit keys are present", () => {
    expect(
      Object.keys(
        createProviderAdaptersFromEnv({
          ANTHROPIC_API_KEY: "anthropic-key",
          OPENAI_API_KEY: "openai-key",
          OPENROUTER_API_KEY: "openrouter-key"
        })
      ).sort()
    ).toEqual(["anthropic", "openai", "openrouter"]);
    expect(
      Object.keys(
        createSearchProviderAdaptersFromEnv({
          OPENROUTER_API_KEY: "openrouter-key"
        })
      )
    ).toEqual(["openrouter"]);
  });

  it("registers fake only in explicit non-production test mode", () => {
    expect(
      Object.keys(
        createProviderAdaptersFromEnv({
          AIQSA_TEST_MODE: "1"
        })
      )
    ).toEqual(["fake"]);
    expect(
      Object.keys(
        createProviderAdaptersFromEnv({
          AIQSA_TEST_MODE: "1",
          NODE_ENV: "production"
        })
      )
    ).toEqual([]);
    expect(Object.keys(createProviderAdaptersFromEnv({ AIQSA_TEST_MODE: "true" }))).toEqual([]);
    expect(Object.keys(createProviderAdaptersFromEnv({ AIQSA_FAKE_PROVIDER: "1" }))).toEqual([]);
    expect(Object.keys(createProviderAdaptersFromEnv({ AIQSA_SHOW_FAKE_PROVIDER: "1" }))).toEqual([]);
  });
});

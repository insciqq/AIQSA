import { describe, expect, it } from "vitest";
import {
  defaultGeminiChatParams,
  defaultOpenRouterParams,
  defaultOpenAIResponsesParams,
  normalizeOpenAIResponsesParams,
  normalizeOpenRouterParams,
  providerParameterSchemas
} from "./providerParams";

describe("provider parameter defaults", () => {
  it("keeps OpenAI Responses defaults aligned with the project contract", () => {
    expect(defaultOpenAIResponsesParams()).toMatchObject({
      background: true,
      manualContextReplay: true,
      maxOutputTokens: 128000,
      reasoning: {
        effort: "medium"
      },
      stream: false
    });
  });

  it("uses neutral temperature as the chat default while keeping zero selectable", () => {
    expect(defaultOpenAIResponsesParams().temperature).toBe(1);
    expect(normalizeOpenAIResponsesParams({ temperature: 0 }).temperature).toBe(0);
    expect(defaultOpenRouterParams().temperature).toBe(1);
    expect(defaultOpenRouterParams().stream).toBe(true);
    expect(normalizeOpenRouterParams({}).temperature).toBeUndefined();
    expect(normalizeOpenRouterParams({}).stream).toBe(true);
    expect(normalizeOpenRouterParams({ stream: false }).stream).toBe(false);
    expect(normalizeOpenRouterParams({ temperature: 0 }).temperature).toBe(0);
  });

  it("keeps Gemini compatibility defaults bounded and free of sampling controls", () => {
    expect(defaultGeminiChatParams()).toEqual({
      maxTokens: 65536,
      reasoning: { effort: "medium" },
      stream: true
    });
    expect(providerParameterSchemas.gemini.fields.map(({ name }) => name)).toEqual([
      "maxTokens",
      "stream",
      "reasoning.effort"
    ]);
  });

  it("normalizes partial OpenAI reasoning params without dropping defaults", () => {
    expect(
      normalizeOpenAIResponsesParams({
        max_output_tokens: 96,
        reasoning: {
          effort: "high",
          mode: "pro",
          summary: "detailed"
        }
      })
    ).toMatchObject({
      background: true,
      maxOutputTokens: 96,
      reasoning: {
        effort: "high",
        mode: "pro",
        summary: "detailed"
      },
      stream: false
    });
  });

  it("maps every max-output-token alias to the same provider cap", () => {
    for (const alias of [
      "maxOutputTokens",
      "maxTokens",
      "max_output_tokens",
      "max_tokens",
      "max_completion_tokens"
    ]) {
      expect(normalizeOpenAIResponsesParams({ [alias]: 2048 }).maxOutputTokens).toBe(2048);
      expect(normalizeOpenRouterParams({ [alias]: 2048 }).maxTokens).toBe(2048);
    }
  });

  it("exposes schemas for every built-in provider family", () => {
    expect(Object.keys(providerParameterSchemas).sort()).toEqual([
      "anthropic",
      "fake",
      "gemini",
      "openai",
      "openrouter"
    ]);
  });

  it("exposes GPT-5.6 max effort and reasoning mode without adding OpenRouter-only minimal effort", () => {
    const openAiEffort = providerParameterSchemas.openai.fields.find((field) => field.name === "reasoning.effort");
    const openAiMode = providerParameterSchemas.openai.fields.find((field) => field.name === "reasoning.mode");
    const openRouterEffort = providerParameterSchemas.openrouter.fields.find((field) => field.name === "reasoning.effort");

    expect(openAiEffort?.allowedValues).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(openAiMode?.allowedValues).toEqual(["standard", "pro"]);
    expect(openRouterEffort?.allowedValues).toContain("minimal");
  });

  it("normalizes OpenRouter route-provider and token params from UI-shaped keys", () => {
    expect(
      normalizeOpenRouterParams({
        max_output_tokens: 96,
        provider: {
          allow_fallbacks: false,
          data_collection: "deny",
          order: ["perplexity"],
          only: ["Perplexity"],
          require_parameters: true,
          sort: "price",
          zdr: true
        },
        reasoning: {
          enabled: true,
          effort: "high",
          max_tokens: 24
        },
        temperature: 0
      })
    ).toMatchObject({
      maxTokens: 96,
      provider: {
        allowFallbacks: false,
        dataCollection: "deny",
        order: ["perplexity"],
        only: ["Perplexity"],
        requireParameters: true,
        sort: "price",
        zdr: true
      },
      reasoning: {
        enabled: true,
        effort: "high",
        maxTokens: 24
      },
      temperature: 0
    });
  });
});

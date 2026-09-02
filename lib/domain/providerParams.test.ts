import { describe, expect, it } from "vitest";
import { defaultOpenRouterParams, defaultOpenAIResponsesParams, normalizeOpenAIResponsesParams, normalizeOpenRouterParams } from "./providerParams";

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

  it("preserves the explicit structured-output tool-choice capability", () => {
    expect(normalizeOpenRouterParams({
      provider: { structured_output_tool_choice: "auto" }
    }).provider.structuredOutputToolChoice).toBe("auto");
    expect(normalizeOpenRouterParams({}).provider.structuredOutputToolChoice)
      .toBeUndefined();
  });
});

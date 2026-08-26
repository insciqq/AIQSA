import { describe, expect, it, vi } from "vitest";
import type { ProviderModelConfiguration } from "./providerConfiguration";
import {
  buildOpenAIResponsesStructuredOutputRequest,
  buildOpenRouterStructuredOutputRequest,
  createOpenAIResponsesStructuredOutputAdapter,
  createOpenRouterStructuredOutputAdapter,
  supportsStructuredOutputAdapter
} from "./structuredOutput";

const schema = {
  additionalProperties: false,
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  type: "object"
};

const request = {
  maxOutputTokens: 64,
  name: "strict_result",
  schema,
  systemPrompt: "Return a strict result.",
  userPrompt: "Set ok to true."
};

function responsesModel(
  adapterKind: "openai_responses_compatible" | "openai_responses_native"
): ProviderModelConfiguration {
  return {
    adapterKind,
    answerSelectable: true,
    capabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      vision: false
    },
    defaultParams: {},
    modelClass: "answer",
    upstreamModelId: "gpt-test"
  };
}

const openRouterModel: ProviderModelConfiguration = {
  adapterKind: "openrouter_chat_completions",
  answerSelectable: true,
  capabilities: {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    vision: false
  },
  defaultParams: {
    provider: {
      allowFallbacks: false,
      dataCollection: "deny",
      only: ["ignored-default"],
      order: ["Anthropic"],
      requireParameters: false,
      sort: "latency",
      zdr: true
    }
  },
  modelClass: "answer",
  openRouterRouting: { mode: "only_selected", providers: ["OpenAI"] },
  upstreamModelId: "vendor/model"
};

describe("provider structured output", () => {
  it("admits only the three adapter paths with implemented strict-schema transports", () => {
    expect([
      "openai_responses_native",
      "openai_responses_compatible",
      "openrouter_chat_completions"
    ].every(supportsStructuredOutputAdapter)).toBe(true);
    expect([
      "openai_chat_completions_compatible",
      "anthropic_messages",
      "gemini_interactions_native"
    ].some(supportsStructuredOutputAdapter)).toBe(false);
  });

  it("keeps uniqueness server-authoritative while mapping the provider schema subset", () => {
    const requestWithUniqueItems = {
      ...request,
      schema: {
        additionalProperties: false,
        properties: {
          tool_ids: {
            items: { enum: ["alpha", "beta"], type: "string" },
            maxItems: 2,
            type: "array",
            uniqueItems: true
          }
        },
        required: ["tool_ids"],
        type: "object"
      }
    };
    const responses = buildOpenAIResponsesStructuredOutputRequest(
      responsesModel("openai_responses_native"),
      requestWithUniqueItems
    );
    const openRouter = buildOpenRouterStructuredOutputRequest(
      openRouterModel,
      requestWithUniqueItems
    );

    expect(requestWithUniqueItems.schema.properties.tool_ids.uniqueItems).toBe(true);
    expect(responses).toMatchObject({
      text: {
        format: {
          schema: {
            properties: {
              tool_ids: { maxItems: 2, type: "array" }
            }
          }
        }
      }
    });
    expect(openRouter).toMatchObject({
      tools: [{
        function: {
          parameters: {
            properties: {
              tool_ids: { maxItems: 2, type: "array" }
            }
          }
        },
        type: "function"
      }]
    });
    expect(JSON.stringify(responses)).not.toContain("uniqueItems");
    expect(JSON.stringify(openRouter)).not.toContain("uniqueItems");
  });

  it.each([
    "openai_responses_native",
    "openai_responses_compatible"
  ] as const)("maps strict JSON Schema to %s", (adapterKind) => {
    const body = buildOpenAIResponsesStructuredOutputRequest(
      responsesModel(adapterKind),
      request
    );
    expect(body).toMatchObject({
      input: [{ content: [{ text: "Set ok to true.", type: "input_text" }], role: "user" }],
      instructions: "Return a strict result.",
      max_output_tokens: 64,
      model: "gpt-test",
      store: false,
      stream: false,
      text: {
        format: {
          name: "strict_result",
          schema,
          strict: true,
          type: "json_schema"
        }
      }
    });
    if (adapterKind === "openai_responses_native") {
      expect(body).toHaveProperty("background", false);
    } else {
      expect(body).not.toHaveProperty("background");
    }
  });

  it("preserves OpenRouter routing while forcing one schema-bound tool call", () => {
    expect(buildOpenRouterStructuredOutputRequest(openRouterModel, request)).toMatchObject({
      max_tokens: 64,
      model: "vendor/model",
      provider: {
        allow_fallbacks: false,
        data_collection: "deny",
        only: ["OpenAI"],
        order: ["Anthropic"],
        require_parameters: true,
        sort: "latency",
        zdr: true
      },
      stream: false,
      tool_choice: "required",
      tools: [{
        function: {
          name: "strict_result",
          parameters: schema,
          strict: true
        },
        type: "function"
      }]
    });
    expect(buildOpenRouterStructuredOutputRequest(openRouterModel, request))
      .not.toHaveProperty("parallel_tool_calls");
  });

  it("reserves enough OpenRouter completion budget for reasoning before a strict tool call", () => {
    const reasoningModel: ProviderModelConfiguration = {
      ...openRouterModel,
      capabilities: {
        ...openRouterModel.capabilities,
        reasoning: true
      },
      defaultParams: {
        ...openRouterModel.defaultParams,
        reasoning: {
          enabled: true,
          effort: "high",
          exclude: true,
          maxTokens: 512
        }
      }
    };

    expect(buildOpenRouterStructuredOutputRequest(reasoningModel, {
      ...request,
      reasoningEffort: "high"
    })).toMatchObject({
      max_tokens: 1_024,
      reasoning: {
        effort: "high",
        enabled: true,
        exclude: true,
        max_tokens: 512
      }
    });
    expect(buildOpenRouterStructuredOutputRequest(reasoningModel, {
      ...request,
      maxOutputTokens: 2_048,
      reasoningEffort: "high"
    })).toHaveProperty("max_tokens", 2_048);

    const disabled = buildOpenRouterStructuredOutputRequest(reasoningModel, {
      ...request,
      reasoningEffort: "none"
    });
    expect(disabled).toMatchObject({
      max_tokens: 1_024,
      reasoning: { exclude: true }
    });
    expect(disabled.reasoning).not.toHaveProperty("enabled");
    expect(disabled.reasoning).not.toHaveProperty("effort");
    expect(disabled.reasoning).not.toHaveProperty("max_tokens");

    expect(buildOpenRouterStructuredOutputRequest({
      ...reasoningModel,
      defaultParams: {
        ...reasoningModel.defaultParams,
        reasoning: { enabled: false, exclude: true }
      }
    }, request)).toMatchObject({
      max_tokens: 1_024,
      reasoning: { exclude: true }
    });
  });

  it("parses one bounded Responses object without exposing raw response fields", async () => {
    const create = vi.fn(async () => ({
      id: "private-provider-id",
      output_text: JSON.stringify({ ok: true }),
      status: "completed",
      usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 }
    }));
    const adapter = createOpenAIResponsesStructuredOutputAdapter({
      client: {
        async cancel() { return {}; },
        create,
        async retrieve() { return {}; }
      },
      model: responsesModel("openai_responses_native")
    });

    const onUsage = vi.fn();
    const onProviderResponseId = vi.fn();
    await expect(adapter.execute(request, { onProviderResponseId, onUsage }))
      .resolves.toEqual({ ok: true });
    expect(onProviderResponseId).toHaveBeenCalledWith("private-provider-id");
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 11,
      outputTokens: 2,
      totalTokens: 13
    }));
    expect(JSON.stringify(await adapter.execute(request))).not.toContain("private-provider-id");
  });

  it("parses one OpenRouter schema tool call and rejects free-form output", async () => {
    const createChatCompletion = vi.fn(async () => ({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: null as string | null,
          tool_calls: [{
            function: { arguments: JSON.stringify({ ok: true }), name: "strict_result" },
            id: "call-1",
            type: "function"
          }]
        }
      }],
      id: "openrouter-response-1",
      usage: { completion_tokens: 3, prompt_tokens: 9, total_tokens: 12 }
    }));
    const adapter = createOpenRouterStructuredOutputAdapter({
      client: { createChatCompletion },
      model: openRouterModel
    });
    const onUsage = vi.fn();
    const onProviderResponseId = vi.fn();
    await expect(adapter.execute(request, { onProviderResponseId, onUsage }))
      .resolves.toEqual({ ok: true });
    expect(onProviderResponseId).toHaveBeenCalledWith("openrouter-response-1");
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 9,
      outputTokens: 3,
      totalTokens: 12
    }));

    createChatCompletion.mockResolvedValueOnce({
      choices: [{
        finish_reason: "stop",
        message: { content: "not json", tool_calls: [] }
      }],
      id: "openrouter-response-invalid",
      usage: { completion_tokens: 0, prompt_tokens: 0, total_tokens: 0 }
    });
    await expect(adapter.execute(request)).rejects.toThrow("structured_output_invalid");
  });

  it("reports absent usage honestly instead of manufacturing zero tokens", async () => {
    const adapter = createOpenAIResponsesStructuredOutputAdapter({
      client: {
        async cancel() { return {}; },
        async create() {
          return {
            id: "response-without-usage",
            output_text: JSON.stringify({ ok: true }),
            status: "completed"
          };
        },
        async retrieve() { return {}; }
      },
      model: responsesModel("openai_responses_native")
    });
    const onProviderResponseId = vi.fn();
    const onUsage = vi.fn();
    await expect(adapter.execute(request, { onProviderResponseId, onUsage }))
      .resolves.toEqual({ ok: true });
    expect(onProviderResponseId).toHaveBeenCalledWith("response-without-usage");
    expect(onUsage).not.toHaveBeenCalled();
  });
});

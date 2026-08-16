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
      response_format: {
        json_schema: {
          schema: {
            properties: {
              tool_ids: { maxItems: 2, type: "array" }
            }
          }
        }
      }
    });
    expect(JSON.stringify(responses)).not.toContain("uniqueItems");
    expect(JSON.stringify(openRouter)).not.toContain("uniqueItems");
  });

  it.each([
    "openai_responses_native",
    "openai_responses_compatible"
  ] as const)("maps strict JSON Schema to %s", (adapterKind) => {
    expect(buildOpenAIResponsesStructuredOutputRequest(
      responsesModel(adapterKind),
      request
    )).toMatchObject({
      background: false,
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
  });

  it("preserves OpenRouter routing while forcing parameter support", () => {
    expect(buildOpenRouterStructuredOutputRequest(openRouterModel, request)).toMatchObject({
      max_completion_tokens: 64,
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
      response_format: {
        json_schema: {
          name: "strict_result",
          schema,
          strict: true
        },
        type: "json_schema"
      },
      stream: false
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
    await expect(adapter.execute(request, { onUsage })).resolves.toEqual({ ok: true });
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 11,
      outputTokens: 2,
      totalTokens: 13
    }));
    expect(JSON.stringify(await adapter.execute(request))).not.toContain("private-provider-id");
  });

  it("parses one OpenRouter object and rejects free-form output", async () => {
    const createChatCompletion = vi.fn(async () => ({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ ok: true }) } }],
      usage: { completion_tokens: 3, prompt_tokens: 9, total_tokens: 12 }
    }));
    const adapter = createOpenRouterStructuredOutputAdapter({
      client: { createChatCompletion },
      model: openRouterModel
    });
    const onUsage = vi.fn();
    await expect(adapter.execute(request, { onUsage })).resolves.toEqual({ ok: true });
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 9,
      outputTokens: 3,
      totalTokens: 12
    }));

    createChatCompletion.mockResolvedValueOnce({
      choices: [{ finish_reason: "stop", message: { content: "not json" } }],
      usage: { completion_tokens: 0, prompt_tokens: 0, total_tokens: 0 }
    });
    await expect(adapter.execute(request)).rejects.toThrow("structured_output_invalid");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ProviderModelConfiguration } from "./providerConfiguration";
import {
  buildOpenAIResponsesStructuredOutputRequest,
  buildOpenRouterStructuredOutputRequest,
  createOpenAIResponsesStructuredOutputAdapter,
  createOpenRouterStructuredOutputAdapter,
  STRUCTURED_OUTPUT_LIMITS,
  supportsStructuredOutputAdapter
} from "./structuredOutput";
import { hasVerifiedStructuredOutput, structuredOutputVerificationEvidence } from "./structuredOutputEvidence";

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

const rootUnionSchema = {
  oneOf: [
    {
      additionalProperties: false,
      properties: { kind: { const: "ok", type: "string" } },
      required: ["kind"],
      type: "object"
    },
    {
      additionalProperties: false,
      properties: { kind: { const: "insufficient", type: "string" } },
      required: ["kind"],
      type: "object"
    }
  ]
};

const rootUnionRequest = {
  ...request,
  schema: rootUnionSchema
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

const openRouterProviderDefaults = {
  allowFallbacks: false,
  dataCollection: "deny",
  only: ["ignored-default"],
  order: ["Anthropic"],
  requireParameters: false,
  sort: "latency",
  zdr: true
};

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
    provider: openRouterProviderDefaults
  },
  modelClass: "answer",
  openRouterRouting: { mode: "only_selected", providers: ["OpenAI"] },
  upstreamModelId: "vendor/model"
};

describe("provider structured output", () => {
  it("requires a new OpenRouter JSON receipt instead of accepting the former tool-call proof", () => {
    expect(hasVerifiedStructuredOutput({ structuredOutput: {
      adapterKind: openRouterModel.adapterKind, probeVersion: 4,
      upstreamModelId: openRouterModel.upstreamModelId, verified: true
    } }, openRouterModel)).toBe(false);
    const structuredOutput = structuredOutputVerificationEvidence(openRouterModel.adapterKind, openRouterModel.upstreamModelId);
    expect(hasVerifiedStructuredOutput({ structuredOutput }, openRouterModel)).toBe(true);
    expect(hasVerifiedStructuredOutput({ structuredOutput }, { ...openRouterModel, upstreamModelId: "other/model" })).toBe(false);
  });

  it.each([
    { choices: [{ finish_reason: "length", message: { content: '{"ok":true}' } }] },
    { choices: [{ finish_reason: "content_filter", message: { content: '{"ok":true}' } }] },
    { choices: [{ message: { content: '{"ok":true}' } }] },
    { choices: [{ finish_reason: "stop", message: { content: '{"ok":true}', refusal: "Refused" } }] },
    { choices: [{ finish_reason: "stop", message: { content: '{"ok":true}', tool_calls: [{ id: "call-1" }] } }] },
    { choices: [{ finish_reason: "stop", message: { content: "[]" } }] },
    { choices: [{ finish_reason: "stop", message: { content: '{"ok":' } }] },
    { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ text: "x".repeat(STRUCTURED_OUTPUT_LIMITS.maxOutputCharacters) }) } }] }
  ])("rejects incomplete, ambiguous or invalid OpenRouter JSON (%#)", async (response) => {
    const adapter = createOpenRouterStructuredOutputAdapter({
      client: { createChatCompletion: vi.fn(async () => response) }, model: openRouterModel
    });
    await expect(adapter.execute(request)).rejects.toThrow();
  });

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

  it("maps canonical oneOf branches to the portable nested anyOf subset", () => {
    const requestWithNestedUnion = {
      ...request,
      schema: {
        additionalProperties: false,
        properties: {
          result: rootUnionSchema
        },
        required: ["result"],
        type: "object"
      }
    };
    const canonicalBefore = JSON.stringify(requestWithNestedUnion.schema);
    const responses = buildOpenAIResponsesStructuredOutputRequest(
      responsesModel("openai_responses_compatible"),
      requestWithNestedUnion
    );
    const openRouter = buildOpenRouterStructuredOutputRequest(
      openRouterModel,
      requestWithNestedUnion
    );

    expect(responses).toMatchObject({
      text: {
        format: {
          schema: {
            properties: {
              result: { anyOf: rootUnionSchema.oneOf }
            },
            type: "object"
          }
        }
      }
    });
    expect(openRouter).toMatchObject({
      response_format: {
        json_schema: {
          schema: {
            properties: {
              result: { anyOf: rootUnionSchema.oneOf }
            },
            type: "object"
          }
        }
      }
    });
    expect(JSON.stringify(responses)).not.toContain("oneOf");
    expect(JSON.stringify(openRouter)).not.toContain("oneOf");
    expect(JSON.stringify(requestWithNestedUnion.schema)).toBe(canonicalBefore);
  });

  it("wraps a canonical root union in a strict transport-only object", () => {
    const canonicalBefore = JSON.stringify(rootUnionRequest.schema);
    const expectedWireSchema = {
      additionalProperties: false,
      properties: {
        __aiqsa_payload: { anyOf: rootUnionSchema.oneOf }
      },
      required: ["__aiqsa_payload"],
      type: "object"
    };

    expect(buildOpenAIResponsesStructuredOutputRequest(
      responsesModel("openai_responses_compatible"),
      rootUnionRequest
    )).toMatchObject({
      text: { format: { schema: expectedWireSchema } }
    });
    expect(buildOpenRouterStructuredOutputRequest(
      openRouterModel,
      rootUnionRequest
    )).toMatchObject({
      response_format: { json_schema: { schema: expectedWireSchema } }
    });
    expect(JSON.stringify(rootUnionRequest.schema)).toBe(canonicalBefore);
  });

  it("projects a oneOf discriminated by a required scalar-const tuple", () => {
    const compositeUnion = {
      oneOf: [
        {
          additionalProperties: false,
          properties: {
            decision: { const: "select", type: "string" },
            requestCoverage: { const: "complete", type: "string" }
          },
          required: ["decision", "requestCoverage"],
          type: "object"
        },
        {
          additionalProperties: false,
          properties: {
            decision: { const: "select", type: "string" },
            requestCoverage: { const: "partial", type: "string" }
          },
          required: ["decision", "requestCoverage"],
          type: "object"
        },
        {
          additionalProperties: false,
          properties: {
            decision: { const: "insufficient", type: "string" },
            requestCoverage: { const: "none", type: "string" }
          },
          required: ["decision", "requestCoverage"],
          type: "object"
        }
      ]
    };
    const compositeRequest = { ...request, schema: compositeUnion };

    const responses = buildOpenAIResponsesStructuredOutputRequest(
      responsesModel("openai_responses_compatible"),
      compositeRequest
    );
    const openRouter = buildOpenRouterStructuredOutputRequest(
      openRouterModel,
      compositeRequest
    );

    expect(responses).toHaveProperty(
      "text.format.schema.properties.__aiqsa_payload.anyOf",
      compositeUnion.oneOf
    );
    expect(openRouter).toHaveProperty(
      "response_format.json_schema.schema.properties.__aiqsa_payload.anyOf",
      compositeUnion.oneOf
    );
  });

  it("fails closed instead of weakening a non-discriminated oneOf", () => {
    const overlappingBranch = {
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
      type: "object"
    };
    const unsupportedRequest = {
      ...request,
      schema: { oneOf: [overlappingBranch, { ...overlappingBranch }] }
    };

    expect(() => buildOpenAIResponsesStructuredOutputRequest(
      responsesModel("openai_responses_compatible"),
      unsupportedRequest
    )).toThrow("structured_output_schema_unsupported");
    expect(() => buildOpenRouterStructuredOutputRequest(
      openRouterModel,
      unsupportedRequest
    )).toThrow("structured_output_schema_unsupported");
  });

  it("bounds structured prompts by UTF-8 bytes as well as JavaScript characters", () => {
    expect(() => buildOpenAIResponsesStructuredOutputRequest(
      responsesModel("openai_responses_native"),
      {
        ...request,
        userPrompt: "😀".repeat(64_001)
      }
    )).toThrow("structured_output_request_invalid");
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

  it.each([
    "openai_responses_native",
    "openai_responses_compatible"
  ] as const)(
    "reserves Responses output budget for reasoning before strict JSON on %s",
    (adapterKind) => {
      const model = responsesModel(adapterKind);
      expect(buildOpenAIResponsesStructuredOutputRequest(model, {
        ...request,
        reasoningEffort: "medium"
      })).toHaveProperty("max_output_tokens", 1_024);
      expect(buildOpenAIResponsesStructuredOutputRequest(model, {
        ...request,
        maxOutputTokens: 2_048,
        reasoningEffort: "medium"
      })).toHaveProperty("max_output_tokens", 2_048);
      expect(buildOpenAIResponsesStructuredOutputRequest(model, {
        ...request,
        reasoningEffort: "none"
      })).toHaveProperty("max_output_tokens", 64);
    }
  );

  it("preserves OpenRouter routing while requesting native strict JSON Schema", () => {
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
      response_format: {
        json_schema: {
          name: "strict_result",
          schema,
          strict: true
        },
        type: "json_schema"
      }
    });
    expect(buildOpenRouterStructuredOutputRequest(openRouterModel, request))
      .not.toHaveProperty("parallel_tool_calls");
  });

  it("does not constrain JSON routing by answer temperature or the retired function choice", () => {
    const body = buildOpenRouterStructuredOutputRequest({
      ...openRouterModel,
      defaultParams: {
        ...openRouterModel.defaultParams,
        temperature: 1,
        provider: {
          ...openRouterProviderDefaults,
          structuredOutputToolChoice: "auto"
        }
      }
    }, request);
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("temperature");
    expect(body).toHaveProperty("response_format.type", "json_schema");
  });

  it("reserves enough OpenRouter completion budget for reasoning before strict JSON", () => {
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

  it("unwraps only the exact transport wrapper from Responses root unions", async () => {
    const create = vi.fn(async () => ({
      id: "root-union-response",
      output_text: JSON.stringify({ __aiqsa_payload: { kind: "ok" } }),
      status: "completed"
    }));
    const adapter = createOpenAIResponsesStructuredOutputAdapter({
      client: {
        async cancel() { return {}; },
        create,
        async retrieve() { return {}; }
      },
      model: responsesModel("openai_responses_compatible")
    });

    await expect(adapter.execute(rootUnionRequest)).resolves.toEqual({ kind: "ok" });
    create.mockResolvedValueOnce({
      id: "missing-root-union-wrapper",
      output_text: JSON.stringify({ kind: "ok" }),
      status: "completed"
    });
    await expect(adapter.execute(rootUnionRequest))
      .rejects.toThrow("structured_output_invalid");
  });

  it("parses native OpenRouter JSON and rejects free-form output", async () => {
    const createChatCompletion = vi.fn(async () => ({
      choices: [{
        finish_reason: "stop",
        message: {
          content: JSON.stringify({ ok: true })
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
        message: { content: "not json" }
      }],
      id: "openrouter-response-invalid",
      usage: { completion_tokens: 0, prompt_tokens: 0, total_tokens: 0 }
    });
    await expect(adapter.execute(request)).rejects.toThrow("structured_output_invalid");
  });

  it("unwraps only the exact transport wrapper from OpenRouter root unions", async () => {
    const response = (value: Record<string, unknown>) => ({
      choices: [{
        finish_reason: "stop",
        message: {
          content: JSON.stringify(value)
        }
      }],
      id: "openrouter-root-union"
    });
    const createChatCompletion = vi.fn(async () => response({
      __aiqsa_payload: { kind: "ok" }
    }));
    const adapter = createOpenRouterStructuredOutputAdapter({
      client: { createChatCompletion },
      model: openRouterModel
    });

    await expect(adapter.execute(rootUnionRequest)).resolves.toEqual({ kind: "ok" });
    createChatCompletion.mockResolvedValueOnce(response({
      __aiqsa_payload: { kind: "ok" },
      extra: true
    }));
    await expect(adapter.execute(rootUnionRequest))
      .rejects.toThrow("structured_output_invalid");
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

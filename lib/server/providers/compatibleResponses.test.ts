import { describe, expect, it, vi } from "vitest";
import {
  buildCompatibleResponsesRequest,
  createCompatibleResponsesAdapter
} from "./compatibleResponses";
import type { OpenAIResponsesClient } from "./openaiResponsesTransport";
import type { NormalizedSearchPlanOption, ProviderRunRequest } from "./types";

function request(overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "Latest question", type: "text" }] },
    context: {
      messages: [
        { content: { blocks: [{ text: "Earlier question", type: "text" }] }, id: "u1", role: "user" },
        { content: { blocks: [{ text: "Earlier answer", type: "text" }] }, id: "a1", role: "assistant" },
        { content: { blocks: [{ text: "Latest question", type: "text" }] }, id: "u2", role: "user" }
      ],
      mode: "branch_path"
    },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    toolMode: "auto",
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      vision: false
    },
    modelId: "compatible-model",
    params: {
      background: true,
      maxOutputTokens: 64,
      manualContextReplay: false,
      store: true,
      stream: false
    },
    previousProviderResponseId: "must-not-be-used",
    prompt: { developer: null, system: null },
    provider: "custom",
    searchPlan: { mode: "all_selected", options: [] },
    ...overrides
  };
}

function hostedSearchOption(): NormalizedSearchPlanOption {
  return {
    adapterKind: "answer_provider_hosted",
    config: {},
    credentialMode: "answer_provider",
    executionModes: ["model_choice"],
    modelId: null,
    optionId: "custom-web-search:connection-custom",
    protocol: "openai_responses_web_search",
    provider: "openai_compatible",
    providerModelId: null,
    revisionId: "revision-hosted",
    searchStrategyRowId: "route-hosted"
  };
}

function responseBody(frames: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    }
  });
}

describe("compatible Responses adapter", () => {
  it("preserves required tool choice on the portable wire body", () => {
    expect(buildCompatibleResponsesRequest(request({
      toolChoice: "required",
      tools: [{
        capability: "memory",
        description: "Return one result.",
        inputSchema: {
          additionalProperties: false,
          properties: { result: { type: "string" } },
          required: ["result"],
          type: "object"
        },
        name: "submit_result",
        strict: true
      }]
    }))).toMatchObject({
      parallel_tool_calls: false,
      tool_choice: "required"
    });
  });

  it("forces stateless manual replay and strips native-only extensions", () => {
    const body = buildCompatibleResponsesRequest(request());

    expect(body).toMatchObject({
      model: "compatible-model",
      store: false,
      stream: false
    });
    expect(body).not.toHaveProperty("background");
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body).not.toHaveProperty("prompt_cache_key");
    expect(body).not.toHaveProperty("prompt_cache_options");
    expect(body).not.toHaveProperty("prompt_cache_retention");
    expect(body).not.toHaveProperty("metadata");
    expect(JSON.stringify(body)).toContain("Earlier question");
    expect(JSON.stringify(body)).toContain("Earlier answer");
  });

  it("does not expose native retrieve, refresh, or cancel lifecycle", () => {
    const client: OpenAIResponsesClient = {
      cancel: async () => ({}),
      create: async () => ({}),
      retrieve: async () => ({})
    };
    const adapter = createCompatibleResponsesAdapter({ client });

    expect(adapter.cancel).toBeUndefined();
    expect(adapter.refresh).toBeUndefined();
    expect(adapter.retrieve).toBeUndefined();
  });

  it("serializes standard hosted web search while remaining stateless", () => {
    const body = buildCompatibleResponsesRequest(
      request({
        searchPlan: { mode: "model_choice", options: [hostedSearchOption()] }
      })
    );
    expect(body).toMatchObject({
      include: ["web_search_call.action.sources"],
      store: false,
      tools: [{ type: "web_search" }]
    });
    expect(body).not.toHaveProperty("background");
  });

  it("keeps canonical effort and pro mode with the Responses default mapping", () => {
    expect(buildCompatibleResponsesRequest(request({
      params: {
        maxOutputTokens: 64,
        reasoning: { effort: "max", mode: "pro", summary: "auto" },
        stream: false
      }
    }))).toMatchObject({
      reasoning: { effort: "max", mode: "pro", summary: "auto" }
    });
  });

  it("uses one override for actual and preview requests without a canonical reasoning object", () => {
    const runRequest = request({
      params: {
        maxOutputTokens: 64,
        reasoning: { effort: "high", mode: "pro", summary: "auto" },
        stream: false
      }
    });
    const mapping = { effortPath: "reason", modePath: "mode" } as const;
    const body = buildCompatibleResponsesRequest(runRequest, {
      reasoningRequestMapping: mapping
    });
    const adapter = createCompatibleResponsesAdapter({
      client: {
        cancel: async () => ({}),
        create: async () => ({}),
        retrieve: async () => ({})
      },
      reasoningRequestMapping: mapping
    });
    const preview = adapter.buildRequestPreview?.(runRequest);

    expect(body).toMatchObject({ mode: "pro", reason: "high" });
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("background");
    expect(preview?.body).toMatchObject({ mode: "pro", reason: "high" });
    expect(preview?.body).not.toHaveProperty("reasoning");
    expect(preview?.body).not.toHaveProperty("background");
    expect(preview?.body).toHaveProperty("store", false);
  });

  it("normalizes a completed non-streaming response", async () => {
    const create = vi.fn(async () => ({
      id: "response-1",
      model: "compatible-model",
      output_text: "Compatible answer",
      status: "completed",
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 }
    }));
    const client: OpenAIResponsesClient = {
      cancel: async () => ({}),
      create,
      retrieve: async () => ({})
    };
    const adapter = createCompatibleResponsesAdapter({ client });
    const events = [];
    const signal = new AbortController().signal;
    const stream = adapter.stream(request(), { signal, timeoutMs: 300_000 });
    let next = await stream.next();
    while (!next.done) {
      events.push(next.value);
      next = await stream.next();
    }

    expect(next.value.finalText).toBe("Compatible answer");
    expect(events.some((event) => event.type === "usage")).toBe(true);
    expect(events.some((event) => event.type === "token")).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.any(Object), { signal, timeoutMs: 300_000 });
  });

  it("rejects malformed completed function calls before non-stream usage", async () => {
    const client: OpenAIResponsesClient = {
      cancel: async () => ({}),
      create: async () => ({
        id: "response-invalid-tool",
        output: [{ arguments: "{}", name: "missing_id", type: "function_call" }],
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      }),
      retrieve: async () => ({})
    };
    const adapter = createCompatibleResponsesAdapter({ client });
    const stream = adapter.stream(request());

    await expect(stream.next()).rejects.toThrow("openai_response_tool_call_invalid");
  });

  it("keeps compatible streaming Search artifacts provider-neutral", async () => {
    const completed = {
      response: {
        id: "response-stream-1",
        model: "compatible-model",
        output: [
          { id: "search-1", status: "completed", type: "web_search_call" },
          {
            content: [{ annotations: [], text: "Compatible answer", type: "output_text" }],
            type: "message"
          }
        ],
        status: "completed",
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
      },
      type: "response.completed"
    };
    const client: OpenAIResponsesClient = {
      cancel: async () => ({}),
      create: async () => ({}),
      retrieve: async () => ({}),
      stream: async () => new Response(responseBody([
        'event: response.created\ndata: {"type":"response.created","response":{"id":"response-stream-1","status":"in_progress"}}\n\n',
        'event: response.web_search_call.searching\ndata: {"type":"response.web_search_call.searching","response_id":"response-stream-1","item_id":"search-1"}\n\n',
        `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`
      ]))
    };
    const adapter = createCompatibleResponsesAdapter({ client });
    const events = [];
    const stream = adapter.stream(request({
      params: { stream: true },
      searchPlan: { mode: "model_choice", options: [hostedSearchOption()] }
    }));
    let next = await stream.next();
    while (!next.done) {
      events.push(next.value);
      next = await stream.next();
    }

    expect(events).toContainEqual(expect.objectContaining({
      data: expect.objectContaining({
        artifactType: "summary",
        payload: expect.objectContaining({ provider: "openai-compatible" })
      })
    }));
    const searchEvents = events.filter((event) =>
      event.type === "artifact" && event.data.artifactType === "search");
    expect(searchEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(searchEvents)).not.toContain('"provider":"openai"');
    expect(next.value.finalProviderResponsePreview).toMatchObject({
      provider: "openai-compatible"
    });
  });
});

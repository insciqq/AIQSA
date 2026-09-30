import { describe, expect, it, vi } from "vitest";
import {
  buildCompatibleResponsesRequest,
  createCompatibleResponsesAdapter
} from "./compatibleResponses";
import { createFetchOpenAIResponsesClient, type OpenAIResponsesClient } from "./openaiResponsesTransport";
import { observedFailure } from "./providerObservability";
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
  it.each(["gpt-6-sol", "gpt-6-luna"])("keeps %s reasoning portable without native lifecycle or cache fields", (modelId) => {
    const body = buildCompatibleResponsesRequest(request({ modelId, params: {
      background: true, store: true, stream: true,
      reasoning: { effort: "medium", mode: "pro" }, temperature: 0.3
    } }));
    expect(body).toMatchObject({ model: modelId, store: false, stream: true,
      reasoning: { effort: "medium", mode: "pro" } });
    for (const field of ["background", "previous_response_id", "prompt_cache_options", "prompt_cache_retention", "temperature"]) {
      expect(body).not.toHaveProperty(field);
    }
  });
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
      store: false
    });
    expect(body).not.toHaveProperty("stream");
    expect(body).not.toHaveProperty("background");
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body).not.toHaveProperty("prompt_cache_key");
    expect(body).not.toHaveProperty("prompt_cache_options");
    expect(body).not.toHaveProperty("prompt_cache_retention");
    expect(body).not.toHaveProperty("metadata");
    expect(JSON.stringify(body)).toContain("Earlier question");
    expect(JSON.stringify(body)).toContain("Earlier answer");
  });

  it("preserves direct and fallback PDF routing through the compatible Responses adapter", () => {
    const attachment = {
      base64Data: "COMPATIBLE_PRIVATE_PDF_BYTES",
      byteSize: 16,
      extractedText: "COMPATIBLE_PDF_FALLBACK_TEXT",
      fileName: "compatible.pdf",
      id: "compatible-pdf",
      kind: "pdf" as const,
      metadata: {},
      mimeType: "application/pdf",
      status: "ready" as const
    };
    const direct = JSON.stringify(buildCompatibleResponsesRequest(request({
      attachmentIds: [attachment.id],
      attachments: [attachment],
      modelCapabilities: {
        ...request().modelCapabilities,
        nativePdfInput: true,
        pdf: true
      }
    })));
    const fallback = JSON.stringify(buildCompatibleResponsesRequest(request({
      attachmentIds: [attachment.id],
      attachments: [attachment],
      modelCapabilities: {
        ...request().modelCapabilities,
        nativePdfInput: false,
        pdf: true
      }
    })));

    expect(direct).toContain("COMPATIBLE_PRIVATE_PDF_BYTES");
    expect(direct).toContain('"type":"input_file"');
    expect(direct).not.toContain("COMPATIBLE_PDF_FALLBACK_TEXT");
    expect(fallback).toContain("COMPATIBLE_PDF_FALLBACK_TEXT");
    expect(fallback).not.toContain("COMPATIBLE_PRIVATE_PDF_BYTES");
    expect(fallback).not.toContain('"type":"input_file"');
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

  it("rejects malformed completed function calls before non-stream output, keeping their reported usage", async () => {
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

    await expect(stream.next()).resolves.toMatchObject({ value: { type: "usage", data: { totalTokens: 2 } } });
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

describe("compatible Responses context-length refusal (codex-lb shapes)", () => {
  const sentinel = "PRIVATE_PROVIDER_MESSAGE_CANARY";
  const error = { message: `Your input exceeds the context window of this model. Please adjust your input and try again. ${sentinel}`,
    type: "invalid_request_error", code: "context_length_exceeded", param: "input" };
  // codex-lb re-issues the failure as its own minimal response object.
  const failed = (id: string, extra: Record<string, unknown> = {}) => ({ type: "response.failed", response: { object: "response",
    status: "failed", error, incomplete_details: null, id, created_at: 1_790_000_000, ...extra }, sequence_number: 3 });
  const opened = (type: string, id: string) => ({ type, response: { id, object: "response", status: "in_progress",
    created_at: 1_790_000_000 }, sequence_number: type === "response.created" ? 1 : 2 });
  const frames = (events: readonly Record<string, unknown>[]) => events.map((event) =>
    `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const streamed = (body: string) => createCompatibleResponsesAdapter({ client: createFetchOpenAIResponsesClient({
    acceptStreamedCreate: true, apiKey: "synthetic", baseUrl: "https://lb.example.test/v1",
    fetchFn: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }) }) });
  const run = async (adapter: ReturnType<typeof createCompatibleResponsesAdapter>, input: ProviderRunRequest) => {
    const events: unknown[] = [];
    const stream = adapter.stream(input);
    try {
      let next = await stream.next();
      while (!next.done) {
        events.push(next.value);
        next = await stream.next();
      }
      return { events, failure: null };
    } catch (failure) {
      return { events, failure };
    }
  };
  const streamingRequest = request({ params: { maxOutputTokens: 16, stream: true } });

  it.each([
    ["the created identity", frames([opened("response.created", "resp_1"), opened("response.in_progress", "resp_1"), failed("resp_1")])],
    ["an identity re-issued by the proxy", frames([opened("response.created", "resp_1"), opened("response.in_progress", "resp_1"),
      failed("resp_lb")])],
    ["empty keepalive frames", `data: \n\n${frames([opened("response.created", "resp_1")])}event: keepalive\ndata:\n\n${
      frames([failed("resp_1")])}`]
  ])("classifies a streamed response.failed terminal under %s (HTTP 200)", async (_case, body) => {
    const { events, failure } = await run(streamed(body), streamingRequest);
    expect(failure).toMatchObject({ code: "provider_context_length_exceeded", message: "openai_response_failed" });
    expect(observedFailure(failure)).toEqual({ code: "provider_context_length_exceeded", reason: "safety_limit" });
    // No usage and no output before the refusal: only the lifecycle summary.
    expect(events).toEqual([expect.objectContaining({ data: expect.objectContaining({ artifactType: "summary" }), type: "artifact" })]);
    expect(JSON.stringify(failure)).not.toContain(sentinel);
  });

  it("reports usage a failed context-length terminal states before the refusal", async () => {
    const { events, failure } = await run(streamed(frames([opened("response.created", "resp_1"),
      failed("resp_lb", { usage: { input_tokens: 900, output_tokens: 0, total_tokens: 900 } })])), streamingRequest);
    expect(failure).toMatchObject({ code: "provider_context_length_exceeded" });
    expect(events).toContainEqual({ data: expect.objectContaining({ inputTokens: 900 }), type: "usage" });
  });

  it("keeps the identity check for other failures under a re-issued identity", async () => {
    const { failure } = await run(streamed(frames([opened("response.created", "resp_1"), { type: "response.failed",
      response: { object: "response", status: "failed", error: { code: "server_error", message: sentinel }, id: "resp_lb" } }])),
    streamingRequest);
    expect(failure).toMatchObject({ message: "openai_response_identity_mismatch" });
    expect(failure).not.toHaveProperty("code");
  });

  it("classifies the non-streamed HTTP 400 body with its status", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ error }, { status: 400 }));
    const adapter = createCompatibleResponsesAdapter({ client: createFetchOpenAIResponsesClient({ acceptStreamedCreate: true,
      apiKey: "synthetic", baseUrl: "https://lb.example.test/v1", fetchFn, initialRequestRetry: { maxAttempts: 3 } }) });
    const { events, failure } = await run(adapter, request({ params: { maxOutputTokens: 16, stream: false } }));
    expect(failure).toMatchObject({ code: "provider_context_length_exceeded", status: 400,
      message: "OpenAI request failed with status 400" });
    expect(observedFailure(failure)).toEqual({ code: "provider_context_length_exceeded", httpStatus: 400, reason: "http" });
    expect(events).toEqual([]);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(JSON.stringify(failure)).not.toContain(sentinel);
  });
});

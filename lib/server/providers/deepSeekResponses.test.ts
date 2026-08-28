import { describe, expect, it, vi } from "vitest";
import type { ValidatedSearchQuery } from "../../domain/search";
import { buildDeepSeekResponsesRequest } from "./deepSeekResponsesRequest";
import {
  createDeepSeekResponsesAdapter
} from "./deepSeekResponses";
import {
  createDeepSeekResponsesSearchAdapter
} from "./deepSeekResponsesSearch";
import {
  createFetchDeepSeekResponsesClient,
  type DeepSeekResponsesClient
} from "./deepSeekResponsesTransport";
import type { ProviderRunRequest, ProviderSearchRequest } from "./types";
import {
  buildDeepSeekResponsesStructuredOutputRequest,
  createDeepSeekResponsesStructuredOutputAdapter
} from "./structuredOutput";

function request(overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-deepseek",
    content: { blocks: [{ text: "Current question", type: "text" }] },
    context: {
      messages: [
        { content: { blocks: [{ text: "Earlier question", type: "text" }] }, id: "u1", role: "user" },
        { content: { blocks: [{ text: "Earlier answer", type: "text" }] }, id: "a1", role: "assistant" },
        { content: { blocks: [{ text: "Current question", type: "text" }] }, id: "u2", role: "user" }
      ],
      mode: "branch_path"
    },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: true,
      parallelToolCalls: true,
      pdf: true,
      reasoning: true,
      streaming: true,
      toolCalling: true,
      vision: true
    },
    modelId: "deepseek-v4-pro",
    params: {
      maxOutputTokens: 1_024,
      reasoning: { effort: "high" },
      stream: false,
      temperature: 0.4
    },
    previousProviderResponseId: "must-not-be-used",
    prompt: { developer: "Be exact.", system: "System rule." },
    provider: "deepseek",
    searchPlan: { mode: "all_selected", options: [] },
    toolMode: "auto",
    ...overrides
  };
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } });
}

describe("DeepSeek Responses provider", () => {
  it("builds a stateless native request without OpenAI lifecycle fields", () => {
    const longDescription = "Use the complete schema. ".repeat(200);
    const schema = {
      additionalProperties: false,
      properties: { query: { description: "Query", type: "string" } },
      required: ["query"],
      type: "object"
    };
    const body = buildDeepSeekResponsesRequest(request({
      providerToolMessages: [
        [{ content: [{ text: "private reasoning", type: "reasoning_text" }], type: "reasoning" }],
        { call_id: "call-1", output: "tool output", type: "function_call_output" }
      ],
      searchPlan: {
        mode: "model_choice",
        options: [{
          adapterKind: "answer_provider_hosted",
          config: {},
          credentialMode: "answer_provider",
          executionModes: ["model_choice"],
          modelId: null,
          optionId: "deepseek-native-web-search",
          protocol: "deepseek_responses_web_search",
          provider: "deepseek",
          providerModelId: null,
          revisionId: "revision-deepseek",
          searchStrategyRowId: "deepseek-native-web-search"
        }]
      },
      toolChoice: "required",
      tools: [{
        capability: "mcp",
        description: longDescription,
        inputSchema: schema,
        name: "mcp__search",
        strict: true
      }]
    }));

    expect(body.input).toHaveLength(5);
    expect(body.tools).toEqual([
      { type: "web_search" },
      {
        description: longDescription,
        name: "mcp__search",
        parameters: schema,
        type: "function"
      }
    ]);
    expect(body.tool_choice).toBe("required");
    expect(body).not.toHaveProperty("background");
    expect(body).not.toHaveProperty("include");
    expect(body).not.toHaveProperty("metadata");
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body).not.toHaveProperty("prompt_cache_key");
    expect(body).not.toHaveProperty("store");
    expect(body).not.toHaveProperty("temperature");
  });

  it("serializes vision input and uses temperature only with reasoning disabled", () => {
    const body = buildDeepSeekResponsesRequest(request({
      attachmentIds: ["image"],
      attachments: [{
        byteSize: 12,
        dataUrl: "data:image/png;base64,AAAA",
        extractedText: null,
        fileName: "chart.png",
        id: "image",
        kind: "image",
        metadata: { image: { detail: "original" } },
        mimeType: "image/png",
        status: "ready"
      }],
      context: undefined,
      modelId: "deepseek-v4-flash-vision-exp",
      params: {
        maxOutputTokens: 256,
        reasoning: { effort: "none" },
        stream: false,
        temperature: 0.25
      }
    }));
    expect(body.input).toEqual([{
      content: [
        { text: "Current question", type: "input_text" },
        { detail: "original", image_url: "data:image/png;base64,AAAA", type: "input_image" }
      ],
      role: "user"
    }]);
    expect(body.temperature).toBe(0.25);
  });

  it("uses only the official Responses endpoint and bearer authentication", async () => {
    const fetchFn = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit
    ) => Response.json({
      id: "response-1",
      output_text: "ok",
      status: "completed"
    }));
    const client = createFetchDeepSeekResponsesClient({
      apiKey: "secret-key",
      fetchFn
    });
    await client.create({ input: [], model: "deepseek-v4-pro" });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/responses");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-key");
  });

  it("uses DeepSeek JSON Schema output without OpenAI lifecycle parameters", async () => {
    const schema = {
      additionalProperties: false,
      properties: { answer: { type: "string" } },
      required: ["answer"],
      type: "object"
    };
    const model = {
      adapterKind: "deepseek_responses_native" as const,
      upstreamModelId: "deepseek-v4-pro"
    };
    const structuredRequest = {
      name: "result",
      reasoningEffort: "low",
      schema,
      systemPrompt: "Return structured data.",
      userPrompt: "Provide the answer."
    };
    const body = buildDeepSeekResponsesStructuredOutputRequest(model, structuredRequest);
    expect(body).toMatchObject({
      max_output_tokens: 1_024,
      model: "deepseek-v4-pro",
      reasoning: { effort: "low" },
      stream: false,
      text: { format: { name: "result", schema, strict: true, type: "json_schema" } }
    });
    expect(body).not.toHaveProperty("background");
    expect(body).not.toHaveProperty("store");

    const client: DeepSeekResponsesClient = {
      create: async () => ({
        id: "structured-1",
        output_text: "{\"answer\":\"ok\"}",
        status: "completed",
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 }
      }),
      stream: async () => { throw new Error("unexpected stream"); }
    };
    await expect(createDeepSeekResponsesStructuredOutputAdapter({ client, model }).execute(
      structuredRequest
    )).resolves.toEqual({ answer: "ok" });
  });

  it("normalizes a multi-round function call without exposing raw reasoning as an artifact", async () => {
    const client: DeepSeekResponsesClient = {
      create: async () => ({
        id: "response-tool",
        model: "deepseek-v4-pro",
        output: [
          {
            content: [{ text: "private chain", type: "reasoning_text" }],
            id: "reasoning-1",
            type: "reasoning"
          },
          {
            arguments: "{\"value\":7}",
            call_id: "call-7",
            name: "calculate",
            type: "function_call"
          }
        ],
        status: "completed",
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 }
      }),
      stream: async () => { throw new Error("unexpected stream"); }
    };
    const stream = createDeepSeekResponsesAdapter({ client }).stream(request());
    const events = [];
    let next = await stream.next();
    while (!next.done) {
      events.push(next.value);
      next = await stream.next();
    }
    expect(next.value.toolCalls).toMatchObject([{
      arguments: { value: 7 },
      id: "call-7",
      name: "calculate"
    }]);
    expect(next.value.providerToolCallMessage).toHaveLength(2);
    expect(next.value.finalProviderResponsePreview).toMatchObject({ provider: "deepseek" });
    expect(JSON.stringify(events)).not.toContain("private chain");
  });

  it("requires a semantic completed event for streaming", async () => {
    const terminal = {
      id: "response-stream",
      model: "deepseek-v4-flash",
      output: [{ content: [{ text: "done", type: "output_text" }], type: "message" }],
      status: "completed",
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
    };
    const client: DeepSeekResponsesClient = {
      create: async () => { throw new Error("unexpected create"); },
      stream: async () => sseResponse([
        `event: response.created\ndata: ${JSON.stringify({ response: { id: terminal.id, status: "in_progress" }, type: "response.created" })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "done", response_id: terminal.id, type: "response.output_text.delta" })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ response: terminal, type: "response.completed" })}\n\n`
      ])
    };
    const stream = createDeepSeekResponsesAdapter({ client }).stream(request({
      params: { maxOutputTokens: 64, reasoning: { effort: "none" }, stream: true }
    }));
    let result;
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    result = next.value;
    expect(result.finalText).toBe("done");
    expect(result.providerResponseId).toBe("response-stream");
  });

  it("accepts confirmed DeepSeek web search without inventing source URLs", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const client: DeepSeekResponsesClient = {
      create: async (body) => {
        requestBody = body;
        return {
          id: "response-search",
          output: [
            { id: "search-1", status: "completed", type: "web_search_call" },
            { content: [{ text: "Verified finding", type: "output_text" }], type: "message" }
          ],
          status: "completed",
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
        };
      },
      stream: async () => { throw new Error("unexpected stream"); }
    };
    const searchRequest: ProviderSearchRequest = {
      correlationId: "search-test",
      query: "official DeepSeek" as ValidatedSearchQuery,
      searchPolicy: {
        maxOutputTokens: 1_024,
        modelCapabilities: {
          nativePdfInput: false,
          nativeSearch: true,
          pdf: true,
          reasoning: true,
          reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
          vision: false
        },
        modelId: "deepseek-v4-pro",
        provider: "deepseek",
        reasoningPolicy: "lowest_supported",
        strategyId: "deepseek-responses-web-search"
      },
      strategyId: "deepseek-native-web-search"
    };
    const result = await createDeepSeekResponsesSearchAdapter({ client }).search(searchRequest);
    expect(result).toMatchObject({
      findings: "Verified finding",
      sourceAttribution: "provider_unavailable",
      sources: []
    });
    expect(requestBody).toMatchObject({
      tool_choice: "auto",
      tools: [{ type: "web_search" }]
    });
    expect(result.artifacts).toMatchObject([{
      data: { payload: { provider: "deepseek", sourceAttribution: "provider_unavailable" } }
    }]);
  });

  it("marks hosted Search artifacts as source-unavailable in ordinary answers", async () => {
    const client: DeepSeekResponsesClient = {
      create: async () => ({
        id: "response-hosted-search",
        output: [
          { id: "search-1", status: "completed", type: "web_search_call" },
          { content: [{ text: "Current finding", type: "output_text" }], type: "message" }
        ],
        status: "completed"
      }),
      stream: async () => { throw new Error("unexpected stream"); }
    };
    const stream = createDeepSeekResponsesAdapter({ client }).stream(request());
    const events = [];
    let next = await stream.next();
    while (!next.done) {
      events.push(next.value);
      next = await stream.next();
    }

    expect(events).toContainEqual({
      data: {
        artifactType: "search",
        payload: {
          id: "search-1",
          provider: "deepseek",
          sourceAttribution: "provider_unavailable",
          status: "completed",
          type: "web_search_call"
        }
      },
      type: "artifact"
    });
  });
});

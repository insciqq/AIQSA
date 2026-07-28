import { describe, expect, it } from "vitest";
import {
  buildCompatibleResponsesRequest,
  createCompatibleResponsesAdapter
} from "./compatibleResponses";
import type { OpenAIResponsesClient } from "./openaiResponsesTransport";
import type { ProviderRunRequest } from "./types";

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
    prompt: { developer: null, presetId: null, system: null },
    provider: "custom",
    searchStrategy: "search-disabled",
    ...overrides
  };
}

describe("compatible Responses adapter", () => {
  it("forces stateless manual replay and strips native-only extensions", () => {
    const body = buildCompatibleResponsesRequest(request());

    expect(body).toMatchObject({
      background: false,
      model: "compatible-model",
      store: false,
      stream: false
    });
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
    expect(buildCompatibleResponsesRequest(
      request({ searchStrategy: "openai-native-web-search" })
    )).toMatchObject({
      background: false,
      include: ["web_search_call.action.sources"],
      store: false,
      tools: [{ type: "web_search" }]
    });
  });

  it("normalizes a completed non-streaming response", async () => {
    const client: OpenAIResponsesClient = {
      cancel: async () => ({}),
      create: async () => ({
        id: "response-1",
        model: "compatible-model",
        output_text: "Compatible answer",
        status: "completed",
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 }
      }),
      retrieve: async () => ({})
    };
    const adapter = createCompatibleResponsesAdapter({ client });
    const events = [];
    const stream = adapter.stream(request());
    let next = await stream.next();
    while (!next.done) {
      events.push(next.value);
      next = await stream.next();
    }

    expect(next.value.finalText).toBe("Compatible answer");
    expect(events.some((event) => event.type === "usage")).toBe(true);
    expect(events.some((event) => event.type === "token")).toBe(true);
  });
});

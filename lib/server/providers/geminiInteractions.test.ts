import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { describe, expect, it, vi } from "vitest";
import { createGeminiInteractionsAdapter } from "./geminiInteractions";
import type { GeminiInteractionsClient } from "./geminiInteractionsTransport";
import type { ProviderRunRequest, ProviderRunResult } from "./types";

function request(stream: boolean): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "hello", type: "text" }] },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    toolMode: "auto",
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: true,
      pdf: false,
      reasoning: false,
      streaming: true,
      vision: false
    },
    modelId: "gemini-3.6-flash",
    params: { maxTokens: 32, stream },
    prompt: { developer: null, system: null },
    provider: "gemini",
    searchPlan: { mode: "all_selected", options: [] }
  };
}

async function collect(
  stream: AsyncGenerator<ModelRunSseEvent, ProviderRunResult>
): Promise<ProviderRunResult> {
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  return next.value;
}

async function collectEvents(
  stream: AsyncGenerator<ModelRunSseEvent, ProviderRunResult>
): Promise<ModelRunSseEvent[]> {
  const events: ModelRunSseEvent[] = [];
  let next = await stream.next();
  while (!next.done) {
    events.push(next.value);
    next = await stream.next();
  }
  return events;
}

describe("Gemini Interactions adapter", () => {
  it("uses unary create when streaming is disabled", async () => {
    const createInteraction = vi.fn<GeminiInteractionsClient["createInteraction"]>(async () => ({
      id: "unary-1",
      model: "gemini-3.6-flash",
      status: "completed",
      steps: [{ content: [{ text: "ok", type: "text" }], type: "model_output" }]
    }));
    const client: GeminiInteractionsClient = {
      createInteraction,
      streamInteraction: vi.fn()
    };
    const result = await collect(createGeminiInteractionsAdapter({ client }).stream(request(false)));

    expect(createInteraction).toHaveBeenCalledOnce();
    expect(createInteraction.mock.calls[0]?.[0]).toMatchObject({ store: false, stream: false });
    expect(result.finalText).toBe("ok");
  });

  it("does not synthesize a usage event when unary usage is absent", async () => {
    const client: GeminiInteractionsClient = {
      createInteraction: vi.fn(async () => ({
        id: "unary-no-usage",
        model: "gemini-3.6-flash",
        status: "completed",
        steps: [{ content: [{ text: "ok", type: "text" }], type: "model_output" }]
      })),
      streamInteraction: vi.fn()
    };

    const events = await collectEvents(
      createGeminiInteractionsAdapter({ client }).stream(request(false))
    );

    expect(events.some(({ type }) => type === "usage")).toBe(false);
  });

  it("uses strict SSE when streaming is enabled", async () => {
    const body = [
      'event: interaction.created\ndata: {"event_type":"interaction.created","interaction":{"id":"stream-1","status":"in_progress"}}\n\n',
      'event: step.start\ndata: {"event_type":"step.start","index":0,"step":{"type":"model_output","content":[]}}\n\n',
      'event: step.delta\ndata: {"event_type":"step.delta","index":0,"delta":{"type":"text","text":"ok"}}\n\n',
      'event: step.stop\ndata: {"event_type":"step.stop","index":0}\n\n',
      'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"id":"stream-1","status":"completed"}}\n\n',
      "event: done\ndata: [DONE]\n\n"
    ].join("");
    const client: GeminiInteractionsClient = {
      createInteraction: vi.fn(),
      streamInteraction: vi.fn(async () => new Response(body, {
        headers: { "content-type": "text/event-stream" }
      }))
    };
    const result = await collect(createGeminiInteractionsAdapter({ client }).stream(request(true)));

    expect(client.streamInteraction).toHaveBeenCalledOnce();
    expect(result.finalText).toBe("ok");
  });

  it("does not require hosted grounding for a logical Google source admitted as client Search", async () => {
    const body = [
      'event: interaction.created\ndata: {"event_type":"interaction.created","interaction":{"id":"stream-client-search","status":"in_progress"}}\n\n',
      'event: step.start\ndata: {"event_type":"step.start","index":0,"step":{"type":"model_output","content":[]}}\n\n',
      'event: step.delta\ndata: {"event_type":"step.delta","index":0,"delta":{"type":"text","text":"ordinary answer"}}\n\n',
      'event: step.stop\ndata: {"event_type":"step.stop","index":0}\n\n',
      'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"id":"stream-client-search","status":"completed"}}\n\n',
      "event: done\ndata: [DONE]\n\n"
    ].join("");
    const client: GeminiInteractionsClient = {
      createInteraction: vi.fn(),
      streamInteraction: vi.fn(async () => new Response(body, {
        headers: { "content-type": "text/event-stream" }
      }))
    };
    const clientSearchRequest: ProviderRunRequest = {
      ...request(true),
      searchPlan: {
        mode: "model_choice",
        options: [{
          adapterKind: "provider_model_client",
          config: {},
          credentialMode: "provider_model",
          displayName: "Google Search",
          executionModes: ["all_selected", "model_choice"],
          modelId: "gemini-3.6-flash",
          optionId: "gemini-google-search",
          protocol: "gemini_google_search",
          provider: "gemini",
          providerModelId: "gemini-search-model",
          revisionId: "gemini-search-revision",
          searchStrategyRowId: "gemini-search-client-route"
        }]
      },
    };

    const result = await collect(
      createGeminiInteractionsAdapter({ client }).stream(clientSearchRequest)
    );

    expect(client.streamInteraction).toHaveBeenCalledWith(
      expect.not.objectContaining({ tools: [{ type: "google_search" }] }),
      expect.any(Object)
    );
    expect(result.finalText).toBe("ordinary answer");
  });
});

import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { describe, expect, it } from "vitest";
import type { ProviderRunResult } from "./types";
import {
  parseGeminiInteractionsSse,
  streamGeminiInteractionsJsonResponse
} from "./geminiInteractionsResponse";

const suggestionsHtml = [
  "<style>.container { display: flex; position: relative; }</style>",
  '<div class="container"><a class="chip" href="https://www.google.com/search?q=aiqsa" target="_blank">Search on Google</a>',
  '<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">',
  '<circle cx="10" cy="10" r="8" fill="#4285f4"></circle>',
  '<path d="M1 1 L2 2 Z" fill="currentColor"></path></svg></div>'
].join("");

async function collect(
  stream: AsyncGenerator<ModelRunSseEvent, ProviderRunResult>
): Promise<{ events: ModelRunSseEvent[]; result: ProviderRunResult }> {
  const events: ModelRunSseEvent[] = [];
  let next = await stream.next();
  while (!next.done) {
    events.push(next.value);
    next = await stream.next();
  }
  return { events, result: next.value };
}

function sseResponse(frames: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    }
  });
}

function frame(event: string, payload: unknown): string {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `event: ${event}\ndata: ${data}\n\n`;
}

describe("Gemini Interactions response normalization", () => {
  it("normalizes grounded JSON with safe usage and live-only display data", async () => {
    const normalized = await collect(streamGeminiInteractionsJsonResponse({
      id: "interaction-1",
      model: "gemini-3.6-flash",
      status: "completed",
      steps: [
        { signature: "search-thought-signature", type: "thought" },
        {
          arguments: { queries: ["AIQSA"] },
          id: "search-1",
          signature: "search-call-signature",
          type: "google_search_call"
        },
        {
          call_id: "search-1",
          result: [{ search_suggestions: suggestionsHtml }],
          signature: "search-result-signature",
          type: "google_search_result"
        },
        {
          content: [{
            annotations: [{
              end_index: 12,
              start_index: 0,
              title: "AIQSA source",
              type: "url_citation",
              url: "https://example.test/source"
            }],
            text: "Grounded answer",
            type: "text"
          }],
          type: "model_output"
        }
      ],
      usage: {
        total_cached_tokens: 3,
        total_input_tokens: 10,
        total_output_tokens: 5,
        total_thought_tokens: 7,
        total_tokens: 22,
        total_tool_use_tokens: 99
      }
    }, { modelId: "gemini-3.6-flash" }));

    const groundingIndex = normalized.events.findIndex((event) =>
      event.type === "grounding_display" && Boolean(event.data.suggestionsHtml));
    const tokenIndex = normalized.events.findIndex((event) => event.type === "token");
    expect(groundingIndex).toBeGreaterThanOrEqual(0);
    expect(tokenIndex).toBeGreaterThan(groundingIndex);
    expect(normalized.events[groundingIndex]).toEqual({
      data: {
        citations: [{
          endIndex: 12,
          startIndex: 0,
          title: "AIQSA source",
          url: "https://example.test/source"
        }],
        provider: "gemini",
        runSearch: { callCount: 1, queryCount: 1 },
        suggestionsHtml
      },
      type: "grounding_display"
    });
    expect(normalized.result).toMatchObject({
      finalText: "Grounded answer",
      providerResponseId: "interaction-1",
      usage: {
        cachedInputTokens: 3,
        inputTokens: 10,
        outputTokens: 12,
        reasoningTokens: 7,
        totalTokens: 22
      }
    });
    const durableShape = JSON.stringify(normalized.result);
    expect(durableShape).not.toContain(suggestionsHtml);
    expect(durableShape).not.toContain("search-call-signature");
    expect(durableShape).not.toContain("search-result-signature");
  });

  it("preserves ordered provider signatures only in private function continuation state", async () => {
    const normalized = await collect(streamGeminiInteractionsJsonResponse({
      id: "interaction-tools",
      model: "gemini-3.6-flash",
      status: "requires_action",
      steps: [
        { signature: "private-thought-signature", type: "thought" },
        { content: [{ text: "Using a tool.", type: "text" }], type: "model_output" },
        {
          arguments: { id: "42" },
          id: "call-1",
          name: "records__lookup",
          signature: "private-function-signature",
          type: "function_call"
        }
      ]
    }, { modelId: "gemini-3.6-flash" }));

    expect(normalized.result.toolCalls).toMatchObject([{
      arguments: { id: "42" },
      id: "call-1",
      name: "records__lookup"
    }]);
    expect(normalized.result.providerToolCallMessage).toEqual([
      { signature: "private-thought-signature", type: "thought" },
      { content: [{ text: "Using a tool.", type: "text" }], type: "model_output" },
      {
        arguments: { id: "42" },
        id: "call-1",
        name: "records__lookup",
        signature: "private-function-signature",
        type: "function_call"
      }
    ]);
    expect(JSON.stringify(normalized.result.finalProviderResponsePreview))
      .not.toContain("private-thought-signature");
    expect(JSON.stringify(normalized.result.finalProviderResponsePreview))
      .not.toContain("private-function-signature");
  });

  it("accepts a provisional thought signature at step.start when summaries are disabled", async () => {
    const normalized = await collect(parseGeminiInteractionsSse({
      groundingExpected: false,
      idleTimeoutMs: 1_000,
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse([
        frame("interaction.created", {
          event_type: "interaction.created",
          interaction: { id: "stream-thought-none", status: "in_progress" }
        }),
        frame("step.start", {
          event_type: "step.start",
          index: 0,
          step: { signature: "", type: "thought" }
        }),
        frame("step.delta", {
          delta: { signature: "private-thought-signature", type: "thought_signature" },
          event_type: "step.delta",
          index: 0
        }),
        frame("step.stop", { event_type: "step.stop", index: 0 }),
        frame("step.start", {
          event_type: "step.start",
          index: 1,
          step: { type: "model_output" }
        }),
        frame("step.delta", {
          delta: { text: "Answer without a thought summary", type: "text" },
          event_type: "step.delta",
          index: 1
        }),
        frame("step.stop", { event_type: "step.stop", index: 1 }),
        frame("interaction.completed", {
          event_type: "interaction.completed",
          interaction: { id: "stream-thought-none", status: "completed" }
        }),
        frame("done", "[DONE]")
      ])
    }));

    expect(normalized.result.finalText).toBe("Answer without a thought summary");
    expect(JSON.stringify(normalized.result)).not.toContain("private-thought-signature");
  });

  it("assembles documented provisional Google Search signatures from later deltas", async () => {
    const normalized = await collect(parseGeminiInteractionsSse({
      groundingExpected: true,
      idleTimeoutMs: 1_000,
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse([
        frame("interaction.created", {
          event_type: "interaction.created",
          interaction: { id: "stream-search-signatures", status: "in_progress" }
        }),
        frame("step.start", {
          event_type: "step.start",
          index: 0,
          step: { id: "search-1", signature: "", type: "google_search_call" }
        }),
        frame("step.delta", {
          delta: {
            arguments: { queries: ["AIQSA"] },
            signature: "private-search-call-signature",
            type: "google_search_call"
          },
          event_type: "step.delta",
          index: 0
        }),
        frame("step.stop", { event_type: "step.stop", index: 0 }),
        frame("step.start", {
          event_type: "step.start",
          index: 1,
          step: { call_id: "search-1", signature: "", type: "google_search_result" }
        }),
        frame("step.delta", {
          delta: {
            is_error: false,
            result: [{ search_suggestions: suggestionsHtml }],
            signature: "private-search-result-signature",
            type: "google_search_result"
          },
          event_type: "step.delta",
          index: 1
        }),
        frame("step.stop", { event_type: "step.stop", index: 1 }),
        frame("step.start", {
          event_type: "step.start",
          index: 2,
          step: { type: "model_output" }
        }),
        frame("step.delta", {
          delta: { text: "Grounded answer", type: "text" },
          event_type: "step.delta",
          index: 2
        }),
        frame("step.stop", { event_type: "step.stop", index: 2 }),
        frame("interaction.completed", {
          event_type: "interaction.completed",
          interaction: { id: "stream-search-signatures", status: "completed" }
        }),
        frame("done", "[DONE]")
      ])
    }));

    expect(normalized.result.finalText).toBe("Grounded answer");
    expect(normalized.events).toContainEqual(expect.objectContaining({
      data: expect.objectContaining({ suggestionsHtml }),
      type: "grounding_display"
    }));
    expect(JSON.stringify(normalized.result)).not.toContain("private-search-call-signature");
    expect(JSON.stringify(normalized.result)).not.toContain("private-search-result-signature");
  });

  it("keeps an empty signature invalid outside a provisional step.start", async () => {
    await expect(collect(streamGeminiInteractionsJsonResponse({
      id: "interaction-empty-signature",
      status: "completed",
      steps: [
        { signature: "", type: "thought" },
        { content: [{ text: "Answer", type: "text" }], type: "model_output" }
      ]
    }, { modelId: "gemini-3.6-flash" }))).rejects.toThrow(
      "gemini_interactions_step_invalid"
    );

    await expect(collect(parseGeminiInteractionsSse({
      groundingExpected: false,
      idleTimeoutMs: 1_000,
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse([
        frame("interaction.created", {
          event_type: "interaction.created",
          interaction: { id: "stream-unsettled-signature", status: "in_progress" }
        }),
        frame("step.start", {
          event_type: "step.start",
          index: 0,
          step: { signature: "", type: "thought" }
        }),
        frame("step.stop", { event_type: "step.stop", index: 0 })
      ])
    }))).rejects.toThrow("gemini_interactions_step_invalid");

  });

  it("treats null optional fields as absent on the first streamed thought step", async () => {
    const normalized = await collect(parseGeminiInteractionsSse({
      groundingExpected: false,
      idleTimeoutMs: 1_000,
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse([
        frame("interaction.created", {
          event_type: "interaction.created",
          interaction: { id: "stream-null-optionals", status: "in_progress" }
        }),
        frame("step.start", {
          event_type: "step.start",
          index: 0,
          step: { signature: null, summary: null, type: "thought" }
        }),
        frame("step.stop", { event_type: "step.stop", index: 0 }),
        frame("step.start", {
          event_type: "step.start",
          index: 1,
          step: { content: null, type: "model_output" }
        }),
        frame("step.delta", {
          delta: { text: "Answer after null thought fields", type: "text" },
          event_type: "step.delta",
          index: 1
        }),
        frame("step.stop", { event_type: "step.stop", index: 1 }),
        frame("interaction.completed", {
          event_type: "interaction.completed",
          interaction: { id: "stream-null-optionals", status: "completed" }
        }),
        frame("done", "[DONE]")
      ])
    }));

    expect(normalized.result.finalText).toBe("Answer after null thought fields");
  });

  it("normalizes null optional fields in terminal Search steps", async () => {
    const normalized = await collect(streamGeminiInteractionsJsonResponse({
      id: "interaction-null-optionals",
      model: "gemini-3.6-flash",
      status: "completed",
      steps: [
        { signature: null, summary: null, type: "thought" },
        {
          arguments: null,
          id: "search-null-optionals",
          search_type: null,
          signature: null,
          type: "google_search_call"
        },
        {
          call_id: "search-null-optionals",
          is_error: null,
          result: [{ search_suggestions: suggestionsHtml }],
          signature: null,
          type: "google_search_result"
        },
        {
          content: [{ annotations: null, text: "Grounded answer", type: "text" }],
          type: "model_output"
        }
      ]
    }, { groundingExpected: true, modelId: "gemini-3.6-flash" }));

    expect(normalized.result.finalText).toBe("Grounded answer");
    expect(normalized.events).toContainEqual(expect.objectContaining({
      data: expect.objectContaining({ suggestionsHtml }),
      type: "grounding_display"
    }));
  });

  it("emits an early purge marker, then validated suggestions, then buffered SSE text", async () => {
    const terminalSteps = [
      {
        arguments: { queries: ["AIQSA"] },
        id: "search-1",
        signature: "call-signature",
        type: "google_search_call"
      },
      {
        call_id: "search-1",
        result: [{ search_suggestions: suggestionsHtml }],
        signature: "result-signature",
        type: "google_search_result"
      },
      { content: [{ text: "Grounded stream", type: "text" }], type: "model_output" }
    ];
    const normalized = await collect(parseGeminiInteractionsSse({
      groundingExpected: true,
      idleTimeoutMs: 1_000,
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse([
        frame("interaction.created", {
          event_type: "interaction.created",
          interaction: { id: "stream-1", model: "gemini-3.6-flash", status: "in_progress" }
        }),
        frame("step.start", {
          event_type: "step.start",
          index: 0,
          step: { content: [], type: "model_output" }
        }),
        frame("step.delta", {
          delta: { text: "Grounded stream", type: "text" },
          event_type: "step.delta",
          index: 0
        }),
        frame("step.stop", { event_type: "step.stop", index: 0 }),
        frame("step.start", {
          event_type: "step.start",
          index: 1,
          step: terminalSteps[0]
        }),
        frame("step.stop", { event_type: "step.stop", index: 1 }),
        frame("step.start", {
          event_type: "step.start",
          index: 2,
          step: { call_id: "search-1", type: "google_search_result" }
        }),
        frame("step.stop", { event_type: "step.stop", index: 2 }),
        frame("interaction.completed", {
          event_type: "interaction.completed",
          interaction: { id: "stream-1", status: "completed", steps: terminalSteps }
        }),
        frame("done", "[DONE]")
      ])
    }));

    const markers = normalized.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === "grounding_display");
    const early = markers.find(({ event }) => event.type === "grounding_display" &&
      event.data.suggestionsHtml === "");
    const validated = markers.find(({ event }) => event.type === "grounding_display" &&
      event.data.suggestionsHtml === suggestionsHtml);
    const tokenIndex = normalized.events.findIndex((event) => event.type === "token");
    expect(early?.index).toBeGreaterThanOrEqual(0);
    expect(validated?.index).toBeGreaterThan(early?.index ?? -1);
    expect(tokenIndex).toBeGreaterThan(validated?.index ?? Number.MAX_SAFE_INTEGER);
    expect(normalized.result.finalText).toBe("Grounded stream");
  });

  it("fails closed without releasing buffered grounded text when suggestions are missing", async () => {
    const generator = parseGeminiInteractionsSse({
      groundingExpected: true,
      idleTimeoutMs: 1_000,
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse([
        frame("interaction.created", {
          event_type: "interaction.created",
          interaction: { id: "stream-bad", status: "in_progress" }
        }),
        frame("step.start", {
          event_type: "step.start",
          index: 0,
          step: { arguments: { queries: ["x"] }, id: "search-1", type: "google_search_call" }
        }),
        frame("step.stop", { event_type: "step.stop", index: 0 }),
        frame("step.start", {
          event_type: "step.start",
          index: 1,
          step: { content: [], type: "model_output" }
        }),
        frame("step.delta", {
          delta: { text: "must stay buffered", type: "text" },
          event_type: "step.delta",
          index: 1
        }),
        frame("step.stop", { event_type: "step.stop", index: 1 }),
        frame("interaction.completed", {
          event_type: "interaction.completed",
          interaction: { id: "stream-bad", status: "completed" }
        }),
        frame("done", "[DONE]")
      ])
    });
    const events: ModelRunSseEvent[] = [];
    let failure: unknown;
    try {
      let next = await generator.next();
      while (!next.done) {
        events.push(next.value);
        next = await generator.next();
      }
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ message: "gemini_interactions_grounding_suggestions_missing" });
    expect(events.some((event) => event.type === "grounding_display")).toBe(true);
    expect(events.some((event) => event.type === "token")).toBe(false);
  });

  it("releases a buffered ordinary answer when auto Search legitimately makes no call", async () => {
    const normalized = await collect(parseGeminiInteractionsSse({
      groundingExpected: true,
      idleTimeoutMs: 1_000,
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse([
        frame("interaction.created", {
          event_type: "interaction.created",
          interaction: { id: "stream-no-search", status: "in_progress" }
        }),
        frame("step.start", {
          event_type: "step.start",
          index: 0,
          step: { content: [], type: "model_output" }
        }),
        frame("step.delta", {
          delta: { text: "Ordinary answer", type: "text" },
          event_type: "step.delta",
          index: 0
        }),
        frame("step.stop", { event_type: "step.stop", index: 0 }),
        frame("interaction.completed", {
          event_type: "interaction.completed",
          interaction: { id: "stream-no-search", status: "completed" }
        }),
        frame("done", "[DONE]")
      ])
    }));

    expect(normalized.events.some((event) => event.type === "grounding_display")).toBe(false);
    expect(normalized.events.filter((event) => event.type === "token")).toEqual([
      { data: { delta: "Ordinary answer" }, type: "token" }
    ]);
    expect(normalized.result.finalText).toBe("Ordinary answer");
  });

  it("assembles signed SSE function calls and requires terminal plus done evidence", async () => {
    const normalized = await collect(parseGeminiInteractionsSse({
      groundingExpected: false,
      idleTimeoutMs: 1_000,
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse([
        frame("interaction.created", {
          event_type: "interaction.created",
          interaction: { id: "stream-tools", status: "in_progress" }
        }),
        frame("step.start", { event_type: "step.start", index: 0, step: { type: "thought" } }),
        frame("step.delta", {
          delta: { signature: "private-stream-signature", type: "thought_signature" },
          event_type: "step.delta",
          index: 0
        }),
        frame("step.stop", { event_type: "step.stop", index: 0 }),
        frame("step.start", {
          event_type: "step.start",
          index: 1,
          step: {
            arguments: {},
            id: "call-1",
            name: "records__lookup",
            signature: "private-stream-function-signature",
            type: "function_call"
          }
        }),
        frame("step.delta", {
          delta: { arguments: '{"id":"42"}', type: "arguments_delta" },
          event_type: "step.delta",
          index: 1
        }),
        frame("step.stop", { event_type: "step.stop", index: 1 }),
        frame("interaction.completed", {
          event_type: "interaction.completed",
          interaction: { id: "stream-tools", status: "requires_action" }
        }),
        frame("done", "[DONE]")
      ])
    }));

    expect(normalized.result.toolCalls).toMatchObject([{
      arguments: { id: "42" },
      id: "call-1",
      name: "records__lookup"
    }]);
    expect(normalized.result.providerToolCallMessage).toEqual([
      { signature: "private-stream-signature", type: "thought" },
      {
        arguments: { id: "42" },
        id: "call-1",
        name: "records__lookup",
        signature: "private-stream-function-signature",
        type: "function_call"
      }
    ]);

    await expect(collect(parseGeminiInteractionsSse({
      groundingExpected: false,
      idleTimeoutMs: 1_000,
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse([
        frame("interaction.created", {
          event_type: "interaction.created",
          interaction: { id: "truncated", status: "in_progress" }
        })
      ])
    }))).rejects.toThrow("gemini_interactions_stream_truncated");
  });

  it("drops raw SSE error details", async () => {
    const remoteSecret = "remote-error-secret";
    let failure: unknown;
    try {
      await collect(parseGeminiInteractionsSse({
        groundingExpected: false,
        idleTimeoutMs: 1_000,
        modelId: "gemini-3.6-flash",
        responseBody: sseResponse([
          frame("interaction.created", {
            event_type: "interaction.created",
            interaction: { id: "error-1", status: "in_progress" }
          }),
          frame("error", {
            error: { code: remoteSecret, message: remoteSecret },
            event_type: "error"
          })
        ])
      }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ message: "gemini_interactions_stream_error" });
    expect((failure as Error).message).not.toContain(remoteSecret);
  });
});

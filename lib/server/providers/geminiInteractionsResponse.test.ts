import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { describe, expect, it } from "vitest";
import type { ProviderRunResult } from "./types";
import {
  parseGeminiInteractionsSse,
  streamGeminiInteractionsJsonResponse
} from "./geminiInteractionsResponse";
import { DEFAULT_PROVIDER_STREAM_LIMITS } from "./network";
import { PROVIDER_RESPONSE_MAX_CITATIONS } from "../../domain/answerCitations";
import { decodeGroundingDisplay } from "../../domain/groundingDisplay";

const suggestionsHtml = [
  "<style>#provider-css-canary { pos\\69 tion: fixed; inset: 0; z-index: 2147483647; }</style>",
  '<div class="container"><a class="chip" href="https://www.google.com/search?q=aiqsa" target="_blank">Search on Google</a>',
  '<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">',
  '<circle cx="10" cy="10" r="8" fill="#4285f4"></circle>',
  '<path d="M1 1 L2 2 Z" fill="currentColor"></path></svg></div>'
].join("");
const suggestionsProjection = [
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
  const outputSteps = [{ type: "model_output", content: [{ type: "text", text: "ok" }] }];
  const metadataStream = (created: Record<string, unknown>, completed: Record<string, unknown>,
    updates: readonly Record<string, unknown>[] = []) =>
    parseGeminiInteractionsSse({ groundingExpected: false, modelId: "gemini-3.8-flash",
      responseBody: sseResponse([
        frame("interaction.created", { event_type: "interaction.created", interaction: created }),
        ...updates.map(update => frame("interaction.status_update", { event_type: "interaction.status_update", ...update })),
        frame("interaction.completed", { event_type: "interaction.completed",
          interaction: { steps: outputSteps, ...completed } }),
        frame("done", "[DONE]")
      ]) });

  it.each([
    { id: "", status: "in_progress" },
    { status: "in_progress" },
    { id: "" },
    { object: "interaction", model: "gemini-3.8-flash" }
  ])("accepts omitted stateless metadata without inventing an ID: %j", async created => {
    const normalized = await collect(metadataStream(created, { status: "completed" }));
    expect(normalized.result.finalText).toBe("ok");
    expect(normalized.result).not.toHaveProperty("providerResponseId");
    expect(JSON.stringify(normalized.events)).not.toContain("responseId");
  });

  it("retains a supplied ID when completion omits it and accepts a later first ID", async () => {
    expect((await collect(metadataStream({ id: "known-id" }, { status: "completed" })))
      .result.providerResponseId).toBe("known-id");
    expect((await collect(metadataStream({}, { id: "late-id", status: "completed" })))
      .result.providerResponseId).toBe("late-id");
  });

  it("accepts a stateless status update with no ID and preserves any earlier ID", async () => {
    const updates = [{ status: "in_progress" }];
    expect((await collect(metadataStream({}, { status: "completed" }, updates)))
      .result.providerResponseId).toBeUndefined();
    expect((await collect(metadataStream({ id: "known-id" }, { status: "completed" }, updates)))
      .result.providerResponseId).toBe("known-id");
    expect((await collect(metadataStream({}, { status: "completed" }, [
      { status: "in_progress", interaction_id: "later-id" }
    ]))).result.providerResponseId).toBe("later-id");
  });

  it.each([
    { interaction_id: null, status: "in_progress" },
    { interaction_id: 7, status: "in_progress" },
    { interaction_id: "different-id", status: "in_progress" },
    { interaction_id: "known-id" },
    { interaction_id: "known-id", status: null }
  ])("still validates supplied status update metadata: %j", async update => {
    await expect(collect(metadataStream({ id: "known-id" }, { status: "completed" }, [update])))
      .rejects.toThrow("gemini_interactions_stream_status_invalid");
  });

  it.each([
    [{ id: null }, { status: "completed" }, "stream_created_id_missing"],
    [{ id: 7 }, { status: "completed" }, "stream_created_id_missing"],
    [{ id: "\u0001" }, { status: "completed" }, "stream_created_id_invalid"],
    [{ id: "x".repeat(513) }, { status: "completed" }, "stream_created_id_too_long"],
    [{ status: null }, { status: "completed" }, "stream_created_status_invalid"],
    [{ status: "completed" }, { status: "completed" }, "stream_created_status_invalid"],
    [{}, { id: null, status: "completed" }, "stream_completed_id_invalid"],
    [{ id: "first" }, { id: "different", status: "completed" }, "stream_completed_id_invalid"]
  ] as const)("rejects malformed supplied stream metadata %#", async (created, completed, suffix) => {
    await expect(collect(metadataStream(created, completed))).rejects.toThrow(`gemini_interactions_${suffix}`);
  });

  it.each([undefined, null, "in_progress", "failed", "cancelled", "incomplete"])(
    "still requires a successful explicit terminal status: %s", async status => {
      await expect(collect(metadataStream({}, { status }))).rejects.toThrow(
        ["failed", "cancelled", "incomplete"].includes(String(status))
          ? `gemini_interaction_${status}` : "gemini_interaction_not_terminal"
      );
    });

  it("does not treat an omitted-metadata created frame as terminal proof", async () => {
    await expect(collect(parseGeminiInteractionsSse({ groundingExpected: false, modelId: "gemini-3.8-flash",
      responseBody: sseResponse([
        frame("interaction.created", { event_type: "interaction.created", interaction: {} }),
        frame("done", "[DONE]")
      ]) }))).rejects.toThrow("gemini_interactions_stream_truncated");
  });

  it("retains signed no-call steps for a required-tool correction without exposing the signature", async () => {
    const steps = [
      { signature: "private-correction-signature", type: "thought" },
      { type: "model_output", content: [{ type: "text", text: "I answered too early." }] }
    ];
    const normalized = await collect(streamGeminiInteractionsJsonResponse({
      id: "correction-interaction", status: "completed", steps
    }, { modelId: "gemini-3.8-flash" }));
    expect(normalized.result.toolCalls).toEqual([]);
    expect(normalized.result.providerToolCallMessage).toEqual(steps);
    expect(JSON.stringify(normalized.result.finalProviderResponsePreview)).not.toContain("private-correction-signature");
  });

  it("normalizes grounded JSON with safe usage and display data", async () => {
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
        suggestionsHtml: suggestionsProjection
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
        totalTokens: 22,
        // The answer's own Google Search query, billed on the answer row.
        webSearchCount: 1
      }
    });
    expect(normalized.events).toContainEqual({ data: expect.objectContaining({ inputTokens: 10, webSearchCount: 1 }), type: "usage" });
    const durableShape = JSON.stringify(normalized.result);
    expect(durableShape).not.toContain(suggestionsHtml);
    expect(durableShape).not.toContain(suggestionsProjection);
    expect(durableShape).not.toContain("search-call-signature");
    expect(durableShape).not.toContain("search-result-signature");
    expect(JSON.stringify(normalized.events)).not.toContain("provider-css-canary");
    expect(JSON.stringify(normalized.events)).not.toContain("<style");
  });

  it("displays up to 500 grounded citations per interaction and keeps usage when refusing more", async () => {
    const interaction = (count: number) => {
      const annotation = (index: number) => ({ end_index: 5, start_index: 0, title: `Source ${index}`,
        type: "url_citation", url: `https://example.test/source/${index}` });
      const first = Math.floor(count / 2);
      const output = (from: number, length: number) => ({
        content: [{ annotations: Array.from({ length }, (_, index) => annotation(from + index)), text: "Grounded answer", type: "text" }],
        type: "model_output"
      });
      return {
        id: `interaction-${count}`, model: "gemini-3.6-flash", status: "completed",
        steps: [
          { arguments: { queries: ["AIQSA"] }, id: "search-1", type: "google_search_call" },
          { call_id: "search-1", result: [{ search_suggestions: suggestionsHtml }], type: "google_search_result" },
          output(0, first),
          output(first, count - first)
        ],
        usage: { total_input_tokens: 10, total_output_tokens: 5, total_thought_tokens: 0, total_tokens: 15 }
      };
    };
    for (const count of [101, PROVIDER_RESPONSE_MAX_CITATIONS]) {
      const normalized = await collect(streamGeminiInteractionsJsonResponse(interaction(count), { modelId: "gemini-3.6-flash" }));
      const grounding = normalized.events.find((event) => event.type === "grounding_display");
      expect(grounding?.type === "grounding_display" ? grounding.data.citations : []).toHaveLength(count);
      // The display bound admits everything the adapter accepted, live and reloaded.
      expect(decodeGroundingDisplay(grounding?.data)?.citations).toHaveLength(count);
    }
    const events: ModelRunSseEvent[] = [];
    await expect((async () => {
      for await (const event of streamGeminiInteractionsJsonResponse(interaction(PROVIDER_RESPONSE_MAX_CITATIONS + 1),
        { modelId: "gemini-3.6-flash" })) events.push(event);
    })()).rejects.toThrow("gemini_interactions_grounding_invalid");
    expect(events).toEqual([{ type: "usage", data: expect.objectContaining({ inputTokens: 10, totalTokens: 15 }) }]);
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
      streamLimits: DEFAULT_PROVIDER_STREAM_LIMITS,
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
    expect(normalized.result.providerToolCallMessage).toContainEqual({
      signature: "private-thought-signature", type: "thought"
    });
    expect(JSON.stringify(normalized.result.finalProviderResponsePreview)).not.toContain("private-thought-signature");
    expect(JSON.stringify(normalized.events)).not.toContain("private-thought-signature");
  });

  it("assembles documented provisional Google Search signatures from later deltas", async () => {
    const normalized = await collect(parseGeminiInteractionsSse({
      groundingExpected: true,
      streamLimits: DEFAULT_PROVIDER_STREAM_LIMITS,
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
      data: expect.objectContaining({ suggestionsHtml: suggestionsProjection }),
      type: "grounding_display"
    }));
    expect(JSON.stringify(normalized.events)).not.toContain("provider-css-canary");
    expect(JSON.stringify(normalized.events)).not.toContain("<style");
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
      streamLimits: DEFAULT_PROVIDER_STREAM_LIMITS,
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
      streamLimits: DEFAULT_PROVIDER_STREAM_LIMITS,
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
      data: expect.objectContaining({ suggestionsHtml: suggestionsProjection }),
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
      streamLimits: DEFAULT_PROVIDER_STREAM_LIMITS,
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
      event.data.suggestionsHtml === suggestionsProjection);
    const tokenIndex = normalized.events.findIndex((event) => event.type === "token");
    expect(early?.index).toBeGreaterThanOrEqual(0);
    expect(validated?.index).toBeGreaterThan(early?.index ?? -1);
    expect(tokenIndex).toBeGreaterThan(validated?.index ?? Number.MAX_SAFE_INTEGER);
    expect(normalized.result.finalText).toBe("Grounded stream");
    // Without reported tokens the streamed answer still carries the query it ran.
    expect(normalized.result.usage).toMatchObject({ completeness: "unavailable", webSearchCount: 1 });
    expect(JSON.stringify(normalized.events)).not.toContain("provider-css-canary");
    expect(JSON.stringify(normalized.events)).not.toContain("<style");
  });

  it("fails closed without releasing buffered grounded text when suggestions are missing", async () => {
    const generator = parseGeminiInteractionsSse({
      groundingExpected: true,
      streamLimits: DEFAULT_PROVIDER_STREAM_LIMITS,
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
      streamLimits: DEFAULT_PROVIDER_STREAM_LIMITS,
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
      streamLimits: DEFAULT_PROVIDER_STREAM_LIMITS,
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
      streamLimits: DEFAULT_PROVIDER_STREAM_LIMITS,
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse([
        frame("interaction.created", {
          event_type: "interaction.created",
          interaction: { id: "truncated", status: "in_progress" }
        })
      ])
    }))).rejects.toThrow("gemini_interactions_stream_truncated");
  });

  it("bounds streamed and terminal-only visible output at the exact configured limit", async () => {
    const visibleFrames = (parts: readonly string[]) => [
      frame("interaction.created", {
        event_type: "interaction.created",
        interaction: { id: "stream-output-limit", status: "in_progress" }
      }),
      frame("step.start", {
        event_type: "step.start",
        index: 0,
        step: { type: "model_output" }
      }),
      ...parts.map((text) => frame("step.delta", {
        delta: { text, type: "text" },
        event_type: "step.delta",
        index: 0
      })),
      frame("step.stop", { event_type: "step.stop", index: 0 }),
      frame("interaction.completed", {
        event_type: "interaction.completed",
        interaction: { id: "stream-output-limit", status: "completed" }
      }),
      frame("done", "[DONE]")
    ];
    const exact = await collect(parseGeminiInteractionsSse({
      groundingExpected: false,
      streamLimits: { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars: 5 },
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse(visibleFrames(["Hel", "lo"]))
    }));
    expect(exact.result.finalText).toBe("Hello");

    await expect(collect(parseGeminiInteractionsSse({
      groundingExpected: false,
      streamLimits: { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars: 5 },
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse(visibleFrames(["Hello", "!"]))
    }))).rejects.toMatchObject({
      code: "provider_output_too_large",
      maxChars: 5,
      observedChars: 6,
      retainedTextKind: "visible_output"
    });

    await expect(collect(parseGeminiInteractionsSse({
      groundingExpected: false,
      streamLimits: { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars: 5 },
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse([
        frame("interaction.created", {
          event_type: "interaction.created",
          interaction: { id: "terminal-output-limit", status: "in_progress" }
        }),
        frame("interaction.completed", {
          event_type: "interaction.completed",
          interaction: {
            id: "terminal-output-limit",
            status: "completed",
            steps: [{ content: [{ text: "Hello!", type: "text" }], type: "model_output" }]
          }
        }),
        frame("done", "[DONE]")
      ])
    }))).rejects.toMatchObject({
      code: "provider_output_too_large",
      maxChars: 5,
      observedChars: 6,
      retainedTextKind: "visible_output"
    });
  });

  it("bounds function argument and thought-summary fragments at exact and over limits", async () => {
    const toolFrames = (argumentsDelta: string) => [
      frame("interaction.created", {
        event_type: "interaction.created",
        interaction: { id: "stream-tool-limit", status: "in_progress" }
      }),
      frame("step.start", {
        event_type: "step.start",
        index: 0,
        step: { id: "call-1", name: "lookup", type: "function_call" }
      }),
      frame("step.delta", {
        delta: { arguments: argumentsDelta, type: "arguments_delta" },
        event_type: "step.delta",
        index: 0
      }),
      frame("step.stop", { event_type: "step.stop", index: 0 }),
      frame("interaction.completed", {
        event_type: "interaction.completed",
        interaction: { id: "stream-tool-limit", status: "requires_action" }
      }),
      frame("done", "[DONE]")
    ];
    const exactTool = await collect(parseGeminiInteractionsSse({
      groundingExpected: false,
      streamLimits: { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars: 7 },
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse(toolFrames('{"x":1}'))
    }));
    expect(exactTool.result.toolCalls).toMatchObject([{ arguments: { x: 1 } }]);
    await expect(collect(parseGeminiInteractionsSse({
      groundingExpected: false,
      streamLimits: { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars: 7 },
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse(toolFrames('{"x":10}'))
    }))).rejects.toMatchObject({
      code: "provider_output_too_large",
      retainedTextKind: "tool_arguments"
    });

    const structuredToolFrames = (query: string) => [
      frame("interaction.created", {
        event_type: "interaction.created",
        interaction: { id: "structured-tool-limit", status: "in_progress" }
      }),
      frame("step.start", {
        event_type: "step.start",
        index: 0,
        step: {
          arguments: { query },
          id: "call-structured",
          name: "lookup",
          type: "function_call"
        }
      }),
      frame("step.stop", { event_type: "step.stop", index: 0 }),
      frame("interaction.completed", {
        event_type: "interaction.completed",
        interaction: { id: "structured-tool-limit", status: "requires_action" }
      }),
      frame("done", "[DONE]")
    ];
    await expect(collect(parseGeminiInteractionsSse({
      groundingExpected: false,
      streamLimits: { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars: 17 },
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse(structuredToolFrames("Hello"))
    }))).resolves.toMatchObject({ result: { toolCalls: [{ arguments: { query: "Hello" } }] } });
    await expect(collect(parseGeminiInteractionsSse({
      groundingExpected: false,
      streamLimits: { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars: 17 },
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse(structuredToolFrames("Hello!"))
    }))).rejects.toMatchObject({
      code: "provider_output_too_large",
      retainedTextKind: "tool_arguments"
    });

    const thoughtFrames = (text: string) => [
      frame("interaction.created", {
        event_type: "interaction.created",
        interaction: { id: "stream-thought-limit", status: "in_progress" }
      }),
      frame("step.start", {
        event_type: "step.start",
        index: 0,
        step: { type: "thought" }
      }),
      frame("step.delta", {
        delta: { content: { text, type: "text" }, type: "thought_summary" },
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
        delta: { text: "ok", type: "text" },
        event_type: "step.delta",
        index: 1
      }),
      frame("step.stop", { event_type: "step.stop", index: 1 }),
      frame("interaction.completed", {
        event_type: "interaction.completed",
        interaction: { id: "stream-thought-limit", status: "completed" }
      }),
      frame("done", "[DONE]")
    ];
    await expect(collect(parseGeminiInteractionsSse({
      groundingExpected: false,
      streamLimits: { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars: 5 },
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse(thoughtFrames("think"))
    }))).resolves.toMatchObject({ result: { finalText: "ok" } });
    await expect(collect(parseGeminiInteractionsSse({
      groundingExpected: false,
      streamLimits: { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars: 5 },
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse(thoughtFrames("think!"))
    }))).rejects.toMatchObject({
      code: "provider_output_too_large",
      retainedTextKind: "reasoning"
    });

    const terminalThoughtFrames = (text: string) => [
      frame("interaction.created", {
        event_type: "interaction.created",
        interaction: { id: "terminal-thought-limit", status: "in_progress" }
      }),
      frame("interaction.completed", {
        event_type: "interaction.completed",
        interaction: {
          id: "terminal-thought-limit",
          status: "completed",
          steps: [
            { summary: [{ text, type: "text" }], type: "thought" },
            { content: [{ text: "ok", type: "text" }], type: "model_output" }
          ]
        }
      }),
      frame("done", "[DONE]")
    ];
    await expect(collect(parseGeminiInteractionsSse({
      groundingExpected: false,
      streamLimits: { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars: 5 },
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse(terminalThoughtFrames("think"))
    }))).resolves.toMatchObject({ result: { finalText: "ok" } });
    await expect(collect(parseGeminiInteractionsSse({
      groundingExpected: false,
      streamLimits: { ...DEFAULT_PROVIDER_STREAM_LIMITS, maxOutputChars: 5 },
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse(terminalThoughtFrames("think!"))
    }))).rejects.toMatchObject({
      code: "provider_output_too_large",
      retainedTextKind: "reasoning"
    });
  });

  it("enforces grounding suggestion and annotation totals before retaining a later step", async () => {
    const searchResultStep = (index: number, count: number) => [
      frame("step.start", {
        event_type: "step.start",
        index,
        step: {
          call_id: `search-${index}`,
          result: Array.from({ length: count }, () => ({
            search_suggestions: suggestionsHtml
          })),
          type: "google_search_result"
        }
      }),
      frame("step.stop", { event_type: "step.stop", index })
    ];
    await expect(collect(parseGeminiInteractionsSse({
      groundingExpected: true,
      streamLimits: DEFAULT_PROVIDER_STREAM_LIMITS,
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse([
        frame("interaction.created", {
          event_type: "interaction.created",
          interaction: { id: "suggestion-total-limit", status: "in_progress" }
        }),
        ...searchResultStep(0, 11),
        ...searchResultStep(1, 10)
      ])
    }))).rejects.toThrow("gemini_interactions_grounding_invalid");

    const annotation = {
      end_index: 1,
      start_index: 0,
      title: "Source",
      type: "url_citation",
      url: "https://example.com/source"
    };
    const modelOutputStep = (index: number) => [
      frame("step.start", {
        event_type: "step.start",
        index,
        step: {
          content: [{
            // Two steps together exceed the shared per-response citation cap.
            annotations: Array.from({ length: PROVIDER_RESPONSE_MAX_CITATIONS / 2 + 1 }, () => annotation),
            text: "ok",
            type: "text"
          }],
          type: "model_output"
        }
      }),
      frame("step.stop", { event_type: "step.stop", index })
    ];
    await expect(collect(parseGeminiInteractionsSse({
      groundingExpected: false,
      streamLimits: DEFAULT_PROVIDER_STREAM_LIMITS,
      modelId: "gemini-3.6-flash",
      responseBody: sseResponse([
        frame("interaction.created", {
          event_type: "interaction.created",
          interaction: { id: "annotation-total-limit", status: "in_progress" }
        }),
        ...modelOutputStep(0),
        ...modelOutputStep(1)
      ])
    }))).rejects.toThrow("gemini_interactions_grounding_invalid");
  });

  it("drops raw SSE error details", async () => {
    const remoteSecret = "remote-error-secret";
    let failure: unknown;
    try {
      await collect(parseGeminiInteractionsSse({
        groundingExpected: false,
        streamLimits: DEFAULT_PROVIDER_STREAM_LIMITS,
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


it("observes Gemini argument deltas privately before requiring terminal proof", async () => {
  const observations: import("./types").ProviderToolArgumentEvent[] = [];
  const argumentsText = '{"files":[{"text":"private-code-canary"}]}';
  const normalized = await collect(parseGeminiInteractionsSse({ groundingExpected: false, modelId: "gemini", streamLimits: DEFAULT_PROVIDER_STREAM_LIMITS,
    onToolArguments: async event => { observations.push(event); }, responseBody: sseResponse([
      frame("interaction.created", { event_type: "interaction.created", interaction: { id: "interaction-1", status: "in_progress" } }),
      frame("step.start", { event_type: "step.start", index: 0, step: { type: "function_call", id: "call-1", name: "create_artifact" } }),
      frame("step.delta", { event_type: "step.delta", index: 0, delta: { type: "arguments_delta", arguments: argumentsText } }),
      frame("step.stop", { event_type: "step.stop", index: 0 }),
      frame("interaction.completed", { event_type: "interaction.completed", interaction: { id: "interaction-1", status: "requires_action" } }),
      frame("done", "[DONE]")
    ]) }));
  expect(observations).toMatchObject([{ name: "create_artifact", callId: "call-1" }, { delta: argumentsText }]);
  expect(JSON.stringify(normalized.events)).not.toContain("private-code-canary");
});

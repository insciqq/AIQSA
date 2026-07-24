import { describe, expect, it } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ProviderRunResult } from "./types";
import {
  isFailedOpenAIResponse,
  isTerminalOpenAIResponse,
  normalizeCompletedOpenAIResponse,
  openAIResponseStatus,
  openAIResponseSummaryEvent,
  parseOpenAIResponsesSse,
  shouldPollOpenAIResponse,
  type ParseOpenAIResponsesSseInput
} from "./openaiResponsesResponse";

function responseBody(frames: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    }
  });
}

function sseInput(
  frames: readonly string[],
  overrides: Partial<Omit<ParseOpenAIResponsesSseInput, "responseBody">> = {}
): ParseOpenAIResponsesSseInput {
  return {
    background: true,
    idleTimeoutMs: 1000,
    responseBody: responseBody(frames),
    stream: true,
    ...overrides
  };
}

async function collectSse(input: ParseOpenAIResponsesSseInput): Promise<{
  events: ModelRunSseEvent[];
  result: ProviderRunResult;
}> {
  const stream = parseOpenAIResponsesSse(input);
  const events: ModelRunSseEvent[] = [];
  let next = await stream.next();

  while (!next.done) {
    events.push(next.value);
    next = await stream.next();
  }

  return {
    events,
    result: next.value
  };
}

describe("OpenAI Responses response normalization", () => {
  const remoteSecret = "sk-aiqsa-remote-error-regression-123456789";

  it("classifies polling, terminal, failed, missing, and unknown response statuses", () => {
    expect(openAIResponseStatus({})).toBe("unknown");
    expect(openAIResponseStatus({ status: remoteSecret })).toBe("unknown");
    expect(shouldPollOpenAIResponse({ status: "queued" })).toBe(true);
    expect(shouldPollOpenAIResponse({ status: "in_progress" })).toBe(true);
    expect(shouldPollOpenAIResponse({ status: "completed" })).toBe(false);
    expect(isTerminalOpenAIResponse({ status: "completed" })).toBe(true);
    expect(isTerminalOpenAIResponse({ status: "cancelled" })).toBe(true);
    expect(isFailedOpenAIResponse({ status: "cancelled" })).toBe(true);
    expect(isFailedOpenAIResponse({ status: "failed" })).toBe(true);
    expect(isFailedOpenAIResponse({ status: "incomplete" })).toBe(true);
    expect(isTerminalOpenAIResponse({ status: "future_status" })).toBe(false);
    expect(isFailedOpenAIResponse({ status: "future_status" })).toBe(false);
  });

  it.each([{}, { status: "future_status" }, { status: "in_progress" }])(
    "refuses to normalize a response without explicit completed status: %j",
    (response) => {
      expect(() => normalizeCompletedOpenAIResponse(response)).toThrow("openai_response_not_completed");
    }
  );

  it("builds byte-compatible summary artifacts with optional lifecycle fields", () => {
    expect(
      openAIResponseSummaryEvent({
        attempt: 2,
        background: false,
        error: { retryable: true, status: 503 },
        providerResponseId: "resp-1",
        status: "retrying",
        stream: true
      })
    ).toEqual({
      data: {
        artifactType: "summary",
        payload: {
          attempt: 2,
          background: false,
          error: { retryable: true, status: 503 },
          provider: "openai",
          responseId: "resp-1",
          status: "retrying",
          stream: true
        }
      },
      type: "artifact"
    });
  });

  it("normalizes completed text, usage, search, reasoning, citations, and tool continuation", () => {
    const response = {
      error: { code: remoteSecret, message: `must not persist ${remoteSecret}` },
      id: "resp-complete",
      model: "gpt-5.5",
      output: [
        {
          action: { sources: [{ title: "Example", url: "https://example.com/source" }], type: "search" },
          id: "search-1",
          status: "completed",
          type: "web_search_call"
        },
        {
          id: "reasoning-1",
          summary: [{ text: "Need current data", type: "summary_text" }],
          type: "reasoning"
        },
        {
          content: [
            {
              annotations: [
                {
                  title: "Safe source",
                  type: "url_citation",
                  url: " https://example.com/safe "
                },
                {
                  title: "Hostile source",
                  type: "url_citation",
                  url: "javascript:alert(1)"
                }
              ],
              text: "Normalized answer",
              type: "output_text"
            }
          ],
          type: "message"
        },
        {
          arguments: "{\"keyword\":\"latest model\"}",
          call_id: "call-1",
          id: "function-1",
          name: "search_via_perplexity",
          status: "completed",
          type: "function_call"
        }
      ],
      status: "completed",
      usage: {
        input_tokens: 11,
        input_tokens_details: {
          cache_write_tokens: 3,
          cached_tokens: 4
        },
        output_tokens: 5,
        output_tokens_details: {
          reasoning_tokens: 2
        },
        total_tokens: 16
      }
    };

    const normalized = normalizeCompletedOpenAIResponse(response, "resp-complete");
    const artifactTypes = normalized.events.flatMap((event) =>
      event.type === "artifact" ? [event.data.artifactType] : []
    );

    expect(artifactTypes).toEqual(["search", "reasoning", "citation"]);
    expect(normalized.events).toContainEqual({
      data: {
        artifactType: "citation",
        payload: {
          title: "Safe source",
          type: "url_citation",
          url: "https://example.com/safe"
        }
      },
      type: "artifact"
    });
    expect(JSON.stringify(normalized.events)).not.toContain("javascript:alert");
    expect(normalized.events.at(-1)).toEqual({
      data: { delta: "Normalized answer" },
      type: "token"
    });
    expect(normalized.result).toMatchObject({
      finalProviderResponsePreview: {
        id: "resp-complete",
        model: "gpt-5.5",
        provider: "openai",
        status: "completed",
        text: "Normalized answer"
      },
      finalText: "Normalized answer",
      providerResponseId: "resp-complete",
      providerToolCallMessage: [
        expect.objectContaining({ id: "reasoning-1", type: "reasoning" }),
        expect.objectContaining({ call_id: "call-1", type: "function_call" })
      ],
      toolCalls: [
        expect.objectContaining({
          arguments: { keyword: "latest model" },
          id: "call-1",
          name: "search_via_perplexity"
        })
      ],
      usage: {
        cachedInputTokens: 4,
        cacheWriteInputTokens: 3,
        inputTokens: 11,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 16
      }
    });
    expect(JSON.stringify(normalized.result.finalProviderResponsePreview)).not.toContain(remoteSecret);
  });

  it("sanitizes visible debug templates while retaining raw text in the provider preview", () => {
    const rawText = [
      "## Question",
      "`hi1`",
      "",
      "## Answer",
      "Hi! How can I help you today?",
      "",
      "## Provider Parameters",
      "- Model: hidden"
    ].join("\n");
    const normalized = normalizeCompletedOpenAIResponse({ output_text: rawText, status: "completed", usage: {} });

    expect(normalized.events).toEqual([
      {
        data: { delta: "Hi! How can I help you today?" },
        type: "token"
      }
    ]);
    expect(normalized.result.finalText).toBe("Hi! How can I help you today?");
    expect(normalized.result.finalProviderResponsePreview.rawText).toBe(rawText);
  });

  it("omits synthetic tokens for empty text and normalizes malformed usage to zero totals", () => {
    const normalized = normalizeCompletedOpenAIResponse({
      output: [{ content: [{ text: 42, type: "output_text" }], type: "message" }],
      status: "completed",
      usage: {
        input_tokens: Number.NaN,
        output_tokens: -2,
        total_tokens: 0
      }
    });

    expect(normalized.events).toEqual([]);
    expect(normalized.result.finalText).toBe("");
    expect(normalized.result.usage).toEqual({
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0
    });
  });

  it("parses live deltas, lifecycle search, final artifacts, ids, and usage without duplicating text", async () => {
    const completed = {
      response: {
        id: "resp-stream-1",
        model: "gpt-5.5",
        output: [
          {
            content: [
              {
                annotations: [
                  { title: "Example", type: "url_citation", url: "https://example.com" },
                  { title: "Unsafe", type: "url_citation", url: "data:text/html,bad" }
                ],
                text: "Hello",
                type: "output_text"
              }
            ],
            type: "message"
          }
        ],
        status: "completed",
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
      },
      type: "response.completed"
    };
    const normalized = await collectSse(
      sseInput([
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-stream-1","status":"in_progress"}}\n\n',
        'event: response.web_search_call.searching\ndata: {"type":"response.web_search_call.searching","response_id":"resp-stream-1","item_id":"search-1","output_index":0}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","responseId":"ignored-lower-precedence","delta":"Hel"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","id":"ignored-lowest-precedence","delta":"lo"}\n\n',
        "event: response.comp",
        `leted\ndata: ${JSON.stringify(completed)}\n\n`
      ])
    );

    expect(normalized.events.map((event) => event.type)).toEqual([
      "artifact",
      "artifact",
      "token",
      "token",
      "usage",
      "artifact"
    ]);
    expect(
      normalized.events.filter((event) => event.type === "token").map((event) => event.data.delta)
    ).toEqual(["Hel", "lo"]);
    expect(normalized.events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          artifactType: "search",
          payload: expect.objectContaining({ responseId: "resp-stream-1", status: "searching" })
        }),
        type: "artifact"
      })
    );
    expect(JSON.stringify(normalized.events)).not.toContain("data:text/html");
    expect(normalized.result).toMatchObject({
      finalText: "Hello",
      providerResponseId: "resp-stream-1",
      usage: {
        inputTokens: 4,
        outputTokens: 2,
        totalTokens: 6
      }
    });
  });

  it("rejects partial and empty EOF without inventing a completed response", async () => {
    const partial = parseOpenAIResponsesSse(
      sseInput([
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-partial","status":"in_progress","usage":{"input_tokens":2}}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Partial"}\n\n'
      ])
    );

    await expect(partial.next()).resolves.toMatchObject({
      done: false,
      value: {
        data: expect.objectContaining({ inputTokens: 2, totalTokens: 2 }),
        type: "usage"
      }
    });
    await expect(partial.next()).resolves.toMatchObject({
      done: false,
      value: expect.objectContaining({ type: "artifact" })
    });
    await expect(partial.next()).resolves.toEqual({
      done: false,
      value: { data: { delta: "Partial" }, type: "token" }
    });
    await expect(partial.next()).rejects.toThrow("openai_stream_truncated");

    const empty = parseOpenAIResponsesSse(sseInput([]));
    await expect(empty.next()).rejects.toThrow("openai_stream_truncated");
  });

  it("collapses remote stream error details to a stable local code", async () => {
    const errorStream = parseOpenAIResponsesSse(
      sseInput([`event: error\ndata: {"error":{"code":"overloaded","message":"${remoteSecret}"}}\n\n`])
    );
    let failure: unknown;
    try {
      await errorStream.next();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ message: "openai_stream_error" });
    expect((failure as Error).message).not.toContain(remoteSecret);

    const codeOnlyStream = parseOpenAIResponsesSse(
      sseInput(['event: response.in_progress\ndata: {"error":{"code":"temporary_failure"}}\n\n'])
    );
    await expect(codeOnlyStream.next()).rejects.toThrow("openai_stream_error");
  });

  it.each([
    { embeddedStatus: "completed", eventType: "response.failed", status: "failed" },
    { embeddedStatus: undefined, eventType: "response.cancelled", status: "cancelled" },
    { embeddedStatus: "failed", eventType: "response.incomplete", status: "incomplete" }
  ] as const)("uses the $status event as the canonical terminal failure", async ({ embeddedStatus, eventType, status }) => {
    const terminalStream = parseOpenAIResponsesSse(
      sseInput([
        `event: ${eventType}\ndata: ${JSON.stringify({
          response: { id: `resp-${status}`, status: embeddedStatus },
          type: eventType
        })}\n\n`
      ])
    );
    await expect(terminalStream.next()).resolves.toMatchObject({
      done: false,
      value: {
        data: {
          artifactType: "summary",
          payload: expect.objectContaining({ status })
        },
        type: "artifact"
      }
    });
    await expect(terminalStream.next()).rejects.toMatchObject({
      message: `openai_response_${status}`
    });
  });

  it.each(["failed", "incomplete", "cancelled"])(
    "does not accept response.completed with embedded %s status",
    async (status) => {
      const stream = parseOpenAIResponsesSse(
        sseInput([
          `event: response.completed\ndata: ${JSON.stringify({
            response: { id: `resp-${status}`, status },
            type: "response.completed"
          })}\n\n`
        ])
      );

      await expect(stream.next()).rejects.toThrow(`openai_response_${status}`);
    }
  );

  it("ignores non-record frames but still requires terminal proof and rejects malformed JSON", async () => {
    const ignored = parseOpenAIResponsesSse(sseInput(['event: ping\ndata: 42\n\n']));
    await expect(ignored.next()).rejects.toThrow("openai_stream_truncated");

    const malformed = parseOpenAIResponsesSse(sseInput(['event: message\ndata: {not-json}\n\n']));
    await expect(malformed.next()).rejects.toThrow("openai_stream_truncated");
  });
});

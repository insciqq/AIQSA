import { describe, expect, it } from "vitest";
import { modelCallRetryDecision } from "../engine/modelCall";
import { observedFailure } from "./providerObservability";
import { buildGeminiInteractionsRequest } from "./geminiInteractionsRequest";
import { parseGeminiInteractionsSse, streamGeminiInteractionsJsonResponse } from "./geminiInteractionsResponse";
import { streamOpenAICompatibleChatSseResponse } from "./openaiCompatibleChatResponse";
import { streamOpenRouterSseResponse } from "./openRouterChatResponse";
import type { ProviderRunRequest } from "./types";

async function failure(stream: AsyncGenerator<unknown, unknown>): Promise<unknown> {
  try {
    for (let next = await stream.next(); !next.done; next = await stream.next()) { /* drain */ }
  } catch (error) {
    return error;
  }
  throw new Error("expected the stream to fail");
}

// Review finding: a body that closed before its terminal frame failed the turn at once on Chat and Gemini routes,
// while the same drop on Responses is sent again (`agent_docs/PROVIDERS.md`, Transport).
describe("a stream that ends before its terminal frame", () => {
  const signal = new AbortController().signal;
  const context = { modelId: "m", provider: "openai_compatible" };
  const partialChat = `data: ${JSON.stringify({ choices: [{ delta: { content: "Partial" } }] })}\n\n`;

  it.each([
    ["compatible Chat", () => streamOpenAICompatibleChatSseResponse(new Response(partialChat), context)],
    ["OpenRouter Chat", () => streamOpenRouterSseResponse(new Response(partialChat), context)],
    ["Gemini Interactions", () => parseGeminiInteractionsSse({ groundingExpected: false, modelId: "m", responseBody: new Response("").body! })]
  ])("is a dropped stream the engine sends again: %s", async (_name, stream) => {
    const error = await failure(stream() as AsyncGenerator<unknown, unknown>);
    expect((error as Error).message).toContain("stream_truncated");
    expect(modelCallRetryDecision(error, signal)).toEqual({ retryAfterMs: null });
  });
});

// Review finding: a Chat response cut by its output limit or a content filter returned its tool calls, and the engine ran them.
describe("a Chat response that stopped before it finished", () => {
  const context = { modelId: "m", provider: "openai_compatible" };
  const call = { tool_calls: [{ function: { arguments: "{}", name: "get_session_status" }, id: "c", index: 0, type: "function" }] };
  const body = (finish_reason: string) => `data: ${JSON.stringify({ choices: [{ delta: call, finish_reason }] })}\n\ndata: [DONE]\n\n`;

  it.each([
    ["compatible Chat", "length", "provider_budget_exhausted"],
    ["OpenRouter Chat", "length", "provider_budget_exhausted"],
    ["OpenRouter Chat", "content_filter", "provider_refused"]
  ])("runs none of its calls: %s, %s", async (route, finishReason, code) => {
    const parse = route === "compatible Chat" ? streamOpenAICompatibleChatSseResponse : streamOpenRouterSseResponse;
    const error = await failure(parse(new Response(body(finishReason)), context) as AsyncGenerator<unknown, unknown>);
    expect(observedFailure(error).code).toBe(code);
  });
});

// Review finding: Gemini may send a thought without a signature; kept as history, it made the next tool round unsendable.
describe("a Gemini thought without a signature", () => {
  it("is not kept, and one an earlier release kept is left out of the next request", async () => {
    const stream = streamGeminiInteractionsJsonResponse({ status: "requires_action", steps: [
      { signature: null, summary: null, type: "thought" },
      { arguments: {}, id: "c", name: "get_session_status", type: "function_call" }
    ] }, { modelId: "gemini-3.6-flash" });
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    expect(next.value.toolCalls).toHaveLength(1);
    expect(next.value.history?.some((item) => item.type === "reasoning")).toBe(false);
    const request = { attachments: [], history: [
      { text: "Check status", type: "user" },
      { native: { format: "gemini_interactions", fields: { signature: null, summary: null, type: "thought" } }, type: "reasoning" },
      ...next.value.history!,
      { callId: "c", name: "get_session_status", output: "OK", type: "tool_result" }
    ], modelCapabilities: { reasoning: false }, modelId: "gemini-3.6-flash", params: {}, prompt: { developer: null, system: "Help" },
    searchPlan: { options: [] } } as unknown as ProviderRunRequest;
    expect(() => buildGeminiInteractionsRequest(request)).not.toThrow();
  });
});

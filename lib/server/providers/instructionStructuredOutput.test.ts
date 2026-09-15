import { describe, expect, it } from "vitest";
import { buildAnthropicMessagesStructuredOutputRequest, buildDeepSeekResponsesStructuredOutputRequest,
  buildGeminiInteractionsStructuredOutputRequest, buildOpenAIResponsesStructuredOutputRequest,
  buildOpenRouterStructuredOutputRequest, type ProviderStructuredOutputRequest } from "./structuredOutput";
import type { ProviderModelConfiguration } from "./providerConfiguration";

const request: ProviderStructuredOutputRequest = { name: "fixture", systemPrompt: "System style", userPrompt: "Original question",
  responseReminder: "SYNTHETIC_REMINDER", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }, maxOutputTokens: 64 };
const variants = [
  ["openai_responses_native", buildOpenAIResponsesStructuredOutputRequest],
  ["openai_responses_compatible", buildOpenAIResponsesStructuredOutputRequest],
  ["anthropic_messages", buildAnthropicMessagesStructuredOutputRequest],
  ["deepseek_responses_native", buildDeepSeekResponsesStructuredOutputRequest],
  ["gemini_interactions_native", buildGeminiInteractionsStructuredOutputRequest],
  ["openrouter_chat_completions", buildOpenRouterStructuredOutputRequest]
] as const;
describe("structured answer instruction transport", () => {
  it.each(variants)("%s sends the reminder as the last user content block", (adapterKind, build) => {
    const model = { adapterKind, upstreamModelId: "fixture-model", defaultParams: {},
      capabilities: { nativePdfInput: false, nativeSearch: false, vision: false, pdf: false, reasoning: false } } as ProviderModelConfiguration;
    const body = build(model, request);
    const messages = (body.messages ?? body.input) as { content: unknown; role?: string; type?: string }[];
    const user = messages.find(row => row.role === "user" || row.type === "user_input");
    expect(user?.content).toEqual([{ text: request.userPrompt, type: expect.any(String) },
      { text: request.responseReminder, type: expect.any(String) }]);
    expect(JSON.stringify(body).split(request.responseReminder!)).toHaveLength(2);
    expect(() => build(model, { ...request, responseReminder: "x".repeat(4001) })).toThrow("structured_output_request_invalid");
  });
});

import { describe, expect, it } from "vitest";
import { normalizeTokenUsage } from "../../domain/usage";
import { extractOpenAIUsage } from "./openaiResponsesResponse";
import { extractOpenAIChatUsage } from "./openaiChatCompletions";
import { extractAnthropicMessageUsage, updateAnthropicMessageUsage } from "./anthropicMessagesSearch";
import { extractGeminiInteractionsUsage } from "./geminiInteractionsResponse";

const providers = [
  { name: "Responses", read: (usage: Record<string, unknown>) => extractOpenAIUsage({ usage }),
    input: "input_tokens", zero: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
  { name: "Chat Completions", read: (usage: Record<string, unknown>) => extractOpenAIChatUsage({ usage }, { includeCacheWrite: true }),
    input: "prompt_tokens", zero: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
  { name: "Anthropic", read: extractAnthropicMessageUsage,
    input: "input_tokens", zero: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  { name: "Gemini", read: extractGeminiInteractionsUsage,
    input: "total_input_tokens", zero: { total_input_tokens: 0, total_output_tokens: 0, total_thought_tokens: 0, total_tokens: 0 } }
];

describe.each(providers)("$name usage presence", ({ read, input, zero }) => {
  it("distinguishes absence, partial zero and a fully reported zero after JSON serialization", () => {
    expect(read({})).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null, completeness: "unavailable" });
    const partial = read({ [input]: 0 });
    expect(partial).toMatchObject({ inputTokens: 0, outputTokens: null, totalTokens: null, completeness: "partial" });
    expect(normalizeTokenUsage(JSON.parse(JSON.stringify({ ...partial })))).toEqual(partial);
    expect(read(zero)).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0, completeness: "complete" });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "12"])("does not turn malformed input %s into a reported count", (invalid) => {
    expect(read({ [input]: invalid })).toMatchObject({ inputTokens: null, completeness: "unavailable" });
  });
});

it("retains cache categories, cumulative Anthropic input and explicit Chat Completions zero", () => {
  const initial = extractAnthropicMessageUsage({ input_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 0 });
  expect(updateAnthropicMessageUsage(initial, { output_tokens: 5 })).toMatchObject({
    inputTokens: 9, cachedInputTokens: 3, cacheWriteInputTokens: 2, outputTokens: 5, totalTokens: 14, completeness: "complete"
  });
  expect(extractOpenAIChatUsage({ usage: {
    prompt_tokens: 0, input_tokens: 12, completion_tokens: 0, output_tokens: 8, total_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0 }, input_tokens_details: { cached_tokens: 7 }, cache_write_tokens: 0
  } }, { includeCacheWrite: true })).toMatchObject({
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalTokens: 0
  });
});

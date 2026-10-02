import { describe, expect, it } from "vitest";
import { insertToolHistory } from "./toolHistory";
import { buildAnthropicMessagesRequest } from "../providers/anthropicMessages";
import { buildDeepSeekResponsesRequest, buildDeepSeekResponsesRequestPreview } from "../providers/deepSeekResponsesRequest";
import { createFakeProviderAdapter } from "../providers/fakeProvider";
import { buildGeminiInteractionsRequest, buildGeminiInteractionsRequestPreview } from "../providers/geminiInteractionsRequest";
import { buildOpenAICompatibleChatRequest, buildOpenAICompatibleChatRequestPreview } from "../providers/openaiCompatibleChatRequest";
import { buildOpenAIResponsesRequest, buildOpenAIResponsesRequestPreview } from "../providers/openaiResponsesRequest";
import { buildOpenRouterChatRequest, buildOpenRouterChatRequestPreview } from "../providers/openRouterChatRequest";
import type { ProviderRunRequest } from "../providers/types";

const PAST = "PAST_RECORD create_issue executed with the synthetic title";
const EARLIER_ATTEMPT = "EARLIER_ATTEMPT_RECORD write executed";

function request(provider: string, modelId: string, params: Record<string, unknown> = {}): ProviderRunRequest {
  const base: ProviderRunRequest = {
    attachmentIds: [], attachments: [], chatId: "chat-1",
    content: { blocks: [{ text: "Current question", type: "text" }] },
    context: { messages: [
      { content: { blocks: [{ text: "Create the synthetic issue", type: "text" }] }, id: "u-1", role: "user" },
      { content: { blocks: [{ text: "Earlier answer", type: "text" }] }, id: "a-1", role: "assistant" },
      { content: { blocks: [{ text: "Current question", type: "text" }] }, id: "u-2", role: "user" }
    ], mode: "branch_path" },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, streaming: true, toolCalling: true,
      vision: false },
    modelId, params: { maxOutputTokens: 128, ...params }, prompt: { developer: null, system: "Be precise." }, provider,
    searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto"
  };
  const block = (turnMessageId: string, userMessageId: string, text: string) => ({ turnMessageId, userMessageId, footer: null,
    header: `[AIQSA record ${turnMessageId}]`, entries: [{ ref: `tcr1_${"a".repeat(32)}`, details: true, compact: text, full: text }] });
  // A past turn's record before its answer; earlier attempts of the current message before it.
  return insertToolHistory(base, { blocks: [block("a-1", "u-1", PAST), block("u-2", "u-2", EARLIER_ATTEMPT)] });
}

const order = (text: string, ...needles: string[]) => needles.map((needle) => text.indexOf(needle));

describe.each([
  ["openai responses", () => request("openai", "gpt-5.5"), buildOpenAIResponsesRequest, buildOpenAIResponsesRequestPreview],
  ["openai-compatible chat", () => request("openai_compatible", "compatible-model"), buildOpenAICompatibleChatRequest,
    buildOpenAICompatibleChatRequestPreview],
  ["openrouter chat", () => request("openrouter", "vendor/model"), buildOpenRouterChatRequest, buildOpenRouterChatRequestPreview],
  ["gemini interactions", () => request("gemini", "gemini-3.6-flash", { stream: true }), buildGeminiInteractionsRequest,
    buildGeminiInteractionsRequestPreview],
  ["deepseek responses", () => request("deepseek", "deepseek-chat"), buildDeepSeekResponsesRequest, buildDeepSeekResponsesRequestPreview]
] as const)("%s carries tool-history records as assistant context", (_label, make, build, preview) => {
  it("places them before the answer and before the current message, and keeps them out of previews", () => {
    const wire = JSON.stringify(build(make() as never));
    const [past, answer, attempt, current] = order(wire, PAST, "Earlier answer", EARLIER_ATTEMPT, "Current question\"");
    expect(past).toBeGreaterThan(-1);
    expect(past).toBeLessThan(answer!);
    expect(attempt).toBeGreaterThan(answer!);
    expect(attempt).toBeLessThan(wire.lastIndexOf("Current question"));
    void current;
    const shown = JSON.stringify(preview(make() as never));
    expect(shown).not.toContain(PAST);
    expect(shown).not.toContain(EARLIER_ATTEMPT);
  });
});

describe("anthropic messages", () => {
  it("merges a record with its answer and keeps the current message last as the user's turn", () => {
    const body = buildAnthropicMessagesRequest(request("anthropic", "claude-sonnet-5", { thinking: { enabled: false } })) as {
      messages: Array<{ role: string; content: Array<{ text?: string }> }> };
    expect(body.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    const assistant = body.messages[1]!.content.map((part) => part.text ?? "").join("\n");
    expect(assistant.indexOf(PAST)).toBeLessThan(assistant.indexOf("Earlier answer"));
    // Earlier attempts merge into the same assistant turn just before the current question.
    expect(assistant).toContain(EARLIER_ATTEMPT);
    expect(JSON.stringify(body.messages.at(-1))).toContain("Current question");
    const shown = JSON.stringify(buildAnthropicMessagesRequest(request("anthropic", "claude-sonnet-5"), { preview: true }));
    expect(shown).not.toContain(PAST);
  });
});

describe("fake provider", () => {
  it("keeps records out of its replayed preview", () => {
    const shown = JSON.stringify(createFakeProviderAdapter().buildRequestPreview(request("fake", "fake-qsa")));
    expect(shown).not.toContain(PAST);
    expect(shown).not.toContain(EARLIER_ATTEMPT);
  });
});

import { describe, expect, it } from "vitest";
import type { ProviderRunRequest } from "./types";
import { buildOpenAIResponsesRequest, buildOpenAIResponsesRequestPreview } from "./openaiResponsesRequest";
import { buildOpenAICompatibleChatRequest, buildOpenAICompatibleChatRequestPreview } from "./openaiCompatibleChatRequest";
import { buildOpenRouterChatRequest, buildOpenRouterChatRequestPreview } from "./openRouterChatRequest";
import { buildDeepSeekResponsesRequest, buildDeepSeekResponsesRequestPreview } from "./deepSeekResponsesRequest";
import { buildGeminiInteractionsRequest, buildGeminiInteractionsRequestPreview } from "./geminiInteractionsRequest";
import { buildAnthropicMessagesRequest } from "./anthropicMessages";
import { createFakeProviderAdapter } from "./fakeProvider";

const instructions = "SYNTHETIC_PERSONAL_STYLE";
const reminder = "SYNTHETIC_FINAL_REMINDER";
function request(): ProviderRunRequest {
  const content = { blocks: [{ type: "text", text: "Current question" }, { type: "attachment", attachmentId: "fixture-document" }] };
  return { attachmentIds: ["fixture-document"], attachments: [{ id: "fixture-document", kind: "document", status: "ready",
    fileName: "fixture.txt", mimeType: "text/plain", byteSize: 10, metadata: {}, extractedText: "DOCUMENT_FIXTURE" }],
    chatId: "fixture-chat", content, context: { mode: "branch_path", messages: [
      { id: "old-question", role: "user", content: { blocks: [{ type: "text", text: "Earlier question" }] } },
      { id: "old-answer", role: "assistant", content: { blocks: [{ type: "text", text: "Earlier answer" }] } },
      { id: "current", role: "user", content }
    ] }, knowledgePlan: { mode: "none", baseIds: [], sourceIds: [], version: 1 },
    modelCapabilities: { vision: false, pdf: false, nativePdfInput: false, nativeSearch: false, reasoning: false },
    modelId: "fixture-model", provider: "openai", params: { maxOutputTokens: 64 }, toolMode: "none",
    prompt: { system: "SERVER_BASELINE", developer: "SERVER_BOUNDARY", personalInstructions: instructions, responseReminder: reminder },
    searchPlan: { mode: "all_selected", options: [] } };
}
const adapters = [
  ["Responses", buildOpenAIResponsesRequest, buildOpenAIResponsesRequestPreview],
  ["Compatible chat", buildOpenAICompatibleChatRequest, buildOpenAICompatibleChatRequestPreview],
  ["OpenRouter", buildOpenRouterChatRequest, buildOpenRouterChatRequestPreview],
  ["DeepSeek", buildDeepSeekResponsesRequest, buildDeepSeekResponsesRequestPreview],
  ["Gemini", buildGeminiInteractionsRequest, buildGeminiInteractionsRequestPreview],
  ["Anthropic", buildAnthropicMessagesRequest, (input: ProviderRunRequest) => buildAnthropicMessagesRequest(input, { preview: true })]
] as const;

describe("accepted instructions on provider requests", () => {
  it.each(adapters)("%s appends one user reminder after attachments and keeps previews private", (_name, build, preview) => {
    const input = request();
    const before = JSON.stringify(input);
    const wire = JSON.stringify(build(input));
    expect(wire.split(reminder)).toHaveLength(2);
    expect(wire.indexOf(reminder)).toBeGreaterThan(wire.indexOf("DOCUMENT_FIXTURE"));
    expect(wire.indexOf(instructions)).toBeGreaterThan(wire.indexOf("SERVER_BASELINE"));
    expect(wire.indexOf("SERVER_BOUNDARY")).toBeGreaterThan(wire.indexOf(instructions));
    const body = build(input) as Record<string, unknown>;
    const messages = (body.messages ?? body.input) as { content: unknown; role?: string; type?: string }[];
    const current = messages.find(message => JSON.stringify(message.content).includes(reminder));
    expect(current?.role ?? current?.type).toMatch(/^(user|user_input)$/);
    expect(JSON.stringify(current?.content)).toContain("Current question");
    const redacted = JSON.stringify(preview(input));
    expect(redacted).not.toContain(reminder); expect(redacted).not.toContain(instructions);
    expect(JSON.stringify(build(input))).toBe(wire);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("does not send a second reminder with a native stateful tool continuation", () => {
    const input = request();
    const body = buildOpenAIResponsesRequest({ ...input, previousProviderResponseId: "fixture-response",
      providerToolMessages: [{ type: "function_call_output", call_id: "fixture-call", output: "done" }] });
    expect(JSON.stringify(body)).not.toContain(reminder);
    expect(JSON.stringify(body)).toContain(instructions);
    expect(body.input).toHaveLength(1);
  });

  it("keeps literal text out of fake diagnostics as well", () => {
    const preview = JSON.stringify(createFakeProviderAdapter().buildRequestPreview(request()));
    expect(preview).not.toContain(instructions); expect(preview).not.toContain(reminder);
  });
});

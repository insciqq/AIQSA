import { describe, expect, it } from "vitest";
import { buildAnthropicMessagesRequest } from "./anthropicMessages";
import {
  buildGeminiInteractionsRequest,
  buildGeminiInteractionsRequestPreview
} from "./geminiInteractionsRequest";
import {
  buildOpenAICompatibleChatRequest,
  buildOpenAICompatibleChatRequestPreview
} from "./openaiCompatibleChatRequest";
import {
  buildOpenAIResponsesRequest,
  buildOpenAIResponsesRequestPreview
} from "./openaiResponsesRequest";
import {
  buildOpenRouterChatRequest,
  buildOpenRouterChatRequestPreview
} from "./openRouterChatRequest";
import type { ProviderRunRequest } from "./types";

const skillCanary = "SKILL_INSTRUCTIONS_PRIVATE_CANARY";
const catalogCanary = "SKILL_CATALOG_PRIVATE_CANARY";
const toolCanary = "SKILL_FILE_PRIVATE_CANARY";
const aliasCanary = "skill-private-alias-canary";
const currentQuestion = "CURRENT_USER_MESSAGE_CANARY";
const placeholder = "[selected Skill instructions omitted]";

function request(
  provider: string,
  params: Record<string, unknown>
): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: currentQuestion, type: "text" }] },
    context: {
      messages: [
        {
          content: { blocks: [{ text: "Earlier answer", type: "text" }] },
          id: "assistant-1",
          role: "assistant"
        },
        {
          content: { blocks: [{ text: skillCanary, type: "text" }] },
          id: "skill-context:user-2",
          purpose: "skill_context",
          role: "user"
        },
        {
          content: { blocks: [{ text: catalogCanary, type: "text" }] },
          id: "skill-catalog:user-2",
          purpose: "skill_catalog",
          role: "user"
        },
        {
          content: { blocks: [{ text: currentQuestion, type: "text" }] },
          id: "user-2",
          role: "user"
        }
      ],
      mode: "branch_path"
    },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: true,
      vision: false
    },
    modelId: "model-1",
    params,
    prompt: { developer: "Application instruction", system: "System instruction" },
    provider,
    searchPlan: { mode: "all_selected", options: [] },
    toolMode: "auto"
  };
}

function expectActualOrder(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).toContain(skillCanary);
  expect(serialized).toContain(catalogCanary);
  expect(serialized).toContain(currentQuestion);
  expect(serialized.indexOf(skillCanary)).toBeLessThan(serialized.lastIndexOf(currentQuestion));
  expect(serialized).not.toContain(placeholder);
}

function expectRedactedPreview(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(skillCanary);
  expect(serialized).not.toContain(catalogCanary);
  expect(serialized).toContain(placeholder);
  expect(serialized).toContain(currentQuestion);
}

describe("provider Skill context mapping", () => {
  it("keeps user-level order and redacts previews for every provider adapter", () => {
    const openai = request("openai", { maxOutputTokens: 64 });
    const compatible = request("openai_compatible", { maxOutputTokens: 64, stream: true });
    const openrouter = request("openrouter", { max_output_tokens: 64 });
    const gemini = request("gemini", { maxOutputTokens: 64, stream: true });
    const anthropic = request("anthropic", { maxTokens: 64 });
    const argumentsValue = { skill: aliasCanary, path: "references/private.txt" };
    openai.providerToolMessages = [
      { type: "function_call", call_id: "call-1", name: "read_skill_file", arguments: JSON.stringify(argumentsValue) },
      { type: "function_call_output", call_id: "call-1", output: toolCanary }
    ];
    compatible.providerToolMessages = openrouter.providerToolMessages = [
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read_skill_file", arguments: JSON.stringify(argumentsValue) } }] },
      { role: "tool", tool_call_id: "call-1", content: toolCanary }
    ];
    gemini.providerToolMessages = [
      { type: "function_call", id: "call-1", name: "read_skill_file", arguments: argumentsValue },
      { type: "function_result", call_id: "call-1", name: "read_skill_file", result: toolCanary }
    ];
    anthropic.providerToolMessages = [
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read_skill_file", input: argumentsValue }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: toolCanary }] }
    ];

    const cases = [
      {
        actual: buildOpenAIResponsesRequest(openai),
        preview: buildOpenAIResponsesRequestPreview(openai)
      },
      {
        actual: buildOpenAICompatibleChatRequest(compatible),
        preview: buildOpenAICompatibleChatRequestPreview(compatible)
      },
      {
        actual: buildOpenRouterChatRequest(openrouter),
        preview: buildOpenRouterChatRequestPreview(openrouter)
      },
      {
        actual: buildGeminiInteractionsRequest(gemini),
        preview: buildGeminiInteractionsRequestPreview(gemini)
      },
      {
        actual: buildAnthropicMessagesRequest(anthropic, {
          preview: false,
          redactFiles: false,
          redactImages: false
        }),
        preview: buildAnthropicMessagesRequest(anthropic, {
          preview: true,
          redactFiles: true,
          redactImages: true
        })
      }
    ];

    for (const providerCase of cases) {
      expectActualOrder(providerCase.actual);
      expectRedactedPreview(providerCase.preview);
      expect(JSON.stringify(providerCase.actual)).toContain(toolCanary);
      expect(JSON.stringify(providerCase.actual)).toContain(aliasCanary);
      expect(JSON.stringify(providerCase.preview)).not.toContain(toolCanary);
      expect(JSON.stringify(providerCase.preview)).not.toContain(aliasCanary);
    }
  });
});

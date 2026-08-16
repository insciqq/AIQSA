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
          content: { blocks: [{ text: currentQuestion, type: "text" }] },
          id: "user-2",
          role: "user"
        }
      ],
      mode: "branch_path"
    },
    knowledgePlan: { baseIds: [] },
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
  expect(serialized).toContain(currentQuestion);
  expect(serialized.indexOf(skillCanary)).toBeLessThan(serialized.lastIndexOf(currentQuestion));
  expect(serialized).not.toContain(placeholder);
}

function expectRedactedPreview(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(skillCanary);
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
    }
  });
});

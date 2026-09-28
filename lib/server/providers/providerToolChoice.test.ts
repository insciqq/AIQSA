import { describe, expect, it } from "vitest";
import { resolveProviderToolChoice } from "./providerToolChoice";
import { buildOpenAIResponsesRequest } from "./openaiResponsesRequest";
import { buildOpenAICompatibleChatRequest } from "./openaiCompatibleChatRequest";
import { buildGeminiInteractionsRequest } from "./geminiInteractionsRequest";
import type { ProviderRunRequest } from "./types";

describe("provider wire tool choice", () => {
  it.each([
    ["openai", buildOpenAIResponsesRequest],
    ["openai_compatible", buildOpenAICompatibleChatRequest],
    ["gemini", buildGeminiInteractionsRequest]
  ] as const)("keeps an explicit route restriction consistent with the %s wire body", (provider, build) => {
    const request: ProviderRunRequest = { provider, modelId: "test-model", chatId: "test-chat",
      attachmentIds: [], attachments: [], content: { blocks: [{ type: "text", text: "Use the result tool." }] },
      knowledgePlan: { version: 1, mode: "none", baseIds: [], sourceIds: [] },
      searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto", toolChoice: "required", forcedToolName: "result",
      modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false,
        toolCalling: true, nativeForcedToolChoice: false }, params: { maxOutputTokens: 128 },
      prompt: { system: null, developer: null },
      tools: [{ capability: "memory", name: "result", description: "Return a result.", strict: true,
        inputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } }]
    };
    const body = build(request);
    if ("generation_config" in body) expect(body.generation_config).toMatchObject({ tool_choice: "auto" });
    else expect(body).toMatchObject({ tool_choice: "auto" });
    expect(request.toolChoice).toBe("required");
  });

  it.each(["minimal", "low", "medium", "high", "xhigh", "max"])(
    "preserves DeepSeek %s reasoning by lowering only required choice", (effort) => {
      const input = { adapterKind: "deepseek_responses_native", modelId: "deepseek-v4.1-flash",
        params: { reasoning: { effort } }, toolChoice: "required" as const };
      expect(resolveProviderToolChoice(input)).toEqual({ requirementMode: "validated_auto", wireToolChoice: "auto" });
      expect(input).toMatchObject({ params: { reasoning: { effort } }, toolChoice: "required" });
      expect(resolveProviderToolChoice({ ...input, toolChoice: "none" }).wireToolChoice).toBe("none");
    }
  );

  it("keeps native DeepSeek required without reasoning and does not infer gateway restrictions", () => {
    expect(resolveProviderToolChoice({ adapterKind: "deepseek_responses_native", modelId: "deepseek-v4.1-flash",
      params: { reasoning: { effort: "none" } }, toolChoice: "required" }))
      .toEqual({ requirementMode: "native", wireToolChoice: "required" });
    expect(resolveProviderToolChoice({ adapterKind: "openrouter_chat_completions", modelId: "deepseek/deepseek-v4.1-flash",
      params: { reasoning: { effort: "high" } }, toolChoice: "required" }))
      .toEqual({ requirementMode: "native", wireToolChoice: "required" });
  });

  it.each(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-mythos-5-1"])(
    "uses automatic choice for catalog restriction %s in native and gateway requests", (modelId) => {
      for (const enabled of [true, false]) {
        expect(resolveProviderToolChoice({ adapterKind: "anthropic_messages", modelId,
          params: { thinking: { enabled, type: "adaptive" } }, toolChoice: "required" }))
          .toEqual({ requirementMode: "validated_auto", wireToolChoice: "auto" });
        expect(resolveProviderToolChoice({ adapterKind: "openrouter_chat_completions",
          modelId: `anthropic/${modelId.replace(/-(\d)-(\d)$/u, "-$1.$2")}`,
          params: { reasoning: { enabled, effort: "high" } }, toolChoice: "required" }).wireToolChoice).toBe("auto");
      }
    }
  );

  it.each(["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8"])(
    "distinguishes manual from adaptive thinking for %s", (modelId) => {
      const input = { adapterKind: "anthropic_messages", modelId, toolChoice: "required" as const };
      expect(resolveProviderToolChoice({ ...input, params: { thinking: { enabled: true, type: "enabled", budgetTokens: 1024 } } })
        .wireToolChoice).toBe("auto");
      expect(resolveProviderToolChoice({ ...input, params: { thinking: { enabled: true, type: "adaptive" } } })
        .wireToolChoice).toBe("required");
      expect(resolveProviderToolChoice({ ...input, params: { thinking: { enabled: false, type: "enabled", budgetTokens: 1024 } } })
        .wireToolChoice).toBe("required");
    }
  );

  it("honors admitted route restrictions without treating capabilities as proof", () => {
    const input = { adapterKind: "openrouter_chat_completions", modelId: "publisher/model",
      params: {}, modelCapabilities: { nativeForcedToolChoice: false } };
    expect(resolveProviderToolChoice({ ...input, toolChoice: "required" }))
      .toEqual({ requirementMode: "validated_auto", wireToolChoice: "auto" });
    expect(resolveProviderToolChoice({ ...input, toolChoice: "none" }).wireToolChoice).toBe("none");
    expect(resolveProviderToolChoice(input).wireToolChoice).toBe("auto");
  });
});

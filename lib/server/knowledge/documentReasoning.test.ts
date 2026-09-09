import { describe, expect, it } from "vitest";
import { buildAnthropicMessagesRequest } from "../providers/anthropicMessages";
import { buildGeminiInteractionsRequest } from "../providers/geminiInteractionsRequest";
import { buildOpenAIResponsesRequest } from "../providers/openaiResponsesRequest";
import { buildOpenRouterChatRequest } from "../providers/openRouterChatRequest";
import { normalizeProviderExecutionSnapshot, type ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { modelPdfProviderRequest } from "../parsing/modelPdfRequest";
import { freezeKnowledgeDocumentReasoning } from "./documentReasoning";
import { isCurrentKnowledgeProfilePolicy, knowledgeProfileConfiguration, knowledgeProfileEgressPolicy } from "./knowledgeProfile";

function snapshot(
  providerFamily: "openai" | "gemini" | "anthropic" | "openrouter" = "openai",
  defaultParams: Record<string, unknown> = {}
): ProviderExecutionSnapshot {
  const adapterKind = {
    openai: "openai_responses_native", gemini: "gemini_interactions_native",
    anthropic: "anthropic_messages", openrouter: "openrouter_chat_completions"
  }[providerFamily];
  return normalizeProviderExecutionSnapshot({
    connection: { allowPrivateNetwork: false, apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer", responseTimeoutMs: 300_000 },
    connectionDisplayName: "Reader", connectionId: "connection-1", credentialId: "credential-1",
    credentialVersionId: "credential-version-1", modelDisplayName: "Reader", providerFamily,
    providerModelId: "reader-1", version: 1,
    model: { adapterKind, answerSelectable: true, modelClass: "answer",
      ...(providerFamily === "openrouter" ? { openRouterRouting: { mode: "only_selected", providers: ["selected-route"] } } : {}),
      upstreamModelId: "reader-model", capabilities: {
        defaultReasoningEffort: "high", reasoningEfforts: ["none", "low", "high"],
        nativePdfInput: true, nativeSearch: false, pdf: true, reasoning: true, streaming: true, vision: true
      }, defaultParams
    }
  });
}

function request(snapshot: ProviderExecutionSnapshot) {
  return modelPdfProviderRequest({
    batch: { kind: "images", pageStart: 1, pageEnd: 1, images: [{ bytes: Buffer.from("image"), height: 10,
      mimeType: "image/png", page: 1, sourceHeight: 10, sourceWidth: 10, width: 10 }] },
    mode: "system_model_vision", prompt: "Transcribe this page.",
    snapshot: normalizeProviderExecutionSnapshot(snapshot), supplement: null, visionDetail: "original"
  });
}

describe("Documents reasoning snapshot", () => {
  it("distinguishes Default from Off and never mutates deployment defaults", () => {
    const original = snapshot("openai", { reasoning: { effort: "high", summary: "auto" }, temperature: 0.4 });
    const before = JSON.stringify(original);
    expect(freezeKnowledgeDocumentReasoning(original, null)).toBe(original);
    const off = freezeKnowledgeDocumentReasoning(original, "none")!;
    expect(buildOpenAIResponsesRequest(request(off)).reasoning?.effort).toBe("none");
    expect(buildOpenAIResponsesRequest(request(original)).reasoning?.effort).toBe("high");
    expect(off.model.defaultParams.temperature).toBe(0.4);
    expect(JSON.stringify(original)).toBe(before);
  });

  it("maps Gemini's advertised levels and rejects unsupported Off", () => {
    const base = snapshot("gemini", { reasoning: { effort: "high" } });
    const original = { ...base, model: { ...base.model, capabilities: {
      ...base.model.capabilities, reasoningEfforts: ["low", "high"]
    } } };
    expect(freezeKnowledgeDocumentReasoning(original, "none")).toBeNull();
    const low = freezeKnowledgeDocumentReasoning(original, "low")!;
    expect(buildGeminiInteractionsRequest(request(low)).generation_config.thinking_level).toBe("low");
  });

  it("applies Anthropic effort and disables thinking without an invalid output effort for Off", () => {
    const original = snapshot("anthropic", {
      output_config: { effort: "high" }, thinking: { enabled: true, budgetTokens: 2048, type: "enabled" }
    });
    const low = buildAnthropicMessagesRequest(request(freezeKnowledgeDocumentReasoning(original, "low")!));
    expect(low).toMatchObject({ output_config: { effort: "low" }, thinking: { type: "adaptive" } });
    const off = buildAnthropicMessagesRequest(request(freezeKnowledgeDocumentReasoning(original, "none")!));
    expect(off).not.toHaveProperty("thinking");
    expect(off).toHaveProperty("output_config.effort", "high");
  });

  it.each([false, true])("maps OpenRouter enabled/verbosity controls without stale budgets (verbosity=%s)", (verbosity) => {
    const original = snapshot("openrouter", {
      provider: { dataCollection: "deny", only: ["selected-route"], allowFallbacks: false },
      reasoning: { enabled: true, effort: "high", maxTokens: 2048, max_tokens: 1024 },
      ...(verbosity ? { verbosity: "high" } : {})
    });
    const low = buildOpenRouterChatRequest(request(freezeKnowledgeDocumentReasoning(original, "low")!));
    expect(low.reasoning).toEqual(verbosity ? { enabled: true } : { enabled: true, effort: "low" });
    if (verbosity) expect(low.verbosity).toBe("low");
    expect(low.provider).toMatchObject({ data_collection: "deny", only: ["selected-route"], allow_fallbacks: false });
    const off = buildOpenRouterChatRequest(request(freezeKnowledgeDocumentReasoning(original, "none")!));
    expect(off.reasoning).toEqual({ enabled: false, effort: "none" });
    expect(off).not.toHaveProperty("verbosity");
  });

  it("rejects unsupported overrides and preserves a non-reasoning model's Default", () => {
    const base = snapshot();
    const original = { ...base, model: { ...base.model, capabilities: {
      ...base.model.capabilities, reasoning: false, reasoningEfforts: undefined, defaultReasoningEffort: undefined
    } } };
    expect(freezeKnowledgeDocumentReasoning(original, "low")).toBeNull();
    expect(freezeKnowledgeDocumentReasoning(original, "none")).toBeNull();
    expect(freezeKnowledgeDocumentReasoning(original, null)).toBe(original);
    expect(request(original).params).not.toHaveProperty("reasoning");
  });

  it.each(["openai", "gemini", "anthropic", "openrouter"] as const)(
    "accepts legacy %s defaults and checks the independent choice against its frozen effective snapshot", (providerFamily) => {
      const original = snapshot(providerFamily, providerFamily === "anthropic"
        ? { outputConfig: { effort: "high" }, thinking: { enabled: true, type: "adaptive" } }
        : { reasoning: { effort: "high" } });
      const fields = { embeddingProviderModelId: "embedding-1", pdfProcessingMode: "system_model_direct_pdf" as const,
        pdfSystemModelProviderModelId: "reader-1" };
      const policy = { ...fields, egressPolicy: knowledgeProfileEgressPolicy(fields),
        pdfSystemModelSnapshot: original, profileConfiguration: knowledgeProfileConfiguration(fields) };
      expect(isCurrentKnowledgeProfilePolicy(policy)).toBe(true);
      const selected = { ...policy, profileConfiguration: knowledgeProfileConfiguration({ ...fields, pdfReasoningEffort: "low" }) };
      expect(isCurrentKnowledgeProfilePolicy(selected)).toBe(false);
      expect(isCurrentKnowledgeProfilePolicy({ ...selected,
        pdfSystemModelSnapshot: freezeKnowledgeDocumentReasoning(original, "low") })).toBe(true);
      expect(isCurrentKnowledgeProfilePolicy({ ...selected,
        profileConfiguration: { ...selected.profileConfiguration, pdfReasoningEffort: "unsupported" } })).toBe(false);
    }
  );
});

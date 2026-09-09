import { describe, expect, it } from "vitest";
import {
  ADD_PROVIDER_TILES,
  builtInRequest,
  customRequest,
  customSaveLabel,
  discoveredModelHint,
  initialBuiltInForm,
  initialCustomForm,
  suggestedConnectionName
} from "./addProviderView";
import { fixtureConnection, workingConnection } from "../providerFixtures";

describe("addProviderView", () => {
  it("lists the six tiles with a protocol subtitle only on Custom", () => {
    expect(ADD_PROVIDER_TILES.map(({ family, label, subtitle }) => [family, label, subtitle])).toEqual([
      ["openai", "OpenAI", undefined],
      ["anthropic", "Anthropic", undefined],
      ["gemini", "Gemini", undefined],
      ["deepseek", "DeepSeek", undefined],
      ["openrouter", "OpenRouter", undefined],
      ["custom", "Custom", "OpenAI-compatible"]
    ]);
  });

  it("prefills the family name, then a numbered name once the family is connected", () => {
    expect(suggestedConnectionName("openai", [])).toBe("OpenAI");
    expect(suggestedConnectionName("openai", [workingConnection()])).toBe("OpenAI · 2");
    expect(suggestedConnectionName("openai", [
      workingConnection(),
      fixtureConnection({ displayName: "openai · 2", id: "conn-two" })
    ])).toBe("OpenAI · 3");
    expect(suggestedConnectionName("gemini", [workingConnection()])).toBe("Gemini");
  });

  it("falls back to the family name for a first connection and omits unchanged endpoint settings", () => {
    const validation = builtInRequest({
      connections: [],
      expectedState: "state-openai",
      family: "openai",
      form: { ...initialBuiltInForm("openai", []), name: "   ", secret: " sk-key " }
    });
    expect(validation).toEqual({
      body: { connectionDisplayName: "OpenAI", expectedState: "state-openai", provider: "openai", secret: "sk-key" },
      ok: true
    });
    expect(builtInRequest({
      connections: [workingConnection()],
      expectedState: "state-openai",
      family: "openai",
      form: { ...initialBuiltInForm("openai", [workingConnection()]), name: "", secret: "sk-key" }
    })).toMatchObject({ field: "name", ok: false });
    expect(builtInRequest({
      connections: [],
      expectedState: "state-openai",
      family: "openai",
      form: { ...initialBuiltInForm("openai", []), apiRoot: "http://10.0.0.9/v1", secret: "sk-key" }
    })).toMatchObject({ field: "apiRoot", ok: false });
    expect(builtInRequest({
      connections: [],
      expectedState: "state-openai",
      family: "openai",
      form: { ...initialBuiltInForm("openai", []), allowPrivateNetwork: true, apiRoot: "http://10.0.0.9/v1", secret: "sk-key" }
    })).toMatchObject({
      body: { configuration: { allowPrivateNetwork: true, apiRoot: "http://10.0.0.9/v1", responseTimeoutSeconds: 300 } },
      ok: true
    });
  });

  it("hints the class of a discovered id and keeps non-chat ids unselectable", () => {
    expect(discoveredModelHint({ capabilities: { contextWindow: 200_000, reasoning: true }, id: "gpt-5.6-terra" }))
      .toEqual({ hint: "reasoning · 200k context", supported: true });
    expect(discoveredModelHint({ capabilities: {}, id: "gpt-5.5" })).toEqual({ hint: "chat", supported: true });
    expect(discoveredModelHint({ capabilities: {}, id: "text-embedding-3-large" })).toEqual({ hint: "embeddings", supported: false });
    expect(discoveredModelHint({ capabilities: {}, id: "cohere/rerank-4-pro" })).toEqual({ hint: "reranking", supported: false });
    expect(discoveredModelHint({ capabilities: {}, id: "whisper-1" })).toEqual({ hint: "not supported", supported: false });
  });

  it("requires a private http endpoint and Chat Completions for a no-key setup", () => {
    const base = { ...initialCustomForm(), apiRoot: "https://llm.example.test/v1", name: "LLM", noKey: true };
    expect(customRequest({ connections: [], discovered: null, form: base })).toMatchObject({ field: "secret", ok: false });
    const local = { ...base, allowPrivateNetwork: true, apiRoot: "http://10.0.0.5:8000/v1", protocol: "responses" as const };
    expect(customRequest({ connections: [], discovered: null, form: local })).toMatchObject({ field: "secret", ok: false });
    expect(customRequest({
      connections: [],
      discovered: null,
      form: { ...local, manualModelId: "local/llama", protocol: "chat_completions" }
    })).toMatchObject({
      body: { allowPrivateNetwork: true, authenticationMode: "none", modelId: "local/llama", protocol: "chat_completions" },
      ok: true
    });
    expect(customSaveLabel(0)).toBe("Test & Save");
    expect(customSaveLabel(1)).toBe("Test & Save 1 model");
    expect(customSaveLabel(3)).toBe("Test & Save 3 models");
  });

  it("keeps each selected model's declared capabilities and limits separate", () => {
    const discovered = [
      { id: "first", capabilities: { contextWindow: 272_000, maxOutputTokens: 65_536, defaultMaxOutputTokens: 2_048, toolCalling: true, vision: true, parallelToolCalls: true } },
      { id: "second", capabilities: { contextWindow: 32_768, toolCalling: false, vision: false, reasoning: false } },
      { id: "unknown", capabilities: {} },
      { id: "reasoning", capabilities: { contextWindow: 128_000, reasoning: true, reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" } }
    ];
    const form = {
      ...initialCustomForm(), apiRoot: "https://llm.example.test/v1", name: "LLM", secret: "test-key",
      selectedModelIds: discovered.map(({ id }) => id)
    };
    const result = customRequest({ connections: [], discovered, form });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.perModelCapabilities).toEqual(Object.fromEntries(discovered.map((model) => [model.id, model.capabilities])));
    expect(result.body.capabilities?.reasoning).toBe(false);
    expect(result.body.perModelCapabilities?.unknown).not.toHaveProperty("reasoning");
    expect(result.body.perModelCapabilities?.first).not.toHaveProperty("reasoningEfforts");
    expect(result.body.reasoningRequestMapping).toMatchObject({ effortPath: "reasoning_effort" });

    const single = customRequest({ connections: [], discovered, form: { ...form, selectedModelIds: ["first"] } });
    expect(single).toMatchObject({ ok: true, body: { perModelCapabilities: { first: discovered[0]!.capabilities } } });
  });

  it("preserves an explicit reasoning override without borrowing another model's limits", () => {
    const discovered = [{
      id: "model", capabilities: { contextWindow: 272_000, reasoning: true, reasoningEfforts: ["low"], defaultReasoningEffort: "low" }
    }];
    const result = customRequest({
      connections: [], discovered,
      form: { ...initialCustomForm(), apiRoot: "https://llm.example.test/v1", name: "LLM", secret: "test-key", reasoningChoice: "disabled", selectedModelIds: ["model"] }
    });
    expect(result).toMatchObject({ ok: true, body: { perModelCapabilities: { model: { contextWindow: 272_000, reasoning: false } } } });
    if (result.ok) {
      expect(result.body.perModelCapabilities?.model).not.toHaveProperty("reasoningEfforts");
      expect(result.body).not.toHaveProperty("reasoningRequestMapping");
    }
    expect(discovered[0]!.capabilities.reasoningEfforts).toEqual(["low"]);
  });
});

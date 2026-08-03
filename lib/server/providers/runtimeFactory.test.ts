import { describe, expect, it, vi } from "vitest";
import type { ProviderRunRequest, ProviderRunResult } from "./types";
import type { ProviderExecutionSnapshot } from "./runtimeFactory";
import {
  createProviderRuntimeBinding,
  createProviderPreviewRuntimeBinding,
  normalizeProviderExecutionSnapshot
} from "./runtimeFactory";

function snapshot(
  adapterKind: Exclude<ProviderExecutionSnapshot["model"]["adapterKind"], "fake">
): ProviderExecutionSnapshot {
  const providerFamily = adapterKind === "gemini_interactions_native"
    ? "gemini"
    : adapterKind === "openai_responses_native"
    ? "openai"
    : adapterKind === "anthropic_messages"
      ? "anthropic"
      : adapterKind === "openrouter_chat_completions"
        ? "openrouter"
        : "openai_compatible";
  return {
    connection: {
      allowPrivateNetwork: false,
      apiRoot: adapterKind === "anthropic_messages"
        ? "https://api.anthropic.com/v1"
        : "https://provider.example.test/v1"
    },
    connectionDisplayName: "Connection",
    connectionId: "connection-1",
    credentialId: "credential-1",
    credentialVersionId: "credential-version-1",
    model: {
      adapterKind,
      answerSelectable: true,
      capabilities: {
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        streaming: true,
        vision: false
      },
      defaultParams: {},
      ...(adapterKind === "openrouter_chat_completions"
        ? { openRouterRouting: { mode: "automatic" as const, providers: [] as [] } }
        : {}),
      upstreamModelId: "upstream/model"
    },
    modelDisplayName: "Model",
    providerFamily,
    providerModelId: "deployment-1",
    version: 1
  };
}

function compatibleRequest(): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: { blocks: [{ text: "hello", type: "text" }] },
    forceNonStreaming: true,
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      vision: false
    },
    modelId: "upstream/model",
    params: { stream: false },
    prompt: { developer: null, presetId: null, system: null },
    provider: "openai_compatible",
    searchStrategy: "search-disabled"
  };
}

async function collect(
  stream: AsyncGenerator<unknown, ProviderRunResult>
): Promise<ProviderRunResult> {
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  return next.value;
}

describe("provider runtime factory", () => {
  it.each([
    "gemini_interactions_native",
    "openai_responses_native",
    "openai_responses_compatible",
    "openai_chat_completions_compatible",
    "anthropic_messages",
    "openrouter_chat_completions"
  ] as const)("constructs %s only with an explicit safe fetch", (adapterKind) => {
    const fetchFn = vi.fn<typeof fetch>();
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: "secret",
      snapshot: snapshot(adapterKind)
    });

    expect(runtime.adapter).toBeDefined();
    expect(Boolean(runtime.searchAdapter)).toBe(adapterKind === "openrouter_chat_completions");
    expect(runtime.toolBridge?.supportsToolCalling({
      modelId: "upstream/model",
      provider: runtime.toolBridge.provider
    })).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never falls back to global fetch", () => {
    expect(() => createProviderRuntimeBinding({
      options: { allowFake: false },
      secret: "secret",
      snapshot: snapshot("openai_responses_compatible")
    })).toThrow("provider_safe_fetch_required");
  });

  it.each([
    "openai_responses_native",
    "openai_responses_compatible"
  ] as const)("exposes the dedicated Search adapter only for Search-capable %s models", (adapterKind) => {
    const base = snapshot(adapterKind);
    const searchCapable: ProviderExecutionSnapshot = {
      ...base,
      model: {
        ...base.model,
        capabilities: {
          ...base.model.capabilities,
          defaultReasoningEffort: "medium",
          nativeSearch: true,
          reasoning: true,
          reasoningEfforts: ["none", "low", "medium"]
        }
      }
    };
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn: vi.fn<typeof fetch>() },
      secret: "secret",
      snapshot: searchCapable
    });

    expect(runtime.searchAdapter).toBeDefined();
    expect(createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn: vi.fn<typeof fetch>() },
      secret: "secret",
      snapshot: base
    }).searchAdapter).toBeUndefined();
  });

  it("builds a serializer-only preview boundary without a real credential", () => {
    const preview = createProviderPreviewRuntimeBinding(
      snapshot("openai_chat_completions_compatible"),
      false
    );
    expect(preview.adapter.buildRequestPreview).toBeTypeOf("function");
  });

  it("keeps the versioned compatible reasoning mapping in preview serialization", () => {
    const base = snapshot("openai_chat_completions_compatible");
    const mapped = normalizeProviderExecutionSnapshot({
      ...base,
      model: {
        ...base.model,
        capabilities: { ...base.model.capabilities, reasoning: true },
        reasoningRequestMapping: {
          effortPath: "reason.effort",
          modePath: "reason.mode"
        }
      }
    });
    const runtime = createProviderPreviewRuntimeBinding(mapped, false);
    const preview = runtime.adapter.buildRequestPreview?.({
      ...compatibleRequest(),
      params: {
        reasoning: { effort: "max", mode: "pro" },
        stream: false
      }
    });

    expect(mapped.model).toMatchObject({
      reasoningRequestMapping: {
        effortPath: "reason.effort",
        modePath: "reason.mode"
      }
    });
    expect(preview?.body).toMatchObject({
      reason: { effort: "max", mode: "pro" }
    });
  });

  it("selects only the native Gemini adapter/bridge and rejects family mismatches", () => {
    const gemini = snapshot("gemini_interactions_native");
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn: vi.fn<typeof fetch>() },
      secret: "secret",
      snapshot: gemini
    });

    expect(runtime.toolBridge?.provider).toBe("gemini");
    expect(runtime.toolBridge?.supportsToolCalling({
      modelId: "gemini-3.6-flash",
      provider: "gemini"
    })).toBe(true);
    expect(() => normalizeProviderExecutionSnapshot({
      ...snapshot("openai_chat_completions_compatible"),
      providerFamily: "gemini"
    })).toThrow("provider_execution_snapshot_invalid");
    expect(() => normalizeProviderExecutionSnapshot({
      ...gemini,
      providerFamily: "openai_compatible"
    })).toThrow("provider_execution_snapshot_invalid");
    expect(() => normalizeProviderExecutionSnapshot({
      ...snapshot("openai_responses_native"),
      providerFamily: "openai_compatible"
    })).toThrow("provider_execution_snapshot_invalid");
    expect(() => normalizeProviderExecutionSnapshot({
      ...snapshot("openai_chat_completions_compatible"),
      providerFamily: "openai"
    })).toThrow("provider_execution_snapshot_invalid");
  });

  it("routes explicit no-auth compatible Chat through the transport without a credential", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_request, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", index: 0, message: { content: "ok", role: "assistant" } }],
        id: "chatcmpl-1",
        model: "upstream/model",
        usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 }
      }));
    });
    const noAuthSnapshot: ProviderExecutionSnapshot = {
      ...snapshot("openai_chat_completions_compatible"),
      connection: {
        allowPrivateNetwork: true,
        apiRoot: "http://127.0.0.1:11434/v1",
        authenticationMode: "none"
      }
    };
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: null,
      snapshot: noAuthSnapshot
    });

    await expect(collect(runtime.adapter.stream(compatibleRequest()))).resolves.toMatchObject({
      finalText: "ok"
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(() => createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: "unexpected",
      snapshot: noAuthSnapshot
    })).toThrow("provider_credential_unexpected");
  });

  it("routes explicit no-auth compatible Responses Search without an authorization header", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
      expect(String(request)).toBe("http://127.0.0.1:11434/v1/responses");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "upstream/model",
        tools: [{ type: "web_search" }]
      });
      return new Response(JSON.stringify({
        id: "response-local-1",
        model: "upstream/model",
        output_text: "ok",
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      }));
    });
    const base = snapshot("openai_responses_compatible");
    const noAuthSnapshot: ProviderExecutionSnapshot = {
      ...base,
      connection: {
        allowPrivateNetwork: true,
        apiRoot: "http://127.0.0.1:11434/v1",
        authenticationMode: "none"
      },
      model: {
        ...base.model,
        capabilities: { ...base.model.capabilities, nativeSearch: true }
      }
    };
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: null,
      snapshot: noAuthSnapshot
    });
    const request = {
      ...compatibleRequest(),
      modelCapabilities: {
        ...compatibleRequest().modelCapabilities,
        nativeSearch: true
      },
      searchPlan: {
        mode: "model_choice" as const,
        options: [{
          adapterKind: "answer_provider_hosted" as const,
          config: {},
          credentialMode: "answer_provider" as const,
          executionModes: ["model_choice" as const],
          modelId: null,
          optionId: "custom-web-search:connection-1",
          protocol: "openai_responses_web_search" as const,
          provider: "openai_compatible",
          providerModelId: null,
          revisionId: "revision-hosted",
          searchStrategyRowId: "route-hosted"
        }]
      },
      searchStrategy: "custom-web-search:connection-1"
    };

    await expect(collect(runtime.adapter.stream(request))).resolves.toMatchObject({
      finalText: "ok"
    });
    expect(runtime.toolBridge).toBeDefined();
    expect(runtime.searchAdapter).toBeDefined();
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("keeps legacy and explicit bearer snapshots fail-closed without a credential", () => {
    const fetchFn = vi.fn<typeof fetch>();
    expect(() => createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: null,
      snapshot: snapshot("openai_chat_completions_compatible")
    })).toThrow("provider_credential_missing");
    expect(() => createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: null,
      snapshot: {
        ...snapshot("openai_chat_completions_compatible"),
        connection: {
          ...snapshot("openai_chat_completions_compatible").connection,
          authenticationMode: "bearer"
        }
      }
    })).toThrow("provider_credential_missing");
  });

  it("rejects no-auth outside compatible Chat and Responses", () => {
    expect(() => normalizeProviderExecutionSnapshot({
      ...snapshot("openai_responses_native"),
      connection: {
        allowPrivateNetwork: true,
        apiRoot: "http://127.0.0.1:11434/v1",
        authenticationMode: "none"
      }
    })).toThrow("provider_execution_snapshot_invalid");
  });

  it("injects a deferred Gemini credential only as x-goog-api-key", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_request, init) => new Response(JSON.stringify({
      id: "interaction-1",
      model: "gemini-3.6-flash",
      status: "completed",
      steps: [{ content: [{ text: "ok", type: "text" }], type: "model_output" }]
    })));
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn },
      secret: async () => "resolved-google-secret",
      snapshot: snapshot("gemini_interactions_native")
    });
    const request: ProviderRunRequest = {
      attachmentIds: [],
      attachments: [],
      chatId: "chat-1",
      content: { blocks: [{ text: "hello", type: "text" }] },
      modelCapabilities: {
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        streaming: false,
        vision: false
      },
      modelId: "gemini-3.6-flash",
      params: { stream: false },
      prompt: { developer: null, presetId: null, system: null },
      provider: "gemini",
      searchStrategy: "search-disabled"
    };
    const stream = runtime.adapter.stream(request);
    while (!(await stream.next()).done) {
      // Drain the normalized provider events.
    }

    const headers = new Headers(fetchFn.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-goog-api-key")).toBe("resolved-google-secret");
    expect(headers.get("authorization")).toBeNull();
  });

  it("keeps Fake behind the explicit test boundary and credential-free", () => {
    const fake: ProviderExecutionSnapshot = {
      connection: { allowPrivateNetwork: true, apiRoot: "http://127.0.0.1" },
      connectionDisplayName: "Fake",
      connectionId: "fake-connection",
      credentialId: null,
      credentialVersionId: null,
      model: {
        adapterKind: "fake",
        capabilities: {
          nativePdfInput: false,
          nativeSearch: true,
          pdf: true,
          reasoning: true,
          vision: true
        },
        defaultParams: {},
        upstreamModelId: "fake-qsa"
      },
      modelDisplayName: "Fake QSA",
      providerFamily: "fake",
      providerModelId: "fake-model",
      version: 1
    };

    expect(() => createProviderRuntimeBinding({
      options: { allowFake: false },
      secret: null,
      snapshot: fake
    })).toThrow("fake_provider_not_allowed");
    expect(createProviderRuntimeBinding({
      options: { allowFake: true },
      secret: null,
      snapshot: fake
    }).adapter).toBeDefined();
  });

  it("rejects cross-shape, oversized, and credential-less snapshots", () => {
    expect(() => normalizeProviderExecutionSnapshot({
      ...snapshot("openai_responses_native"),
      credentialVersionId: null
    })).toThrow("provider_execution_snapshot_invalid");
    expect(() => normalizeProviderExecutionSnapshot({
      ...snapshot("openai_responses_native"),
      modelDisplayName: "x".repeat(100_000)
    })).toThrow("provider_execution_snapshot_invalid");
  });
});
